#!/usr/bin/env node
// inputsHash of the Android APK (plan §6.1): one SHA-256 over everything a commit feeds into the APK.
//
// Usage:
//   node android/release/inputs-hash.mjs --default-ref <staging|release> [--commit <rev>] [--repo <dir>] [--list]
//     --default-ref  the build's defaultRef: staging for prereleases, release for stable releases
//     --commit       the commit to hash (default HEAD)
//     --repo         the repository directory (default: the checkout that contains this script)
//     --list         print the canonical listing instead of the hash (entries end in NUL bytes;
//                    pipe it through `tr '\0' '\n'` to read it)
//   Prints the hash as 64 lowercase hex digits and a newline.
//   Exit 0 ok, 1 when the commit cannot be hashed (message on stderr), 2 on a usage error.
//
//   The whole release build recipe must stay fixed: a release build may vary only -PdefaultRef. Any other
//   Gradle property, and any option of the steps that prepare the runtime inputs (the Node and npm producers,
//   fetch-termux.sh, notices.py) that changes the APK bytes, is outside inputsHash unless it is read from files
//   under android/. So the release job must vary none of them: -PincludeX86_64, for example, adds an x86_64
//   section to the runtime-manifest.json that every split APK carries (update-manifest.mjs refuses such
//   APKs), and notices.py --android-libraries changes the bundled notices. The generated Node and npm payloads
//   are covered only through their android/runtime.lock pins, and release-decision.mjs refuses to re-attach
//   until those pins fix the payload bytes (unpinnedRuntimePayloads in common.mjs).
//
// Definition, format v2:
//   inputs     The entries of `git ls-tree -r <commit>` (mode, object id, path) at these paths, plus defaultRef:
//                android/                      every entry except pure docs; android/runtime.lock must be a
//                                              regular file
//                scripts/bootstrap/install.sh  a regular file; the APK bundles it for first run and Repair
//                .gitattributes, scripts/.gitattributes, scripts/bootstrap/.gitattributes
//                                              when tracked: with the android/**/.gitattributes entries they
//                                              decide the checkout bytes of every other input
//              EXTRA_INPUTS must list every file outside android/ that the Gradle build packages; changing
//              the set of paths needs a new format version. Only committed content counts, never the working
//              tree, so ignored files, build outputs and the checkout's own line endings cannot change the
//              hash. The checkout's git settings (core.autocrlf, info/attributes) are not inputs; the root
//              .gitattributes pins LF for text files regardless.
//   pure docs  Regular files (mode 100644 or 100755) under android/ whose name ends in ".md" in any letter
//              case and whose path is outside android/app/src/ (Gradle source sets, where any file can be
//              packaged into the APK). Symlinks, submodules and all other files are inputs, including tests
//              and these release scripts.
//   listing    "sillybunny-android-inputs v2\n"
//              "defaultRef <staging|release>\n"
//              then one record per input, sorted by the raw bytes of its path:
//              "<mode> <object id> <path>\0"
//              with the mode as git prints it (for example 100644), the object id in lowercase hex and
//              the path as raw bytes relative to the repository root.
//   inputsHash the lowercase hex SHA-256 of the listing.

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isMainModule, parseCliArgs, ReleaseToolError, requireOption, resolveCommit, runCli, runGit, UsageError } from './common.mjs';

export const INPUTS_FORMAT = 'sillybunny-android-inputs v2';
export const RUNTIME_LOCK_PATH = 'android/runtime.lock';
/** Files outside android/ that the APK packages. Keep this in step with the Gradle build. */
export const EXTRA_INPUTS = Object.freeze(['scripts/bootstrap/install.sh']);
const ANDROID_PREFIX = 'android/';
const SOURCE_SETS_PREFIX = 'android/app/src/';
const DEFAULT_REFS = ['staging', 'release'];
const REGULAR_FILE_MODE = /^100(?:644|755)$/;

// The root .gitattributes and the one in every directory above an extra input. Those under android/
// are android/ entries already.
function attributeFiles(paths) {
    const files = new Set(['.gitattributes']);
    for (const filePath of paths) {
        const directories = filePath.split('/').slice(0, -1);
        for (let depth = 1; depth <= directories.length; depth++) {
            files.add(`${directories.slice(0, depth).join('/')}/.gitattributes`);
        }
    }
    return [...files].sort();
}

/** The .gitattributes paths outside android/ that are inputs when tracked. */
export const ATTRIBUTE_INPUTS = Object.freeze(attributeFiles(EXTRA_INPUTS));
/** Inputs that must be tracked regular files at every hashed commit. */
export const REQUIRED_INPUTS = Object.freeze([RUNTIME_LOCK_PATH, ...EXTRA_INPUTS]);
const OPTIONAL_PATHS = new Set([...EXTRA_INPUTS, ...ATTRIBUTE_INPUTS]);

function entryName(entry) {
    return Buffer.isBuffer(entry.path) ? entry.path.toString('latin1') : entry.path;
}

