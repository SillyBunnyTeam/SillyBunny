import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getPublicLibCacheInfo, getPublicLibInputsSignature } from '../webpack.config.js';
import { serverDirectory } from './server-directory.js';

export const PREBUILT_LIB_MANIFEST_FILENAME = 'lib.manifest.json';
const SHA256_RE = /^[0-9a-f]{64}$/;
const CACHE_VERSION_RE = /^[0-9a-f]{16}$/;

/**
 * Resolves the candidate directory holding a staged prebuilt `lib.js` and `lib.manifest.json`.
 * @param {string} [explicitDir] Optional explicit override directory.
 * @returns {string}
 */
export function resolvePrebuiltLibDir(explicitDir = undefined) {
    const envDir = process.env.SILLYBUNNY_PREBUILT_LIB_DIR?.trim();
    if (explicitDir) {
        return path.resolve(explicitDir);
    }
    if (envDir) {
        return path.resolve(envDir);
    }
    return path.join(serverDirectory, 'dist', 'lib');
}

/**
 * Builds a deterministic `lib.manifest.json` object for a compiled `lib.js` file.
 * @param {object} options Options.
 * @param {string} options.libFilePath Path to compiled `lib.js`.
 * @param {boolean} [options.forceDist=false] Whether cache info uses `dist/_webpack`.
 * @returns {{ schemaVersion: 1, cacheVersion: string, inputsHash: string, file: string, sha256: string, bytes: number }}
 */
export function createPrebuiltLibManifest({ libFilePath, forceDist = false }) {
    const cacheInfo = getPublicLibCacheInfo({ forceDist });
    const inputsHash = getPublicLibInputsSignature();
    const content = fs.readFileSync(libFilePath);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    return {
        schemaVersion: 1,
        cacheVersion: cacheInfo.cacheVersion,
        inputsHash,
        file: cacheInfo.outputFile,
        sha256,
        bytes: content.length,
    };
}

/**
 * Verifies a staged `dist/lib/lib.js` + `dist/lib/lib.manifest.json` against `cacheInfo` and `inputsHash`,
 * and atomically stages it into `<DATA_ROOT>/_webpack/<cacheVersion>/output/lib.js`.
 * Returns `false` on absence or any mismatch so the caller falls back to local Webpack compilation.
 * @param {object} options Options.
 * @param {{ webpackRoot: string, cacheVersion: string, outputDirectory: string, outputFile: string }} options.cacheInfo Resolved Webpack cache info.
 * @param {string} [options.prebuiltDir] Optional explicit prebuilt directory override.
 * @param {string} [options.expectedInputsHash] Optional override for testing.
 * @returns {boolean}
 */
export function tryReusePrebuiltPublicLib({ cacheInfo, prebuiltDir = undefined, expectedInputsHash = undefined }) {
    const candidateDir = resolvePrebuiltLibDir(prebuiltDir);
    const manifestPath = path.join(candidateDir, PREBUILT_LIB_MANIFEST_FILENAME);

    let manifestStat;
    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch {
        return false;
    }
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        console.warn(`Ignoring prebuilt frontend library manifest (not a regular file): ${manifestPath}`);
        return false;
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        console.warn(`Ignoring malformed prebuilt frontend library manifest at ${manifestPath}; falling back to Webpack compile.`);
        return false;
    }

    if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1) {
        console.warn(`Ignoring prebuilt frontend library manifest with unsupported schemaVersion at ${manifestPath}.`);
        return false;
    }

    const hasCacheVersion = typeof manifest.cacheVersion === 'string' && manifest.cacheVersion.length > 0;
    const hasInputsHash = typeof manifest.inputsHash === 'string' && manifest.inputsHash.length > 0;
    if (!hasCacheVersion && !hasInputsHash) {
        console.warn(`Ignoring prebuilt frontend library manifest missing cacheVersion and inputsHash at ${manifestPath}.`);
        return false;
    }
    if (hasCacheVersion && (!CACHE_VERSION_RE.test(manifest.cacheVersion) || manifest.cacheVersion !== cacheInfo.cacheVersion)) {
        console.warn(`Prebuilt frontend library cacheVersion mismatch (${manifest.cacheVersion} !== ${cacheInfo.cacheVersion}); falling back to Webpack compile.`);
        return false;
    }
    const currentInputsHash = expectedInputsHash ?? getPublicLibInputsSignature();
    if (hasInputsHash && (!SHA256_RE.test(manifest.inputsHash) || manifest.inputsHash !== currentInputsHash)) {
        console.warn('Prebuilt frontend library inputsHash mismatch; falling back to Webpack compile.');
        return false;
    }

    const fileName = manifest.file ?? cacheInfo.outputFile;
    if (fileName !== cacheInfo.outputFile || typeof manifest.sha256 !== 'string' || !SHA256_RE.test(manifest.sha256)) {
        console.warn(`Ignoring prebuilt frontend library manifest with invalid file/sha256 at ${manifestPath}.`);
        return false;
    }
    if (manifest.bytes !== undefined && (!Number.isInteger(manifest.bytes) || manifest.bytes <= 0)) {
        console.warn(`Ignoring prebuilt frontend library manifest with invalid byte length at ${manifestPath}.`);
        return false;
    }

    const sourceLibPath = path.join(candidateDir, cacheInfo.outputFile);
    let libStat;
    try {
        libStat = fs.lstatSync(sourceLibPath);
    } catch {
        console.warn(`Prebuilt frontend library bundle missing at ${sourceLibPath}; falling back to Webpack compile.`);
        return false;
    }
    if (libStat.isSymbolicLink() || !libStat.isFile() || libStat.size <= 0) {
        console.warn(`Prebuilt frontend library bundle is invalid at ${sourceLibPath}; falling back to Webpack compile.`);
        return false;
    }
    if (manifest.bytes !== undefined && libStat.size !== manifest.bytes) {
        console.warn(`Prebuilt frontend library size mismatch (${libStat.size} !== ${manifest.bytes}); falling back to Webpack compile.`);
        return false;
    }

    let content;
    try {
        content = fs.readFileSync(sourceLibPath);
    } catch {
        return false;
    }
    if (manifest.bytes !== undefined && content.length !== manifest.bytes) {
        console.warn('Prebuilt frontend library size changed during read; falling back to Webpack compile.');
        return false;
    }
    const actualSha = crypto.createHash('sha256').update(content).digest('hex');
    if (actualSha !== manifest.sha256) {
        console.warn(`Prebuilt frontend library sha256 mismatch (${actualSha} !== ${manifest.sha256}); falling back to Webpack compile.`);
        return false;
    }

    const tempOutputDir = path.join(
        cacheInfo.webpackRoot,
        cacheInfo.cacheVersion,
        `output.prebuilt-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    );
    try {
        fs.mkdirSync(tempOutputDir, { recursive: true });
        fs.writeFileSync(path.join(tempOutputDir, cacheInfo.outputFile), content, { mode: 0o644 });
        fs.rmSync(cacheInfo.outputDirectory, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(cacheInfo.outputDirectory), { recursive: true });
        fs.renameSync(tempOutputDir, cacheInfo.outputDirectory);
        console.log();
        console.log('Reusing staged prebuilt frontend libraries...');
        return true;
    } catch (error) {
        try {
            fs.rmSync(tempOutputDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup before Webpack compile fallback.
        }
        console.warn('Failed to stage prebuilt frontend libraries; falling back to Webpack compile.', error);
        return false;
    }
}
