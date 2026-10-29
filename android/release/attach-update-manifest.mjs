#!/usr/bin/env node
// Attaches android-update.json to the draft release release.yml has just created, after the APKs it lists
// (plan §5.4, §6.1, §6.2).
//
// Usage:
//   node android/release/attach-update-manifest.mjs --repository <owner/repo> --release-url <url>
//       --manifest <file> [--github-api-url <url>]
//     --repository      the repository (GITHUB_REPOSITORY)
//     --release-url     the draft's html_url, which `gh release create` prints. A draft's html_url ends in
//                       untagged-<id>, and two drafts can share a tag name, so the release is found by this URL
//                       rather than by its tag
//     --manifest        the android-update.json to attach
//     --github-api-url  the REST API root (default https://api.github.com; release.yml passes GITHUB_API_URL)
//   The token comes from GITHUB_TOKEN or GH_TOKEN, never from the command line. It is sent only to the API host
//   and to the release's upload host; redirects to asset storage are followed without it. Drafts are listed only
//   to tokens with push access.
//   Prints a JSON summary. Exit 0 once attached; 1 when a check fails and 2 on a usage error, each with the
//   placeholder and a JSON object {"code": ..., ...} on stderr.
//
// A published release must hold every APK its android-update.json lists (plan §6.1): installed apps download
// stable APKs from the release that served the manifest. So, before the manifest goes up:
//   - the release is a draft, with the manifest's prerelease flag, and has no android-update.json yet;
//   - the manifest passes the app's rules (manifest-rules.mjs);
//   - every APK the manifest lists is exactly one uploaded asset of the release, and downloading it gives the
//     manifest's size and SHA-256.
// Then the manifest is uploaded, downloaded again and compared byte for byte. Nothing is deleted, replaced or
// published. After a failure the draft has no android-update.json (or, when the read-back fails, one that does
// not match), and maintainers must not publish it.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { bigintToJson, isMainModule, isPlainObject, parseCliArgs, ReleaseToolError, requireOption, runCli, UsageError } from './common.mjs';
import { decodeManifestBytes, MAX_APK_BYTES, MAX_MANIFEST_BYTES, validateManifestText } from './manifest-rules.mjs';
import { MANIFEST_ASSET_NAME } from './release-decision.mjs';

const USER_AGENT = 'sillybunny-android-release-tooling';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A failed check: the placeholder plus its machine-readable details. `error.details` keeps them for callers. */
function toolError(code, details = {}) {
    const error = new ReleaseToolError(`TODO(copy) ${JSON.stringify({ code, ...details })}`);
    error.details = { code, ...details };
    return error;
}

function usageError(code, details = {}) {
    const error = new UsageError(`TODO(copy) ${JSON.stringify({ code, ...details })}`);
    error.details = { code, ...details };
    return error;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseHttpsUrl(value, option) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw usageError('invalid-url', { option, value: String(value).slice(0, 200) });
    }
    if (url.protocol !== 'https:') {
        throw usageError('url-not-https', { option });
    }
    return url;
}

/** Origin and path of a URL: never its query, which can carry a signed storage token. */
function describe(url) {
    return `${url.origin}${url.pathname}`;
}

/**
 * A REST client for one repository. The token goes only to `trustedOrigins`; every other host (asset storage)
 * is reached without it, and redirects are followed by hand to keep it that way.
 */
