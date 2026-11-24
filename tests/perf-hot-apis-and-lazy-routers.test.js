/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import extractChunksReference from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import '../src/fetch-patch.js';
import { setConfigFilePath } from '../src/util.js';
import {
    createCardPng,
    createCardTextChunk,
    createImageChunks,
    createV1Card,
    createV2Card,
    createV3Card,
    encodePng,
} from './util/card-corpus.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const originalDataRoot = globalThis.DATA_ROOT;
const defaultDataRoot = path.join(repoRoot, 'data');

const environment = {
    SILLYTAVERN_PERFORMANCE_USEDISKCACHE: 'true',
    SILLYTAVERN_PERFORMANCE_MEMORYCACHECAPACITY: '100mb',
    SILLYTAVERN_GIT_BACKEND: 'auto',
    SILLYTAVERN_EXTENSIONS_ENABLED: 'true',
};
const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
globalThis.DATA_ROOT = defaultDataRoot;

const mockGit = {
    checkIsRepo: jest.fn(async () => true),
    revparse: jest.fn(async () => 'abcdef1234567890abcdef1234567890abcdef12'),
    branch: jest.fn(async () => ({ current: 'main', tracking: 'origin/main', all: ['main'] })),
    fetch: jest.fn(async () => {}),
    getRemotes: jest.fn(async () => [{ name: 'origin', refs: { fetch: 'https://example.test/ext.git' } }]),
    raw: jest.fn(async () => '0\t0\n'),
    status: jest.fn(async () => ({ isClean: () => true, files: [] })),
    pull: jest.fn(async () => {}),
    stash: jest.fn(async () => {}),
};

const simpleGitFactory = () => ({
    CheckRepoActions: { IS_REPO_ROOT: 'root' },
    simpleGit: jest.fn(() => mockGit),
});
if (typeof jest.unstable_mockModule === 'function') {
    jest.unstable_mockModule('simple-git', simpleGitFactory);
} else {
    const bunTestSpecifier = 'bun:test';
    const { mock } = await import(bunTestSpecifier);
    mock.module('simple-git', simpleGitFactory);
}

const { lazyRouter, setupPrivateEndpoints } = await import('../src/server-startup.js');
const { CharacterIndex } = await import('../src/character-index.js');
const {
    ENTITY_DATE_ADDED_FILE,
    reconcileEntityDateAdded,
    removeEntityDateAdded,
} = await import('../src/entity-date-added.js');
const { default: extract, extractCharacterCardText, extractTextChunks } = await import('../src/png/extract.js');
const { calculateChatSize, characterIndex, router: charactersRouter } = await import('../src/endpoints/characters.js');
const {
    router: settingsRouter,
    readPresetsFromDirectory,
    readAndParseFromDirectory,
    areFilesEqual,
} = await import('../src/endpoints/settings.js');
const { SETTINGS_FILE } = await import('../src/constants.js');
const {
    router: tokenizersRouter,
    getTiktokenTokenizer,
    getSentencepiceTokenizer,
    getWebTokenizer,
} = await import('../src/endpoints/tokenizers.js');
const {
    clearExtensionManifestCache,
    router: extensionsRouter,
} = await import('../src/endpoints/extensions.js');
const {
    THUMBNAIL_CACHE_CONTROL,
    generateThumbnail,
    getThumbnailMobileRuntimeSettings,
    getThumbnailRuntimeSettings,
    publicRouter: thumbnailsRouter,
    setThumbnailMobileRuntimeSettings,
    setThumbnailRuntimeSettings,
} = await import('../src/endpoints/thumbnails.js');
const {
    getThumbnailDimensions,
    getThumbnailMobileDimensions,
    isAnimatedImageHeader,
    queueMetadataGeneration,
    readIsAnimatedFromHeader,
    readMetadataIndex,
    readMetadataIndexCached,
    setThumbnailDimensions,
    setThumbnailMobileDimensions,
    writeMetadataIndex,
} = await import('../src/endpoints/image-metadata.js');
const { router: backgroundsRouter } = await import('../src/endpoints/backgrounds.js');
const {
    clearWorldInfoCaches,
    router: worldInfoRouter,
} = await import('../src/endpoints/worldinfo.js');

afterAll(() => {
    globalThis.DATA_ROOT = originalDataRoot;
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    process.chdir(originalWorkingDirectory);
});


// Packages that must stay out of the static import graph of the server boot.
const HEAVY_PACKAGES = [
    'vectra',
    'sillytavern-transformers',
    'bing-translate-api',
    'google-translate-api-x',
    '@zeldafan0225/ai_horde',
    'wavefile',
    'archiver',
    'proxy-agent',
    'tiktoken',
    '@agnai/web-tokenizers',
    '@agnai/sentencepiece-js',
    '@anthropic-ai/tokenizer',
];

// Routers mounted through lazyRouter, in mount order.
const LAZY_MOUNTS = [
    ['/api/novelai', 'novelai'],
    ['/api/sd', 'stable-diffusion'],
    ['/api/horde', 'horde'],
    ['/api/vector', 'vectors'],
    ['/api/translate', 'translate'],
    ['/api/extra/classify', 'classify'],
    ['/api/extra/caption', 'caption'],
    ['/api/search', 'search'],
    ['/api/speech', 'speech'],
    ['/api/azure', 'azure'],
    ['/api/volcengine', 'volcengine'],
    ['/api/minimax', 'minimax'],
    ['/api/data-maid', 'data-maid'],
];

/**
 * Lists the static import specifiers of a module, skipping type-only `import('...')` in JSDoc and dynamic imports.
 * @param {string} source Module source
 * @returns {string[]} Specifiers
 */
function getStaticImports(source) {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [];
    const pattern = /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    for (const match of withoutComments.matchAll(pattern)) {
        specifiers.push(match[1]);
    }
    return specifiers;
}

/**
 * Walks the static import graph from a module and returns every bare package specifier it reaches.
 * @param {string} entry Absolute path of the entry module
 * @returns {Map<string, string>} Package specifier to the first file importing it
 */
function collectStaticPackages(entry) {
    const packages = new Map();
    const seen = new Set();
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file) || !fs.existsSync(file)) continue;
        seen.add(file);
        for (const specifier of getStaticImports(fs.readFileSync(file, 'utf8'))) {
            if (specifier.startsWith('.')) {
                queue.push(path.resolve(path.dirname(file), specifier));
            } else if (!specifier.startsWith('node:') && !packages.has(specifier)) {
                packages.set(specifier, path.relative(repoRoot, file));
            }
        }
    }
    return packages;
}

describe('lazyRouter', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl = '';
    const order = [];
    let loads = 0;
    let failNextLoad = false;
    /** @type {(value?: unknown) => void} */
    let releaseLoad = () => { };
    /** @type {(value?: unknown) => void} */
    let signalLoaderEntered = () => { };
    /** @type {Promise<unknown>} */
    let loaderEntered = Promise.resolve();

    function armLoaderBarrier() {
        loaderEntered = new Promise(resolve => {
            signalLoaderEntered = resolve;
        });
    }

    beforeAll(async () => {
        const app = express();
        app.use((req, _res, next) => {
            order.push(`before:${req.path}`);
            next();
        });
        app.use('/lazy', lazyRouter(async () => {
            loads++;
            const gate = new Promise(resolve => { releaseLoad = resolve; });
            signalLoaderEntered();
            await gate;
            if (failNextLoad) {
                failNextLoad = false;
                throw new Error('load failed');
            }
            const router = express.Router();
            router.get('/hello', (req, res) => res.json({ baseUrl: req.baseUrl, url: req.url }));
            return { router };
        }));
        app.use('/lazy', (req, res) => {
            order.push(`after:${req.path}`);
            res.json({ fallthrough: true });
        });
        app.use((error, _req, res, _next) => {
            res.status(500).json({ error: error.message });
        });
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => resolve(undefined));
        });
        const address = server.address();
        baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    });

    afterAll(async () => {
        releaseLoad();
        server?.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    });

    test('does not load until the first request, retries a failed load, then coalesces concurrent loads', async () => {
        expect(loads).toBe(0);

        failNextLoad = true;
        armLoaderBarrier();
        const failed = fetch(`${baseUrl}/lazy/hello`);
        await loaderEntered;
        releaseLoad();
        const failedResponse = await failed;
        expect(failedResponse.status).toBe(500);
        expect(await failedResponse.json()).toEqual({ error: 'load failed' });
        expect(loads).toBe(1);

        armLoaderBarrier();
        const concurrent = [fetch(`${baseUrl}/lazy/hello`), fetch(`${baseUrl}/lazy/hello`), fetch(`${baseUrl}/lazy/hello`)];
        await loaderEntered;
        releaseLoad();
        const bodies = await Promise.all((await Promise.all(concurrent)).map(response => response.json()));
        expect(loads).toBe(2);
        for (const body of bodies) {
            expect(body).toEqual({ baseUrl: '/lazy', url: '/hello' });
        }
    });

    test('keeps the mount position: earlier middleware runs first and unmatched paths fall through', async () => {
        order.length = 0;
        const response = await fetch(`${baseUrl}/lazy/missing`);
        expect(await response.json()).toEqual({ fallthrough: true });
        expect(order).toEqual(['before:/lazy/missing', 'after:/missing']);
        expect(loads).toBe(2);
    });
});

