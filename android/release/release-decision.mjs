#!/usr/bin/env node
// Release decision for the Android APK (plan §6.1): re-attach the previous release's APKs or build new ones.
//
// Usage:
//   node android/release/release-decision.mjs --prerelease <true|false>
//       (--previous <file.json> | --github-repository <owner/repo> [--exclude-tag <tag>] [--github-api-url <url>])
//       [--allow-unpinned-runtime] [--commit <rev>] [--repo <dir>]
//     --prerelease         the release's channel (steps.tag.outputs.prerelease); true builds with defaultRef
//                          staging, false with release
//     --allow-unpinned-runtime
//                          decide although android/runtime.lock pins node or npm as null. inputsHash cannot
//                          cover those generated payloads then, so the decision can only be a build: a release
//                          whose inputsHash matches still fails and asks for a versionCode bump. Without this
//                          flag an unpinned lock fails the decision. The flag can stay in the release job; it
//                          has no effect once both are pinned
//     --previous           a JSON array of earlier releases, [] when there are none. Each item is either
//                          { "tag", "draft", "prerelease", "publishedAt", "manifest" } (only "manifest" is
//                          required; it is the android-update.json object or, for exact checks, its raw text)
//                          or a bare manifest object
//     --github-repository  instead, list the releases through the GitHub REST API and download each one's
//                          android-update.json. The token comes from GITHUB_TOKEN or GH_TOKEN, never from the
//                          command line, and is sent only to the API host. Drafts are listed only when the
//                          token has push access.
//     --exclude-tag        leave this tag (the release being prepared) out of the fetched list
//     --github-api-url     the REST API root (default https://api.github.com)
//     --commit             the commit being released (default HEAD); inputsHash, versionCode, versionName,
//                          min-app-version and the runtime.lock pins are read from it
//     --repo               the repository directory (default: the checkout that contains this script)
//   Prints the decision as JSON:
//     { "action": "reattach" | "build", "previous": <the most recent same-channel release or null>,
//       "reasons": [...], "prerelease", "defaultRef", "inputsHash", "versionCode", "versionName",
//       "minAppVersion", "highestPreviousVersionCode", "unpinnedRuntime", "commit" }
//   "unpinnedRuntime" lists the runtime.lock pins that are still null ([] once node and npm are pinned).
//   "versionCode" and "versionName" are the ones this release carries. "previous" names the release's
//   "tag" and its "assets" (ABI -> APK asset name). To re-attach, download android-update.json and those
//   APKs from the release "previous.tag", confirm them with
//     update-manifest.mjs --validate android-update.json --prerelease <flag> --inputs-hash <inputsHash>
//       --apk <abi>=<file> (for every asset)
//   and attach them to the new release unchanged, under the same names.
//   Exit 0 with a decision, 1 when a §6.1 rule fails (message on stderr), 2 on a usage error.
//
// Rules (§6.1):
//   - versionName must pass the app's android-update.json rule (1 to 128 characters, not blank, no control
//     characters), so a name the manifest cannot carry fails before the APK build.
//   - android/runtime.lock must pin node and npm, because inputsHash covers the generated Node and npm
//     payloads only through those pins. While either pin is null the decision fails, unless
//     --allow-unpinned-runtime is given; then only a build is allowed, never a re-attach.
//   - Every previous manifest must pass the app's parser rules (manifest-rules.mjs); a non-prerelease one
//     must also pass the stable channel's rules, and a release's own prerelease flag must match its
//     manifest's.
//   - Re-attach when inputsHash equals that of the most recent previous non-draft release of the same
//     channel. "Most recent" means the highest versionCode; ties go to the later publishedAt, then to
//     the earlier position in the list (newest first, as the GitHub API lists releases). Every build
//     raises versionCode above all earlier releases and a re-attach keeps it, so this is the channel's
//     latest release; if a manual release ever broke that order, the highest versionCode is what
//     devices may already run. The re-attached manifest's defaultRef, versionCode and versionName must
//     match this release's (inputsHash covers all three).
//   - Otherwise build, with a versionCode greater than the highest versionCode of every previous
//     release of either channel, drafts included, so prerelease testers receive the stable build and
//     nothing ever downgrades.
//   - android/min-app-version must not be greater than the versionCode attached to this release.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    bigintToJson,
    defaultRefFor,
    isMainModule,
    isPlainObject,
    MAX_VERSION_CODE,
    parseAppVersionProperties,
    parseBooleanOption,
    parseCliArgs,
    parseMinAppVersion,
    readCommittedFile,
    ReleaseToolError,
    requireOption,
    runCli,
    RUNTIME_PINS,
    runtimeLockPins,
    UsageError,
} from './common.mjs';
import { inputsHashAtCommit, RUNTIME_LOCK_PATH } from './inputs-hash.mjs';
import { decodeManifestBytes, isManifestText, isStableDownloadTag, MAX_MANIFEST_BYTES, validateManifestText } from './manifest-rules.mjs';

