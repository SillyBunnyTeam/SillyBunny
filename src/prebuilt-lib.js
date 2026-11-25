import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { serverDirectory } from './server-directory.js';

export const PREBUILT_LIB_MANIFEST_SCHEMA_VERSION = 1;
export const PREBUILT_LIB_FILENAME = 'lib.js';
export const PREBUILT_LIB_MANIFEST_FILENAME = 'lib.manifest.json';
export const PREBUILT_LIB_INPUT_FILES = Object.freeze([
    'public/lib.js',
    'webpack.config.js',
    'package.json',
    'package-lock.json',
    'bun.lock',
]);

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Computes the lowercase SHA-256 hex digest of a buffer or string.
 * @param {Buffer|Uint8Array|string} data Data to hash.
 * @returns {string} Hex digest.
 */
export function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Resolves the directory that holds prebuilt `lib.js` and `lib.manifest.json`.
 * @param {object} [options] Resolution options.
 * @param {string} [options.prebuiltDir] Explicit override directory.
 * @param {string} [options.rootDir=serverDirectory] Repository root directory.
 * @param {Record<string, string|undefined>} [options.env=process.env] Environment variables.
 * @returns {string} Absolute path to the prebuilt lib directory.
 */
export function resolvePrebuiltLibDir({ prebuiltDir = undefined, rootDir = serverDirectory, env = process.env } = {}) {
    if (typeof prebuiltDir === 'string' && prebuiltDir.trim()) {
        return path.resolve(prebuiltDir);
    }

    const envDir = env?.SILLYBUNNY_PREBUILT_LIB_DIR;
    if (typeof envDir === 'string' && envDir.trim()) {
        return path.resolve(envDir);
    }

    return path.join(rootDir, 'dist', 'lib');
}

/**
 * Computes a portable SHA-256 hash of all inputs that determine the public vendor bundle.
 * Uses normalized POSIX relative paths and LF line endings so CI-built Linux artifacts match Windows/Android installs.
 * @param {object} [options] Hashing options.
 * @param {string} [options.rootDir=serverDirectory] Repository root directory.
 * @returns {string} Lowercase SHA-256 hex digest.
 */
export function computePublicLibInputsHash({ rootDir = serverDirectory } = {}) {
    const hasher = crypto.createHash('sha256');

    for (const relativePosixPath of PREBUILT_LIB_INPUT_FILES) {
        const absolutePath = path.join(rootDir, ...relativePosixPath.split('/'));
        if (!fs.existsSync(absolutePath)) {
            hasher.update(`${relativePosixPath}:missing\n`);
            continue;
        }

        const normalizedContent = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
        hasher.update(`${relativePosixPath}:${Buffer.byteLength(normalizedContent, 'utf8')}\n`);
        hasher.update(normalizedContent, 'utf8');
        hasher.update('\n');
    }

    return hasher.digest('hex');
}

/**
 * Validates a parsed prebuilt lib manifest object.
 * @param {unknown} value Parsed JSON value.
 * @returns {boolean} True when the manifest conforms to schema v1.
 */
export function isValidPrebuiltLibManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const manifest = /** @type {Record<string, unknown>} */ (value);
    return manifest.schemaVersion === PREBUILT_LIB_MANIFEST_SCHEMA_VERSION
        && typeof manifest.cacheVersion === 'string'
        && manifest.cacheVersion.length > 0
        && typeof manifest.inputsHash === 'string'
        && SHA256_HEX_RE.test(manifest.inputsHash)
        && typeof manifest.sha256 === 'string'
        && SHA256_HEX_RE.test(manifest.sha256)
        && typeof manifest.webpackVersion === 'string'
        && manifest.webpackVersion.length > 0
        && typeof manifest.bundleBytes === 'number'
        && Number.isInteger(manifest.bundleBytes)
        && manifest.bundleBytes > 0
        && manifest.builtWithNode === true;
}

/**
 * Reads and validates `lib.manifest.json` from a prebuilt directory.
 * @param {string} prebuiltDir Directory containing `lib.manifest.json`.
 * @returns {Record<string, any>|null} Validated manifest object, or null if absent/invalid.
 */
export function readPrebuiltPublicLibManifest(prebuiltDir) {
    const manifestPath = path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return isValidPrebuiltLibManifest(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Seeds `<DATA_ROOT>/_webpack/<cacheVersion>/output/lib.js` from a verified prebuilt `dist/lib/` bundle.
 * Returns `false` cleanly whenever the prebuilt bundle is absent, stale (`inputsHash` mismatch), or fails SHA-256 verification.
 * @param {object} options Seeding options.
 * @param {string} [options.cacheVersion] Active Webpack cache version string.
 * @param {string} [options.inputsHash] Expected portable `inputsHash` for the current repo inputs.
 * @param {string} options.outputPath Destination `lib.js` path inside the active Webpack output directory.
 * @param {string} [options.prebuiltDir] Override directory for `lib.js` and `lib.manifest.json`.
 * @returns {boolean} True if a verified prebuilt bundle was atomically seeded to `outputPath`.
 */
export function trySeedPrebuiltPublicLib({ cacheVersion = undefined, inputsHash = undefined, outputPath, prebuiltDir = undefined } = {}) {
    if (typeof outputPath !== 'string' || !outputPath) {
        return false;
    }

    const resolvedPrebuiltDir = resolvePrebuiltLibDir({ prebuiltDir });
    const manifest = readPrebuiltPublicLibManifest(resolvedPrebuiltDir);
    if (!manifest) {
        return false;
    }

    const expectedInputsHash = typeof inputsHash === 'string' && inputsHash
        ? inputsHash
        : computePublicLibInputsHash();

    if (manifest.inputsHash !== expectedInputsHash) {
        console.debug('Prebuilt frontend library bundle inputsHash mismatch; falling back to local Webpack build.');
        return false;
    }

    const sourceBundlePath = path.join(resolvedPrebuiltDir, PREBUILT_LIB_FILENAME);
    let sourceStat;
    try {
        sourceStat = fs.lstatSync(sourceBundlePath);
    } catch {
        return false;
    }

    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size !== manifest.bundleBytes) {
        console.warn('Prebuilt frontend library bundle validation failed; falling back to local Webpack build.');
        return false;
    }

    let verifiedBuffer;
    try {
        verifiedBuffer = fs.readFileSync(sourceBundlePath);
    } catch {
        return false;
    }

    if (verifiedBuffer.byteLength !== manifest.bundleBytes || sha256Hex(verifiedBuffer) !== manifest.sha256) {
        console.warn('Prebuilt frontend library bundle integrity check failed; falling back to local Webpack build.');
        return false;
    }

    const outputDir = path.dirname(outputPath);
    const tempName = `.${path.basename(outputPath)}.seed.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tempPath = path.join(outputDir, tempName);

    try {
        fs.mkdirSync(outputDir, { recursive: true });
        // Write the verified bytes to a fresh inode so later rebuilds of dist/lib/lib.js cannot mutate the cache in place.
        fs.writeFileSync(tempPath, verifiedBuffer);
        fs.renameSync(tempPath, outputPath);
        if (cacheVersion) {
            console.debug(`Seeded prebuilt frontend library bundle for cache version ${cacheVersion}.`);
        }
        return true;
    } catch (error) {
        try {
            fs.rmSync(tempPath, { force: true });
        } catch {
            // Ignore cleanup failure for temp file.
        }
        console.warn('Failed to seed prebuilt frontend library bundle; falling back to local Webpack build.', error);
        return false;
    }
}