describe('setupPrivateEndpoints', () => {
    /** @type {Array<[string|Function, Function?]>} */
    const mounts = [];

    beforeAll(() => {
        const app = /** @type {any} */ ({
            use: (...args) => {
                mounts.push(args);
            },
        });
        setupPrivateEndpoints(app);
    });

    test('mounts the optional integration routers lazily at their original paths', () => {
        const lazy = mounts.filter(([, handler]) => typeof handler === 'function' && handler.name === 'lazyRouterHandler').map(([mountPath]) => mountPath);
        expect(lazy).toEqual(LAZY_MOUNTS.map(([mountPath]) => mountPath));
    });

    test('keeps the full mount order', () => {
        const paths = mounts.map(([mountPath]) => typeof mountPath === 'string' ? mountPath : '<middleware>');
        expect(paths).toEqual([
            '/', '/api/resumable-generations', '<middleware>', '/api/users', '/api/users', '/api/moving-ui', '/api/images',
            '/api/quick-replies', '/api/avatars', '/api/themes', '/api/openai', '/api/google', '/api/anthropic',
            '/api/tokenizers', '/api/presets', '/api/secrets', '/thumbnail', '/api/novelai', '/api/extensions',
            '/api/assets', '/api/files', '/api/characters', '/api/chats/archive', '/api/chats', '/api/groups',
            '/api/worldinfo', '/api/stats', '/api/backgrounds', '/api/sprites', '/api/content', '/api/settings',
            '/api/sd', '/api/horde', '/api/vector', '/api/translate', '/api/extra/classify', '/api/extra/caption',
            '/api/search', '/api/backends/text-completions', '/api/openrouter', '/api/nanogpt', '/api/backends/kobold',
            '/api/backends/chat-completions', '/api/speech', '/api/azure', '/api/volcengine', '/api/minimax',
            '/api/data-maid', '/api/backups', '/api/image-metadata', '/api/server-admin', '/api/in-chat-agents',
            '/api/sillybunny-conversation', '/api/sillybunny/conversation', '/api/sillybunny/themes',
            '/api/sillybunny/managed-content',
        ]);
    });

    test.each(LAZY_MOUNTS)('%s loads its router on first use', async (mountPath) => {
        const [, handler] = mounts.find(([candidate]) => candidate === mountPath);
        const next = jest.fn();
        const req = /** @type {any} */ ({ method: 'GET', url: '/__sillybunny_unmatched__', originalUrl: `${mountPath}/__sillybunny_unmatched__`, headers: {} });
        const res = /** @type {any} */ ({});
        await new Promise((resolve) => {
            next.mockImplementation(resolve);
            handler(req, res, next);
        });
        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeUndefined();
    }, 30_000);
});

describe('server boot import graph', () => {
    test('heavy optional packages are not statically imported from server-startup.js', () => {
        const packages = collectStaticPackages(path.join(repoRoot, 'src', 'server-startup.js'));
        const leaked = HEAVY_PACKAGES.filter(name => packages.has(name)).map(name => `${name} <- ${packages.get(name)}`);
        expect(leaked).toEqual([]);
    });

    test('heavy optional packages are not statically imported from server-main.js', () => {
        const packages = collectStaticPackages(path.join(repoRoot, 'src', 'server-main.js'));
        const leaked = HEAVY_PACKAGES.filter(name => packages.has(name)).map(name => `${name} <- ${packages.get(name)}`);
        expect(leaked).toEqual([]);
    });
});

describe('lazy heavy dependencies', () => {
    test('request proxy loads proxy-agent only when enabled', async () => {
        const http = await import('node:http');
        const https = await import('node:https');
        const originalHttpAgent = http.default.globalAgent;
        const originalHttpsAgent = https.default.globalAgent;
        const originalAllProxy = process.env.all_proxy;
        const { default: initRequestProxy } = await import('../src/request-proxy.js');
        try {
            initRequestProxy({ enabled: false, url: 'http://127.0.0.1:9', bypass: [], enableKeepAlive: false, privateRequestFilterEnabled: false });
            expect(http.default.globalAgent).toBe(originalHttpAgent);

            const info = jest.spyOn(console, 'info').mockImplementation(() => { });
            initRequestProxy({ enabled: true, url: 'http://127.0.0.1:9', bypass: [], enableKeepAlive: false, privateRequestFilterEnabled: false });
            info.mockRestore();
            expect(http.default.globalAgent).not.toBe(originalHttpAgent);
            expect(http.default.globalAgent.constructor.name).toBe('ProxyAgent');
        } finally {
            http.default.globalAgent = originalHttpAgent;
            https.default.globalAgent = originalHttpsAgent;
            if (originalAllProxy === undefined) {
                delete process.env.all_proxy;
            } else {
                process.env.all_proxy = originalAllProxy;
            }
        }
    });

    test('transformers image decoding still loads its decoder on demand', async () => {
        const { getRawImage } = await import('../src/transformers.js');
        // Minimal 1x1 24-bit red BMP (pure-JS codec so worktrees with a junctioned node_modules need no symlink flags).
        const bmp = Buffer.alloc(58);
        bmp.write('BM', 0, 'ascii');
        bmp.writeUInt32LE(58, 2);
        bmp.writeUInt32LE(54, 10);
        bmp.writeUInt32LE(40, 14);
        bmp.writeInt32LE(1, 18);
        bmp.writeInt32LE(1, 22);
        bmp.writeUInt16LE(1, 26);
        bmp.writeUInt16LE(24, 28);
        bmp.writeUInt32LE(4, 34);
        bmp[54] = 0; // B
        bmp[55] = 0; // G
        bmp[56] = 255; // R

        const image = await getRawImage(bmp.toString('base64'));
        expect(image).not.toBeNull();
        expect([image.width, image.height, image.channels]).toEqual([1, 1, 4]);
        expect(Array.from(image.data)).toEqual([255, 0, 0, 255]);

        const resized = await image.resize(2, 2);
        expect([resized.width, resized.height, resized.channels]).toEqual([2, 2, 4]);
        expect(await getRawImage(Buffer.from('not an image').toString('base64'))).toBeNull();
    });
});