export const MANIFEST_ASSET_NAME = 'android-update.json';

function optionalType(item, key, type, label) {
    const value = item[key];
    if (value !== undefined && value !== null && typeof value !== type) {
        throw new ReleaseToolError(`previous release ${label}: "${key}" must be a ${type}`);
    }
    return value ?? null;
}

/**
 * Validates the previous releases. Returns
 * { tag, draft, releasePrerelease, publishedAt, manifest (normalized), index } entries.
 */
export function normalizePreviousReleases(previous) {
    if (!Array.isArray(previous)) {
        throw new ReleaseToolError('the previous releases must be a JSON array');
    }
    return previous.map((item, index) => {
        if (!isPlainObject(item)) {
            throw new ReleaseToolError(`previous release #${index} must be an object`);
        }
        const isEntry = Object.hasOwn(item, 'manifest');
        let label = `#${index}`;
        const tag = isEntry ? optionalType(item, 'tag', 'string', label) : null;
        label = tag ?? label;
        const draft = isEntry ? optionalType(item, 'draft', 'boolean', label) ?? false : false;
        const releasePrerelease = isEntry ? optionalType(item, 'prerelease', 'boolean', label) : null;
        const publishedAt = isEntry ? optionalType(item, 'publishedAt', 'string', label) : null;
        const raw = isEntry ? item.manifest : item;
        let manifest;
        try {
            manifest = validateManifestText(typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '');
        } catch (error) {
            throw new ReleaseToolError(`previous release ${label}: ${error.message}`);
        }
        label = tag ?? manifest.releaseTag;
        if (!manifest.prerelease && !isStableDownloadTag(manifest.releaseTag)) {
            throw new ReleaseToolError(`previous release ${label}: android-update.json releaseTag cannot form the stable download URL (UpdateRepository.encodeReleaseTag)`);
        }
        if (releasePrerelease !== null && releasePrerelease !== manifest.prerelease) {
            throw new ReleaseToolError(`previous release ${label} is ${releasePrerelease ? 'a prerelease' : 'a stable release'} but its android-update.json says prerelease ${manifest.prerelease}`);
        }
        return { tag: tag ?? manifest.releaseTag, draft, releasePrerelease, publishedAt, manifest, index };
    });
}

function publishedTime(entry) {
    const time = entry.publishedAt === null ? NaN : Date.parse(entry.publishedAt);
    return Number.isNaN(time) ? -Infinity : time;
}

/** The most recent entry: highest versionCode, then later publishedAt, then earlier list position. */
export function mostRecentRelease(entries) {
    let best = null;
    for (const entry of entries) {
        if (best === null || entry.manifest.versionCode > best.manifest.versionCode) {
            best = entry;
        } else if (entry.manifest.versionCode === best.manifest.versionCode) {
            const time = publishedTime(entry);
            const bestTime = publishedTime(best);
            if (time > bestTime || (time === bestTime && entry.index < best.index)) {
                best = entry;
            }
        }
    }
    return best;
}

function describeRelease(entry) {
    if (entry === null) {
        return null;
    }
    return {
        tag: entry.tag,
        draft: entry.draft,
        publishedAt: entry.publishedAt,
        releaseTag: entry.manifest.releaseTag,
        prerelease: entry.manifest.prerelease,
        defaultRef: entry.manifest.defaultRef,
        versionCode: bigintToJson(entry.manifest.versionCode),
        versionName: entry.manifest.versionName,
        inputsHash: entry.manifest.inputsHash,
        assets: Object.fromEntries(Object.entries(entry.manifest.assets).map(([abi, asset]) => [abi, asset.name])),
    };
}

function toMinAppVersion(value) {
    if (typeof value === 'bigint' && value >= 0n) {
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return BigInt(value);
    }
    if (typeof value === 'string') {
        return parseMinAppVersion(value);
    }
    throw new ReleaseToolError('minAppVersion must be a non-negative integer');
}

