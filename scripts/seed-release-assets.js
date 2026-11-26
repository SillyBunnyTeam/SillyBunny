#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const DEFAULT_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RELEASE_DOWNLOAD_BASE = 'https://github.com/SillyBunnyTeam/SillyBunny/releases/download';
const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_TAR_BYTES = 128 * 1024 * 1024;
const PREBUILT_LIB_FILENAME = 'lib.js';
const PREBUILT_LIB_MANIFEST_FILENAME = 'lib.manifest.json';
const FRONTEND_MANIFEST_FILE = 'asset-manifest.json';

export const RELEASE_ASSET_TARGETS = Object.freeze([
    {
        key: 'prebuiltLib',
        tarballName: 'sillybunny-prebuilt-lib.tar.gz',
        expectedPrefix: 'dist/lib',
        destRelative: path.join('dist', 'lib'),
        manifestFile: PREBUILT_LIB_MANIFEST_FILENAME,
    },
    {
        key: 'frontendAssets',
        tarballName: 'sillybunny-frontend-assets.tar.gz',
        expectedPrefix: 'dist/frontend',
        destRelative: path.join('dist', 'frontend'),
        manifestFile: FRONTEND_MANIFEST_FILE,
    },
]);

let prebuiltLibHelpersPromise = null;
let frontendAssetHelpersPromise = null;

async function loadPrebuiltLibHelpers() {
    if (!prebuiltLibHelpersPromise) {
        prebuiltLibHelpersPromise = import('../src/prebuilt-lib.js')
            .then((mod) => (
                mod
                && typeof mod.computePublicLibInputsHash === 'function'
                && typeof mod.readPrebuiltPublicLibManifest === 'function'
                    ? mod
                    : null
            ))
            .catch(() => null);
    }
    return prebuiltLibHelpersPromise;
}

async function loadFrontendAssetHelpers() {
    if (!frontendAssetHelpersPromise) {
        frontendAssetHelpersPromise = import('../src/frontend-assets.js')
            .then((mod) => (
                mod && typeof mod.computeFrontendInputsHash === 'function'
                    ? mod
                    : null
            ))
            .catch(() => null);
    }
    return frontendAssetHelpersPromise;
}

function isTruthy(value) {
    return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function isAllowedReleaseBaseUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }

    if (parsed.protocol === 'https:') {
        return true;
    }

    if (parsed.protocol === 'http:') {
        const host = parsed.hostname.toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    }

    return false;
}

/**
 * Parses a GitHub release `SHA256SUMS` text file into a map of basename -> lowercase SHA-256 hex digest.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseSha256Sums(text) {
    const map = new Map();
    if (typeof text !== 'string') {
        return map;
    }

    for (const rawLine of text.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const match = trimmed.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
        if (!match) {
            continue;
        }

        const digest = match[1].toLowerCase();
        const fileName = path.posix.basename(match[2].trim().replace(/\\/g, '/'));
        if (fileName) {
            map.set(fileName, digest);
        }
    }

    return map;
}

function validateArchiveEntryPath(rawPath, expectedPrefix) {
    if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0') || rawPath.includes('\\')) {
        throw new Error(`Unsafe tar entry path: ${JSON.stringify(rawPath)}`);
    }

    const stripped = rawPath.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!stripped || stripped.startsWith('/') || /^[A-Za-z]:/.test(stripped)) {
        throw new Error(`Absolute tar entry path rejected: ${rawPath}`);
    }

    const segments = stripped.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Path traversal segment rejected in tar entry: ${rawPath}`);
    }

    const normalizedPrefix = expectedPrefix.replace(/^\/+|\/+$/g, '');
    if (stripped === normalizedPrefix) {
        return '';
    }

    if (!stripped.startsWith(`${normalizedPrefix}/`)) {
        throw new Error(`Tar entry outside expected prefix "${normalizedPrefix}/": ${rawPath}`);
    }

    return stripped.slice(normalizedPrefix.length + 1);
}

/**
 * Safely extracts a POSIX USTAR/PAX `.tar.gz` buffer strictly under `expectedPrefix` into `destDir`.
 * Rejects symlinks, hardlinks, device nodes, absolute paths, path traversal, and paths outside `expectedPrefix`.
 * @param {Buffer} gzBuffer
 * @param {object} options
 * @param {string} options.expectedPrefix Archive prefix such as `dist/frontend` or `dist/lib`
 * @param {string} options.destDir Target destination directory (replaced atomically)
 * @returns {{ fileCount: number, totalBytes: number }}
 */
