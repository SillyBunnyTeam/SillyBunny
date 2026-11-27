import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { isBunRuntime } from './runtime.js';
import { serverDirectory } from './server-directory.js';

export const PREBUILT_LIB_MANIFEST_SCHEMA_VERSION = 1;
export const PREBUILT_LIB_FILENAME = 'lib.js';
// The minifier writes the notices it extracts from third-party code to `<output filename>.LICENSE.txt`, and the first line of lib.js points at it.
export const PREBUILT_LIB_LICENSE_FILENAME = `${PREBUILT_LIB_FILENAME}.LICENSE.txt`;
export const PREBUILT_LIB_MANIFEST_FILENAME = 'lib.manifest.json';
export const PREBUILT_LIB_INPUT_FILES = Object.freeze([
    'public/lib.js',
    'webpack.config.js',
    'package.json',
    'package-lock.json',
    'bun.lock',
]);

// Far above any real bundle (a few MB) and manifest (a few hundred bytes); they only bound what a damaged or hostile dist/lib can make the server allocate.
export const PREBUILT_LIB_MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
export const PREBUILT_LIB_MAX_MANIFEST_BYTES = 64 * 1024;
export const PREBUILT_LIB_MAX_LICENSE_BYTES = 1024 * 1024;

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
 * Resolves the positive integer byte length from either the canonical PR 11 (`bundleBytes`)
 * or Android prebuilt (`bytes`) manifest field.
 * @param {Record<string, unknown>} manifest
 * @returns {number|null}
 */
function resolveManifestBundleBytes(manifest) {
    if (typeof manifest.bundleBytes === 'number' && Number.isInteger(manifest.bundleBytes) && manifest.bundleBytes > 0) {
        return manifest.bundleBytes;
    }
    if (typeof manifest.bytes === 'number' && Number.isInteger(manifest.bytes) && manifest.bytes > 0) {
        return manifest.bytes;
    }
    return null;
}

/**
 * Validates a parsed prebuilt lib manifest object (supporting both canonical PR 11 and PR #918 Android schemas).
 * @param {unknown} value Parsed JSON value.
 * @returns {boolean} True when the manifest conforms to schema v1.
 */
export function isValidPrebuiltLibManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const manifest = /** @type {Record<string, unknown>} */ (value);
    const bundleBytes = resolveManifestBundleBytes(manifest);
    if (manifest.schemaVersion !== PREBUILT_LIB_MANIFEST_SCHEMA_VERSION
        || typeof manifest.cacheVersion !== 'string'
        || manifest.cacheVersion.length === 0
        || typeof manifest.inputsHash !== 'string'
        || !SHA256_HEX_RE.test(manifest.inputsHash)
        || typeof manifest.sha256 !== 'string'
        || !SHA256_HEX_RE.test(manifest.sha256)
        || bundleBytes === null) {
        return false;
    }

    if (manifest.file !== undefined && manifest.file !== PREBUILT_LIB_FILENAME) {
        return false;
    }

    // The licence fields are optional (a bundle without extracted notices has none), but a half-written pair is invalid.
    if (manifest.licenseSha256 !== undefined || manifest.licenseBytes !== undefined) {
        if (typeof manifest.licenseSha256 !== 'string'
            || !SHA256_HEX_RE.test(manifest.licenseSha256)
            || typeof manifest.licenseBytes !== 'number'
            || !Number.isInteger(manifest.licenseBytes)
            || manifest.licenseBytes <= 0
            || manifest.licenseBytes > PREBUILT_LIB_MAX_LICENSE_BYTES) {
            return false;
        }
    }

    if (manifest.bundleBytes !== undefined) {
        return typeof manifest.webpackVersion === 'string'
            && manifest.webpackVersion.length > 0
            && manifest.builtWithNode === true;
    }

    // Compatibility with Android prebuilt manifests (`{ schemaVersion: 1, cacheVersion, inputsHash, file, sha256, bytes }`).
    return manifest.builtWithNode === undefined || manifest.builtWithNode === true;
}

/**
 * Reads the version of the installed Webpack from its package.json, without loading Webpack itself.
 * @returns {string|null} Version string, or null when Webpack is not installed.
 */
