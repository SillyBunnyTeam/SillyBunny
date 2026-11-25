#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import webpack from 'webpack';
import getPublicLibConfig, { getPublicLibCacheInfo } from '../webpack.config.js';
import { isBunRuntime } from '../src/runtime.js';
import { serverDirectory } from '../src/server-directory.js';
import {
    PREBUILT_LIB_FILENAME,
    PREBUILT_LIB_MANIFEST_FILENAME,
    PREBUILT_LIB_MANIFEST_SCHEMA_VERSION,
    computePublicLibInputsHash,
    sha256Hex,
} from '../src/prebuilt-lib.js';

const TAR_BLOCK_SIZE = 512;

/**
 * Builds the deterministic Node Webpack config for the prebuilt public vendor bundle.
 * @param {string} outputPath Destination directory for `lib.js`.
 * @param {object} [options] Optional overrides.
 * @param {string} [options.entry] Optional custom entry path (defaults to `public/lib.js`).
 * @returns {import('webpack').Configuration} Webpack configuration.
 */
export function resolvePrebuiltPublicLibConfig(outputPath, { entry = undefined } = {}) {
    const baseConfig = getPublicLibConfig({
        forceDist: true,
        outputPath,
    });

    return {
        ...baseConfig,
        ...(entry ? { entry } : {}),
        context: serverDirectory,
        mode: 'production',
        cache: false,
        devtool: false,
        watch: false,
        resolve: {
            ...(baseConfig.resolve ?? {}),
            modules: [path.join(serverDirectory, 'node_modules'), 'node_modules'],
        },
        optimization: {
            ...(baseConfig.optimization ?? {}),
            minimize: true,
            moduleIds: 'deterministic',
            chunkIds: 'deterministic',
        },
        output: {
            ...(baseConfig.output ?? {}),
            path: outputPath,
            filename: PREBUILT_LIB_FILENAME,
            libraryTarget: 'module',
        },
    };
}

/**
 * Executes a single Webpack compilation to the requested directory.
 * @param {string} outputDir Directory to emit `lib.js` into.
 * @param {object} [options] Optional compile overrides.
 * @param {string} [options.entry] Optional custom entry path (defaults to `public/lib.js`).
 * @returns {Promise<Buffer>} Compiled `lib.js` buffer.
 */
export async function compilePrebuiltPublicLibToDir(outputDir, { entry = undefined } = {}) {
    if (isBunRuntime()) {
        throw new Error('Prebuilt lib.js must be compiled with Node.js (minified Webpack output is unsupported under Bun).');
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const config = resolvePrebuiltPublicLibConfig(outputDir, { entry });
    const compiler = webpack(config);

    await new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            const output = stats?.toString(config.stats);
            if (output) {
                console.log(output);
            }

            compiler.close((closeError) => {
                const compileError = error ?? closeError;
                if (compileError) {
                    reject(compileError);
                    return;
                }

                if (stats?.hasErrors()) {
                    reject(new Error('Webpack failed to compile prebuilt frontend libraries.'));
                    return;
                }

                resolve();
            });
        });
    });

    const bundlePath = path.join(outputDir, PREBUILT_LIB_FILENAME);
    if (!fs.existsSync(bundlePath)) {
        throw new Error(`Webpack did not produce ${PREBUILT_LIB_FILENAME} in ${outputDir}.`);
    }

    return fs.readFileSync(bundlePath);
}

/**
 * Encodes a single POSIX USTAR header block for a regular file.
 * @param {string} entryName POSIX path inside the tar archive.
 * @param {number} size Byte length of the file.
 * @returns {Buffer} 512-byte tar header block.
 */
function createTarHeader(entryName, size) {
    if (Buffer.byteLength(entryName, 'utf8') > 100) {
        throw new Error(`Tar entry name exceeds 100-byte USTAR limit: ${entryName}`);
    }

    const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
    header.write(entryName, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    let checksum = 0;
    for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
        checksum += header[i];
    }

    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return header;
}

/**
 * Builds a deterministic `.tar.gz` buffer from an ordered list of `{ name, content }` entries.
 * @param {Array<{ name: string, content: Buffer }>} entries Archive entries.
 * @returns {Buffer} Gzipped tar archive bytes.
 */
export function createDeterministicTarGz(entries) {
    const blocks = [];

    for (const { name, content } of entries) {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        blocks.push(createTarHeader(name, buffer.byteLength));
        blocks.push(buffer);

        const remainder = buffer.byteLength % TAR_BLOCK_SIZE;
        if (remainder !== 0) {
            blocks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
        }
    }

    // Standard POSIX tar EOF marker: two 512-byte zero blocks.
    blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));

    const tarBuffer = Buffer.concat(blocks);
    const gzipBuffer = zlib.gzipSync(tarBuffer, { level: 9 });
    // Normalize gzip header mtime (bytes 4..7) and OS flag (byte 9 = Unix) for cross-platform reproducibility.
    if (gzipBuffer.byteLength >= 10) {
        gzipBuffer[4] = 0;
        gzipBuffer[5] = 0;
        gzipBuffer[6] = 0;
        gzipBuffer[7] = 0;
        gzipBuffer[9] = 3;
    }
    return gzipBuffer;
}

