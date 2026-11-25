import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { unzipSync } from 'fflate';
import yauzl from 'yauzl';

import { setConfigFilePath } from '../src/util.js';
import {
    PREBUILT_LIB_FILENAME,
    PREBUILT_LIB_MANIFEST_FILENAME,
    PREBUILT_LIB_MANIFEST_SCHEMA_VERSION,
    computePublicLibInputsHash,
    sha256Hex,
    trySeedPrebuiltPublicLib,
} from '../src/prebuilt-lib.js';
import {
    buildPrebuiltPublicLib,
    createDeterministicTarGz,
} from '../scripts/build-prebuilt-lib.js';
import {
    DUPLICATE_ORT_WASM_FILES,
    pruneAndroidNodeModules,
} from '../scripts/prune-android-node-modules.js';
import getWebpackServeMiddleware from '../src/middleware/webpack-serve.js';
import { getPublicLibCacheInfo } from '../webpack.config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { clampZipEntryMtime, createBackupArchive } = await import('../src/users.js');

jest.setTimeout(60000);

const tempRoots = [];

function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
}

function writeFiles(rootDir, entries) {
    for (const [relativePosixPath, content] of Object.entries(entries)) {
        const target = path.join(rootDir, ...relativePosixPath.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

function parseTarGz(archiveBuffer) {
    const tar = zlib.gunzipSync(archiveBuffer);
    const entries = new Map();
    let offset = 0;

    while (offset + 512 <= tar.byteLength) {
        const header = tar.subarray(offset, offset + 512);
        const isZeroBlock = header.every(byte => byte === 0);
        if (isZeroBlock) {
            break;
        }

        const nameEnd = header.indexOf(0, 0);
        const name = header.subarray(0, nameEnd >= 0 && nameEnd < 100 ? nameEnd : 100).toString('utf8');
        const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
        const size = parseInt(sizeText, 8);
        offset += 512;

        entries.set(name, Buffer.from(tar.subarray(offset, offset + size)));
        const paddedSize = Math.ceil(size / 512) * 512;
        offset += paddedSize;
    }

    return entries;
}

function inspectZipWithYauzl(buffer) {
    return new Promise((resolve, reject) => {
        const entries = new Map();
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
            if (openError) {
                reject(openError);
                return;
            }
            zipfile.on('error', reject);
            zipfile.on('end', () => resolve(entries));
            zipfile.on('entry', (entry) => {
                zipfile.openReadStream(entry, (streamError, stream) => {
                    if (streamError) {
                        reject(streamError);
                        return;
                    }
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.on('error', reject);
                    stream.on('end', () => {
                        entries.set(entry.fileName, {
                            content: Buffer.concat(chunks),
                            compressionMethod: entry.compressionMethod,
                        });
                        zipfile.readEntry();
                    });
                });
            });
            zipfile.readEntry();
        });
    });
}

afterAll(() => {
    for (const dir of tempRoots) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('prebuilt public lib.js manifest, seeding, and reproducible build', () => {
    const previousDataRoot = global.DATA_ROOT;
    const previousPrebuiltEnv = process.env.SILLYBUNNY_PREBUILT_LIB_DIR;

    afterEach(() => {
        global.DATA_ROOT = previousDataRoot;
        if (previousPrebuiltEnv === undefined) {
            delete process.env.SILLYBUNNY_PREBUILT_LIB_DIR;
        } else {
            process.env.SILLYBUNNY_PREBUILT_LIB_DIR = previousPrebuiltEnv;
        }
    });

    test('computePublicLibInputsHash is portable across CRLF/LF and reacts to input and webpack.config.js changes', () => {
        const rootLf = makeTempDir('sb-inputs-lf-');
        const rootCrlf = makeTempDir('sb-inputs-crlf-');

        writeFiles(rootLf, {
            'public/lib.js': 'export const a = 1;\nexport const b = 2;\n',
            'webpack.config.js': 'export default function getPublicLibConfig() { return {}; }\n',
            'package.json': '{"name":"sillybunny"}\n',
            'package-lock.json': '{"lockfileVersion":3}\n',
            'bun.lock': '{\n  "lockfileVersion": 1\n}\n',
        });
        writeFiles(rootCrlf, {
            'public/lib.js': 'export const a = 1;\r\nexport const b = 2;\r\n',
            'webpack.config.js': 'export default function getPublicLibConfig() { return {}; }\r\n',
            'package.json': '{"name":"sillybunny"}\r\n',
            'package-lock.json': '{"lockfileVersion":3}\r\n',
            'bun.lock': '{\r\n  "lockfileVersion": 1\r\n}\r\n',
        });

        const hashLf = computePublicLibInputsHash({ rootDir: rootLf });
        const hashCrlf = computePublicLibInputsHash({ rootDir: rootCrlf });

        expect(hashLf).toMatch(/^[0-9a-f]{64}$/);
        expect(hashCrlf).toBe(hashLf);

        fs.writeFileSync(path.join(rootLf, 'webpack.config.js'), 'export default function getPublicLibConfig() { return { mode: "production" }; }\n', 'utf8');
        const webpackChangedHash = computePublicLibInputsHash({ rootDir: rootLf });
        expect(webpackChangedHash).not.toBe(hashLf);

        fs.writeFileSync(path.join(rootLf, 'public', 'lib.js'), 'export const a = 2;\n', 'utf8');
        const changedHash = computePublicLibInputsHash({ rootDir: rootLf });
        expect(changedHash).not.toBe(webpackChangedHash);
    });

    test('trySeedPrebuiltPublicLib seeds verified bundle and rejects missing, mismatched, or corrupted artifacts', () => {
        const prebuiltDir = makeTempDir('sb-prebuilt-src-');
        const outputDir = makeTempDir('sb-prebuilt-out-');
        const bundleContent = Buffer.from('export default { ok: true };\n', 'utf8');
        const inputsHash = sha256Hex('inputs-v1');
        const manifest = {
            schemaVersion: PREBUILT_LIB_MANIFEST_SCHEMA_VERSION,
            cacheVersion: '0123456789abcdef',
            inputsHash,
            sha256: sha256Hex(bundleContent),
            webpackVersion: '5.105.4',
            bundleBytes: bundleContent.byteLength,
            builtWithNode: true,
        };

        // 1. Missing manifest -> returns false cleanly.
        const missingTarget = path.join(outputDir, 'missing', 'lib.js');
        expect(trySeedPrebuiltPublicLib({
            cacheVersion: manifest.cacheVersion,
            inputsHash,
            outputPath: missingTarget,
            prebuiltDir,
        })).toBe(false);
        expect(fs.existsSync(missingTarget)).toBe(false);

        // 2. Write valid prebuilt bundle + manifest -> seeds atomically.
        fs.writeFileSync(path.join(prebuiltDir, PREBUILT_LIB_FILENAME), bundleContent);
        fs.writeFileSync(path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME), JSON.stringify(manifest));

        const validTarget = path.join(outputDir, 'valid', 'lib.js');
        expect(trySeedPrebuiltPublicLib({
            cacheVersion: manifest.cacheVersion,
            inputsHash,
            outputPath: validTarget,
            prebuiltDir,
        })).toBe(true);
        expect(fs.readFileSync(validTarget)).toEqual(bundleContent);
        expect(fs.readdirSync(path.dirname(validTarget))).toEqual(['lib.js']);

        // 3. inputsHash mismatch -> returns false and does not write output.
        const staleTarget = path.join(outputDir, 'stale', 'lib.js');
        expect(trySeedPrebuiltPublicLib({
            cacheVersion: manifest.cacheVersion,
            inputsHash: sha256Hex('inputs-v2'),
            outputPath: staleTarget,
            prebuiltDir,
        })).toBe(false);
        expect(fs.existsSync(staleTarget)).toBe(false);

        // 4. Same-length corrupted lib.js -> sha256 check fails before writing output or creating outputDir.
        const corruptedContent = Buffer.from('export default { ok: false};\n', 'utf8');
        expect(corruptedContent.byteLength).toBe(bundleContent.byteLength);
        fs.writeFileSync(path.join(prebuiltDir, PREBUILT_LIB_FILENAME), corruptedContent);

        const corruptTarget = path.join(outputDir, 'corrupt', 'lib.js');
        expect(trySeedPrebuiltPublicLib({
            cacheVersion: manifest.cacheVersion,
            inputsHash,
            outputPath: corruptTarget,
            prebuiltDir,
        })).toBe(false);
        expect(fs.existsSync(corruptTarget)).toBe(false);
        expect(fs.existsSync(path.dirname(corruptTarget))).toBe(false);

        // 5. Post-seed mutation isolation: overwriting source dist/lib/lib.js in place must NOT mutate seeded output (no shared hard-link inode).
        expect(fs.readFileSync(validTarget)).toEqual(bundleContent);
        expect(fs.lstatSync(validTarget).isSymbolicLink()).toBe(false);
    });

    test('trySeedPrebuiltPublicLib rejects symlinked source bundles even when target bytes match manifest', () => {
        const prebuiltDir = makeTempDir('sb-prebuilt-symlink-src-');
        const outsideDir = makeTempDir('sb-prebuilt-symlink-outside-');
        const outputDir = makeTempDir('sb-prebuilt-symlink-out-');
        const bundleContent = Buffer.from('export default { symlinked: true };\n', 'utf8');
        const inputsHash = sha256Hex('inputs-symlink');
        const outsideBundle = path.join(outsideDir, 'real-lib.js');

        fs.writeFileSync(outsideBundle, bundleContent);
        fs.writeFileSync(
            path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME),
            JSON.stringify({
                schemaVersion: PREBUILT_LIB_MANIFEST_SCHEMA_VERSION,
                cacheVersion: 'fedcba9876543210',
                inputsHash,
                sha256: sha256Hex(bundleContent),
                webpackVersion: '5.105.4',
                bundleBytes: bundleContent.byteLength,
                builtWithNode: true,
            }),
        );

        const sourceSymlink = path.join(prebuiltDir, PREBUILT_LIB_FILENAME);
        let symlinkCreated = false;
        try {
            fs.symlinkSync(outsideBundle, sourceSymlink);
            symlinkCreated = true;
        } catch {
            // Symlink creation may require elevation on some Windows setups; fall back to lstat spy.
        }

        const symlinkTarget = path.join(outputDir, 'symlink', 'lib.js');
        let lstatSpy = null;
        if (!symlinkCreated) {
            fs.writeFileSync(sourceSymlink, bundleContent);
            const realLstat = fs.lstatSync;
            lstatSpy = jest.spyOn(fs, 'lstatSync').mockImplementation((targetPath, ...args) => {
                if (path.resolve(String(targetPath)) === path.resolve(sourceSymlink)) {
                    return {
                        isSymbolicLink: () => true,
                        isFile: () => false,
                        size: bundleContent.byteLength,
                    };
                }
                return realLstat(targetPath, ...args);
            });
        }

        try {
            expect(trySeedPrebuiltPublicLib({
                cacheVersion: 'fedcba9876543210',
                inputsHash,
                outputPath: symlinkTarget,
                prebuiltDir,
            })).toBe(false);
            expect(fs.existsSync(symlinkTarget)).toBe(false);
        } finally {
            lstatSpy?.mockRestore();
        }
    });

    test('webpack-serve middleware seeds from SILLYBUNNY_PREBUILT_LIB_DIR and skips local Webpack compilation', async () => {
        const dataRoot = makeTempDir('sb-data-root-');
        const prebuiltDir = makeTempDir('sb-prebuilt-env-');
        global.DATA_ROOT = dataRoot;

        const cacheInfo = getPublicLibCacheInfo({ forceDist: false });
        const inputsHash = computePublicLibInputsHash({ rootDir: repoRoot });
        const bundleContent = Buffer.from('export const seeded = "from-prebuilt-artifact";\n', 'utf8');

        fs.writeFileSync(path.join(prebuiltDir, PREBUILT_LIB_FILENAME), bundleContent);
        fs.writeFileSync(
            path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME),
            JSON.stringify({
                schemaVersion: PREBUILT_LIB_MANIFEST_SCHEMA_VERSION,
                cacheVersion: cacheInfo.cacheVersion,
                inputsHash,
                sha256: sha256Hex(bundleContent),
                webpackVersion: '5.105.4',
                bundleBytes: bundleContent.byteLength,
                builtWithNode: true,
            }),
        );

        process.env.SILLYBUNNY_PREBUILT_LIB_DIR = prebuiltDir;
        const middleware = getWebpackServeMiddleware();

        expect(fs.existsSync(cacheInfo.outputFilePath)).toBe(false);
        await middleware.runWebpackCompiler();
        expect(fs.existsSync(cacheInfo.outputFilePath)).toBe(true);
        expect(fs.readFileSync(cacheInfo.outputFilePath)).toEqual(bundleContent);
    });

    test('buildPrebuiltPublicLib produces byte-for-byte reproducible output and valid deterministic tar.gz', async () => {
        const workDir = makeTempDir('sb-build-lib-');
        const outDir = path.join(workDir, 'dist', 'lib');
        const tarballPath = path.join(workDir, 'sillybunny-prebuilt-lib.tar.gz');
        const entryPath = path.join(workDir, 'test-entry.js');

        fs.writeFileSync(
            entryPath,
            [
                'import { gzipSync } from \'fflate\';',
                'import { sha256 } from \'js-sha256\';',
                'import yaml from \'yaml\';',
                'export { gzipSync, sha256, yaml };',
            ].join('\n'),
            'utf8',
        );

        const result = await buildPrebuiltPublicLib({
            outDir,
            verify: true,
            tarballPath,
            entry: entryPath,
        });

        expect(result.verified).toBe(true);
        expect(result.manifest).toMatchObject({
            schemaVersion: 1,
            builtWithNode: true,
            inputsHash: computePublicLibInputsHash({ rootDir: repoRoot }),
        });
        expect(result.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.manifest.bundleBytes).toBeGreaterThan(0);

        const archiveBytes = fs.readFileSync(tarballPath);
        const extracted = parseTarGz(archiveBytes);
        expect([...extracted.keys()]).toEqual(['dist/lib/lib.js', 'dist/lib/lib.manifest.json']);
        expect(extracted.get('dist/lib/lib.js')).toEqual(fs.readFileSync(result.bundlePath));
        expect(extracted.get('dist/lib/lib.manifest.json')).toEqual(fs.readFileSync(result.manifestPath));

        // Re-running deterministic tar.gz creation yields byte-for-byte identical archive bytes.
        const secondArchive = createDeterministicTarGz([
            { name: 'dist/lib/lib.js', content: fs.readFileSync(result.bundlePath) },
            { name: 'dist/lib/lib.manifest.json', content: fs.readFileSync(result.manifestPath) },
        ]);
        expect(secondArchive.equals(archiveBytes)).toBe(true);

        // Seed from the built directory succeeds with strict integrity check.
        const seededOutput = path.join(workDir, 'seeded', 'lib.js');
        expect(trySeedPrebuiltPublicLib({
            cacheVersion: result.manifest.cacheVersion,
            inputsHash: result.manifest.inputsHash,
            outputPath: seededOutput,
            prebuiltDir: outDir,
        })).toBe(true);
        expect(sha256Hex(fs.readFileSync(seededOutput))).toBe(result.manifest.sha256);
    });

    test('package.json scripts and release.yml wire prebuilt lib build, verify, and tarball upload', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        expect(pkg.scripts['build:lib']).toBe('node scripts/build-prebuilt-lib.js');
        expect(pkg.scripts['verify:lib']).toBe('node scripts/build-prebuilt-lib.js --verify');

        const releaseWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
        expect(releaseWorkflow).toContain('npm run build:lib');
        expect(releaseWorkflow).toContain('--verify');
        expect(releaseWorkflow).toContain('sillybunny-prebuilt-lib.tar.gz');
    });
});