export function extractSafeTarGz(gzBuffer, { expectedPrefix, destDir }) {
    const tarBuffer = zlib.gunzipSync(gzBuffer, { maxOutputLength: MAX_EXTRACTED_TAR_BYTES });
    const extractedFiles = [];
    let offset = 0;
    let pendingPaxPath = null;
    let totalBytes = 0;

    while (offset + 512 <= tarBuffer.length) {
        const header = tarBuffer.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            break;
        }

        const magic = header.subarray(257, 262).toString('ascii');
        if (magic !== 'ustar') {
            throw new Error(`Unsupported tar header magic: ${JSON.stringify(magic)}`);
        }

        const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const typeflag = header.subarray(156, 157).toString('ascii');
        const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
        const size = Number.parseInt(sizeOctal || '0', 8);

        if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tarBuffer.length) {
            throw new Error(`Invalid tar entry size for "${rawName}".`);
        }

        const dataStart = offset + 512;
        const data = tarBuffer.subarray(dataStart, dataStart + size);

        if (typeflag === 'x') {
            const paxText = data.toString('utf8');
            const pathMatch = paxText.match(/^\d+ path=([^\n]+)\n/m);
            pendingPaxPath = pathMatch ? pathMatch[1] : null;
        } else if (typeflag === '5') {
            const fullName = pendingPaxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
            pendingPaxPath = null;
            validateArchiveEntryPath(fullName, expectedPrefix);
        } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
            const fullName = pendingPaxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
            pendingPaxPath = null;
            const relPosix = validateArchiveEntryPath(fullName, expectedPrefix);
            if (!relPosix) {
                throw new Error(`Tar file entry cannot overwrite root prefix: ${fullName}`);
            }
            totalBytes += data.length;
            if (totalBytes > MAX_EXTRACTED_TAR_BYTES) {
                throw new Error('Tar archive exceeded maximum allowed extracted size.');
            }
            extractedFiles.push({ relPosix, data: Buffer.from(data) });
        } else {
            throw new Error(`Unsupported tar entry type "${typeflag}" for "${rawName}".`);
        }

        const paddedSize = Math.ceil(size / 512) * 512;
        offset = dataStart + paddedSize;
    }

    if (extractedFiles.length === 0) {
        throw new Error(`Tar archive contained no regular files under ${expectedPrefix}/`);
    }

    const parentDir = path.dirname(destDir);
    fs.mkdirSync(parentDir, { recursive: true });
    const tempDir = path.join(parentDir, `.${path.basename(destDir)}.seed-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    const backupDir = path.join(parentDir, `.${path.basename(destDir)}.prev-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);

    try {
        fs.mkdirSync(tempDir, { recursive: true });
        for (const file of extractedFiles) {
            const targetPath = path.join(tempDir, ...file.relPosix.split('/'));
            const resolvedTarget = path.resolve(targetPath);
            if (!resolvedTarget.startsWith(`${path.resolve(tempDir)}${path.sep}`)) {
                throw new Error(`Resolved extraction path escaped staging directory: ${file.relPosix}`);
            }
            fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
            fs.writeFileSync(resolvedTarget, file.data);
        }

        const hadExisting = fs.existsSync(destDir);
        if (hadExisting) {
            fs.renameSync(destDir, backupDir);
        }
        try {
            fs.renameSync(tempDir, destDir);
        } catch (renameError) {
            if (hadExisting && fs.existsSync(backupDir) && !fs.existsSync(destDir)) {
                try {
                    fs.renameSync(backupDir, destDir);
                } catch {
                    // Best-effort rollback.
                }
            }
            throw renameError;
        }
        if (hadExisting) {
            fs.rmSync(backupDir, { recursive: true, force: true });
        }

        return { fileCount: extractedFiles.length, totalBytes };
    } catch (error) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Resolves an exact release tag matching `HEAD` (`vX.Y.Z`), or empty string when `HEAD` is untagged.
 * @param {string} repoDir
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveExactReleaseTag(repoDir = DEFAULT_REPO_DIR, env = process.env) {
    const result = spawnSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
        cwd: repoDir,
        env,
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        return '';
    }
    const tag = String(result.stdout || '').split(/\r?\n/, 1)[0].trim();
    return RELEASE_TAG_RE.test(tag) ? tag : '';
}

function readHeadSha(repoDir, env) {
    try {
        const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: repoDir,
            env,
            encoding: 'utf8',
            windowsHide: true,
        });
        return headResult.status === 0 ? String(headResult.stdout || '').trim() : '';
    } catch {
        return '';
    }
}

function isRegularFile(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        return !stat.isSymbolicLink() && stat.isFile();
    } catch {
        return false;
    }
}

function hasMatchingHeadStamp(repoDir, currentHeadSha) {
    if (!currentHeadSha) {
        return true;
    }
    try {
        const stamped = fs.readFileSync(path.join(repoDir, 'dist', '.release-assets-head'), 'utf8').trim();
        return stamped === currentHeadSha;
    } catch {
        return false;
    }
}