function createClient({ apiUrl, token, fetchImpl }) {
    const api = parseHttpsUrl(apiUrl, 'github-api-url');
    const apiRoot = api.href.replace(/\/+$/, '');
    const trustedOrigins = new Set([api.origin]);

    async function request(url, { method = 'GET', accept = 'application/vnd.github+json', body, contentType } = {}) {
        let target;
        try {
            target = new URL(url);
        } catch {
            throw toolError('invalid-api-url', { url: String(url).split('?')[0].slice(0, 200) });
        }
        for (let hop = 0; hop <= 5; hop++) {
            if (target.protocol !== 'https:') {
                throw toolError('url-not-https', { url: describe(target) });
            }
            const headers = { 'Accept': accept, 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' };
            if (token && trustedOrigins.has(target.origin)) {
                headers.Authorization = `Bearer ${token}`;
            }
            if (contentType) {
                headers['Content-Type'] = contentType;
            }
            let response;
            try {
                response = await fetchImpl(target.href, { method, headers, body, redirect: 'manual' });
            } catch (error) {
                throw toolError('request-failed', { method, url: describe(target), error: error.message });
            }
            if (method === 'GET' && REDIRECTS.has(response.status)) {
                const location = response.headers.get('location');
                let next = null;
                try {
                    next = location ? new URL(location, target) : null;
                } catch {
                    next = null;
                }
                if (next === null || next.protocol !== 'https:') {
                    throw toolError('redirect-unusable', { method, url: describe(target) });
                }
                target = next;
                continue;
            }
            if (!response.ok) {
                throw toolError('http-error', { method, url: describe(target), status: response.status });
            }
            return response;
        }
        throw toolError('too-many-redirects', { method, url: String(url).split('?')[0] });
    }

    return { apiRoot, trustedOrigins, request };
}

/** Reads a response body up to `limit` bytes; more fails. With `hashOnly` the bytes are not kept. */
async function readBody(response, limit, name, { hashOnly = false } = {}) {
    const hash = createHash('sha256');
    const chunks = [];
    let size = 0;
    const add = chunk => {
        size += chunk.length;
        if (size > limit) {
            throw toolError('download-too-large', { name, limit });
        }
        hash.update(chunk);
        if (!hashOnly) {
            chunks.push(chunk);
        }
    };
    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                add(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
        }
    } else {
        add(Buffer.from(await response.arrayBuffer()));
    }
    return { sha256: hash.digest('hex'), size, bytes: hashOnly ? null : Buffer.concat(chunks) };
}

async function readJson(response, what) {
    try {
        return await response.json();
    } catch {
        throw toolError('not-json', { what });
    }
}

/** Finds the release whose html_url is `releaseUrl`, retrying while the new draft is not listed yet. */
async function findRelease({ client, repository, releaseUrl, attempts, retryDelayMs, sleepImpl, perPage = 100, maxPages = 10 }) {
    for (let attempt = 1; ; attempt++) {
        const matches = [];
        for (let page = 1; ; page++) {
            if (page > maxPages) {
                throw toolError('too-many-releases', { repository, limit: maxPages * perPage });
            }
            const list = await readJson(await client.request(`${client.apiRoot}/repos/${repository}/releases?per_page=${perPage}&page=${page}`), 'release-list');
            if (!Array.isArray(list)) {
                throw toolError('release-list-not-array', { repository });
            }
            matches.push(...list.filter(release => isPlainObject(release) && release.html_url === releaseUrl));
            if (list.length < perPage) {
                break;
            }
        }
        if (matches.length === 1) {
            return matches[0];
        }
        if (matches.length > 1) {
            throw toolError('release-ambiguous', { releaseUrl, count: matches.length });
        }
        if (attempt >= attempts) {
            // A draft is listed only to a token with push access.
            throw toolError('release-not-found', { releaseUrl, attempts });
        }
        await sleepImpl(retryDelayMs);
    }
}

/** The single asset named `name`, completely uploaded and with an API URL. */
function releaseAsset(release, name) {
    const assets = (Array.isArray(release.assets) ? release.assets : []).filter(asset => isPlainObject(asset) && asset.name === name);
    if (assets.length !== 1) {
        throw toolError('apk-asset-count', { name, count: assets.length });
    }
    const [asset] = assets;
    if (asset.state !== 'uploaded' || typeof asset.url !== 'string') {
        throw toolError('apk-asset-incomplete', { name, state: asset.state ?? null });
    }
    return asset;
}

/** The upload URL for `name`, from the release's upload_url template, on a host the token may be sent to. */
function uploadUrl(release, name, client) {
    if (typeof release.upload_url !== 'string') {
        throw toolError('upload-url-missing');
    }
    let url;
    try {
        url = new URL(release.upload_url.replace(/\{[^}]*\}$/, ''));
    } catch {
        throw toolError('upload-url-invalid');
    }
    const github = client.trustedOrigins.has('https://api.github.com') && url.origin === 'https://uploads.github.com';
    if (url.protocol !== 'https:' || !(client.trustedOrigins.has(url.origin) || github)) {
        throw toolError('upload-host-untrusted', { origin: url.origin });
    }
    client.trustedOrigins.add(url.origin);
    url.search = '';
    url.searchParams.set('name', name);
    return url.href;
}

/**
 * Checks the draft release found by `releaseUrl` against the manifest, then uploads the manifest and reads it
 * back (see the header). `manifestBytes` is the android-update.json file's content. Returns the summary.
 * Errors are ReleaseToolErrors (UsageError for bad arguments) whose `details.code` names the failed check.
 */