function getInstalledWebpackVersion() {
    try {
        const { version } = createRequire(import.meta.url)('webpack/package.json');
        return typeof version === 'string' && version ? version : null;
    } catch {
        return null;
    }
}

/**
 * Reads a regular file in full, unless it has more than `maxBytes` bytes. The size comes from the open descriptor,
 * so a file that grows after an earlier lstat cannot make the buffer larger than the limit.
 * @param {string} filePath File to read.
 * @param {number} maxBytes Largest size that is read.
 * @returns {Buffer|null} The content, or null when the file is larger than `maxBytes` or was shorter than its size.
 */
function readRegularFileUpTo(filePath, maxBytes) {
    // O_NOFOLLOW does not exist on Windows; the callers have lstat-checked the path.
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maxBytes) {
            return null;
        }

        const buffer = Buffer.allocUnsafe(stat.size);
        let offset = 0;
        while (offset < buffer.byteLength) {
            const bytesRead = fs.readSync(fd, buffer, offset, buffer.byteLength - offset, offset);
            if (bytesRead === 0) {
                return null;
            }
            offset += bytesRead;
        }
        return buffer;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Reads and validates the manifest of a prebuilt directory, and says why when it is not usable.
 * @param {string} prebuiltDir Directory containing `lib.manifest.json`.
 * @returns {{ manifest: Record<string, any>|null, reason: string|null }} `manifest` is null when nothing usable is offered.
 * `reason` is null when nothing is offered at all (no directory or no manifest), which is the normal state of an install.
 */
function loadPrebuiltPublicLibManifest(prebuiltDir) {
    let directoryStat;
    try {
        directoryStat = fs.lstatSync(prebuiltDir);
    } catch {
        return { manifest: null, reason: null };
    }
    if (directoryStat.isSymbolicLink()) {
        return { manifest: null, reason: 'the prebuilt directory is a symlink' };
    }

    const manifestPath = path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME);
    let stat;
    try {
        stat = fs.lstatSync(manifestPath);
    } catch {
        return { manifest: null, reason: null };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return { manifest: null, reason: 'the manifest is a symlink or not a regular file' };
    }
    if (stat.size > PREBUILT_LIB_MAX_MANIFEST_BYTES) {
        return { manifest: null, reason: `the manifest is above the limit of ${PREBUILT_LIB_MAX_MANIFEST_BYTES} bytes` };
    }

    try {
        const manifestBytes = readRegularFileUpTo(manifestPath, PREBUILT_LIB_MAX_MANIFEST_BYTES);
        if (!manifestBytes) {
            return { manifest: null, reason: `the manifest is above the limit of ${PREBUILT_LIB_MAX_MANIFEST_BYTES} bytes or changed while it was read` };
        }
        const parsed = JSON.parse(manifestBytes.toString('utf8'));
        if (!isValidPrebuiltLibManifest(parsed)) {
            return { manifest: null, reason: 'the manifest does not match schema version 1' };
        }
        if (resolveManifestBundleBytes(parsed) > PREBUILT_LIB_MAX_BUNDLE_BYTES) {
            return { manifest: null, reason: `the manifest claims a bundle above the limit of ${PREBUILT_LIB_MAX_BUNDLE_BYTES} bytes` };
        }
        return {
            manifest: {
                ...parsed,
                bundleBytes: resolveManifestBundleBytes(parsed),
            },
            reason: null,
        };
    } catch {
        return { manifest: null, reason: 'the manifest cannot be read or parsed' };
    }
}

/**
 * Reads and validates `lib.manifest.json` from a prebuilt directory.
 * A prebuilt directory that is itself a symlink offers nothing.
 * @param {string} prebuiltDir Directory containing `lib.manifest.json`.
 * @returns {Record<string, any>|null} Validated manifest object normalized with `bundleBytes`, or null if absent/invalid.
 */
export function readPrebuiltPublicLibManifest(prebuiltDir) {
    return loadPrebuiltPublicLibManifest(prebuiltDir).manifest;
}

/**
 * Writes a file through a temporary name in the same directory and renames it into place.
 * @param {string} targetPath Destination path.
 * @param {Buffer} bytes Content to write.
 */
