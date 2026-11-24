#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';

export const MANIFEST_FILENAME = 'node_modules.manifest.json';
export const DEFAULT_ARCHIVE_GZ = 'node_modules.tar.gz';
export const DEFAULT_ARCHIVE_ZST = 'node_modules.tar.zst';

export const DUP_ORT_WASMS = Object.freeze([
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd.wasm',
    'ort-wasm-threaded.wasm',
    'ort-wasm.wasm',
]);

const REMOVABLE_PACKAGE_DIRS = new Set(['docs', 'test', 'tests', '__tests__']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_ARCHIVE_NAME_RE = /^node_modules\.tar\.(?:gz|zst)$/;
const MODULE_VERSION_RE = /^[1-9][0-9]*$/;
const TAR_BLOCK_SIZE = 512;

export class BundleError extends Error {
    /**
     * @param {string} code Stable machine-readable error code.
     * @param {string} message Human-readable reason.
     */
    constructor(code, message) {
        super(message);
        this.name = 'BundleError';
        this.code = code;
    }
}

/**
 * Computes the SHA-256 hex digest and byte length of a regular non-symlink file.
 * @param {string} filePath File path.
 * @returns {{ sha256: string, bytes: number }}
 */
export function sha256File(filePath) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch {
        throw new BundleError('file-missing', `File does not exist: ${filePath}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new BundleError('not-regular-file', `Expected a regular file: ${filePath}`);
    }
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(65536);
    let total = 0;
    try {
        while (true) {
            const read = fs.readSync(fd, buf, 0, buf.length, null);
            if (read <= 0) {
                break;
            }
            hash.update(buf.subarray(0, read));
            total += read;
        }
    } finally {
        fs.closeSync(fd);
    }
    return { sha256: hash.digest('hex'), bytes: total };
}

function hasPackageJson(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return true;
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            continue;
        }
        if (entry.name === 'package.json') {
            return true;
        }
        if (entry.isDirectory() && hasPackageJson(path.join(dir, entry.name))) {
            return true;
        }
    }
    return false;
}

/**
 * Applies the exact zero-feature-loss Android node_modules prune in place:
 * - Keeps `sillytavern-transformers` and its 4 active WASMs intact (Locked Decision #1B).
 * - Removes duplicate ORT WASMs from `onnxruntime-web/dist` only when all 4 active WASMs are present.
 * - Keeps every `package.json` and any `docs`/`test`/`tests`/`__tests__` subtree holding one.
 * - Strips `.map` and `.d.{ts,mts,cts}` files.
 * @param {string} nodeModulesDir Path to `node_modules`.
 * @returns {{ removedFiles: number, removedDirs: number, removedDuplicateWasms: number }}
 */
export function pruneAndroidNodeModules(nodeModulesDir) {
    let removedFiles = 0;
    let removedDirs = 0;
    let removedDuplicateWasms = 0;

    const pruneDir = (dir, atPackageRoot) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') {
                    walkNodeModules(full);
                    continue;
                }
                if (atPackageRoot && REMOVABLE_PACKAGE_DIRS.has(entry.name) && !hasPackageJson(full)) {
                    fs.rmSync(full, { recursive: true, force: true });
                    removedDirs += 1;
                    continue;
                }
                pruneDir(full, false);
            } else if (entry.isFile()) {
                if (entry.name === 'package.json') {
                    continue;
                }
                if (entry.name.endsWith('.map') || /\.d\.(?:ts|mts|cts)$/.test(entry.name)) {
                    fs.unlinkSync(full);
                    removedFiles += 1;
                }
            }
        }
    };

    const walkNodeModules = (root) => {
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }
            const full = path.join(root, entry.name);
            if (entry.name.startsWith('@')) {
                let scoped;
                try {
                    scoped = fs.readdirSync(full, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const pkg of scoped) {
                    if (!pkg.isSymbolicLink() && pkg.isDirectory()) {
                        pruneDir(path.join(full, pkg.name), true);
                    }
                }
            } else {
                pruneDir(full, true);
            }
        }
    };

    walkNodeModules(nodeModulesDir);

    const transformersDist = path.join(nodeModulesDir, 'sillytavern-transformers', 'dist');
    const ortDist = path.join(nodeModulesDir, 'onnxruntime-web', 'dist');
    const activeWasmsPresent = DUP_ORT_WASMS.every((name) => {
        try {
            const st = fs.lstatSync(path.join(transformersDist, name));
            return !st.isSymbolicLink() && st.isFile() && st.size > 0;
        } catch {
            return false;
        }
    });

    if (activeWasmsPresent) {
        for (const name of DUP_ORT_WASMS) {
            const dup = path.join(ortDist, name);
            try {
                const st = fs.lstatSync(dup);
                if (!st.isSymbolicLink() && st.isFile()) {
                    fs.unlinkSync(dup);
                    removedDuplicateWasms += 1;
                }
            } catch {
                // Already absent.
            }
        }
    }

    return { removedFiles, removedDirs, removedDuplicateWasms };
}

function writeOctalField(header, offset, length, value) {
    const str = value.toString(8).padStart(length - 1, '0');
    header.write(str, offset, length - 1, 'ascii');
    header[offset + length - 1] = 0;
}

function buildPaxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    let len = Buffer.byteLength(body, 'utf8') + 3;
    while (true) {
        const candidate = `${len}${body}`;
        const actual = Buffer.byteLength(candidate, 'utf8');
        if (actual === len) {
            return Buffer.from(candidate, 'utf8');
        }
        len = actual;
    }
}

function buildTarHeader({ name, mode, size, typeflag, linkname = '' }) {
    const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
    header.write(name.slice(0, 100), 0, 100, 'utf8');
    writeOctalField(header, 100, 8, mode);
    writeOctalField(header, 108, 8, 0);
    writeOctalField(header, 116, 8, 0);
    writeOctalField(header, 124, 12, size);
    writeOctalField(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(typeflag, 156, 1, 'ascii');
    if (linkname) {
        header.write(linkname.slice(0, 100), 157, 100, 'utf8');
    }
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
        sum += header[i];
    }
    const chk = sum.toString(8).padStart(6, '0');
    header.write(chk, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function padTarPayload(payload) {
    const rem = payload.length % TAR_BLOCK_SIZE;
    if (rem === 0) {
        return payload;
    }
    return Buffer.concat([payload, Buffer.alloc(TAR_BLOCK_SIZE - rem, 0)]);
}

function validateRelativeArchivePath(relPath) {
    if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) {
        throw new BundleError('unsafe-archive-path', `Unsafe archive entry path: ${relPath}`);
    }
    const segments = relPath.split('/');
    for (const seg of segments) {
        if (!seg || seg === '.' || seg === '..') {
            throw new BundleError('unsafe-archive-path', `Unsafe path segment in archive: ${relPath}`);
        }
    }
}

/**
 * Creates a byte-deterministic POSIX PAX/USTAR tar buffer of `rootDir`'s contents.
 * @param {string} rootDir Directory whose entries become root-relative tar entries.
 * @returns {Buffer}
 */
export function createDeterministicTar(rootDir) {
    const resolvedRoot = fs.realpathSync(rootDir);
    const chunks = [];

    const visit = (currentDir, relPrefix) => {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            validateRelativeArchivePath(relPath);
            const stat = fs.lstatSync(fullPath);

            const paxRecords = [];
            const archiveName = stat.isDirectory() ? `${relPath}/` : relPath;
            if (Buffer.byteLength(archiveName, 'utf8') > 99) {
                paxRecords.push(buildPaxRecord('path', archiveName));
            }

            if (stat.isSymbolicLink()) {
                const rawLink = fs.readlinkSync(fullPath);
                const normalizedLink = rawLink.split(path.sep).join('/');
                if (path.posix.isAbsolute(normalizedLink)) {
                    throw new BundleError('unsafe-symlink', `Refusing absolute symlink in bundle: ${relPath} -> ${rawLink}`);
                }
                const targetResolved = path.resolve(path.dirname(fullPath), rawLink);
                const relativeToRoot = path.relative(resolvedRoot, targetResolved);
                if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
                    throw new BundleError('unsafe-symlink', `Refusing symlink escaping node_modules: ${relPath} -> ${rawLink}`);
                }
                if (Buffer.byteLength(normalizedLink, 'utf8') > 99) {
                    paxRecords.push(buildPaxRecord('linkpath', normalizedLink));
                }
                if (paxRecords.length > 0) {
                    const paxPayload = Buffer.concat(paxRecords);
                    chunks.push(buildTarHeader({ name: 'PaxHeader/entry', mode: 0o644, size: paxPayload.length, typeflag: 'x' }));
                    chunks.push(padTarPayload(paxPayload));
                }
                chunks.push(buildTarHeader({
                    name: archiveName.slice(0, 99),
                    mode: 0o777,
                    size: 0,
                    typeflag: '2',
                    linkname: normalizedLink.slice(0, 99),
                }));
            } else if (stat.isDirectory()) {
                if (paxRecords.length > 0) {
                    const paxPayload = Buffer.concat(paxRecords);
                    chunks.push(buildTarHeader({ name: 'PaxHeader/entry', mode: 0o644, size: paxPayload.length, typeflag: 'x' }));
                    chunks.push(padTarPayload(paxPayload));
                }
                chunks.push(buildTarHeader({
                    name: archiveName.slice(0, 99),
                    mode: 0o755,
                    size: 0,
                    typeflag: '5',
                }));
                visit(fullPath, relPath);
            } else if (stat.isFile()) {
                const content = fs.readFileSync(fullPath);
                const executable = (stat.mode & 0o111) !== 0;
                const mode = executable ? 0o755 : 0o644;
                if (paxRecords.length > 0) {
                    const paxPayload = Buffer.concat(paxRecords);
                    chunks.push(buildTarHeader({ name: 'PaxHeader/entry', mode: 0o644, size: paxPayload.length, typeflag: 'x' }));
                    chunks.push(padTarPayload(paxPayload));
                }
                chunks.push(buildTarHeader({
                    name: archiveName.slice(0, 99),
                    mode,
                    size: content.length,
                    typeflag: '0',
                }));
                if (content.length > 0) {
                    chunks.push(padTarPayload(content));
                }
            } else {
                throw new BundleError('unsupported-entry-type', `Unsupported filesystem entry in node_modules: ${relPath}`);
            }
        }
    };

    visit(resolvedRoot, '');
    chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
    return Buffer.concat(chunks);
}

function readTarString(buf, offset, length) {
    let end = offset;
    const limit = offset + length;
    while (end < limit && buf[end] !== 0) {
        end += 1;
    }
    return buf.subarray(offset, end).toString('utf8');
}

function readTarOctal(buf, offset, length) {
    const raw = readTarString(buf, offset, length).trim();
    if (!raw) {
        return 0;
    }
    const parsed = Number.parseInt(raw, 8);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new BundleError('corrupt-tar-header', `Invalid octal field in tar header: ${JSON.stringify(raw)}`);
    }
    return parsed;
}

function parsePaxPayload(payload) {
    const attrs = {};
    let pos = 0;
    const text = payload.toString('utf8');
    while (pos < text.length) {
        const spaceIdx = text.indexOf(' ', pos);
        if (spaceIdx === -1) {
            break;
        }
        const recordByteLen = Number.parseInt(text.slice(pos, spaceIdx), 10);
        if (!Number.isFinite(recordByteLen) || recordByteLen <= 0) {
            throw new BundleError('corrupt-pax-header', 'Malformed PAX extended header length');
        }
        const sliceBuf = payload.subarray(
            Buffer.byteLength(text.slice(0, pos), 'utf8'),
            Buffer.byteLength(text.slice(0, pos), 'utf8') + recordByteLen,
        ).toString('utf8');
        const body = sliceBuf.slice(sliceBuf.indexOf(' ') + 1).replace(/\n$/, '');
        const eqIdx = body.indexOf('=');
        if (eqIdx > 0) {
            attrs[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
        }
        pos += sliceBuf.length;
    }
    return attrs;
}

/**
 * Safely extracts a tar buffer into an empty `destDir`, refusing path traversal, escaping symlinks, and special files.
 * @param {Buffer} tarBuffer Decompressed tar stream bytes.
 * @param {string} destDir Destination directory.
 */
export function extractSafeTar(tarBuffer, destDir) {
    if (tarBuffer.length < TAR_BLOCK_SIZE || tarBuffer.length % TAR_BLOCK_SIZE !== 0) {
        throw new BundleError('corrupt-tar-size', 'Tar archive is truncated or misaligned');
    }
    fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
    const resolvedDest = fs.realpathSync(destDir);

    let offset = 0;
    let pendingPax = {};
    let pendingLongName = null;
    let pendingLongLink = null;
    const pendingSymlinks = [];

    while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
        const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
        offset += TAR_BLOCK_SIZE;

        let allZero = true;
        for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
            if (header[i] !== 0) {
                allZero = false;
                break;
            }
        }
        if (allZero) {
            continue;
        }

        let expectedSum = 0;
        for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
            expectedSum += (i >= 148 && i < 156) ? 0x20 : header[i];
        }
        const headerSum = readTarOctal(header, 148, 8);
        if (headerSum !== expectedSum) {
            throw new BundleError('corrupt-tar-checksum', 'Tar header checksum mismatch');
        }

        const size = pendingPax.size !== undefined ? Number.parseInt(pendingPax.size, 10) : readTarOctal(header, 124, 12);
        const mode = readTarOctal(header, 100, 8);
        const typeChar = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const payloadEnd = offset + size;
        const paddedBlocks = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
        if (offset + paddedBlocks > tarBuffer.length) {
            throw new BundleError('corrupt-tar-truncated', 'Tar entry payload extends past archive end');
        }
        const payload = tarBuffer.subarray(offset, payloadEnd);
        offset += paddedBlocks;

        if (typeChar === 'x') {
            pendingPax = { ...pendingPax, ...parsePaxPayload(payload) };
            continue;
        }
        if (typeChar === 'g') {
            continue;
        }
        if (typeChar === 'L') {
            pendingLongName = payload.toString('utf8').replace(/\0+$/, '');
            continue;
        }
        if (typeChar === 'K') {
            pendingLongLink = payload.toString('utf8').replace(/\0+$/, '');
            continue;
        }

        const prefix = readTarString(header, 345, 155);
        const baseName = readTarString(header, 0, 100);
        const ustarName = prefix ? `${prefix}/${baseName}` : baseName;
        const rawEntryPath = (pendingPax.path ?? pendingLongName ?? ustarName).replace(/\/+$/, '');
        const rawLinkName = pendingPax.linkpath ?? pendingLongLink ?? readTarString(header, 157, 100);

        pendingPax = {};
        pendingLongName = null;
        pendingLongLink = null;

        if (!rawEntryPath || rawEntryPath === '.') {
            continue;
        }
        validateRelativeArchivePath(rawEntryPath);

        const targetPath = path.resolve(resolvedDest, ...rawEntryPath.split('/'));
        const relCheck = path.relative(resolvedDest, targetPath);
        if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            throw new BundleError('unsafe-archive-path', `Archive entry escapes destination: ${rawEntryPath}`);
        }

        if (typeChar === '5') {
            fs.mkdirSync(targetPath, { recursive: true, mode: 0o755 });
        } else if (typeChar === '0') {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
            const fileMode = (mode & 0o111) !== 0 ? 0o755 : 0o644;
            fs.writeFileSync(targetPath, payload, { mode: fileMode });
        } else if (typeChar === '2') {
            if (!rawLinkName || rawLinkName.includes('\0') || path.posix.isAbsolute(rawLinkName.replace(/\\/g, '/'))) {
                throw new BundleError('unsafe-symlink', `Unsafe symlink target in archive: ${rawEntryPath} -> ${rawLinkName}`);
            }
            const linkCheck = path.resolve(path.dirname(targetPath), ...rawLinkName.split('/'));
            const linkRel = path.relative(resolvedDest, linkCheck);
            if (!linkRel || linkRel.startsWith('..') || path.isAbsolute(linkRel)) {
                throw new BundleError('unsafe-symlink', `Symlink escapes destination: ${rawEntryPath} -> ${rawLinkName}`);
            }
            pendingSymlinks.push({ targetPath, rawLinkName });
        } else {
            throw new BundleError('unsupported-tar-entry', `Unsupported tar entry type ${JSON.stringify(typeChar)} at ${rawEntryPath}`);
        }
    }

    for (const { targetPath, rawLinkName } of pendingSymlinks) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
        fs.symlinkSync(rawLinkName, targetPath);
    }
}

function compressDeterministicTar(tarBuffer, format) {
    if (format === 'tar.zst') {
        if (typeof zlib.zstdCompressSync !== 'function') {
            throw new BundleError('zstd-unsupported', 'Current Node.js runtime does not expose zlib.zstdCompressSync');
        }
        return zlib.zstdCompressSync(tarBuffer);
    }
    const gz = Buffer.from(zlib.gzipSync(tarBuffer, { level: 9 }));
    if (gz.length >= 10 && gz[0] === 0x1f && gz[1] === 0x8b) {
        // Zero mtime (bytes 4..7) and normalize OS byte (byte 9 = 0xFF unknown) per RFC 1952 for cross-host determinism.
        gz[4] = 0;
        gz[5] = 0;
        gz[6] = 0;
        gz[7] = 0;
        gz[9] = 0xff;
    }
    return gz;
}

function decompressArchive(archiveBytes, archiveFile) {
    try {
        if (archiveFile.endsWith('.tar.zst')) {
            if (typeof zlib.zstdDecompressSync !== 'function') {
                throw new BundleError('zstd-unsupported', 'Current Node.js runtime does not expose zlib.zstdDecompressSync');
            }
            return zlib.zstdDecompressSync(archiveBytes);
        }
        return zlib.gunzipSync(archiveBytes);
    } catch (error) {
        if (error instanceof BundleError) {
            throw error;
        }
        throw new BundleError('corrupt-archive', `Failed to decompress ${archiveFile}: ${error.message}`);
    }
}

function copyTreeWithoutSymlinkFollow(srcDir, dstDir) {
    fs.mkdirSync(dstDir, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(dstDir, entry.name);
        if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(srcPath), dstPath);
        } else if (entry.isDirectory()) {
            copyTreeWithoutSymlinkFollow(srcPath, dstPath);
        } else if (entry.isFile()) {
            const st = fs.lstatSync(srcPath);
            fs.copyFileSync(srcPath, dstPath);
            fs.chmodSync(dstPath, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
        }
    }
}

/**
 * Builds a deterministic pruned Android `node_modules` bundle and `node_modules.manifest.json`.
 * Never mutates the source `nodeModulesDir` unless `inPlacePrune` is explicitly true.
 * @param {object} options Packager options.
 * @param {string} [options.projectDir] Project directory containing `package-lock.json` and `node_modules`.
 * @param {string} [options.nodeModulesDir] Explicit `node_modules` source directory.
 * @param {string} [options.packageLockPath] Explicit `package-lock.json` path.
 * @param {string} options.outputDir Destination directory for archive and manifest.
 * @param {'tar.gz'|'tar.zst'} [options.format='tar.gz'] Archive compression format.
 * @param {string} [options.arch=process.arch] Target Node `process.arch`.
 * @param {string} [options.platform=process.platform] Target Node `process.platform`.
 * @param {string|number} [options.nodeModuleVersion=process.versions.modules] Target Node ABI (`process.versions.modules`).
 * @param {boolean} [options.inPlacePrune=false] Prune `nodeModulesDir` directly instead of staging a copy.
 * @returns {{ manifest: object, archivePath: string, manifestPath: string, pruneStats: object }}
 */
export function buildAndroidNodeModulesBundle({
    projectDir = process.cwd(),
    nodeModulesDir = undefined,
    packageLockPath = undefined,
    outputDir,
    format = 'tar.gz',
    arch = process.arch,
    platform = process.platform,
    nodeModuleVersion = process.versions.modules,
    inPlacePrune = false,
} = {}) {
    if (!outputDir) {
        throw new BundleError('missing-output-dir', 'outputDir is required');
    }
    if (format !== 'tar.gz' && format !== 'tar.zst') {
        throw new BundleError('invalid-format', `Unsupported bundle format: ${format}`);
    }
    const resolvedProject = path.resolve(projectDir);
    const sourceNodeModules = path.resolve(nodeModulesDir ?? path.join(resolvedProject, 'node_modules'));
    const lockPath = path.resolve(packageLockPath ?? path.join(resolvedProject, 'package-lock.json'));
    const normalizedModuleVersion = String(nodeModuleVersion);
    if (!MODULE_VERSION_RE.test(normalizedModuleVersion)) {
        throw new BundleError('invalid-node-module-version', `Invalid nodeModuleVersion: ${normalizedModuleVersion}`);
    }
    if (!arch || typeof arch !== 'string' || !platform || typeof platform !== 'string') {
        throw new BundleError('invalid-target', 'arch and platform must be non-empty strings');
    }

    if (!fs.existsSync(sourceNodeModules) || !fs.statSync(sourceNodeModules).isDirectory()) {
        throw new BundleError('node-modules-missing', `node_modules directory not found: ${sourceNodeModules}`);
    }

    const { sha256: packageLockSha256 } = sha256File(lockPath);
    const resolvedOutput = path.resolve(outputDir);
    fs.mkdirSync(resolvedOutput, { recursive: true, mode: 0o755 });

    let stagingCopy = null;
    let workingNodeModules = sourceNodeModules;
    if (!inPlacePrune) {
        stagingCopy = fs.mkdtempSync(path.join(resolvedOutput, '.nm-pack-work-'));
        workingNodeModules = path.join(stagingCopy, 'node_modules');
        copyTreeWithoutSymlinkFollow(sourceNodeModules, workingNodeModules);
    }

    let pruneStats;
    let compressed;
    try {
        pruneStats = pruneAndroidNodeModules(workingNodeModules);
        const tarBuffer = createDeterministicTar(workingNodeModules);
        compressed = compressDeterministicTar(tarBuffer, format);
    } finally {
        if (stagingCopy) {
            fs.rmSync(stagingCopy, { recursive: true, force: true });
        }
    }

    const archiveFile = format === 'tar.zst' ? DEFAULT_ARCHIVE_ZST : DEFAULT_ARCHIVE_GZ;
    const archiveSha256 = crypto.createHash('sha256').update(compressed).digest('hex');
    const manifest = {
        schemaVersion: 1,
        packageLockSha256,
        nodeModuleVersion: normalizedModuleVersion,
        arch,
        platform,
        archiveFile,
        archiveSha256,
        bytes: compressed.length,
    };

    const archivePath = path.join(resolvedOutput, archiveFile);
    const manifestPath = path.join(resolvedOutput, MANIFEST_FILENAME);
    const tmpSuffix = `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(`${archivePath}${tmpSuffix}`, compressed, { mode: 0o644 });
    fs.renameSync(`${archivePath}${tmpSuffix}`, archivePath);
    fs.writeFileSync(`${manifestPath}${tmpSuffix}`, `${JSON.stringify(manifest, null, 4)}\n`, { mode: 0o644 });
    fs.renameSync(`${manifestPath}${tmpSuffix}`, manifestPath);

    return { manifest, archivePath, manifestPath, pruneStats };
}

/**
 * Verifies a staged Android `node_modules` bundle manifest, lockfile hash, runtime ABI/arch/platform, and archive SHA-256.
 * @param {object} options Verification options.
 * @param {string} options.bundleDir Directory containing `node_modules.manifest.json` and the archive.
 * @param {string} [options.packageLockPath] Path to `package-lock.json` to compare against `packageLockSha256`.
 * @param {string|number} [options.expectedNodeModuleVersion] Expected `process.versions.modules`.
 * @param {string} [options.expectedArch] Expected `process.arch`.
 * @param {string} [options.expectedPlatform] Expected `process.platform`.
 * @returns {{ manifest: object, archivePath: string }}
 */
export function verifyAndroidNodeModulesBundle({
    bundleDir,
    packageLockPath = undefined,
    expectedNodeModuleVersion = undefined,
    expectedArch = undefined,
    expectedPlatform = undefined,
} = {}) {
    if (!bundleDir) {
        throw new BundleError('missing-bundle-dir', 'bundleDir is required');
    }
    const resolvedBundleDir = path.resolve(bundleDir);
    let dirStat;
    try {
        dirStat = fs.statSync(resolvedBundleDir);
    } catch {
        throw new BundleError('bundle-dir-missing', `Bundle directory not found: ${resolvedBundleDir}`);
    }
    if (!dirStat.isDirectory()) {
        throw new BundleError('bundle-dir-invalid', `Bundle path is not a directory: ${resolvedBundleDir}`);
    }

    const manifestPath = path.join(resolvedBundleDir, MANIFEST_FILENAME);
    let manifestStat;
    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch {
        throw new BundleError('manifest-missing', `Manifest not found: ${manifestPath}`);
    }
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        throw new BundleError('manifest-invalid', `Manifest must be a regular file: ${manifestPath}`);
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        throw new BundleError('manifest-invalid-json', `Invalid JSON in ${manifestPath}`);
    }

    if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1) {
        throw new BundleError('manifest-schema', `Unsupported manifest schemaVersion: ${manifest?.schemaVersion}`);
    }
    if (typeof manifest.packageLockSha256 !== 'string' || !SHA256_RE.test(manifest.packageLockSha256)) {
        throw new BundleError('manifest-lock-sha', 'Invalid packageLockSha256 in manifest');
    }
    const manifestModuleVer = String(manifest.nodeModuleVersion ?? '');
    if (!MODULE_VERSION_RE.test(manifestModuleVer)) {
        throw new BundleError('manifest-abi', 'Invalid nodeModuleVersion in manifest');
    }
    if (typeof manifest.arch !== 'string' || !manifest.arch) {
        throw new BundleError('manifest-arch', 'Invalid arch in manifest');
    }
    if (typeof manifest.platform !== 'string' || !manifest.platform) {
        throw new BundleError('manifest-platform', 'Invalid platform in manifest');
    }
    if (typeof manifest.archiveFile !== 'string' || !SAFE_ARCHIVE_NAME_RE.test(manifest.archiveFile)) {
        throw new BundleError('manifest-archive-name', `Unsafe archiveFile in manifest: ${manifest.archiveFile}`);
    }
    if (typeof manifest.archiveSha256 !== 'string' || !SHA256_RE.test(manifest.archiveSha256)) {
        throw new BundleError('manifest-archive-sha', 'Invalid archiveSha256 in manifest');
    }
    if (!Number.isInteger(manifest.bytes) || manifest.bytes <= 0) {
        throw new BundleError('manifest-bytes', 'Invalid bytes count in manifest');
    }

    if (packageLockPath !== undefined) {
        const { sha256: actualLockSha } = sha256File(path.resolve(packageLockPath));
        if (actualLockSha !== manifest.packageLockSha256) {
            throw new BundleError('lock-mismatch', `package-lock.json sha256 ${actualLockSha} !== ${manifest.packageLockSha256}`);
        }
    }
    if (expectedNodeModuleVersion !== undefined && String(expectedNodeModuleVersion) !== manifestModuleVer) {
        throw new BundleError('abi-mismatch', `Node ABI ${expectedNodeModuleVersion} !== ${manifestModuleVer}`);
    }
    if (expectedArch !== undefined && expectedArch !== manifest.arch) {
        throw new BundleError('arch-mismatch', `process.arch ${expectedArch} !== ${manifest.arch}`);
    }
    if (expectedPlatform !== undefined && expectedPlatform !== manifest.platform) {
        throw new BundleError('platform-mismatch', `process.platform ${expectedPlatform} !== ${manifest.platform}`);
    }

    const archivePath = path.join(resolvedBundleDir, manifest.archiveFile);
    const { sha256: actualArchiveSha, bytes: actualBytes } = sha256File(archivePath);
    if (actualBytes !== manifest.bytes) {
        throw new BundleError('archive-size-mismatch', `Archive size ${actualBytes} !== ${manifest.bytes}`);
    }
    if (actualArchiveSha !== manifest.archiveSha256) {
        throw new BundleError('archive-sha-mismatch', `Archive sha256 ${actualArchiveSha} !== ${manifest.archiveSha256}`);
    }

    return { manifest, archivePath };
}