function describeText(value) {
    if (typeof value !== 'string') {
        return `(${value === null ? 'null' : typeof value})`;
    }
    return value.length > 40 ? `${JSON.stringify(value.slice(0, 40))}... (${value.length} characters)` : JSON.stringify(value);
}

/**
 * The §6.1 decision for one release. Throws a ReleaseToolError when a rule fails.
 * `runtimeLock` is the parsed android/runtime.lock of the commit; `previous` is the list
 * normalizePreviousReleases accepts.
 */
export function decideRelease({
    prerelease,
    inputsHash,
    versionCode,
    versionName,
    minAppVersion,
    runtimeLock,
    allowUnpinnedRuntime = false,
    previous = [],
} = {}) {
    if (typeof prerelease !== 'boolean') {
        throw new UsageError('prerelease must be true or false');
    }
    if (typeof allowUnpinnedRuntime !== 'boolean') {
        throw new UsageError('allowUnpinnedRuntime must be true or false');
    }
    if (typeof inputsHash !== 'string' || !/^[0-9a-f]{64}$/.test(inputsHash)) {
        throw new ReleaseToolError('inputsHash must be 64 lowercase hex digits');
    }
    if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
        throw new ReleaseToolError(`versionCode must be an integer from 1 to ${MAX_VERSION_CODE}`);
    }
    // UpdateManifestParser's versionName rule, applied before the build rather than by the generator after it.
    if (!isManifestText(versionName, 128)) {
        throw new ReleaseToolError(`versionName ${describeText(versionName)} must be a non-blank string of at most 128 characters without control characters, as android-update.json requires`);
    }
    const minimum = toMinAppVersion(minAppVersion);
    const pins = runtimeLockPins(runtimeLock);
    const unpinned = RUNTIME_PINS.filter(name => pins[name] === null);
    const unpinnedNames = unpinned.join(' and ');
    if (unpinned.length > 0 && !allowUnpinnedRuntime) {
        throw new ReleaseToolError(`android/runtime.lock does not pin ${unpinnedNames} yet, so inputsHash cannot show that the bundled ${unpinnedNames} payloads are unchanged; pin them, or pass --allow-unpinned-runtime to allow a build (never a re-attach)`);
    }
    const defaultRef = defaultRefFor(prerelease);
    const channel = prerelease ? 'prerelease' : 'stable';
    const entries = normalizePreviousReleases(previous);
    const highest = mostRecentRelease(entries);
    const latest = mostRecentRelease(entries.filter(entry => !entry.draft && entry.manifest.prerelease === prerelease));
    const current = BigInt(versionCode);
    const reasons = [];
    const result = (action, attachedVersionCode) => ({
        action,
        previous: describeRelease(latest),
        reasons,
        prerelease,
        defaultRef,
        inputsHash,
        versionCode: bigintToJson(attachedVersionCode),
        versionName,
        minAppVersion: bigintToJson(minimum),
        highestPreviousVersionCode: highest === null ? null : bigintToJson(highest.manifest.versionCode),
        unpinnedRuntime: unpinned,
    });

    if (latest !== null && latest.manifest.inputsHash === inputsHash) {
        if (unpinned.length > 0) {
            throw new ReleaseToolError(`inputsHash matches the most recent ${channel} release ${latest.tag}, but android/runtime.lock does not pin ${unpinnedNames}, so a re-attach could skip a change to those payloads; bump versionCode in android/app-version.properties to build`);
        }
        const reattached = latest.manifest;
        if (reattached.defaultRef !== defaultRef) {
            throw new ReleaseToolError(`release ${latest.tag} matches inputsHash but has defaultRef ${reattached.defaultRef}; a ${channel} release needs ${defaultRef}`);
        }
        if (reattached.versionCode !== current || reattached.versionName !== versionName) {
            throw new ReleaseToolError(`release ${latest.tag} matches inputsHash but carries versionCode ${reattached.versionCode} and versionName ${JSON.stringify(reattached.versionName)}, not ${versionCode} and ${JSON.stringify(versionName)} from android/app-version.properties`);
        }
        if (minimum > reattached.versionCode) {
            throw new ReleaseToolError(`android/min-app-version ${minimum} is greater than versionCode ${reattached.versionCode} of the re-attached release ${latest.tag}; bump versionCode in android/app-version.properties`);
        }
        reasons.push(`inputsHash matches the most recent ${channel} release ${latest.tag} (versionCode ${reattached.versionCode}); re-attach its APKs and android-update.json unchanged`);
        reasons.push(`min-app-version ${minimum} is not greater than versionCode ${reattached.versionCode}`);
        return result('reattach', reattached.versionCode);
    }

    if (latest !== null) {
        reasons.push(`inputsHash differs from the most recent ${channel} release ${latest.tag} (versionCode ${latest.manifest.versionCode})`);
    } else if (entries.length === 0) {
        reasons.push('no previous release has an android-update.json');
    } else {
        reasons.push(`no previous non-draft ${channel} release has an android-update.json`);
    }
    if (unpinned.length > 0) {
        reasons.push(`android/runtime.lock does not pin ${unpinnedNames}; --allow-unpinned-runtime allows this build, and inputsHash does not cover those payloads`);
    }
    if (highest !== null && current <= highest.manifest.versionCode) {
        throw new ReleaseToolError(`versionCode ${versionCode} in android/app-version.properties must be greater than ${highest.manifest.versionCode}, the highest versionCode of the previous releases (${highest.tag}${highest.draft ? ', a draft' : ''}); bump it`);
    }
    reasons.push(highest === null
        ? `versionCode ${versionCode} is the first APK release`
        : `versionCode ${versionCode} is greater than the highest previous versionCode ${highest.manifest.versionCode} (${highest.tag})`);
    if (minimum > current) {
        throw new ReleaseToolError(`android/min-app-version ${minimum} is greater than versionCode ${versionCode} attached to this release; bump versionCode in android/app-version.properties`);
    }
    reasons.push(`min-app-version ${minimum} is not greater than versionCode ${versionCode}`);
    return result('build', current);
}