async function isTargetAlreadyFresh(target, repoDir, { currentHeadSha = '' } = {}) {
    const destDir = path.join(repoDir, target.destRelative);
    const manifestPath = path.join(destDir, target.manifestFile);
    if (!isRegularFile(manifestPath)) {
        return false;
    }

    if (target.key === 'prebuiltLib') {
        const prebuiltLib = await loadPrebuiltLibHelpers();
        if (prebuiltLib) {
            const manifest = prebuiltLib.readPrebuiltPublicLibManifest(destDir);
            if (!manifest) {
                return false;
            }
            return manifest.inputsHash === prebuiltLib.computePublicLibInputsHash({ rootDir: repoDir });
        }

        if (!isRegularFile(path.join(destDir, PREBUILT_LIB_FILENAME)) || !hasMatchingHeadStamp(repoDir, currentHeadSha)) {
            return false;
        }
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            return Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
        } catch {
            return false;
        }
    }

    if (target.key === 'frontendAssets') {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                return false;
            }
            const frontendAssets = await loadFrontendAssetHelpers();
            if (frontendAssets) {
                if (typeof manifest.inputsHash !== 'string') {
                    return false;
                }
                return manifest.inputsHash === frontendAssets.computeFrontendInputsHash({
                    repoRoot: repoDir,
                    publicRoot: path.join(repoDir, 'public'),
                });
            }
            return hasMatchingHeadStamp(repoDir, currentHeadSha);
        } catch {
            return false;
        }
    }

    return false;
}