/**
 * Verifies a prebuilt Android `node_modules` bundle against the checkout and current Node runtime,
 * extracts into a sibling staging directory, and atomically swaps into `<projectDir>/node_modules`.
 * @param {object} options Install options.
 * @param {string} options.bundleDir Directory containing `node_modules.manifest.json` and archive.
 * @param {string} [options.projectDir=process.cwd()] Checkout directory containing `package-lock.json`.
 * @param {string|number} [options.expectedNodeModuleVersion=process.versions.modules] Runtime ABI.
 * @param {string} [options.expectedArch=process.arch] Runtime architecture.
 * @param {string} [options.expectedPlatform=process.platform] Runtime platform.
 * @returns {{ manifest: object, targetDir: string }}
 */
export function installAndroidNodeModulesBundle({
    bundleDir,
    projectDir = process.cwd(),
    expectedNodeModuleVersion = process.versions.modules,
    expectedArch = process.arch,
    expectedPlatform = process.platform,
} = {}) {
    const resolvedProject = path.resolve(projectDir);
    const packageLockPath = path.join(resolvedProject, 'package-lock.json');
    const { manifest, archivePath } = verifyAndroidNodeModulesBundle({
        bundleDir,
        packageLockPath,
        expectedNodeModuleVersion,
        expectedArch,
        expectedPlatform,
    });

    const archiveBytes = fs.readFileSync(archivePath);
    const actualSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    if (actualSha !== manifest.archiveSha256 || archiveBytes.length !== manifest.bytes) {
        throw new BundleError('archive-sha-mismatch', 'Archive changed during read');
    }

    const tarBuffer = decompressArchive(archiveBytes, manifest.archiveFile);
    const stagingDir = fs.mkdtempSync(path.join(resolvedProject, '.node_modules.staging-'));
    const targetDir = path.join(resolvedProject, 'node_modules');
    let backupDir = null;

    try {
        extractSafeTar(tarBuffer, stagingDir);
        fs.chmodSync(stagingDir, 0o755);

        const extractedEntries = fs.readdirSync(stagingDir);
        if (extractedEntries.length === 0) {
            throw new BundleError('empty-archive', 'Extracted node_modules archive is empty');
        }

        if (fs.existsSync(targetDir)) {
            backupDir = path.join(resolvedProject, `.node_modules.previous-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
            fs.renameSync(targetDir, backupDir);
        }
        fs.renameSync(stagingDir, targetDir);
        if (backupDir) {
            fs.rmSync(backupDir, { recursive: true, force: true });
            backupDir = null;
        }
    } catch (error) {
        if (fs.existsSync(stagingDir)) {
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
        if (backupDir && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
            try {
                fs.renameSync(backupDir, targetDir);
            } catch {
                // Best-effort rollback; caller falls back to npm ci.
            }
        }
        throw error;
    }

    return { manifest, targetDir };
}

function runCli(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            'project-dir': { type: 'string' },
            'node-modules-dir': { type: 'string' },
            'package-lock': { type: 'string' },
            'output-dir': { type: 'string' },
            'bundle-dir': { type: 'string' },
            format: { type: 'string' },
            arch: { type: 'string' },
            platform: { type: 'string' },
            'node-module-version': { type: 'string' },
            verify: { type: 'boolean', default: false },
            install: { type: 'boolean', default: false },
            'check-runtime': { type: 'boolean', default: false },
            'in-place-prune': { type: 'boolean', default: false },
        },
        strict: true,
    });

    if (values.install) {
        const result = installAndroidNodeModulesBundle({
            bundleDir: values['bundle-dir'] ?? values['output-dir'],
            projectDir: values['project-dir'] ?? process.cwd(),
            expectedNodeModuleVersion: values['node-module-version'] ?? process.versions.modules,
            expectedArch: values.arch ?? process.arch,
            expectedPlatform: values.platform ?? process.platform,
        });
        process.stdout.write(`${JSON.stringify({ installed: result.targetDir, archiveSha256: result.manifest.archiveSha256 })}\n`);
        return;
    }

    if (values.verify) {
        const checkRuntime = values['check-runtime'];
        const result = verifyAndroidNodeModulesBundle({
            bundleDir: values['bundle-dir'] ?? values['output-dir'],
            packageLockPath: values['package-lock'],
            expectedNodeModuleVersion: values['node-module-version'] ?? (checkRuntime ? process.versions.modules : undefined),
            expectedArch: values.arch ?? (checkRuntime ? process.arch : undefined),
            expectedPlatform: values.platform ?? (checkRuntime ? process.platform : undefined),
        });
        process.stdout.write(`${JSON.stringify({ verified: result.archivePath, manifest: result.manifest })}\n`);
        return;
    }

    const built = buildAndroidNodeModulesBundle({
        projectDir: values['project-dir'] ?? process.cwd(),
        nodeModulesDir: values['node-modules-dir'],
        packageLockPath: values['package-lock'],
        outputDir: values['output-dir'] ?? values['bundle-dir'],
        format: /** @type {'tar.gz'|'tar.zst'} */ (values.format ?? 'tar.gz'),
        arch: values.arch ?? process.arch,
        platform: values.platform ?? process.platform,
        nodeModuleVersion: values['node-module-version'] ?? process.versions.modules,
        inPlacePrune: values['in-place-prune'],
    });
    process.stdout.write(`${JSON.stringify({ archivePath: built.archivePath, manifestPath: built.manifestPath, manifest: built.manifest })}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    try {
        runCli(process.argv.slice(2));
    } catch (error) {
        const code = error instanceof BundleError ? error.code : 'unexpected-error';
        process.stderr.write(`build-android-node-modules-bundle.mjs failed (${code}): ${error.message}\n`);
        process.exit(1);
    }
}