function buildPngChunk(name, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(name, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

function buildMultiMbCardPng(card, idatBytes = 2 * 1024 * 1024) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(256, 0);
    ihdr.writeUInt32BE(256, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const textPayload = Buffer.concat([
        Buffer.from('chara\0', 'latin1'),
        Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1'),
    ]);
    const idat = Buffer.alloc(idatBytes, 0x3C);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        buildPngChunk('IHDR', ihdr),
        buildPngChunk('IDAT', idat),
        buildPngChunk('tEXt', textPayload),
        buildPngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function referenceReadCardText(pngBytes) {
    const chunks = extractChunksReference(new Uint8Array(pngBytes));
    const textChunks = chunks.filter(chunk => chunk.name === 'tEXt').map(chunk => PNGtext.decode(chunk.data));
    if (textChunks.length === 0) {
        throw new Error('No PNG metadata.');
    }
    const ccv3 = textChunks.find(chunk => chunk.keyword.toLowerCase() === 'ccv3');
    if (ccv3) {
        return Buffer.from(ccv3.text, 'base64').toString('utf8');
    }
    const chara = textChunks.find(chunk => chunk.keyword.toLowerCase() === 'chara');
    if (chara) {
        return Buffer.from(chara.text, 'base64').toString('utf8');
    }
    throw new Error('No PNG metadata.');
}

describe('CharacterIndex bulk query and 200-row batching', () => {
    let tempRoot;
    let index;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-index-'));
        globalThis.DATA_ROOT = tempRoot;
        index = new CharacterIndex({ enabled: true });
    });

    afterEach(() => {
        index.close();
        jest.restoreAllMocks();
        globalThis.DATA_ROOT = defaultDataRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('setMany stores >450 rows in 200-row batches, skips NUL payloads, and getDirectoryEntries loads all in one query', () => {
        const firstDir = path.join(tempRoot, 'user-a', 'characters');
        const secondDir = path.join(tempRoot, 'user-b', 'characters');
        fs.mkdirSync(firstDir, { recursive: true });
        fs.mkdirSync(secondDir, { recursive: true });

        const totalRows = 455;
        const entries = [];
        for (let i = 0; i < totalRows; i++) {
            const fileName = `Card_${String(i).padStart(4, '0')}.png`;
            const filePath = path.join(firstDir, fileName);
            entries.push({
                filePath,
                fileStat: { size: 1000 + i, mtimeMs: 1700000000000 + i },
                data: i === 250 ? 'contains\0nul' : JSON.stringify({ name: `Card ${i}` }),
            });
        }
        // Add a card in another directory to verify directory isolation.
        entries.push({
            filePath: path.join(secondDir, 'Other.png'),
            fileStat: { size: 512, mtimeMs: 1700000009999 },
            data: JSON.stringify({ name: 'Other' }),
        });

        index.setMany(entries);

        const firstDirEntries = index.getDirectoryEntries(firstDir);
        expect(firstDirEntries.size).toBe(totalRows - 1);
        expect(firstDirEntries.has('Card_0250.png')).toBe(false);
        expect(firstDirEntries.get('Card_0000.png')).toEqual({
            size: 1000,
            mtimeMs: 1700000000000,
            data: JSON.stringify({ name: 'Card 0' }),
        });
        expect(firstDirEntries.get('Card_0454.png')).toEqual({
            size: 1454,
            mtimeMs: 1700000000454,
            data: JSON.stringify({ name: 'Card 454' }),
        });

        const secondDirEntries = index.getDirectoryEntries(secondDir);
        expect(secondDirEntries.size).toBe(1);
        expect(secondDirEntries.get('Other.png')?.data).toBe(JSON.stringify({ name: 'Other' }));

        // Verify persistence after reopening the database file.
        index.close();
        const reopened = new CharacterIndex({ enabled: true });
        try {
            expect(reopened.getDirectoryEntries(firstDir).size).toBe(totalRows - 1);
        } finally {
            reopened.close();
        }
    });

    test('getDirectoryEntries returns an empty map when index is disabled', () => {
        const disabled = new CharacterIndex({ enabled: false });
        expect(disabled.getDirectoryEntries(path.join(tempRoot, 'characters'))).toEqual(new Map());
    });
});

describe('PNG fast tEXt extraction parity', () => {
    const { header, pixels, end } = createImageChunks();

    test('matches reference png-chunks-extract + png-chunk-text across V1, V2, V3, case variants, and multi-MB IDAT', () => {
        const v1 = createV1Card();
        const v2 = createV2Card();
        const v3 = createV3Card();
        const cases = [
            createCardPng(v1, ['chara']),
            createCardPng(v2, ['chara']),
            createCardPng(v3, ['chara', 'ccv3']),
            createCardPng(v3, ['CCV3', 'CHARA']),
            encodePng([header, pixels, createCardTextChunk('chara', v2), createCardTextChunk('ccv3', v3), end]),
            buildMultiMbCardPng(v2, 2 * 1024 * 1024),
        ];

        for (const png of cases) {
            const u8 = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
            const refChunks = extractChunksReference(u8);
            const fastChunks = extract(u8);
            expect(fastChunks.map(c => c.name)).toEqual(refChunks.map(c => c.name));
            for (let i = 0; i < refChunks.length; i++) {
                expect(Buffer.from(fastChunks[i].data).equals(Buffer.from(refChunks[i].data))).toBe(true);
            }

            const refTextChunks = refChunks.filter(c => c.name === 'tEXt');
            const fastTextChunks = extractTextChunks(u8);
            expect(fastTextChunks.length).toBe(refTextChunks.length);
            for (let i = 0; i < refTextChunks.length; i++) {
                expect(Buffer.from(fastTextChunks[i].data).equals(Buffer.from(refTextChunks[i].data))).toBe(true);
            }

            expect(extractCharacterCardText(u8)).toBe(referenceReadCardText(u8));
        }
    });

    test('extractTextChunks and extractCharacterCardText skip IDAT CRC while full extract still rejects corrupted IDAT', () => {
        const png = buildMultiMbCardPng(createV2Card(), 256 * 1024);
        // Flip a byte inside the IDAT payload (signature=8, IHDR=25, IDAT header=8 -> offset 41).
        const corruptedIdat = Buffer.from(png);
        corruptedIdat[41] ^= 0xFF;

        expect(() => extract(corruptedIdat)).toThrow(/^CRC values for IDAT header do not match/);
        expect(extractTextChunks(corruptedIdat)).toHaveLength(1);
        expect(extractCharacterCardText(corruptedIdat)).toBe(JSON.stringify(createV2Card()));
    });

    test('extractTextChunks and extractCharacterCardText still reject corrupted tEXt CRC, NUL bytes, bad header, and bounds overrun', () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const png = createCardPng(createV2Card(), ['chara']);

        // Flip a byte in the tEXt chunk CRC (just before the 12-byte IEND chunk).
        const badTextCrc = Buffer.from(png);
        badTextCrc[badTextCrc.length - 13] ^= 0xFF;
        expect(() => extractTextChunks(badTextCrc)).toThrow(/^CRC values for tEXt header do not match/);
        expect(() => extractCharacterCardText(badTextCrc)).toThrow(/^CRC values for tEXt header do not match/);

        // Bad header.
        expect(() => extractTextChunks(Buffer.from('not a png'))).toThrow(/^Invalid \.png file header/);

        // Bounds overrun.
        const overrun = Buffer.from(png);
        overrun.writeUInt32BE(1024 * 1024, 8);
        expect(() => extractTextChunks(overrun)).toThrow(/^PNG chunk at byte 8 runs past the end of the file$/);

        // NUL inside tEXt value.
        const nulTextPng = encodePng([
            header,
            pixels,
            { name: 'tEXt', data: new Uint8Array(Buffer.from('chara\0abc\0def', 'latin1')) },
            end,
        ]);
        expect(() => extractCharacterCardText(nulTextPng)).toThrow(/^Invalid NULL character/);

        // No text chunks.
        expect(() => extractCharacterCardText(encodePng([header, pixels, end]))).toThrow(/^No PNG metadata\.$/);
    });
});

describe('Lock-free read-first reconcileEntityDateAdded', () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-date-added-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('skips locking when initialized and all IDs exist or are tombstoned, even if an active lock directory exists', () => {
        reconcileEntityDateAdded(tempRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
            { id: 'Bob.png', fallback: 2_000 },
        ], 5_000);
        removeEntityDateAdded(tempRoot, 'characters', 'Bob.png', 6_000);

        // Hold a fresh lock directory so any attempt to acquire proper-lockfile would block/retry for seconds.
        const lockPath = path.join(tempRoot, `${ENTITY_DATE_ADDED_FILE}.lock`);
        fs.mkdirSync(lockPath);
        const startedAt = performance.now();
        const result = reconcileEntityDateAdded(tempRoot, 'characters', [
            { id: 'Alice.png', fallback: 9_000 },
            { id: 'Bob.png', fallback: 2_000 },
        ], 10_000);
        const elapsedMs = performance.now() - startedAt;

        expect(result.get('Alice.png')).toBe(1_000);
        expect(result.has('Bob.png')).toBe(false);
        expect(elapsedMs).toBeLessThan(200);
        expect(fs.existsSync(lockPath)).toBe(true);
        fs.rmSync(lockPath, { recursive: true, force: true });
    });

    test('acquires the lock and writes when an entity ID is missing', () => {
        reconcileEntityDateAdded(tempRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
        ], 5_000);

        const dates = reconcileEntityDateAdded(tempRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
            { id: 'Carol.png', fallback: 3_000 },
        ], 8_000);

        expect(dates.get('Alice.png')).toBe(1_000);
        expect(dates.get('Carol.png')).toBe(8_000);
        const stored = JSON.parse(fs.readFileSync(path.join(tempRoot, ENTITY_DATE_ADDED_FILE), 'utf8'));
        expect(stored.characters.entries['Carol.png']).toBe(8_000);
    });
});

describe('calculateChatSize cache invalidation on append', () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-chat-size-'));
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('invalidates cached chat size when appending to a chat file even if parent directory mtime is unchanged', async () => {
        const charDir = path.join(tempRoot, 'Alice');
        fs.mkdirSync(charDir, { recursive: true });
        const chatFile = path.join(charDir, 'chat1.jsonl');
        fs.writeFileSync(chatFile, '{"mes":"hello"}\n', 'utf8');
        const initialSize = fs.statSync(chatFile).size;
        const fixedDirTime = new Date(1_700_000_000_000);
        fs.utimesSync(charDir, fixedDirTime, fixedDirTime);

        const first = await calculateChatSize(charDir);
        expect(first.chatSize).toBe(initialSize);
        expect(first.dateLastChat).toBeGreaterThan(0);

        // Second call with unchanged files hits the cache and returns the same totals.
        const second = await calculateChatSize(charDir);
        expect(second).toEqual(first);

        // Append bytes to the existing file while keeping the parent directory mtime identical.
        const extra = '{"mes":"appended message payload"}\n';
        fs.appendFileSync(chatFile, extra, 'utf8');
        fs.utimesSync(charDir, fixedDirTime, fixedDirTime);

        const afterAppend = await calculateChatSize(charDir);
        expect(afterAppend.chatSize).toBe(initialSize + Buffer.byteLength(extra, 'utf8'));

        // Adding a second chat file updates the total.
        const secondChat = path.join(charDir, 'chat2.jsonl');
        fs.writeFileSync(secondChat, '{"mes":"second"}\n', 'utf8');
        const afterAdd = await calculateChatSize(charDir);
        expect(afterAdd.chatSize).toBe(afterAppend.chatSize + fs.statSync(secondChat).size);

        // Removing the directory resets to zeros.
        fs.rmSync(charDir, { recursive: true, force: true });
        expect(await calculateChatSize(charDir)).toEqual({ chatSize: 0, dateLastChat: 0 });
    });
});