/**
 * Lists a repository's releases through the GitHub REST API and downloads each one's
 * android-update.json. Returns entries for normalizePreviousReleases with the manifest as raw text.
 * `token` is optional and is sent only to the API origin; redirects are followed by hand so that
 * asset storage hosts never receive it.
 */
export async function fetchPreviousReleases({
    repository,
    token = null,
    fetch: fetchImpl = globalThis.fetch,
    apiUrl = 'https://api.github.com',
    excludeTag = null,
    perPage = 100,
    maxPages = 10,
} = {}) {
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new UsageError(`the GitHub repository must look like owner/name, not ${JSON.stringify(repository)}`);
    }
    let api;
    try {
        api = new URL(apiUrl);
    } catch {
        throw new UsageError(`invalid GitHub API URL ${JSON.stringify(apiUrl)}`);
    }
    if (api.protocol !== 'https:') {
        throw new UsageError('the GitHub API URL must use https');
    }
    const apiRoot = api.href.replace(/\/+$/, '');

    async function request(url, accept) {
        let target;
        try {
            target = new URL(url);
        } catch {
            throw new ReleaseToolError(`the GitHub API returned an invalid URL ${JSON.stringify(String(url).slice(0, 120))}`);
        }
        for (let hop = 0; hop <= 5; hop++) {
            const headers = { 'Accept': accept, 'User-Agent': 'sillybunny-android-release-tooling', 'X-GitHub-Api-Version': '2022-11-28' };
            if (token && target.origin === api.origin) {
                headers.Authorization = `Bearer ${token}`;
            }
            const where = `${target.origin}${target.pathname}`;
            let response;
            try {
                response = await fetchImpl(target.href, { headers, redirect: 'manual' });
            } catch (error) {
                throw new ReleaseToolError(`GET ${where} failed: ${error.message}`);
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                const next = location ? new URL(location, target) : null;
                if (next === null || next.protocol !== 'https:') {
                    throw new ReleaseToolError(`GET ${where} redirected to an unusable location`);
                }
                target = next;
                continue;
            }
            if (!response.ok) {
                throw new ReleaseToolError(`GET ${where} failed: HTTP ${response.status}`);
            }
            return response;
        }
        throw new ReleaseToolError(`GET ${url} redirected too many times`);
    }

    const releases = [];
    for (let page = 1; ; page++) {
        if (page > maxPages) {
            throw new ReleaseToolError(`${repository} has more than ${maxPages * perPage} releases; raise maxPages`);
        }
        const response = await request(`${apiRoot}/repos/${repository}/releases?per_page=${perPage}&page=${page}`, 'application/vnd.github+json');
        let list;
        try {
            list = await response.json();
        } catch {
            list = null;
        }
        if (!Array.isArray(list)) {
            throw new ReleaseToolError(`the release list of ${repository} is not a JSON array`);
        }
        releases.push(...list);
        if (list.length < perPage) {
            break;
        }
    }

    const entries = [];
    for (const release of releases) {
        if (!isPlainObject(release) || typeof release.tag_name !== 'string') {
            throw new ReleaseToolError(`the release list of ${repository} has an entry without a tag_name`);
        }
        if (release.tag_name === excludeTag) {
            continue;
        }
        const manifests = (Array.isArray(release.assets) ? release.assets : []).filter(asset => asset?.name === MANIFEST_ASSET_NAME);
        if (manifests.length === 0) {
            continue;
        }
        if (manifests.length > 1 || typeof manifests[0].url !== 'string') {
            throw new ReleaseToolError(`release ${release.tag_name} has an unusable ${MANIFEST_ASSET_NAME} asset list`);
        }
        if (typeof manifests[0].size === 'number' && manifests[0].size > MAX_MANIFEST_BYTES) {
            throw new ReleaseToolError(`release ${release.tag_name}: ${MANIFEST_ASSET_NAME} is larger than 2 MiB`);
        }
        const response = await request(manifests[0].url, 'application/octet-stream');
        let manifest;
        try {
            manifest = decodeManifestBytes(new Uint8Array(await response.arrayBuffer()));
        } catch (error) {
            throw new ReleaseToolError(`release ${release.tag_name}: ${error.message}`);
        }
        entries.push({
            tag: release.tag_name,
            draft: release.draft === true,
            prerelease: release.prerelease === true,
            publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
            manifest,
        });
    }
    return entries;
}