export async function attachUpdateManifest({
    repository,
    releaseUrl,
    manifestBytes,
    token = null,
    apiUrl = 'https://api.github.com',
    fetch: fetchImpl = globalThis.fetch,
    attempts = 5,
    retryDelayMs = 3000,
    sleep: sleepImpl = sleep,
} = {}) {
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw usageError('invalid-repository', { repository: String(repository).slice(0, 200) });
    }
    parseHttpsUrl(releaseUrl, 'release-url');
    if (!(manifestBytes instanceof Uint8Array)) {
        throw usageError('manifest-not-bytes');
    }
    let manifest;
    try {
        manifest = validateManifestText(decodeManifestBytes(manifestBytes));
    } catch (error) {
        throw toolError('manifest-invalid', { error: error.message });
    }
    const client = createClient({ apiUrl, token, fetchImpl });

    const release = await findRelease({ client, repository, releaseUrl, attempts, retryDelayMs, sleepImpl });
    if (release.draft !== true) {
        throw toolError('release-not-draft', { releaseUrl });
    }
    if (release.prerelease !== manifest.prerelease) {
        throw toolError('prerelease-mismatch', { release: release.prerelease ?? null, manifest: manifest.prerelease });
    }
    if ((Array.isArray(release.assets) ? release.assets : []).some(asset => asset?.name === MANIFEST_ASSET_NAME)) {
        throw toolError('manifest-already-attached', { name: MANIFEST_ASSET_NAME });
    }

    const checked = {};
    for (const [abi, expected] of Object.entries(manifest.assets).sort(([a], [b]) => a.localeCompare(b))) {
        const asset = releaseAsset(release, expected.name);
        if (asset.size !== expected.size) {
            throw toolError('apk-asset-size', { name: expected.name, size: asset.size ?? null, expected: expected.size });
        }
        const response = await client.request(asset.url, { accept: 'application/octet-stream' });
        const measured = await readBody(response, MAX_APK_BYTES, expected.name, { hashOnly: true });
        if (measured.size !== expected.size || measured.sha256 !== expected.sha256) {
            throw toolError('apk-asset-mismatch', {
                name: expected.name,
                size: measured.size,
                sha256: measured.sha256,
                expectedSize: expected.size,
                expectedSha256: expected.sha256,
            });
        }
        checked[abi] = { name: expected.name, size: measured.size, sha256: measured.sha256 };
    }

    const target = uploadUrl(release, MANIFEST_ASSET_NAME, client);
    const uploaded = await readJson(
        await client.request(target, { method: 'POST', body: manifestBytes, contentType: 'application/json' }),
        'upload-response',
    );
    if (!isPlainObject(uploaded) || uploaded.name !== MANIFEST_ASSET_NAME || uploaded.size !== manifestBytes.length
        || uploaded.state !== 'uploaded' || typeof uploaded.url !== 'string') {
        throw toolError('upload-unexpected', {
            stored: isPlainObject(uploaded) ? { name: uploaded.name ?? null, size: uploaded.size ?? null, state: uploaded.state ?? null } : null,
            expectedSize: manifestBytes.length,
        });
    }
    const readBack = await readBody(await client.request(uploaded.url, { accept: 'application/octet-stream' }), MAX_MANIFEST_BYTES, MANIFEST_ASSET_NAME);
    if (!readBack.bytes.equals(Buffer.from(manifestBytes))) {
        throw toolError('manifest-read-back-mismatch', { size: readBack.size, sha256: readBack.sha256, expectedSize: manifestBytes.length });
    }

    return {
        release: release.html_url,
        draft: true,
        prerelease: manifest.prerelease,
        releaseTag: manifest.releaseTag,
        versionCode: bigintToJson(manifest.versionCode),
        assets: checked,
        manifest: { name: MANIFEST_ASSET_NAME, size: readBack.size, sha256: readBack.sha256 },
    };
}

async function main(argv) {
    const values = parseCliArgs(argv, {
        'repository': { type: 'string' },
        'release-url': { type: 'string' },
        'manifest': { type: 'string' },
        'github-api-url': { type: 'string' },
    });
    const repository = requireOption(values, 'repository');
    const releaseUrl = requireOption(values, 'release-url');
    const file = requireOption(values, 'manifest');
    let manifestBytes;
    try {
        manifestBytes = readFileSync(file);
    } catch (error) {
        throw toolError('manifest-unreadable', { file, error: error.code ?? error.message });
    }
    const summary = await attachUpdateManifest({
        repository,
        releaseUrl,
        manifestBytes,
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
        apiUrl: values['github-api-url'] ?? 'https://api.github.com',
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    await runCli('attach-update-manifest', main);
}
