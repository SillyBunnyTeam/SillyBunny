// Shared helpers for the Android release scripts in this directory (plan §5.4, §6.1).
// Library module without a CLI. Node and Bun built-ins only; no dependencies.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** A failed release rule or unusable input. The CLIs print the message on one line and exit 1. */
export class ReleaseToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReleaseToolError';
    }
}

/** A command-line mistake. The CLIs print the message on one line and exit 2. */
export class UsageError extends ReleaseToolError {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}

/** `defaultRef` of the build for a channel: prereleases track staging, stable releases track release (§6.2). */
export function defaultRefFor(prerelease) {
    return prerelease ? 'staging' : 'release';
}

export function oneLine(text) {
    return String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The runtime.lock pins that inputsHash can cover only once they are set (the Node and npm payloads). */
export const RUNTIME_PINS = Object.freeze(['node', 'npm']);

/** The ABIs of the release APKs (§5.4); update-manifest.mjs takes exactly these. */
export const RELEASE_ABIS = Object.freeze(['arm64-v8a', 'armeabi-v7a']);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The node and npm pins of a parsed android/runtime.lock: { node, npm }, each the pin's "version" string,
 * or null while the lock pins it as null. Task 4.1 replaces the nulls with objects that carry "version".
 */
export function runtimeLockPins(lock) {
    if (!isPlainObject(lock) || lock.schema !== 1) {
        throw new ReleaseToolError('android/runtime.lock must be a schema 1 lock');
    }
    const pins = {};
    for (const name of RUNTIME_PINS) {
        const pin = lock[name];
        if (pin === null || pin === undefined) {
            pins[name] = null;
        } else if (isPlainObject(pin) && typeof pin.version === 'string' && pin.version !== '') {
            pins[name] = pin.version;
        } else {
            throw new ReleaseToolError(`android/runtime.lock pins ${name} without a "version" string`);
        }
    }
    return pins;
}

/**
 * The RUNTIME_PINS whose payload bytes a parsed android/runtime.lock does not fix yet, in RUNTIME_PINS order.
 * A version is not enough. Node needs the SHA-256 of its source tarball and, for each release ABI, the
 * published binary's OCI digest, SHA-256 and size; android-runtime.yml fills those in after its first
 * publish, and until then they are null. npm comes from the Node source's deps/npm (source "node"), so
 * the source tarball's SHA-256 fixes it.
 */
export function unpinnedRuntimePayloads(lock) {
    const pins = runtimeLockPins(lock);
    const node = pins.node === null ? null : lock.node;
    const sourcePinned = node !== null && isPlainObject(node.source) && SHA256_HEX.test(String(node.source.tarballSha256));
    const binaries = node !== null && isPlainObject(node.binaries) ? node.binaries : {};
    const binaryPinned = binary => isPlainObject(binary)
        && OCI_DIGEST.test(String(binary.digest))
        && SHA256_HEX.test(String(binary.sha256))
        && Number.isSafeInteger(binary.size) && binary.size > 0;
    const pinned = {
        node: sourcePinned && RELEASE_ABIS.every(abi => Object.hasOwn(binaries, abi) && binaryPinned(binaries[abi])),
        npm: pins.npm !== null && lock.npm.source === 'node' && sourcePinned,
    };
    return RUNTIME_PINS.filter(name => !pinned[name]);
}

/** True when `moduleUrl` (the caller's import.meta.url) is the script Node or Bun was started with. */
export function isMainModule(moduleUrl) {
    const script = process.argv[1];
    if (!script) {
        return false;
    }
    const scriptUrl = pathToFileURL(path.resolve(script)).href;
    return process.platform === 'win32' ? scriptUrl.toLowerCase() === moduleUrl.toLowerCase() : scriptUrl === moduleUrl;
}

/** Runs a CLI body and turns any error into one stderr line plus exit code 1 (rule) or 2 (usage). */
export async function runCli(name, main, argv = process.argv.slice(2)) {
    try {
        await main(argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const prefix = error instanceof ReleaseToolError ? '' : 'unexpected error: ';
        process.stderr.write(`${name}: ${prefix}${oneLine(message)}\n`);
        process.exitCode = error instanceof UsageError ? 2 : 1;
    }
}

export function parseCliArgs(argv, options) {
    try {
        return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
    } catch (error) {
        throw new UsageError(error.message);
    }
}

export function requireOption(values, name) {
    const value = values[name];
    if (value === undefined || value === '') {
        throw new UsageError(`--${name} is required`);
    }
    return value;
}

export function parseBooleanOption(value, name) {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new UsageError(`--${name} must be true or false, not ${JSON.stringify(value)}`);
}

export function parsePositiveIntegerOption(value, name) {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new UsageError(`--${name} must be a positive integer, not ${JSON.stringify(value)}`);
    }
    return Number(value);
}

/**
 * Runs git in `repo` and returns stdout as a Buffer. Errors become one-line ReleaseToolErrors.
 * `env` defaults to the caller's environment; tests pass an isolated one.
 */
export function runGit(repo, args, { env } = {}) {
    try {
        return execFileSync('git', ['-C', repo, ...args], {
            env: env ?? process.env,
            maxBuffer: 256 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (error) {
        const stderr = error.stderr ? oneLine(error.stderr.toString('utf8')) : '';
        throw new ReleaseToolError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ` (${oneLine(error.message)})`}`);
    }
}

/** Resolves `revision` to a full commit id. Revisions that look like options are refused. */
export function resolveCommit(repo, revision, { env } = {}) {
    if (typeof revision !== 'string' || revision === '' || revision.startsWith('-')) {
        throw new ReleaseToolError(`invalid commit ${JSON.stringify(revision)}`);
    }
    let output;
    try {
        output = runGit(repo, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { env });
    } catch (error) {
        // --quiet hides a missing commit; anything git still reports (a bad repository path) is kept.
        const fatal = /fatal: (.*)$/.exec(error.message);
        throw new ReleaseToolError(fatal ? `cannot resolve ${revision}: ${fatal[1]}` : `${revision} is not a commit in ${repo}`);
    }
    return output.toString('utf8').trim();
}

/** Reads a tracked file's committed bytes, or null when the path is not tracked at `commit`. */
export function readCommittedFile(repo, commit, filePath, { env } = {}) {
    const listing = runGit(repo, ['ls-tree', '-z', '--full-tree', commit, '--', filePath], { env }).toString('utf8');
    const entry = listing.split('\0').find(line => line.endsWith(`\t${filePath}`));
    if (!entry || !/^100(?:644|755) blob /.test(entry)) {
        return null;
    }
    return runGit(repo, ['cat-file', 'blob', `${commit}:${filePath}`], { env });
}

/** SHA-256 (lowercase hex) and size of the bytes read from `file`, measured in one pass. */
export function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        let size = 0;
        createReadStream(file)
            .on('error', reject)
            .on('data', chunk => {
                hash.update(chunk);
                size += chunk.length;
            })
            .on('end', () => resolve({ sha256: hash.digest('hex'), size }));
    });
}

// Kotlin's Char.isWhitespace() on the JVM: Character.isWhitespace || Character.isSpaceChar,
// that is U+0009-U+000D, U+001C-U+001F and the Zs/Zl/Zp characters.
export function isKotlinWhitespace(code) {
    return (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x20) || code === 0xa0 || code === 0x1680
        || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
        || code === 0x205f || code === 0x3000;
}

/** Kotlin's CharSequence.isBlank(): empty or only whitespace. */
export function isKotlinBlank(value) {
    for (let index = 0; index < value.length; index++) {
        if (!isKotlinWhitespace(value.charCodeAt(index))) {
            return false;
        }
    }
    return true;
}

/** Mirror of android/app/build.gradle.kts: versionCode in 1..2_100_000_000. */
export const MAX_VERSION_CODE = 2_100_000_000;

/**
 * Parses android/app-version.properties the way the Gradle build reads it: java.util.Properties
 * (ISO-8859-1; `key=value`, `key: value` or `key value`; `#`/`!` comments; trailing whitespace kept),
 * then `versionCode.toIntOrNull()` in 1..2_100_000_000 and a non-blank `versionName`.
 * Backslash escapes and line continuations are refused rather than interpreted.
 * `bytes` is a Buffer or a string; a string is taken as already decoded.
 */
export function parseAppVersionProperties(bytes, source = 'android/app-version.properties') {
    const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('latin1');
    const properties = new Map();
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        const line = rawLine.replace(/^[ \t\f]+/, '');
        if (line === '' || line.startsWith('#') || line.startsWith('!')) {
            continue;
        }
        if (line.includes('\\')) {
            throw new ReleaseToolError(`${source}: backslash escapes and line continuations are not supported`);
        }
        const match = /^([^=: \t\f]*)[ \t\f]*(?:[=:][ \t\f]*)?([\s\S]*)$/.exec(line);
        properties.set(match[1], match[2]);
    }
    const versionCodeText = properties.get('versionCode');
    // Kotlin's toIntOrNull accepts an optional plus sign and leading zeros, but no spaces.
    const versionCode = versionCodeText !== undefined && /^\+?[0-9]+$/.test(versionCodeText)
        ? Number(versionCodeText.replace(/^\+/, ''))
        : NaN;
    if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
        throw new ReleaseToolError(`${source}: versionCode must be an integer from 1 to ${MAX_VERSION_CODE}, found ${JSON.stringify(versionCodeText ?? null)}`);
    }
    const versionName = properties.get('versionName');
    if (versionName === undefined || isKotlinBlank(versionName)) {
        throw new ReleaseToolError(`${source}: versionName must not be blank`);
    }
    return { versionCode, versionName };
}

/**
 * Parses android/min-app-version like scripts/self-update.sh: optional surrounding [[:space:]],
 * then decimal digits. Returns a BigInt so huge values compare exactly.
 */
export function parseMinAppVersion(bytes, source = 'android/min-app-version') {
    const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('latin1');
    const match = /^[ \t\n\v\f\r]*([0-9]+)[ \t\n\v\f\r]*$/.exec(text);
    if (!match) {
        throw new ReleaseToolError(`${source} must contain one decimal integer, found ${JSON.stringify(text.slice(0, 40))}`);
    }
    return BigInt(match[1]);
}

/** A BigInt as a JSON number when it is a safe integer, otherwise as a decimal string. */
export function bigintToJson(value) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