/** True for a pure-docs entry, which inputsHash leaves out. `entry.path` is a Buffer or a string. */
export function isPureDoc(entry) {
    const filePath = entryName(entry);
    return REGULAR_FILE_MODE.test(entry.mode)
        && filePath.startsWith(ANDROID_PREFIX)
        && !filePath.startsWith(SOURCE_SETS_PREFIX)
        && filePath.toLowerCase().endsWith('.md');
}

/** Parses `git ls-tree -r -z` output into { mode, type, oid, path } entries; `path` is a Buffer. */
export function parseLsTree(output) {
    const bytes = Buffer.from(output);
    const entries = [];
    let start = 0;
    while (start < bytes.length) {
        let end = bytes.indexOf(0, start);
        if (end === -1) {
            end = bytes.length;
        }
        const record = bytes.subarray(start, end);
        start = end + 1;
        const tab = record.indexOf(0x09);
        const header = tab === -1 ? null : /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(record.subarray(0, tab).toString('latin1'));
        if (!header) {
            throw new ReleaseToolError(`unexpected git ls-tree record ${JSON.stringify(record.toString('latin1').slice(0, 80))}`);
        }
        entries.push({ mode: header[1], type: header[2], oid: header[3], path: Buffer.from(record.subarray(tab + 1)) });
    }
    return entries;
}

/** The canonical listing (see the header) for the ls-tree entries that listInputEntries returns. */
export function canonicalInputsListing(entries, defaultRef) {
    if (!DEFAULT_REFS.includes(defaultRef)) {
        throw new UsageError(`defaultRef must be staging or release, not ${JSON.stringify(defaultRef)}`);
    }
    // Checked first, so an input that is a directory is reported as such rather than by its contents.
    for (const required of REQUIRED_INPUTS) {
        if (!entries.some(entry => entryName(entry) === required && REGULAR_FILE_MODE.test(entry.mode))) {
            throw new ReleaseToolError(`${required} is not a tracked regular file`);
        }
    }
    const inputs = [];
    for (const entry of entries) {
        const filePath = Buffer.from(entry.path);
        const name = filePath.toString('latin1');
        if (!name.startsWith(ANDROID_PREFIX) && !OPTIONAL_PATHS.has(name)) {
            throw new ReleaseToolError(`${JSON.stringify(name)} is not an inputsHash input path`);
        }
        if (!isPureDoc({ mode: entry.mode, path: name })) {
            inputs.push({ mode: entry.mode, oid: entry.oid, path: filePath });
        }
    }
    inputs.sort((left, right) => Buffer.compare(left.path, right.path));
    const parts = [Buffer.from(`${INPUTS_FORMAT}\ndefaultRef ${defaultRef}\n`, 'ascii')];
    for (const input of inputs) {
        parts.push(Buffer.from(`${input.mode} ${input.oid} `, 'ascii'), input.path, Buffer.from([0]));
    }
    return Buffer.concat(parts);
}

/** inputsHash of ls-tree entries: lowercase hex SHA-256 of canonicalInputsListing. */
export function computeInputsHash(entries, defaultRef) {
    return createHash('sha256').update(canonicalInputsListing(entries, defaultRef)).digest('hex');
}

/**
 * Lists the tracked entries at every input path of a commit: android/, EXTRA_INPUTS and ATTRIBUTE_INPUTS.
 * `commit` must already be a resolved commit id.
 */
export function listInputEntries(repo, commit, { env } = {}) {
    const paths = ['android', ...ATTRIBUTE_INPUTS, ...EXTRA_INPUTS];
    const entries = parseLsTree(runGit(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths], { env }));
    if (!entries.some(entry => entryName(entry).startsWith(ANDROID_PREFIX))) {
        throw new ReleaseToolError(`android/ is not tracked at ${commit}`);
    }
    return entries;
}

/**
 * inputsHash of `commit` in `repo` for `defaultRef`.
 * Returns { commit (full id), inputsHash, listing (Buffer), inputs (count), excluded (pure-docs paths) }.
 */
export function inputsHashAtCommit({ repo, commit = 'HEAD', defaultRef, env } = {}) {
    if (!DEFAULT_REFS.includes(defaultRef)) {
        throw new UsageError(`defaultRef must be staging or release, not ${JSON.stringify(defaultRef)}`);
    }
    const resolved = resolveCommit(repo, commit, { env });
    const entries = listInputEntries(repo, resolved, { env });
    const listing = canonicalInputsListing(entries, defaultRef);
    const excluded = entries.filter(isPureDoc).map(entry => entry.path.toString('utf8'));
    return {
        commit: resolved,
        inputsHash: createHash('sha256').update(listing).digest('hex'),
        listing,
        inputs: entries.length - excluded.length,
        excluded,
    };
}

const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(argv) {
    const values = parseCliArgs(argv, {
        'default-ref': { type: 'string' },
        commit: { type: 'string' },
        repo: { type: 'string' },
        list: { type: 'boolean' },
    });
    const result = inputsHashAtCommit({
        repo: path.resolve(values.repo ?? defaultRepo),
        commit: values.commit ?? 'HEAD',
        defaultRef: requireOption(values, 'default-ref'),
    });
    process.stdout.write(values.list ? result.listing : `${result.inputsHash}\n`);
}

if (isMainModule(import.meta.url)) {
    await runCli('inputs-hash', main);
}