async function fetchBufferWithLimit(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('Global fetch is unavailable in this runtime.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'SillyBunny-Release-Asset-Seeder' },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching ${url}`);
        }

        const contentLength = Number(response.headers?.get?.('content-length') || 0);
        if (contentLength > maxBytes) {
            throw new Error(`Response exceeded maximum allowed size (${contentLength} > ${maxBytes}).`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > maxBytes) {
            throw new Error(`Downloaded payload exceeded maximum allowed size (${buffer.length} > ${maxBytes}).`);
        }
        return buffer;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Seeds `dist/lib/` and `dist/frontend/` from verified GitHub Release tarballs when `HEAD` matches a release tag.
 * @param {object} [options]
 * @param {boolean} [options.optional=false]
 * @param {string} [options.repoDir=DEFAULT_REPO_DIR]
 * @param {string} [options.tag]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_MS]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {(msg: string) => void} [options.stdout]
 * @param {(msg: string) => void} [options.stderr]
 * @returns {Promise<{ ok: boolean, seeded: string[], skipped: string[] }>}
 */
export async function seedReleaseAssets({
    optional = false,
    repoDir = DEFAULT_REPO_DIR,
    tag = '',
    baseUrl = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout = msg => console.log(msg),
    stderr = msg => console.error(msg),
} = {}) {
    if (isTruthy(env?.SILLYBUNNY_SKIP_RELEASE_ASSETS)) {
        return { ok: true, seeded: [], skipped: ['disabled'] };
    }

    const resolvedTag = String(tag || env?.SILLYBUNNY_RELEASE_TAG || '').trim() || resolveExactReleaseTag(repoDir, env);
    if (!resolvedTag || !RELEASE_TAG_RE.test(resolvedTag)) {
        return { ok: true, seeded: [], skipped: ['untagged'] };
    }

    const currentHeadSha = readHeadSha(repoDir, env);

    const writeReleaseAssetsStamp = () => {
        try {
            if (currentHeadSha) {
                const distDir = path.join(repoDir, 'dist');
                fs.mkdirSync(distDir, { recursive: true });
                fs.writeFileSync(path.join(distDir, '.release-assets-head'), `${currentHeadSha}\n`, 'utf8');
            }
        } catch {
            // Best-effort stamp only.
        }
    };

    const missingTargets = [];
    for (const target of RELEASE_ASSET_TARGETS) {
        if (!await isTargetAlreadyFresh(target, repoDir, { currentHeadSha })) {
            missingTargets.push(target);
        }
    }
    if (missingTargets.length === 0) {
        writeReleaseAssetsStamp();
        return { ok: true, seeded: [], skipped: ['already-fresh'] };
    }

    const effectiveBaseUrl = String(baseUrl || env?.SILLYBUNNY_RELEASE_ASSET_BASE_URL || DEFAULT_RELEASE_DOWNLOAD_BASE).replace(/\/+$/, '');
    if (!isAllowedReleaseBaseUrl(effectiveBaseUrl)) {
        const message = `Refusing insecure release asset base URL: ${effectiveBaseUrl}`;
        stderr(optional ? `Skipping release asset seed: ${message}` : message);
        return { ok: optional, seeded: [], skipped: ['invalid-base-url'] };
    }

    const seeded = [];
    const skipped = [];

    try {
        const sumsUrl = `${effectiveBaseUrl}/${encodeURIComponent(resolvedTag)}/SHA256SUMS`;
        const sumsBuffer = await fetchBufferWithLimit(sumsUrl, { timeoutMs, maxBytes: 1024 * 1024, fetchImpl });
        const checksums = parseSha256Sums(sumsBuffer.toString('utf8'));

        for (const target of missingTargets) {
            const expectedSha = checksums.get(target.tarballName);
            if (!expectedSha || !SHA256_HEX_RE.test(expectedSha)) {
                skipped.push(`${target.key}:missing-checksum`);
                continue;
            }

            const tarballUrl = `${effectiveBaseUrl}/${encodeURIComponent(resolvedTag)}/${target.tarballName}`;
            const gzBuffer = await fetchBufferWithLimit(tarballUrl, { timeoutMs, maxBytes: MAX_DOWNLOAD_BYTES, fetchImpl });
            const actualSha = crypto.createHash('sha256').update(gzBuffer).digest('hex');
            if (actualSha !== expectedSha) {
                throw new Error(`SHA-256 mismatch for ${target.tarballName} (${actualSha} !== ${expectedSha}).`);
            }

            const destDir = path.join(repoDir, target.destRelative);
            extractSafeTarGz(gzBuffer, {
                expectedPrefix: target.expectedPrefix,
                destDir,
            });

            if (target.key === 'frontendAssets') {
                const frontendAssets = await loadFrontendAssetHelpers();
                if (frontendAssets && typeof frontendAssets.writeFrontendInputsStamp === 'function') {
                    const manifestPath = path.join(destDir, target.manifestFile);
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    const expectedHash = frontendAssets.computeFrontendInputsHash({
                        repoRoot: repoDir,
                        publicRoot: path.join(repoDir, 'public'),
                    });
                    if (manifest?.inputsHash === expectedHash) {
                        frontendAssets.writeFrontendInputsStamp(expectedHash, {
                            distRoot: destDir,
                            repoRoot: repoDir,
                            publicRoot: path.join(repoDir, 'public'),
                        });
                    }
                }
            }

            seeded.push(target.key);
            stdout(`Seeded release asset ${target.tarballName} (${resolvedTag}).`);
        }

        const seededSet = new Set(seeded);
        let allFresh = true;
        for (const target of RELEASE_ASSET_TARGETS) {
            const checkHeadSha = seededSet.has(target.key) ? '' : currentHeadSha;
            if (!await isTargetAlreadyFresh(target, repoDir, { currentHeadSha: checkHeadSha })) {
                allFresh = false;
                break;
            }
        }
        if (allFresh) {
            writeReleaseAssetsStamp();
        }

        return { ok: true, seeded, skipped };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (optional) {
            stderr(`Skipping release asset seed (${resolvedTag}): ${reason}`);
            return { ok: true, seeded, skipped: [...skipped, 'error'] };
        }
        stderr(`Failed to seed release assets (${resolvedTag}): ${reason}`);
        return { ok: false, seeded, skipped: [...skipped, 'error'] };
    }
}

export function parseSeedReleaseAssetsArgs(argv) {
    let optional = false;
    let repoDir = DEFAULT_REPO_DIR;
    let tag = '';
    let baseUrl = '';

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (/^--?optional$/i.test(arg)) {
            optional = true;
            continue;
        }
        if (arg === '--repo' && i + 1 < argv.length) {
            repoDir = path.resolve(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg.startsWith('--repo=')) {
            repoDir = path.resolve(arg.slice('--repo='.length));
            continue;
        }
        if (arg === '--tag' && i + 1 < argv.length) {
            tag = argv[i + 1];
            i += 1;
            continue;
        }
        if (arg.startsWith('--tag=')) {
            tag = arg.slice('--tag='.length);
            continue;
        }
        if (arg === '--base-url' && i + 1 < argv.length) {
            baseUrl = argv[i + 1];
            i += 1;
            continue;
        }
        if (arg.startsWith('--base-url=')) {
            baseUrl = arg.slice('--base-url='.length);
        }
    }

    return { optional, repoDir, tag, baseUrl };
}

function resolveCanonicalPath(targetPath) {
    const resolved = path.resolve(targetPath);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

const scriptPath = resolveCanonicalPath(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolveCanonicalPath(process.argv[1]) : '';
if (invokedPath && (invokedPath === scriptPath || invokedPath.toLowerCase() === scriptPath.toLowerCase())) {
    seedReleaseAssets(parseSeedReleaseAssetsArgs(process.argv.slice(2)))
        .then((result) => {
            if (!result.ok) {
                process.exitCode = 1;
            }
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