const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readPreviousFile(file) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new ReleaseToolError(`cannot read ${file}: ${error.code ?? error.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new ReleaseToolError(`${file} is not JSON: ${error.message}`);
    }
}

async function main(argv) {
    const values = parseCliArgs(argv, {
        'prerelease': { type: 'string' },
        'previous': { type: 'string' },
        'github-repository': { type: 'string' },
        'exclude-tag': { type: 'string' },
        'github-api-url': { type: 'string' },
        'allow-unpinned-runtime': { type: 'boolean' },
        'commit': { type: 'string' },
        'repo': { type: 'string' },
    });
    const prerelease = parseBooleanOption(requireOption(values, 'prerelease'), 'prerelease');
    const fromGitHub = values['github-repository'] !== undefined;
    if (fromGitHub === (values.previous !== undefined)) {
        throw new UsageError('pass exactly one of --previous and --github-repository');
    }
    if (!fromGitHub && (values['exclude-tag'] !== undefined || values['github-api-url'] !== undefined)) {
        throw new UsageError('--exclude-tag and --github-api-url need --github-repository');
    }

    const repo = path.resolve(values.repo ?? defaultRepo);
    const { commit, inputsHash } = inputsHashAtCommit({ repo, commit: values.commit ?? 'HEAD', defaultRef: defaultRefFor(prerelease) });
    const properties = readCommittedFile(repo, commit, 'android/app-version.properties');
    if (properties === null) {
        throw new ReleaseToolError(`android/app-version.properties is not tracked at ${commit}`);
    }
    const minimum = readCommittedFile(repo, commit, 'android/min-app-version');
    if (minimum === null) {
        throw new ReleaseToolError(`android/min-app-version is not tracked at ${commit}`);
    }
    // inputsHashAtCommit has already required the lock to be a tracked regular file.
    let runtimeLock;
    try {
        runtimeLock = JSON.parse(readCommittedFile(repo, commit, RUNTIME_LOCK_PATH).toString('utf8'));
    } catch (error) {
        throw new ReleaseToolError(`${RUNTIME_LOCK_PATH} at ${commit} is not JSON: ${error.message}`);
    }
    const { versionCode, versionName } = parseAppVersionProperties(properties);
    const previous = fromGitHub
        ? await fetchPreviousReleases({
            repository: values['github-repository'],
            token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
            apiUrl: values['github-api-url'] ?? 'https://api.github.com',
            excludeTag: values['exclude-tag'] ?? null,
        })
        : readPreviousFile(values.previous);
    const decision = decideRelease({
        prerelease,
        inputsHash,
        versionCode,
        versionName,
        minAppVersion: parseMinAppVersion(minimum),
        runtimeLock,
        allowUnpinnedRuntime: values['allow-unpinned-runtime'] === true,
        previous,
    });
    process.stdout.write(`${JSON.stringify({ ...decision, commit }, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    await runCli('release-decision', main);
}