function writeFileAtomically(targetPath, bytes) {
    const tempName = `.${path.basename(targetPath)}.seed.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tempPath = path.join(path.dirname(targetPath), tempName);

    try {
        // Write the verified bytes to a fresh inode so later rebuilds of dist/lib/lib.js cannot mutate the cache in place.
        fs.writeFileSync(tempPath, bytes);
        fs.renameSync(tempPath, targetPath);
    } catch (error) {
        try {
            fs.rmSync(tempPath, { force: true });
        } catch {
            // Ignore cleanup failure for temp file.
        }
        throw error;
    }
}

/**
 * Seeds `<DATA_ROOT>/_webpack/<cacheVersion>/output/lib.js` from a verified prebuilt `dist/lib/` bundle.
 * Returns `false` whenever a bundle is offered but rejected, after one log line that names the reason, and returns `false`
 * without logging when none is offered. The caller then runs the local Webpack build.
 * A bundle is rejected when its directory or files are symlinks, or when its manifest was made for other inputs
 * (`inputsHash`), another Webpack (`webpackVersion`), another cache version (`cacheVersion`), or does not match the bytes.
 * The manifest's `sha256` only detects corruption: it is written next to the bundle it describes, so it proves no origin.
 * @param {object} options Seeding options.
 * @param {string} [options.cacheVersion] Cache version of the running install, compared with the manifest's.
 * @param {string} [options.inputsHash] Expected portable `inputsHash` for the current repo inputs.
 * @param {string} [options.webpackVersion] Expected Webpack version; defaults to the installed one.
 * @param {boolean} [options.isBun] Whether the running install is Bun; defaults to the current runtime.
 * @param {string} options.outputPath Destination `lib.js` path inside the active Webpack output directory.
 * @param {string} [options.prebuiltDir] Override directory for `lib.js` and `lib.manifest.json`.
 * @returns {boolean} True if a verified prebuilt bundle was atomically seeded to `outputPath`.
 */
export function trySeedPrebuiltPublicLib({
    cacheVersion = undefined,
    inputsHash = undefined,
    webpackVersion = getInstalledWebpackVersion(),
    isBun = isBunRuntime(),
    outputPath,
    prebuiltDir = undefined,
} = {}) {
    if (typeof outputPath !== 'string' || !outputPath) {
        return false;
    }

    /**
     * @param {string} reason Why the offered bundle is not used.
     * @param {boolean} [stale] The bundle is out of date with this install, which is routine after an update, so it logs at debug level.
     * @returns {false}
     */
    const reject = (reason, stale = false) => {
        const message = `Prebuilt frontend library bundle not used (${reason}); falling back to local Webpack build.`;
        if (stale) {
            console.debug(message);
        } else {
            console.warn(message);
        }
        return false;
    };

    const resolvedPrebuiltDir = resolvePrebuiltLibDir({ prebuiltDir });
    const { manifest, reason: manifestReason } = loadPrebuiltPublicLibManifest(resolvedPrebuiltDir);
    if (!manifest) {
        return manifestReason ? reject(manifestReason) : false;
    }

    const expectedInputsHash = typeof inputsHash === 'string' && inputsHash
        ? inputsHash
        : computePublicLibInputsHash();

    if (manifest.inputsHash !== expectedInputsHash) {
        return reject('its inputsHash differs from the inputs of this install', true);
    }

    // The Android manifest variant has no webpackVersion, so there is nothing to compare for it.
    if (manifest.webpackVersion !== undefined && manifest.webpackVersion !== webpackVersion) {
        return reject(`its webpackVersion ${manifest.webpackVersion} differs from the installed Webpack ${webpackVersion}`, true);
    }

    // The bundle is built under Node.js, and the cache version includes the runtime, so under Bun the same install
    // has another cache version and the manifest's can never equal it. The inputsHash and webpackVersion checks stand in there.
    if (!isBun && manifest.cacheVersion !== cacheVersion) {
        return reject(`its cacheVersion ${manifest.cacheVersion} differs from the cacheVersion ${cacheVersion} of this install`, true);
    }

    const sourceBundlePath = path.join(resolvedPrebuiltDir, PREBUILT_LIB_FILENAME);
    let sourceStat;
    try {
        sourceStat = fs.lstatSync(sourceBundlePath);
    } catch {
        return reject(`${PREBUILT_LIB_FILENAME} is missing`);
    }

    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        return reject(`${PREBUILT_LIB_FILENAME} is a symlink or not a regular file`);
    }
    if (sourceStat.size > PREBUILT_LIB_MAX_BUNDLE_BYTES) {
        return reject(`${PREBUILT_LIB_FILENAME} is above the limit of ${PREBUILT_LIB_MAX_BUNDLE_BYTES} bytes`);
    }
    if (sourceStat.size !== manifest.bundleBytes) {
        return reject(`${PREBUILT_LIB_FILENAME} has ${sourceStat.size} bytes, the manifest says ${manifest.bundleBytes}`);
    }

    let verifiedBuffer;
    try {
        verifiedBuffer = readRegularFileUpTo(sourceBundlePath, manifest.bundleBytes);
    } catch (error) {
        return reject(`${PREBUILT_LIB_FILENAME} cannot be read: ${error?.message}`);
    }

    if (!verifiedBuffer || verifiedBuffer.byteLength !== manifest.bundleBytes) {
        return reject(`${PREBUILT_LIB_FILENAME} changed while it was read`);
    }
    if (sha256Hex(verifiedBuffer) !== manifest.sha256) {
        return reject(`${PREBUILT_LIB_FILENAME} fails the sha256 integrity check`);
    }

    // A live Webpack build leaves the notices beside lib.js, so a seeded bundle must carry them too.
    let verifiedLicense = null;
    if (manifest.licenseSha256 !== undefined) {
        const licensePath = path.join(resolvedPrebuiltDir, PREBUILT_LIB_LICENSE_FILENAME);
        try {
            const licenseStat = fs.lstatSync(licensePath);
            if (licenseStat.isSymbolicLink() || !licenseStat.isFile()) {
                return reject(`${PREBUILT_LIB_LICENSE_FILENAME} is a symlink or not a regular file`);
            }
            verifiedLicense = readRegularFileUpTo(licensePath, manifest.licenseBytes);
        } catch (error) {
            return reject(`${PREBUILT_LIB_LICENSE_FILENAME} cannot be read: ${error?.message}`);
        }
        if (!verifiedLicense || verifiedLicense.byteLength !== manifest.licenseBytes || sha256Hex(verifiedLicense) !== manifest.licenseSha256) {
            return reject(`${PREBUILT_LIB_LICENSE_FILENAME} fails the integrity check against the manifest`);
        }
    }

    const outputDir = path.dirname(outputPath);
    try {
        fs.mkdirSync(outputDir, { recursive: true });
        // The licence goes first: webpack-serve treats an existing lib.js as a complete output directory.
        if (verifiedLicense) {
            writeFileAtomically(path.join(outputDir, PREBUILT_LIB_LICENSE_FILENAME), verifiedLicense);
        }
        writeFileAtomically(outputPath, verifiedBuffer);
        if (cacheVersion) {
            console.debug(`Seeded prebuilt frontend library bundle for cache version ${cacheVersion}.`);
        }
        return true;
    } catch (error) {
        return reject(`it could not be written to the cache: ${error?.message}`);
    }
}

/**
 * Compatibility adapter matching the Android APK prebuilt-lib caller shape (`{ cacheInfo, prebuiltDir, expectedInputsHash }`).
 * Delegates to `trySeedPrebuiltPublicLib()` so all runtimes share a single verified seeding implementation.
 * @param {object} options
 * @param {{ cacheVersion?: string, outputDirectory: string, outputFile: string }} options.cacheInfo
 * @param {string} [options.prebuiltDir]
 * @param {string} [options.expectedInputsHash]
 * @returns {boolean}
 */
export function tryReusePrebuiltPublicLib({ cacheInfo, prebuiltDir = undefined, expectedInputsHash = undefined } = {}) {
    if (!cacheInfo || typeof cacheInfo.outputDirectory !== 'string' || typeof cacheInfo.outputFile !== 'string') {
        return false;
    }

    return trySeedPrebuiltPublicLib({
        cacheVersion: cacheInfo.cacheVersion,
        inputsHash: expectedInputsHash,
        outputPath: path.join(cacheInfo.outputDirectory, cacheInfo.outputFile),
        prebuiltDir,
    });
}