describe('fflate streaming backup ZIP in src/users.js', () => {
    const previousDataRoot = global.DATA_ROOT;

    beforeEach(() => {
        global.DATA_ROOT = makeTempDir('sb-users-zip-');
    });

    afterEach(() => {
        global.DATA_ROOT = previousDataRoot;
    });

    test('streams valid ZIP readable by yauzl and fflate, stores compressed media, excludes secrets, and skips symlinks', async () => {
        const handle = `zip-roundtrip-${Date.now()}`;
        const userRoot = path.join(global.DATA_ROOT, handle);
        const outsideFile = path.join(makeTempDir('sb-outside-'), 'escape.txt');
        fs.writeFileSync(outsideFile, 'must-not-be-archived');

        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
        const webpBytes = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
        const repeatingText = 'compressible-chat-line\n'.repeat(200);

        writeFiles(userRoot, {
            'settings.json': '{"theme":"bunny"}',
            'chats/Émile/chat.jsonl': repeatingText,
            'empty.txt': '',
            '.hidden-file': 'dot-visible',
            'characters/hero.png': pngBytes,
            'user/images/avatar.webp': webpBytes,
            'secrets.json': '{"api_key":"never-export"}',
            'backups/secrets_migration_42.json': '{"api_key":"never-export-2"}',
            'backups/normal_backup.json': '{"ok":true}',
        });

        try {
            fs.symlinkSync(outsideFile, path.join(userRoot, 'symlink-escape.txt'));
        } catch {
            // Symlink creation may require elevation on some Windows setups; skip symlink assertion only if OS refused creation.
        }

        const chunks = [];
        const output = new PassThrough();
        let attachedFilename = null;
        output.attachment = (name) => {
            attachedFilename = name;
        };
        output.on('data', chunk => chunks.push(chunk));

        await createBackupArchive(handle, output);

        const zipBuffer = Buffer.concat(chunks);
        expect(attachedFilename).toMatch(new RegExp(`^${handle}-.+\\.zip$`));

        // Verify with yauzl including compression methods (0 = STORE, 8 = DEFLATE).
        const yauzlEntries = await inspectZipWithYauzl(zipBuffer);
        expect(yauzlEntries.get('settings.json')?.content.toString('utf8')).toBe('{"theme":"bunny"}');
        expect(yauzlEntries.get('settings.json')?.compressionMethod).toBe(8);
        expect(yauzlEntries.get('chats/Émile/chat.jsonl')?.content.toString('utf8')).toBe(repeatingText);
        expect(yauzlEntries.get('chats/Émile/chat.jsonl')?.compressionMethod).toBe(8);
        expect(yauzlEntries.get('empty.txt')?.content.byteLength).toBe(0);
        expect(yauzlEntries.get('.hidden-file')?.content.toString('utf8')).toBe('dot-visible');
        expect(yauzlEntries.get('characters/hero.png')?.content).toEqual(pngBytes);
        expect(yauzlEntries.get('characters/hero.png')?.compressionMethod).toBe(0);
        expect(yauzlEntries.get('user/images/avatar.webp')?.content).toEqual(webpBytes);
        expect(yauzlEntries.get('user/images/avatar.webp')?.compressionMethod).toBe(0);
        expect(yauzlEntries.get('backups/normal_backup.json')?.content.toString('utf8')).toBe('{"ok":true}');
        expect(yauzlEntries.has('secrets.json')).toBe(false);
        expect(yauzlEntries.has('backups/secrets_migration_42.json')).toBe(false);
        expect(yauzlEntries.has('symlink-escape.txt')).toBe(false);

        // Verify roundtrip with fflate.unzipSync as well.
        const unzipped = unzipSync(new Uint8Array(zipBuffer));
        expect(Buffer.from(unzipped['settings.json']).toString('utf8')).toBe('{"theme":"bunny"}');
        expect(Buffer.from(unzipped['characters/hero.png'])).toEqual(pngBytes);
        expect(unzipped['secrets.json']).toBeUndefined();
    });

    test('honors downstream backpressure on slow writable streams without corrupting output', async () => {
        const handle = `zip-backpressure-${Date.now()}`;
        const userRoot = path.join(global.DATA_ROOT, handle);
        const largePayload = Buffer.alloc(320 * 1024);
        for (let i = 0; i < largePayload.length; i++) {
            largePayload[i] = (i * 31) & 0xff;
        }

        writeFiles(userRoot, {
            'characters/large.png': largePayload,
            'chats/log.jsonl': '{"line":1}\n'.repeat(4000),
        });

        const chunks = [];
        let drainCount = 0;
        const slowStream = new Writable({
            highWaterMark: 4096,
            write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                setImmediate(callback);
            },
        });
        slowStream.on('drain', () => {
            drainCount += 1;
        });

        await createBackupArchive(handle, slowStream);

        expect(drainCount).toBeGreaterThan(0);
        const unzipped = unzipSync(new Uint8Array(Buffer.concat(chunks)));
        expect(Buffer.from(unzipped['characters/large.png'])).toEqual(largePayload);
        expect(Buffer.from(unzipped['chats/log.jsonl']).toString('utf8')).toBe('{"line":1}\n'.repeat(4000));
    });

    test('rejects cleanly when user directory does not exist and handles mid-stream abort/error cleanly', async () => {
        const missingHandle = `zip-missing-${Date.now()}`;
        const sink = new PassThrough();
        await expect(createBackupArchive(missingHandle, sink)).rejects.toThrow();

        // Mid-stream client abort resolves cleanly without writing after destroy.
        const abortHandle = `zip-abort-${Date.now()}`;
        const abortRoot = path.join(global.DATA_ROOT, abortHandle);
        writeFiles(abortRoot, {
            'characters/a.png': Buffer.alloc(256 * 1024, 0xab),
            'characters/b.png': Buffer.alloc(256 * 1024, 0xcd),
        });

        let writesBeforeAbort = 0;
        const abortingStream = new Writable({
            highWaterMark: 1024,
            write(_chunk, _encoding, callback) {
                writesBeforeAbort += 1;
                if (writesBeforeAbort === 2) {
                    this.destroy();
                    callback();
                    return;
                }
                setImmediate(callback);
            },
        });

        await expect(createBackupArchive(abortHandle, abortingStream)).resolves.toBeUndefined();
        expect(abortingStream.destroyed).toBe(true);

        // Downstream stream error propagates cleanly.
        const errorHandle = `zip-error-${Date.now()}`;
        const errorRoot = path.join(global.DATA_ROOT, errorHandle);
        writeFiles(errorRoot, {
            'settings.json': '{"fail":true}',
        });

        const failingStream = new Writable({
            write(_chunk, _encoding, callback) {
                callback(new Error('disk full'));
            },
        });
        await expect(createBackupArchive(errorHandle, failingStream)).rejects.toThrow('disk full');
    });

    test('clamps pre-1980 and post-2099 mtimes cleanly instead of throwing FlateError InvalidDate', async () => {
        expect(clampZipEntryMtime(new Date(0)).getFullYear()).toBe(1980);
        expect(clampZipEntryMtime(new Date(2150, 5, 1)).getFullYear()).toBe(2099);
        expect(Number.isNaN(clampZipEntryMtime(new Date(NaN)).getTime())).toBe(false);

        const handle = `zip-old-mtime-${Date.now()}`;
        const userRoot = path.join(global.DATA_ROOT, handle);
        writeFiles(userRoot, {
            'epoch0.txt': 'from-1970-tarball',
            'characters/ancient.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
        });
        fs.utimesSync(path.join(userRoot, 'epoch0.txt'), new Date(0), new Date(0));
        fs.utimesSync(path.join(userRoot, 'characters', 'ancient.png'), new Date(0), new Date(0));

        const chunks = [];
        const output = new PassThrough();
        output.on('data', chunk => chunks.push(chunk));

        await createBackupArchive(handle, output);

        const zipBuffer = Buffer.concat(chunks);
        const yauzlEntries = await inspectZipWithYauzl(zipBuffer);
        expect(yauzlEntries.get('epoch0.txt')?.content.toString('utf8')).toBe('from-1970-tarball');
        expect(yauzlEntries.get('characters/ancient.png')?.compressionMethod).toBe(0);

        const unzipped = unzipSync(new Uint8Array(zipBuffer));
        expect(Buffer.from(unzipped['epoch0.txt']).toString('utf8')).toBe('from-1970-tarball');
    });

    test('falls back to lazy archiver with ZIP64 when ZIP32 thresholds are exceeded and fails loudly if archiver is missing', async () => {
        const handle = `zip-zip64-${Date.now()}`;
        const userRoot = path.join(global.DATA_ROOT, handle);
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
        writeFiles(userRoot, {
            'settings.json': '{"zip64":true,"payload":"' + 'x'.repeat(256) + '"}',
            'characters/card.png': pngBytes,
            'secrets.json': '{"api_key":"must-exclude"}',
        });

        // 1. Total-size threshold triggers real lazy archiver ZIP64 fallback.
        const chunks = [];
        const output = new PassThrough();
        let attachedName = null;
        output.attachment = (name) => {
            attachedName = name;
        };
        output.on('data', chunk => chunks.push(chunk));

        await createBackupArchive(handle, output, {
            zip64Thresholds: { maxTotalBytes: 32 },
        });

        expect(attachedName).toMatch(new RegExp(`^${handle}-.+\\.zip$`));
        const zipBuffer = Buffer.concat(chunks);
        // ZIP64 End of Central Directory signature (0x06064b50) confirms ZIP64 headers were emitted.
        expect(zipBuffer.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);

        const yauzlEntries = await inspectZipWithYauzl(zipBuffer);
        expect(yauzlEntries.get('settings.json')?.content.toString('utf8')).toContain('"zip64":true');
        expect(yauzlEntries.get('settings.json')?.compressionMethod).toBe(8);
        expect(yauzlEntries.get('characters/card.png')?.content).toEqual(pngBytes);
        expect(yauzlEntries.get('characters/card.png')?.compressionMethod).toBe(0);
        expect(yauzlEntries.has('secrets.json')).toBe(false);

        // 2. Entry-count threshold with missing archiver (e.g. pruned on Android) fails loudly before writing bytes.
        const missingChunks = [];
        const missingOutput = new PassThrough();
        missingOutput.on('data', chunk => missingChunks.push(chunk));

        await expect(createBackupArchive(handle, missingOutput, {
            zip64Thresholds: { maxEntries: 1 },
            loadArchiver: () => Promise.reject(Object.assign(new Error('Cannot find package \'archiver\''), { code: 'ERR_MODULE_NOT_FOUND' })),
        })).rejects.toThrow(/ZIP64 fallback/i);
        expect(missingChunks).toHaveLength(0);
    });

    test('destroys PassThrough response without emitting an unhandled error after headers are sent', async () => {
        const handle = `zip-midstream-err-${Date.now()}`;
        const userRoot = path.join(global.DATA_ROOT, handle);
        writeFiles(userRoot, {
            'a-first.png': Buffer.alloc(4096, 0x55),
            'b-second.txt': 'will-fail-on-open',
        });

        const output = new PassThrough();
        output.headersSent = false;
        const originalWrite = output.write.bind(output);
        output.write = (...args) => {
            output.headersSent = true;
            return originalWrite(...args);
        };
        output.resume();

        const realOpen = fs.promises.open;
        const openSpy = jest.spyOn(fs.promises, 'open').mockImplementation((targetPath, ...args) => {
            if (String(targetPath).endsWith('b-second.txt')) {
                return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
            }
            return realOpen(targetPath, ...args);
        });

        const uncaughtErrors = [];
        const onUncaught = (err) => uncaughtErrors.push(err);
        process.on('uncaughtException', onUncaught);

        try {
            await expect(createBackupArchive(handle, output)).resolves.toBeUndefined();
            await new Promise(resolve => setImmediate(resolve));
            expect(output.destroyed).toBe(true);
            expect(uncaughtErrors).toEqual([]);
        } finally {
            process.off('uncaughtException', onUncaught);
            openSpy.mockRestore();
        }
    });

    test('skips files that vanish with ENOENT between directory walk and open without aborting backup', async () => {
        const handle = `zip-enoent-${Date.now()}`;
        const userRoot = path.join(global.DATA_ROOT, handle);
        writeFiles(userRoot, {
            'a-keep.json': '{"keep":true}',
            'b-vanish.tmp': 'transient-temp-file',
            'c-after.json': '{"after":true}',
        });

        const vanishPath = path.join(userRoot, 'b-vanish.tmp');
        const realOpen = fs.promises.open;
        const openSpy = jest.spyOn(fs.promises, 'open').mockImplementation((targetPath, ...args) => {
            if (String(targetPath).endsWith('a-keep.json') && fs.existsSync(vanishPath)) {
                fs.unlinkSync(vanishPath);
            }
            return realOpen(targetPath, ...args);
        });

        const chunks = [];
        const output = new PassThrough();
        output.on('data', chunk => chunks.push(chunk));

        try {
            await createBackupArchive(handle, output);
        } finally {
            openSpy.mockRestore();
        }

        const unzipped = unzipSync(new Uint8Array(Buffer.concat(chunks)));
        expect(Buffer.from(unzipped['a-keep.json']).toString('utf8')).toBe('{"keep":true}');
        expect(Buffer.from(unzipped['c-after.json']).toString('utf8')).toBe('{"after":true}');
        expect(unzipped['b-vanish.tmp']).toBeUndefined();
    });
});