/**
 * Builds `dist/lib/lib.js` and `dist/lib/lib.manifest.json`, optionally verifying reproducibility and writing a release tarball.
 * @param {object} [options] Build options.
 * @param {string} [options.outDir] Output directory (defaults to `<repo>/dist/lib`).
 * @param {boolean} [options.verify=false] Rebuilds into a temporary directory and asserts byte-for-byte SHA-256 identity.
 * @param {string|null} [options.tarballPath=null] Optional path to write `sillybunny-prebuilt-lib.tar.gz`.
 * @param {string} [options.entry] Optional custom entry file override (used by tests; defaults to `public/lib.js`).
 * @returns {Promise<{ outputDir: string, bundlePath: string, manifestPath: string, manifest: Record<string, any>, verified: boolean, tarballPath: string|null }>} Build summary.
 */
export async function buildPrebuiltPublicLib({
    outDir = path.join(serverDirectory, 'dist', 'lib'),
    verify = false,
    tarballPath = null,
    entry = undefined,
} = {}) {
    const resolvedOutDir = path.resolve(outDir);
    const cacheInfo = getPublicLibCacheInfo({ forceDist: true });
    const inputsHash = computePublicLibInputsHash({ rootDir: serverDirectory });

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-prebuilt-lib-stage-'));
    let bundleBuffer;
    try {
        bundleBuffer = await compilePrebuiltPublicLibToDir(stageDir, { entry });
    } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
    }

    const sha256 = sha256Hex(bundleBuffer);
    const manifest = {
        schemaVersion: PREBUILT_LIB_MANIFEST_SCHEMA_VERSION,
        cacheVersion: cacheInfo.cacheVersion,
        inputsHash,
        sha256,
        webpackVersion: webpack.version,
        bundleBytes: bundleBuffer.byteLength,
        builtWithNode: true,
    };

    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestBuffer = Buffer.from(manifestJson, 'utf8');

    if (verify) {
        const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-prebuilt-lib-verify-'));
        let verifyBuffer;
        try {
            verifyBuffer = await compilePrebuiltPublicLibToDir(verifyDir, { entry });
        } finally {
            fs.rmSync(verifyDir, { recursive: true, force: true });
        }

        const verifySha256 = sha256Hex(verifyBuffer);
        if (verifySha256 !== sha256 || verifyBuffer.byteLength !== bundleBuffer.byteLength) {
            throw new Error(
                `Prebuilt lib.js reproducibility check failed: expected sha256=${sha256} (${bundleBuffer.byteLength} bytes), got sha256=${verifySha256} (${verifyBuffer.byteLength} bytes).`,
            );
        }
        console.log(`Verified reproducible prebuilt lib.js (sha256=${sha256}, bytes=${bundleBuffer.byteLength}).`);
    }

    fs.mkdirSync(resolvedOutDir, { recursive: true });
    const bundlePath = path.join(resolvedOutDir, PREBUILT_LIB_FILENAME);
    const manifestPath = path.join(resolvedOutDir, PREBUILT_LIB_MANIFEST_FILENAME);
    fs.writeFileSync(bundlePath, bundleBuffer);
    fs.writeFileSync(manifestPath, manifestBuffer);

    let resolvedTarballPath = null;
    if (tarballPath) {
        resolvedTarballPath = path.resolve(tarballPath);
        fs.mkdirSync(path.dirname(resolvedTarballPath), { recursive: true });
        const archiveBuffer = createDeterministicTarGz([
            { name: `dist/lib/${PREBUILT_LIB_FILENAME}`, content: bundleBuffer },
            { name: `dist/lib/${PREBUILT_LIB_MANIFEST_FILENAME}`, content: manifestBuffer },
        ]);
        fs.writeFileSync(resolvedTarballPath, archiveBuffer);
        console.log(`Wrote prebuilt lib tarball to ${resolvedTarballPath} (${archiveBuffer.byteLength} bytes).`);
    }

    return {
        outputDir: resolvedOutDir,
        bundlePath,
        manifestPath,
        manifest,
        verified: Boolean(verify),
        tarballPath: resolvedTarballPath,
    };
}

/**
 * Parses CLI flags for `scripts/build-prebuilt-lib.js`.
 * @param {string[]} argv CLI argument list.
 * @returns {{ verify: boolean, tarballPath: string|null, outDir: string }} Parsed options.
 */
function parseArgs(argv) {
    let verify = false;
    let tarballPath = null;
    let outDir = path.join(serverDirectory, 'dist', 'lib');

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--verify') {
            verify = true;
        } else if (arg === '--tarball') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--tarball requires an output file path.');
            }
            tarballPath = value;
            i++;
        } else if (arg.startsWith('--tarball=')) {
            tarballPath = arg.slice('--tarball='.length);
            if (!tarballPath) {
                throw new Error('--tarball requires an output file path.');
            }
        } else if (arg === '--out-dir') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--out-dir requires a directory path.');
            }
            outDir = value;
            i++;
        } else if (arg.startsWith('--out-dir=')) {
            outDir = arg.slice('--out-dir='.length);
            if (!outDir) {
                throw new Error('--out-dir requires a directory path.');
            }
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node scripts/build-prebuilt-lib.js [--verify] [--tarball <path>] [--out-dir <dir>]');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return { verify, tarballPath, outDir };
}

function isDirectExecution() {
    if (!process.argv[1]) {
        return false;
    }
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = await buildPrebuiltPublicLib(options);
        console.log(
            `Built prebuilt lib.js -> ${result.bundlePath} (${result.manifest.bundleBytes} bytes, sha256=${result.manifest.sha256}, inputsHash=${result.manifest.inputsHash.slice(0, 12)})`,
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