describe('/api/characters/all fileStat passthrough, bulk index query, and memoryCache population', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-chars-route-'));
        globalThis.DATA_ROOT = tempRoot;
        characterIndex.close();
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            characters: path.join(tempRoot, 'characters'),
            chats: path.join(tempRoot, 'chats'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            userImages: path.join(tempRoot, 'user', 'images'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'perf-test-user' }, directories };
            next();
        });
        app.use('/api/characters', charactersRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        characterIndex.close();
        globalThis.DATA_ROOT = defaultDataRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('uses one getDirectoryEntries query, skips per-card statSync, batches index writes, and populates memoryCache on SQLite hit', async () => {
        for (let i = 0; i < 5; i++) {
            const card = createV2Card();
            card.name = `Hero ${i}`;
            card.data.name = `Hero ${i}`;
            fs.writeFileSync(path.join(directories.characters, `Hero_${i}.png`), createCardPng(card));
        }

        const getSpy = jest.spyOn(characterIndex, 'get');
        const getDirSpy = jest.spyOn(characterIndex, 'getDirectoryEntries');
        const setManySpy = jest.spyOn(characterIndex, 'setMany');
        const statSyncSpy = jest.spyOn(fs, 'statSync');

        // Cold request: parses cards, writes in one setMany batch, and never calls per-card index.get or statSync on the PNGs.
        const coldRes = await fetch(`${baseUrl}/api/characters/all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(coldRes.status).toBe(200);
        const coldCards = await coldRes.json();
        expect(coldCards).toHaveLength(5);
        expect(getDirSpy).toHaveBeenCalledTimes(1);
        expect(getSpy).not.toHaveBeenCalled();
        expect(setManySpy).toHaveBeenCalledTimes(1);
        expect(setManySpy.mock.calls[0][0]).toHaveLength(5);
        const cardStatSyncCalls = statSyncSpy.mock.calls.filter(([p]) => String(p).endsWith('.png'));
        expect(cardStatSyncCalls).toHaveLength(0);

        // Simulate a card that is only in SQLite (not yet in memoryCache) by writing a new PNG and pre-seeding SQLite.
        const warmCard = createV2Card();
        warmCard.name = 'SqliteHit';
        warmCard.data.name = 'SqliteHit';
        const warmPath = path.join(directories.characters, 'SqliteHit.png');
        fs.writeFileSync(warmPath, createCardPng(warmCard));
        const warmStat = fs.statSync(warmPath);
        const sentinelJson = JSON.stringify({ ...warmCard, description: 'From SQLite', data: { ...warmCard.data, description: 'From SQLite' } });
        characterIndex.set(warmPath, warmStat, sentinelJson);

        // First listing loads SqliteHit from SQLite and populates memoryCache.
        const hitRes = await fetch(`${baseUrl}/api/characters/all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(hitRes.status).toBe(200);
        const hitCards = await hitRes.json();
        expect(hitCards.find(c => c.avatar === 'SqliteHit.png')?.description).toBe('From SQLite');

        // Replace SQLite entry with different text while keeping the file untouched; memoryCache must serve the cached entry.
        characterIndex.set(warmPath, warmStat, JSON.stringify({ ...warmCard, description: 'Changed in SQLite', data: { ...warmCard.data, description: 'Changed in SQLite' } }));
        const memRes = await fetch(`${baseUrl}/api/characters/all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(memRes.status).toBe(200);
        const memCards = await memRes.json();
        expect(memCards.find(c => c.avatar === 'SqliteHit.png')?.description).toBe('From SQLite');
    });
});

function createUserDirectories(root) {
    const dirs = {
        root,
        backups: path.join(root, 'backups'),
        novelAI_Settings: path.join(root, 'NovelAI Settings'),
        openAI_Settings: path.join(root, 'OpenAI Settings'),
        textGen_Settings: path.join(root, 'TextGen Settings'),
        koboldAI_Settings: path.join(root, 'KoboldAI Settings'),
        worlds: path.join(root, 'worlds'),
        themes: path.join(root, 'themes'),
        movingUI: path.join(root, 'movingUI'),
        quickreplies: path.join(root, 'QuickReplies'),
        instruct: path.join(root, 'instruct'),
        context: path.join(root, 'context'),
        sysprompt: path.join(root, 'sysprompt'),
        reasoning: path.join(root, 'reasoning'),
        inChatAgents: path.join(root, 'InChatAgents'),
    };

    for (const dirPath of Object.values(dirs)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify({ _version: 1, username: 'Bunny' }, null, 2));
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Alpha.json'), JSON.stringify({ temperature: 0.7 }));
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Broken.json'), '{not valid json');
    fs.writeFileSync(path.join(dirs.novelAI_Settings, 'Novel.json'), JSON.stringify({ temp: 1.0 }));
    fs.writeFileSync(path.join(dirs.textGen_Settings, 'TextGen.json'), JSON.stringify({ top_p: 0.9 }));
    fs.writeFileSync(path.join(dirs.koboldAI_Settings, 'Kobold.json'), JSON.stringify({ rep_pen: 1.1 }));
    fs.writeFileSync(path.join(dirs.worlds, 'LoreOne.json'), JSON.stringify({ entries: {} }));
    fs.writeFileSync(path.join(dirs.themes, 'Dark.json'), JSON.stringify({ name: 'Dark', nested: { accent: 'blue' } }));
    fs.writeFileSync(path.join(dirs.instruct, 'Default.json'), JSON.stringify({ name: 'Default' }));
    fs.writeFileSync(path.join(dirs.context, 'Story.json'), JSON.stringify({ name: 'Story' }));
    fs.writeFileSync(path.join(dirs.sysprompt, 'Helpful.json'), JSON.stringify({ name: 'Helpful' }));
    fs.writeFileSync(path.join(dirs.reasoning, 'Think.json'), JSON.stringify({ name: 'Think' }));
    fs.writeFileSync(path.join(dirs.inChatAgents, 'Helper.json'), JSON.stringify({ name: 'Helper' }));

    return dirs;
}

describe('PR 6 hot APIs: settings cache, ETag, and backup comparison', () => {
    let tempRoot;
    let directories;
    let server;
    let baseUrl;

    beforeAll(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-settings-'));
        directories = createUserDirectories(tempRoot);

        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((req, _res, next) => {
            req.user = { profile: { handle: 'perf-test-user' }, directories };
            next();
        });
        app.use('/api/settings', settingsRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    async function fetchSettings(headers = {}) {
        const res = await fetch(`${baseUrl}/api/settings/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: '{}',
        });
        const text = await res.text();
        return {
            status: res.status,
            etag: res.headers.get('etag'),
            body: text ? JSON.parse(text) : null,
        };
    }

    test('caches preset and parsed directory files by (mtimeMs, size) and emits a stable ETag', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const first = await fetchSettings();
        expect(first.status).toBe(200);
        expect(first.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
        expect(first.body.openai_setting_names).toEqual(['Alpha']);
        expect(first.body.themes).toEqual([{ name: 'Dark', nested: { accent: 'blue' } }]);
        expect(first.body.world_names).toEqual(['LoreOne']);

        const readSpy = jest.spyOn(fs, 'readFileSync');
        const second = await fetchSettings();
        expect(second.status).toBe(200);
        expect(second.etag).toBe(first.etag);
        expect(second.body).toEqual(first.body);
        expect(readSpy).not.toHaveBeenCalled();

        const notModified = await fetchSettings({ 'If-None-Match': first.etag });
        expect(notModified.status).toBe(304);
        expect(notModified.etag).toBe(first.etag);
        expect(notModified.body).toBeNull();
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('invalidates cached files and ETag automatically on modify, add, and delete', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const initial = await fetchSettings();
        expect(initial.status).toBe(200);

        // Modify an existing theme (change content + bump mtime to be immune to coarse FS clocks)
        const themePath = path.join(directories.themes, 'Dark.json');
        fs.writeFileSync(themePath, JSON.stringify({ name: 'Dark', nested: { accent: 'violet' } }));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(themePath, future, future);

        const afterModify = await fetchSettings({ 'If-None-Match': initial.etag });
        expect(afterModify.status).toBe(200);
        expect(afterModify.etag).not.toBe(initial.etag);
        expect(afterModify.body.themes).toEqual([{ name: 'Dark', nested: { accent: 'violet' } }]);

        // Add a new OpenAI preset and a new world file
        const addedPresetPath = path.join(directories.openAI_Settings, 'Beta.json');
        const addedWorldPath = path.join(directories.worlds, 'LoreTwo.json');
        fs.writeFileSync(addedPresetPath, JSON.stringify({ temperature: 0.95 }));
        fs.writeFileSync(addedWorldPath, JSON.stringify({ entries: {} }));

        const afterAdd = await fetchSettings({ 'If-None-Match': afterModify.etag });
        expect(afterAdd.status).toBe(200);
        expect(afterAdd.etag).not.toBe(afterModify.etag);
        expect(afterAdd.body.openai_setting_names).toEqual(['Alpha', 'Beta']);
        expect(afterAdd.body.world_names).toEqual(['LoreOne', 'LoreTwo']);

        // Delete the added files
        fs.unlinkSync(addedPresetPath);
        fs.unlinkSync(addedWorldPath);

        const afterDelete = await fetchSettings({ 'If-None-Match': afterAdd.etag });
        expect(afterDelete.status).toBe(200);
        expect(afterDelete.etag).not.toBe(afterAdd.etag);
        expect(afterDelete.body.openai_setting_names).toEqual(['Alpha']);
        expect(afterDelete.body.world_names).toEqual(['LoreOne']);
    });

    test('returns fresh copies from readAndParseFromDirectory and readPresetsFromDirectory so caller mutations do not poison the cache', () => {
        const themesFirst = readAndParseFromDirectory(directories.themes);
        expect(themesFirst.length).toBe(1);
        themesFirst[0].name = 'Mutated';
        themesFirst[0].nested.accent = 'corrupted';
        themesFirst.push({ name: 'Injected' });

        const themesSecond = readAndParseFromDirectory(directories.themes);
        expect(themesSecond).toEqual([{ name: 'Dark', nested: { accent: 'violet' } }]);

        const presetsFirst = readPresetsFromDirectory(directories.openAI_Settings, { removeFileExtension: true });
        presetsFirst.fileNames.push('Injected');
        presetsFirst.fileContents.push('{}');

        const presetsSecond = readPresetsFromDirectory(directories.openAI_Settings, { removeFileExtension: true });
        expect(presetsSecond.fileNames).toEqual(['Alpha']);
        expect(presetsSecond.fileContents.length).toBe(1);
    });

    test('areFilesEqual short-circuits on stat.size mismatch before reading file bytes', () => {
        const fileA = path.join(tempRoot, 'eq-a.bin');
        const fileB = path.join(tempRoot, 'eq-b.bin');
        const fileC = path.join(tempRoot, 'eq-c.bin');
        fs.writeFileSync(fileA, Buffer.from([1, 2, 3, 4]));
        fs.writeFileSync(fileB, Buffer.from([1, 2, 3, 4, 5]));
        fs.writeFileSync(fileC, Buffer.from([1, 2, 3, 9]));

        const readSpy = jest.spyOn(fs, 'readFileSync');
        expect(areFilesEqual(fileA, fileB)).toBe(false);
        expect(readSpy).not.toHaveBeenCalled();

        expect(areFilesEqual(fileA, fileA)).toBe(true);
        expect(areFilesEqual(fileA, fileC)).toBe(false);
        expect(areFilesEqual(fileA, path.join(tempRoot, 'missing.bin'))).toBe(false);
    });
});

describe('PR 6 hot APIs: tokenizers lazy loading, coalescing, encoding cache, LRU, and count-batch', () => {
    let server;
    let baseUrl;

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use('/api/tokenizers', tokenizersRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    });

    async function post(route, body) {
        const res = await fetch(`${baseUrl}/api/tokenizers${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return {
            status: res.status,
            body: await res.json(),
        };
    }

    test('importing tokenizers.js does not eagerly load tiktoken, web-tokenizers, sentencepiece-js, or anthropic tokenizer', () => {
        const tokenizersUrl = pathToFileURL(path.join(repoRoot, 'src', 'endpoints', 'tokenizers.js')).href;
        const utilUrl = pathToFileURL(path.join(repoRoot, 'src', 'util.js')).href;
        const configPath = path.join(repoRoot, 'default', 'config.yaml');
        const script = [
            'import { createRequire } from "node:module";',
            `const { setConfigFilePath } = await import(${JSON.stringify(utilUrl)});`,
            `setConfigFilePath(${JSON.stringify(configPath)});`,
            `await import(${JSON.stringify(tokenizersUrl)});`,
            'const req = createRequire(import.meta.url);',
            'const loaded = Object.keys(req.cache).filter(k => /tiktoken|web-tokenizers|sentencepiece-js|@anthropic-ai[\\\\/]tokenizer/.test(k));',
            'console.log(JSON.stringify({ loaded }));',
        ].join('\n');

        const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: repoRoot,
            encoding: 'utf8',
        });
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.loaded).toEqual([]);
    });

    test('keys Tiktoken tokenizer cache by canonical encoding rather than model name', () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});

        const o1 = getTiktokenTokenizer('o1');
        const gpt4o = getTiktokenTokenizer('gpt-4o');
        const gpt4 = getTiktokenTokenizer('gpt-4');
        const gpt35 = getTiktokenTokenizer('gpt-3.5-turbo');

        expect(o1).toBe(gpt4o);
        expect(gpt4).toBe(gpt35);
        expect(o1).not.toBe(gpt4);
    });

    test('coalesces concurrent SentencePieceTokenizer.get() and WebTokenizer.get() calls via #loadPromise', async () => {
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        const readFileSpy = jest.spyOn(fs.promises, 'readFile');

        const spTokenizer = getSentencepiceTokenizer('llama');
        const spResults = await Promise.all([spTokenizer.get(), spTokenizer.get(), spTokenizer.get()]);
        expect(spResults[0]).toBeTruthy();
        expect(spResults[1]).toBe(spResults[0]);
        expect(spResults[2]).toBe(spResults[0]);
        const llamaInstantiations = infoSpy.mock.calls.filter(
            args => args[0] === 'Instantiated the tokenizer for' && args[1] === 'llama',
        );
        expect(llamaInstantiations.length).toBe(1);

        const webTokenizer = getWebTokenizer('llama3');
        const webResults = await Promise.all([webTokenizer.get(), webTokenizer.get(), webTokenizer.get()]);
        expect(webResults[0]).toBeTruthy();
        expect(webResults[1]).toBe(webResults[0]);
        expect(webResults[2]).toBe(webResults[0]);
        const llama3Reads = readFileSpy.mock.calls.filter(args => String(args[0]).includes('llama3.json'));
        expect(llama3Reads.length).toBe(1);
    }, 30_000);

    test('validates POST /api/tokenizers/count-batch inputs and enforces caps', async () => {
        expect((await post('/count-batch', [])).status).toBe(400);
        expect((await post('/count-batch', { model: 'gpt-4o', texts: 'not-an-array' })).status).toBe(400);
        expect((await post('/count-batch', { model: 123, texts: ['ok'] })).status).toBe(400);
        expect((await post('/count-batch', { model: 'gpt-4o', texts: ['ok', 42] })).status).toBe(400);
        expect((await post('/count-batch', { model: 'gpt-4o', texts: new Array(501).fill('a') })).status).toBe(400);
        expect((await post('/count-batch', { model: 'gpt-4o', texts: ['x'.repeat(500_001)] })).status).toBe(400);

        const empty = await post('/count-batch', { model: 'gpt-4o', texts: [] });
        expect(empty).toEqual({ status: 200, body: { counts: [] } });
    });

    test('POST /api/tokenizers/count-batch shares LRU cache across models with the same encoding and deduplicates in-flight duplicates', async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});

        const o200kTokenizer = getTiktokenTokenizer('gpt-4o');
        const encodeSpy = jest.spyOn(o200kTokenizer, 'encode');

        const uniqueA = 'perf-lru-alpha-sentence-12345';
        const uniqueB = 'perf-lru-beta-sentence-67890';

        // Duplicate entries in one batch + concurrent request for the same text should only encode each unique text once.
        const [batchOne, batchConcurrent] = await Promise.all([
            post('/count-batch', { model: 'gpt-4o', texts: [uniqueA, uniqueB, uniqueA] }),
            post('/count-batch', { model: 'o1', texts: [uniqueA, uniqueB] }),
        ]);

        expect(batchOne.status).toBe(200);
        expect(batchConcurrent.status).toBe(200);
        expect(batchOne.body.counts.length).toBe(3);
        expect(batchOne.body.counts[0]).toBe(batchOne.body.counts[2]);
        expect(batchConcurrent.body.counts).toEqual([batchOne.body.counts[0], batchOne.body.counts[1]]);
        expect(encodeSpy).toHaveBeenCalledTimes(2);

        // Subsequent call under a different model name sharing o200k_base hits LRU with 0 encode calls.
        encodeSpy.mockClear();
        const cachedHit = await post('/count-batch', { model: 'gpt-5', texts: [uniqueB, uniqueA] });
        expect(cachedHit.status).toBe(200);
        expect(cachedHit.body.counts).toEqual([batchOne.body.counts[1], batchOne.body.counts[0]]);
        expect(encodeSpy).not.toHaveBeenCalled();
    });

    test('preserves exact encode/chunks output on hot-loop Tiktoken and single-pass SentencePiece endpoints', async () => {
        const sample = 'Hello SillyBunny! Line 1.\nLine 2 with emojis 🐰 and symbols [INST].';

        const gpt2Res = await post('/gpt2/encode', { text: sample });
        expect(gpt2Res.status).toBe(200);
        const gpt2Tokenizer = getTiktokenTokenizer('gpt2');
        const expectedIds = Array.from(gpt2Tokenizer.encode(sample));
        const decoder = new TextDecoder();
        const expectedChunks = expectedIds.map(id => decoder.decode(gpt2Tokenizer.decode(new Uint32Array([id]))));
        expect(gpt2Res.body.ids).toEqual(expectedIds);
        expect(gpt2Res.body.count).toBe(expectedIds.length);
        expect(gpt2Res.body.chunks).toEqual(expectedChunks);

        const gpt2Decoded = await post('/gpt2/decode', { ids: gpt2Res.body.ids });
        expect(gpt2Decoded.status).toBe(200);
        expect(gpt2Decoded.body.text).toBe(sample);

        const llamaRes = await post('/llama/encode', { text: sample });
        expect(llamaRes.status).toBe(200);
        const llamaInstance = await getSentencepiceTokenizer('llama').get();
        expect(llamaRes.body.ids).toEqual(llamaInstance.encodeIds(sample));
        expect(llamaRes.body.chunks).toEqual(llamaInstance.encodePieces(sample));
        expect(llamaRes.body.count).toBe(llamaRes.body.ids.length);

        const batchSp = await post('/count-batch', { model: 'llama', texts: [sample, 'short'] });
        expect(batchSp.status).toBe(200);
        expect(batchSp.body.counts[0]).toBe(llamaRes.body.count);
        expect(batchSp.body.counts[1]).toBe(llamaInstance.encodeIds('short').length);
    }, 30_000);
});

const originalThumbnailSettings = getThumbnailRuntimeSettings();
const originalMobileThumbnailSettings = getThumbnailMobileRuntimeSettings();
const originalThumbnailDimensions = getThumbnailDimensions();
const originalMobileThumbnailDimensions = getThumbnailMobileDimensions();
const nativeFetch = global.fetch;

// Node's fetch cannot load file: WASM URLs used by Jimp codecs in Jest.
async function fetchWithFileSupport(input, init) {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.protocol === 'file:') {
        const body = await fs.promises.readFile(fileURLToPath(url));
        return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
    }
    return nativeFetch(input, init);
}

// Valid 8x8 static PNG.
const STATIC_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
    'base64',
);
// Minimal JPEG signature header for content-type sniffing tests.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
// Minimal APNG buffer (PNG signature + IHDR + acTL chunk inside first 200 bytes).
const FAKE_APNG = Buffer.concat([
    STATIC_PNG.subarray(0, 33),
    Buffer.from([0x00, 0x00, 0x00, 0x08]),
    Buffer.from('acTL', 'ascii'),
    Buffer.alloc(12),
]);
// Minimal GIF89a header.
const FAKE_GIF89A = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1');
// Minimal static WebP and animated WebP headers.
const FAKE_STATIC_WEBP = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.alloc(16),
]);
const FAKE_ANIMATED_WEBP = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x28, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8X', 'ascii'),
    Buffer.alloc(14),
    Buffer.from('ANIM', 'ascii'),
    Buffer.alloc(10),
]);

function resetMockGit() {
    mockGit.checkIsRepo.mockReset().mockResolvedValue(true);
    mockGit.revparse.mockReset().mockResolvedValue('abcdef1234567890abcdef1234567890abcdef12');
    mockGit.branch.mockReset().mockResolvedValue({ current: 'main', tracking: 'origin/main', all: ['main'] });
    mockGit.fetch.mockReset().mockResolvedValue(undefined);
    mockGit.getRemotes.mockReset().mockResolvedValue([{ name: 'origin', refs: { fetch: 'https://example.test/ext.git' } }]);
    mockGit.raw.mockReset().mockResolvedValue('0\t0\n');
    mockGit.status.mockReset().mockResolvedValue({ isClean: () => true, files: [] });
    mockGit.pull.mockReset().mockResolvedValue(undefined);
    mockGit.stash.mockReset().mockResolvedValue(undefined);
}

describe('PR6 hot APIs media & extension optimizations', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let tempRoot;
    let directories;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'perf-test-user', admin: true },
                directories,
            };
            next();
        });
        app.use('/api/extensions', extensionsRouter);
        app.use('/thumbnail', thumbnailsRouter);
        app.use('/api/backgrounds', backgroundsRouter);
        app.use('/api/worldinfo', worldInfoRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        global.fetch = fetchWithFileSupport;
        resetMockGit();
        clearExtensionManifestCache();
        clearWorldInfoCaches();

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-media-'));
        directories = {
            root: tempRoot,
            avatars: path.join(tempRoot, 'User Avatars'),
            backgrounds: path.join(tempRoot, 'backgrounds'),
            characters: path.join(tempRoot, 'characters'),
            extensions: path.join(tempRoot, 'extensions'),
            worlds: path.join(tempRoot, 'worlds'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            thumbnailsBg: path.join(tempRoot, 'thumbnails', 'bg'),
            thumbnailsBgMobile: path.join(tempRoot, 'thumbnails', 'bg', 'mobile'),
            thumbnailsPersona: path.join(tempRoot, 'thumbnails', 'persona'),
            thumbnailsPersonaMobile: path.join(tempRoot, 'thumbnails', 'persona', 'mobile'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    });

    afterEach(async () => {
        // Drain any background metadata generation queued by /api/backgrounds/all before deleting tempRoot.
        await queueMetadataGeneration(tempRoot, [], 'bg');
        global.fetch = nativeFetch;
        setThumbnailRuntimeSettings(originalThumbnailSettings);
        setThumbnailMobileRuntimeSettings(originalMobileThumbnailSettings);
        setThumbnailDimensions(originalThumbnailDimensions);
        setThumbnailMobileDimensions(originalMobileThumbnailDimensions);
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    describe('extensions.js', () => {
        test('GET /discover defaults to { type, name } without manifest, and ?manifests=1 returns inline manifests', async () => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            const validDir = path.join(directories.extensions, 'AlphaExt');
            const brokenDir = path.join(directories.extensions, 'BrokenManifestExt');
            const missingDir = path.join(directories.extensions, 'EmptyHusk');
            fs.mkdirSync(validDir);
            fs.mkdirSync(brokenDir);
            fs.mkdirSync(missingDir);
            fs.writeFileSync(path.join(validDir, 'manifest.json'), JSON.stringify({ display_name: 'Alpha', version: '1.0.0' }));
            fs.writeFileSync(path.join(brokenDir, 'manifest.json'), '{not-valid-json');
            // Regular file directly inside extensions dir must be ignored by withFileTypes check.
            fs.writeFileSync(path.join(directories.extensions, 'README.txt'), 'ignore me');

            const defaultRes = await fetch(`${baseUrl}/api/extensions/discover`);
            expect(defaultRes.status).toBe(200);
            const defaultList = await defaultRes.json();
            const defaultAlpha = defaultList.find(item => item.name === 'third-party/AlphaExt');
            expect(defaultAlpha).toEqual({ type: 'local', name: 'third-party/AlphaExt' });
            expect('manifest' in defaultAlpha).toBe(false);
            expect(defaultList.some(item => item.name === 'third-party/EmptyHusk')).toBe(false);

            const inlineRes = await fetch(`${baseUrl}/api/extensions/discover?manifests=1`);
            expect(inlineRes.status).toBe(200);
            const inlineList = await inlineRes.json();
            const inlineAlpha = inlineList.find(item => item.name === 'third-party/AlphaExt');
            expect(inlineAlpha).toEqual({
                type: 'local',
                name: 'third-party/AlphaExt',
                manifest: { display_name: 'Alpha', version: '1.0.0' },
            });
            // Corrupt manifest is skipped cleanly rather than 500-ing discovery.
            expect(inlineList.some(item => item.name === 'third-party/BrokenManifestExt')).toBe(false);
            expect(inlineList.some(item => item.name === 'third-party/EmptyHusk')).toBe(false);

            // Editing manifest.json invalidates the cached inline manifest.
            const manifestPath = path.join(validDir, 'manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify({ display_name: 'Alpha v2', version: '2.0.0' }));
            const updatedRes = await fetch(`${baseUrl}/api/extensions/discover?manifests=1`);
            const updatedList = await updatedRes.json();
            expect(updatedList.find(item => item.name === 'third-party/AlphaExt')?.manifest).toEqual({
                display_name: 'Alpha v2',
                version: '2.0.0',
            });
        });

        test('POST /version calls git.fetch("origin") only once', async () => {
            const extDir = path.join(directories.extensions, 'TrackedExt');
            fs.mkdirSync(extDir);

            const response = await fetch(`${baseUrl}/api/extensions/version`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extensionName: 'TrackedExt', global: false }),
            });

            expect(response.status).toBe(200);
            const payload = await response.json();
            expect(payload).toEqual({
                currentBranchName: 'main',
                currentCommitHash: 'abcdef1234567890abcdef1234567890abcdef12',
                isUpToDate: true,
                remoteUrl: 'https://example.test/ext.git',
            });
            expect(mockGit.fetch).toHaveBeenCalledTimes(1);
            expect(mockGit.fetch).toHaveBeenCalledWith('origin');
        });

        test('POST /update calls git.fetch("origin") only once when up to date and when pulling', async () => {
            const extDir = path.join(directories.extensions, 'UpdateExt');
            fs.mkdirSync(extDir);

            const upToDateRes = await fetch(`${baseUrl}/api/extensions/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extensionName: 'UpdateExt', global: false }),
            });
            expect(upToDateRes.status).toBe(200);
            expect(await upToDateRes.json()).toMatchObject({
                shortCommitHash: 'abcdef1',
                isUpToDate: true,
                remoteUrl: 'https://example.test/ext.git',
            });
            expect(mockGit.fetch).toHaveBeenCalledTimes(1);
            expect(mockGit.pull).not.toHaveBeenCalled();

            resetMockGit();
            mockGit.raw.mockResolvedValue('0\t2\n');
            const behindRes = await fetch(`${baseUrl}/api/extensions/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extensionName: 'UpdateExt', global: false }),
            });
            expect(behindRes.status).toBe(200);
            expect(await behindRes.json()).toMatchObject({
                shortCommitHash: 'abcdef1',
                isUpToDate: false,
                remoteUrl: 'https://example.test/ext.git',
            });
            expect(mockGit.fetch).toHaveBeenCalledTimes(1);
            expect(mockGit.pull).toHaveBeenCalledTimes(1);
            expect(mockGit.pull).toHaveBeenCalledWith('origin', 'main');
        });
    });

    describe('thumbnails.js', () => {
        test('caches sniffed content-type by (path, ctimeMs, size) and invalidates when rewritten', async () => {
            const file = 'avatar.png';
            const originalPath = path.join(directories.characters, file);
            const cachedPath = path.join(directories.thumbnailsAvatar, file);
            fs.writeFileSync(originalPath, STATIC_PNG);
            fs.writeFileSync(cachedPath, STATIC_PNG);

            const openSpy = jest.spyOn(fs.promises, 'open');

            const first = await fetch(`${baseUrl}/thumbnail?type=avatar&file=${file}`);
            expect(first.status).toBe(200);
            expect(first.headers.get('content-type')).toMatch(/^image\/png\b/);
            expect(openSpy).toHaveBeenCalledTimes(1);

            const second = await fetch(`${baseUrl}/thumbnail?type=avatar&file=${file}`);
            expect(second.status).toBe(200);
            expect(second.headers.get('content-type')).toMatch(/^image\/png\b/);
            expect(openSpy).toHaveBeenCalledTimes(1);

            // Overwrite cached thumbnail with JPEG bytes (different size & ctimeMs).
            fs.writeFileSync(cachedPath, FAKE_JPEG);
            const third = await fetch(`${baseUrl}/thumbnail?type=avatar&file=${file}`);
            expect(third.status).toBe(200);
            expect(third.headers.get('content-type')).toMatch(/^image\/jpeg\b/);
            expect(openSpy).toHaveBeenCalledTimes(2);
        });

        test('sets Cache-Control: public, max-age=86400 for non-Firefox or ?t= and preserves Firefox no-store without ?t=', async () => {
            const file = 'cached.png';
            fs.writeFileSync(path.join(directories.characters, file), STATIC_PNG);
            fs.writeFileSync(path.join(directories.thumbnailsAvatar, file), STATIC_PNG);

            const chromiumRes = await fetch(`${baseUrl}/thumbnail?type=avatar&file=${file}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36' },
            });
            expect(chromiumRes.status).toBe(200);
            expect(chromiumRes.headers.get('cache-control')).toBe(THUMBNAIL_CACHE_CONTROL);

            const firefoxNoBust = await fetch(`${baseUrl}/thumbnail?type=avatar&file=${file}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0' },
            });
            expect(firefoxNoBust.status).toBe(200);
            expect(firefoxNoBust.headers.get('cache-control')).toBe('must-understand, no-store');

            const firefoxWithBust = await fetch(`${baseUrl}/thumbnail?type=avatar&file=${file}&t=1700000000000`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0' },
            });
            expect(firefoxWithBust.status).toBe(200);
            expect(firefoxWithBust.headers.get('cache-control')).toBe(THUMBNAIL_CACHE_CONTROL);
        });

        test('deduplicates concurrent thumbnail generation and reads original PNG only once', async () => {
            const file = 'concurrent.png';
            const originalPath = path.join(directories.backgrounds, file);
            fs.writeFileSync(originalPath, STATIC_PNG);
            setThumbnailRuntimeSettings({ enabled: true, format: 'png', quality: 100 });
            setThumbnailDimensions({ ...originalThumbnailDimensions, bg: [4, 4] });

            const readFileSpy = jest.spyOn(fs.promises, 'readFile');
            const results = await Promise.all([
                generateThumbnail(directories, 'bg', file, false, null, 'desktop'),
                generateThumbnail(directories, 'bg', file, false, null, 'desktop'),
                generateThumbnail(directories, 'bg', file, false, null, 'desktop'),
                generateThumbnail(directories, 'bg', file, false, null, 'desktop'),
            ]);

            const expectedPath = path.join(directories.thumbnailsBg, file);
            for (const result of results) {
                expect(result.path).toBe(expectedPath);
                expect(result.aspectRatio).toBe(1);
            }
            expect(fs.existsSync(expectedPath)).toBe(true);
            // In-flight deduplication ensures all 4 concurrent callers share 1 file read, decode, and write.
            const originalReads = readFileSpy.mock.calls.filter(([p]) => p === originalPath);
            expect(originalReads).toHaveLength(1);

            // Single uncached generation must read the PNG exactly once (no double read between APNG check and Jimp).
            readFileSpy.mockClear();
            const singleFile = 'single.png';
            const singleOriginalPath = path.join(directories.backgrounds, singleFile);
            fs.writeFileSync(singleOriginalPath, STATIC_PNG);
            const singleResult = await generateThumbnail(directories, 'bg', singleFile, false, null, 'desktop');
            expect(singleResult.path).toBe(path.join(directories.thumbnailsBg, singleFile));
            const singleReads = readFileSpy.mock.calls.filter(([p]) => p === singleOriginalPath);
            expect(singleReads).toHaveLength(1);
        });
    });

    describe('image-metadata.js and backgrounds.js', () => {
        test('caches image-metadata.json by (mtimeMs, size) and invalidates on write or disk edit', async () => {
            const initial = { version: 1, images: { 'backgrounds/a.png': { isAnimated: false, folderIds: [] } }, folders: [] };
            await writeMetadataIndex(tempRoot, initial);

            const parseSpy = jest.spyOn(JSON, 'parse');

            const cached1 = await readMetadataIndexCached(tempRoot);
            const cached2 = await readMetadataIndexCached(tempRoot);
            expect(cached1).toBe(cached2);
            expect(parseSpy).toHaveBeenCalledTimes(1);

            // readMetadataIndex returns a clone so mutations do not pollute the cache.
            const cloned = await readMetadataIndex(tempRoot);
            cloned.folders.push({ id: 'mutated', name: 'Mutated', thumbnailFile: '' });
            expect((await readMetadataIndexCached(tempRoot)).folders).toEqual([]);
            expect(parseSpy).toHaveBeenCalledTimes(1);

            // Updating via writeMetadataIndex invalidates cache.
            const updated = { version: 1, images: initial.images, folders: [{ id: 'f1', name: 'Nature', thumbnailFile: '' }] };
            await writeMetadataIndex(tempRoot, updated);
            const cached3 = await readMetadataIndexCached(tempRoot);
            expect(cached3.folders).toEqual([{ id: 'f1', name: 'Nature', thumbnailFile: '' }]);
            expect(parseSpy).toHaveBeenCalledTimes(2);

            // External disk edit with different content invalidates cache too.
            const indexPath = path.join(tempRoot, 'image-metadata.json');
            fs.writeFileSync(indexPath, JSON.stringify({ version: 1, images: {}, folders: [{ id: 'ext', name: 'External', thumbnailFile: '' }] }));
            const cached4 = await readMetadataIndexCached(tempRoot);
            expect(cached4.folders).toEqual([{ id: 'ext', name: 'External', thumbnailFile: '' }]);
            expect(parseSpy).toHaveBeenCalledTimes(3);
        });

        test('detects APNG, GIF, animated WebP, and static formats from header bytes alone', async () => {
            expect(isAnimatedImageHeader(STATIC_PNG)).toBe(false);
            expect(isAnimatedImageHeader(FAKE_APNG)).toBe(true);
            expect(isAnimatedImageHeader(FAKE_GIF89A)).toBe(true);
            expect(isAnimatedImageHeader(Buffer.from('GIF87a\x01\x00\x01\x00', 'latin1'))).toBe(true);
            expect(isAnimatedImageHeader(FAKE_STATIC_WEBP)).toBe(false);
            expect(isAnimatedImageHeader(FAKE_ANIMATED_WEBP)).toBe(true);
            expect(isAnimatedImageHeader(FAKE_JPEG)).toBe(false);

            const apngPath = path.join(directories.backgrounds, 'anim.png');
            const staticPath = path.join(directories.backgrounds, 'static.png');
            const gifPath = path.join(directories.backgrounds, 'loop.gif');
            const webpStaticPath = path.join(directories.backgrounds, 'still.webp');
            const webpAnimPath = path.join(directories.backgrounds, 'motion.webp');
            const videoPath = path.join(directories.backgrounds, 'clip.webm');
            fs.writeFileSync(apngPath, FAKE_APNG);
            fs.writeFileSync(staticPath, STATIC_PNG);
            fs.writeFileSync(gifPath, FAKE_GIF89A);
            fs.writeFileSync(webpStaticPath, FAKE_STATIC_WEBP);
            fs.writeFileSync(webpAnimPath, FAKE_ANIMATED_WEBP);
            fs.writeFileSync(videoPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

            expect(await readIsAnimatedFromHeader(apngPath)).toBe(true);
            expect(await readIsAnimatedFromHeader(staticPath)).toBe(false);
            expect(await readIsAnimatedFromHeader(gifPath)).toBe(true);
            expect(await readIsAnimatedFromHeader(webpStaticPath)).toBe(false);
            expect(await readIsAnimatedFromHeader(webpAnimPath)).toBe(true);

            // POST /api/backgrounds/all classifies every file from headers without waiting for Jimp decode.
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            const response = await fetch(`${baseUrl}/api/backgrounds/all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(response.status).toBe(200);
            const { images } = await response.json();
            const byName = Object.fromEntries(images.map(item => [item.filename, item]));
            expect(byName['anim.png']).toEqual({ filename: 'anim.png', isAnimated: true, mediaType: 'image' });
            expect(byName['static.png']).toEqual({ filename: 'static.png', isAnimated: false, mediaType: 'image' });
            expect(byName['loop.gif']).toEqual({ filename: 'loop.gif', isAnimated: true, mediaType: 'image' });
            expect(byName['still.webp']).toEqual({ filename: 'still.webp', isAnimated: false, mediaType: 'image' });
            expect(byName['motion.webp']).toEqual({ filename: 'motion.webp', isAnimated: true, mediaType: 'image' });
            expect(byName['clip.webm']).toEqual({ filename: 'clip.webm', isAnimated: true, mediaType: 'video' });
        });
    });

    describe('worldinfo.js', () => {
        test('POST /list caches headers by (mtimeMs, size) and invalidates only modified or deleted files', async () => {
            const bookA = path.join(directories.worlds, 'Alpha.json');
            const bookB = path.join(directories.worlds, 'Beta.json');
            fs.writeFileSync(bookA, JSON.stringify({ name: 'Alpha Book', extensions: { tag: 1 }, entries: {} }));
            fs.writeFileSync(bookB, JSON.stringify({ name: 'Beta Book', extensions: { tag: 2 }, entries: {} }));

            const readSpy = jest.spyOn(fs.promises, 'readFile');

            const firstRes = await fetch(`${baseUrl}/api/worldinfo/list`, { method: 'POST' });
            expect(firstRes.status).toBe(200);
            expect(await firstRes.json()).toEqual([
                { file_id: 'Alpha', name: 'Alpha Book', extensions: { tag: 1 } },
                { file_id: 'Beta', name: 'Beta Book', extensions: { tag: 2 } },
            ]);
            expect(readSpy).toHaveBeenCalledTimes(2);

            // Unchanged files hit the (mtimeMs, size) cache with zero file reads.
            readSpy.mockClear();
            const secondRes = await fetch(`${baseUrl}/api/worldinfo/list`, { method: 'POST' });
            expect(secondRes.status).toBe(200);
            expect(await secondRes.json()).toEqual([
                { file_id: 'Alpha', name: 'Alpha Book', extensions: { tag: 1 } },
                { file_id: 'Beta', name: 'Beta Book', extensions: { tag: 2 } },
            ]);
            expect(readSpy).toHaveBeenCalledTimes(0);

            // Modifying only Alpha re-reads only Alpha.
            fs.writeFileSync(bookA, JSON.stringify({ name: 'Alpha Updated', extensions: { tag: 99 }, entries: {} }));
            const thirdRes = await fetch(`${baseUrl}/api/worldinfo/list`, { method: 'POST' });
            expect(thirdRes.status).toBe(200);
            expect(await thirdRes.json()).toEqual([
                { file_id: 'Alpha', name: 'Alpha Updated', extensions: { tag: 99 } },
                { file_id: 'Beta', name: 'Beta Book', extensions: { tag: 2 } },
            ]);
            expect(readSpy).toHaveBeenCalledTimes(1);
            expect(readSpy).toHaveBeenCalledWith(bookA, 'utf8');

            // Deleting Beta drops it cleanly.
            fs.unlinkSync(bookB);
            readSpy.mockClear();
            const fourthRes = await fetch(`${baseUrl}/api/worldinfo/list`, { method: 'POST' });
            expect(fourthRes.status).toBe(200);
            expect(await fourthRes.json()).toEqual([
                { file_id: 'Alpha', name: 'Alpha Updated', extensions: { tag: 99 } },
            ]);
            expect(readSpy).toHaveBeenCalledTimes(0);
        });

        test('POST /get sends validated raw JSON without re-parsing unchanged files and preserves error semantics', async () => {
            const bookPath = path.join(directories.worlds, 'RawBook.json');
            const rawJson = '{\n    "name": "Raw Book",\n    "entries": {\n        "0": { "uid": 0, "content": "hello" }\n    }\n}';
            fs.writeFileSync(bookPath, rawJson);

            const parseSpy = jest.spyOn(JSON, 'parse');

            // First call validates JSON once and returns raw JSON text.
            const firstRes = await fetch(`${baseUrl}/api/worldinfo/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'RawBook' }),
            });
            expect(firstRes.status).toBe(200);
            expect(firstRes.headers.get('content-type')).toMatch(/^application\/json\b/);
            const firstText = await firstRes.text();
            expect(firstText).toBe(rawJson);
            expect(parseSpy.mock.calls.filter(([text]) => text === rawJson)).toHaveLength(1);

            // Second call on unchanged file skips JSON.parse completely.
            parseSpy.mockClear();
            const secondRes = await fetch(`${baseUrl}/api/worldinfo/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'RawBook' }),
            });
            expect(secondRes.status).toBe(200);
            expect(await secondRes.text()).toBe(rawJson);
            expect(parseSpy.mock.calls.filter(([text]) => text === rawJson)).toHaveLength(0);

            // Invalid JSON returns 500; stored null returns 404; missing book returns 404.
            jest.spyOn(console, 'error').mockImplementation(() => {});
            const brokenPath = path.join(directories.worlds, 'Broken.json');
            fs.writeFileSync(brokenPath, '{broken');
            const brokenRes = await fetch(`${baseUrl}/api/worldinfo/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Broken' }),
            });
            expect(brokenRes.status).toBe(500);

            const nullPath = path.join(directories.worlds, 'NullBook.json');
            fs.writeFileSync(nullPath, 'null');
            const nullRes = await fetch(`${baseUrl}/api/worldinfo/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'NullBook' }),
            });
            expect(nullRes.status).toBe(404);

            const missingRes = await fetch(`${baseUrl}/api/worldinfo/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'DoesNotExist' }),
            });
            expect(missingRes.status).toBe(404);
        });
    });
});