describe('zero-feature-loss Android node_modules pruner', () => {
    function buildFixtureNodeModules({ missingActiveWasm = null } = {}) {
        const nm = makeTempDir('sb-android-prune-');
        const files = {
            // Regular package with maps, d.ts, docs, tests, protected files
            'sample-pkg/package.json': '{"name":"sample-pkg","main":"index.js"}',
            'sample-pkg/index.js': 'export const ok = true;\n',
            'sample-pkg/index.js.map': '{"version":3,"mappings":"AAAA"}',
            'sample-pkg/index.d.ts': 'export declare const ok: boolean;\n',
            'sample-pkg/types.d.mts': 'export type X = number;\n',
            'sample-pkg/legacy.d.cts': 'export type Y = string;\n',
            'sample-pkg/LICENSE': 'MIT License',
            'sample-pkg/NOTICE.txt': 'Third-party notices',
            'sample-pkg/docs/guide.md': '# Guide\n'.repeat(20),
            'sample-pkg/docs/LICENSE.md': 'Docs license must stay',
            'sample-pkg/tests/unit.test.js': 'test("x", () => {});',
            'sample-pkg/tests/package.json': '{"type":"module"}',
            'sample-pkg/__tests__/snap.js': 'snap',
            'sample-pkg/examples/demo.js': 'console.log("demo");',

            // Scoped package whose main references docs/ -> must NOT prune docs/
            '@scope/docs-runtime/package.json': '{"name":"@scope/docs-runtime","main":"./docs/entry.js"}',
            '@scope/docs-runtime/docs/entry.js': 'module.exports = 42;',
            '@scope/docs-runtime/docs/entry.js.map': '{"version":3}',
            '@scope/docs-runtime/test/spec.js': 'assert(true);',

            // Active transformers + duplicate onnxruntime-web WASMs (#1B invariant)
            'sillytavern-transformers/package.json': '{"name":"sillytavern-transformers"}',
            'sillytavern-transformers/dist/transformers.min.js': 'export const pipeline = () => {};',
            'sillytavern-transformers/dist/transformers.min.js.map': '{"version":3,"sources":[]}',
            'onnxruntime-web/package.json': '{"name":"onnxruntime-web"}',
            'onnxruntime-web/dist/ort.min.js': 'export default {};',
            'onnxruntime-web/dist/ort.min.js.map': '{"version":3}',

            // Verified-unused packages (only removed with --include-unused)
            'html2canvas/package.json': '{"name":"html2canvas"}',
            'html2canvas/dist/html2canvas.js': 'window.html2canvas = {};',
            'archiver/package.json': '{"name":"archiver"}',
            'archiver/index.js': 'module.exports = {};',
        };

        for (const wasmFile of DUPLICATE_ORT_WASM_FILES) {
            files[`onnxruntime-web/dist/${wasmFile}`] = Buffer.alloc(1024, 0x01);
            if (wasmFile !== missingActiveWasm) {
                files[`sillytavern-transformers/dist/${wasmFile}`] = Buffer.alloc(1024, 0x01);
            }
        }

        writeFiles(nm, files);
        return nm;
    }

    test('dry-run reports exact savings without mutating disk, and real prune is idempotent while preserving protected files and active WASMs', () => {
        const nm = buildFixtureNodeModules();

        const dry = pruneAndroidNodeModules({ nodeModulesDir: nm, dryRun: true, includeUnused: false });
        expect(dry.dryRun).toBe(true);
        expect(dry.removedFiles).toBeGreaterThan(0);
        expect(dry.savedBytes).toBeGreaterThan(4096);
        expect(dry.removedDuplicateWasms).toEqual([...DUPLICATE_ORT_WASM_FILES]);
        expect(dry.removedUnusedPackages).toEqual([]);
        // Dry-run must not delete anything.
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'index.js.map'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'onnxruntime-web', 'dist', 'ort-wasm.wasm'))).toBe(true);

        const actual = pruneAndroidNodeModules({ nodeModulesDir: nm, dryRun: false, includeUnused: false });
        expect(actual.dryRun).toBe(false);
        expect(actual.removedFiles).toBe(dry.removedFiles);
        expect(actual.savedBytes).toBe(dry.savedBytes);

        // Non-runtime artifacts removed.
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'index.js.map'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'index.d.ts'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'types.d.mts'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'legacy.d.cts'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'docs', 'guide.md'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'tests', 'unit.test.js'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', '__tests__'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'examples'))).toBe(false);

        // Protected files and runtime files preserved everywhere (even nested inside docs/ and tests/).
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'LICENSE'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'NOTICE.txt'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'docs', 'LICENSE.md'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'sample-pkg', 'tests', 'package.json'))).toBe(true);

        // Package whose main references docs/ keeps its runtime entry while stripping maps & test/.
        expect(fs.existsSync(path.join(nm, '@scope', 'docs-runtime', 'docs', 'entry.js'))).toBe(true);
        expect(fs.existsSync(path.join(nm, '@scope', 'docs-runtime', 'docs', 'entry.js.map'))).toBe(false);
        expect(fs.existsSync(path.join(nm, '@scope', 'docs-runtime', 'test'))).toBe(false);

        // #1B invariant: duplicate onnxruntime-web WASMs stripped, active sillytavern-transformers WASMs untouched.
        for (const wasmFile of DUPLICATE_ORT_WASM_FILES) {
            expect(fs.existsSync(path.join(nm, 'onnxruntime-web', 'dist', wasmFile))).toBe(false);
            expect(fs.existsSync(path.join(nm, 'sillytavern-transformers', 'dist', wasmFile))).toBe(true);
        }
        expect(fs.existsSync(path.join(nm, 'sillytavern-transformers', 'dist', 'transformers.min.js'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'onnxruntime-web', 'dist', 'ort.min.js'))).toBe(true);

        // Unused packages preserved unless --include-unused is passed.
        expect(fs.existsSync(path.join(nm, 'html2canvas', 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'archiver', 'package.json'))).toBe(true);

        // Idempotent second pass removes nothing.
        const secondPass = pruneAndroidNodeModules({ nodeModulesDir: nm, dryRun: false, includeUnused: false });
        expect(secondPass.removedFiles).toBe(0);
        expect(secondPass.savedBytes).toBe(0);
    });

    test('refuses to delete duplicate onnxruntime-web WASMs if any active sillytavern-transformers WASM is missing', () => {
        const nm = buildFixtureNodeModules({ missingActiveWasm: 'ort-wasm-simd.wasm' });

        const result = pruneAndroidNodeModules({ nodeModulesDir: nm, dryRun: false, includeUnused: false });
        expect(result.removedDuplicateWasms).toEqual([]);

        for (const wasmFile of DUPLICATE_ORT_WASM_FILES) {
            expect(fs.existsSync(path.join(nm, 'onnxruntime-web', 'dist', wasmFile))).toBe(true);
        }
    });

    test('removes html2canvas and archiver only when includeUnused is true', () => {
        const nm = buildFixtureNodeModules();

        const result = pruneAndroidNodeModules({ nodeModulesDir: nm, dryRun: false, includeUnused: true });
        expect(result.removedUnusedPackages).toEqual(['html2canvas', 'archiver']);
        expect(fs.existsSync(path.join(nm, 'html2canvas'))).toBe(false);
        expect(fs.existsSync(path.join(nm, 'archiver'))).toBe(false);
    });
});
