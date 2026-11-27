/* eslint-disable playwright/no-standalone-expect */
/* global globalThis, Atomics */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import compression from 'compression';
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { imageSize } from 'image-size';

import { setConfigFilePath } from '../src/util.js';
import { Jimp, JimpMime } from '../src/jimp.js';
import { safeCover } from '../src/jimp-safe.js';
import {
    ANDROID_SQLITE_MMAP_SIZE,
    CharacterIndex,
    DESKTOP_SQLITE_MMAP_SIZE,
    getCharacterIndexPragmas,
    SQLITE_CACHE_SIZE_KIB,
} from '../src/character-index.js';
import {
    acquireChatFileLock,
    acquireChatFileLockAsync,
    getChatFileLockPath,
    withChatFileLockAsync,
} from '../src/chat-file-lock.js';
import {
    clearEntityDateAddedCache,
    ensureEntityDateAdded,
    reconcileEntityDateAdded,
    reconcileEntityDateAddedAsync,
    withEntityDateAddedLockAsync,
} from '../src/entity-date-added.js';
import {
    clearEntityLastChatCache,
    getEntityLastChat,
    setEntityLastChat,
    setEntityLastChatAsync,
    withEntityLastChatLockAsync,
} from '../src/entity-last-chat.js';
import getResponseCompressionMiddleware, {
    compressZstdBuffer,
    isZstdSupported,
    negotiateCompressionEncoding,
    parseAcceptEncoding,
    shouldCompressResponse,
} from '../src/middleware/response-compression.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const originalDataRoot = globalThis.DATA_ROOT;
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const {
    ANDROID_MAX_ACTIVE_TOKENIZERS,
    ANDROID_TOKENIZER_IDLE_TTL_MS,
    clearTokenCountCache,
    DESKTOP_MAX_ACTIVE_TOKENIZERS,
    DESKTOP_TOKENIZER_IDLE_TTL_MS,
    disposeAllTokenizers,
    getSentencepiceTokenizer,
    getTiktokenTokenizer,
    getTokenizerResidencyStatus,
    getWebTokenizer,
    isLowMemoryTokenizerHost,
    router: tokenizersRouter,
    TokenizerResidencyManager,
    tokenizerResidencyManager,
} = await import('../src/endpoints/tokenizers.js');

const {
    generateThumbnail,
    getThumbnailMobileRuntimeSettings,
    getThumbnailRuntimeSettings,
    normalizeThumbnailFormat,
    publicRouter: thumbnailPublicRouter,
    readFileHeader,
    readImageDimensionsHeaderFirst,
    setThumbnailMobileRuntimeSettings,
    setThumbnailRuntimeSettings,
} = await import('../src/endpoints/thumbnails.js');

const {
    AVERAGE_COLOR_MAX_DIMENSION,
    getAverageColorWithJimp,
    getThumbnailDimensions,
} = await import('../src/endpoints/image-metadata.js');

const { createLazyRouter } = await import('../src/server-startup.js');

const {
    clearGroupsCache,
    getGroupsCacheStats,
    router: groupsRouter,
} = await import('../src/endpoints/groups.js');

const {
    clearSpritesCache,
    getSpritesCacheStats,
    router: spritesRouter,
} = await import('../src/endpoints/sprites.js');

const {
    clearAssetsCache,
    getAssetsCacheStats,
    router: assetsRouter,
} = await import('../src/endpoints/assets.js');

const {
    applyStatIncrements,
    router: statsRouter,
} = await import('../src/endpoints/stats.js');

const {
    getWorldInfoEntrySearchText,
    getWorldInfoSearchCacheSize,
    invalidateWorldInfoSearchCache,
    primeWorldInfoSearchCache,
    pruneWorldInfoSearchCache,
    resetSearchContextAccessor,
    setSearchContextAccessor,
    WORLD_INFO_SEARCH_CACHE_MAX_ENTRIES,
} = await import('../public/scripts/sillybunny-search-entities.js');

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

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = zlib.crc32(Buffer.concat([typeBuffer, data]));
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function createMinimalPng(width, height, { extraChunks = [], idatPaddingBytes = 0 } = {}) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const chunks = [pngChunk('IHDR', ihdr)];

    if (idatPaddingBytes > 0) {
        chunks.push(pngChunk('IDAT', Buffer.alloc(idatPaddingBytes, 0x5a)));
    } else {
        const rowSize = 1 + width * 3;
        const raw = Buffer.alloc(rowSize * height);
        for (let y = 0; y < height; y++) {
            raw[y * rowSize] = 0;
            for (let x = 0; x < width; x++) {
                const offset = y * rowSize + 1 + x * 3;
                raw[offset] = 0x20;
                raw[offset + 1] = 0x60;
                raw[offset + 2] = 0xa0;
            }
        }
        chunks.push(pngChunk('IDAT', zlib.deflateSync(raw)));
    }

    for (const [chunkType, chunkData] of extraChunks) {
        chunks.push(pngChunk(chunkType, chunkData));
    }
    chunks.push(pngChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat([signature, ...chunks]);
}

function openRawHttpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                statusCode: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
            }));
            response.on('error', reject);
        });
        req.on('error', reject);
        if (timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => req.destroy(new Error(`No answer within ${timeoutMs} ms`)));
        }
        if (body !== null) {
            req.write(body);
        }
        req.end();
    });
}

function extractTopLevelFunctionSource(source, name) {
    const startRegex = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
    const match = startRegex.exec(source);
    if (!match) {
        throw new Error(`Could not find function ${name}`);
    }
    const startIndex = match.index;
    const openBrace = source.indexOf('{', startIndex);
    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(startIndex, i + 1);
            }
        }
    }
    throw new Error(`Unterminated function ${name}`);
}

afterAll(() => {
    disposeAllTokenizers();
    clearTokenCountCache();
    globalThis.DATA_ROOT = originalDataRoot;
    process.chdir(originalWorkingDirectory);
});

describe('1. Tokenizer WASM Residency Manager', () => {
    const originalConfig = tokenizerResidencyManager.getConfig();

    afterEach(() => {
        disposeAllTokenizers();
        clearTokenCountCache();
        tokenizerResidencyManager.configure(originalConfig);
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('bounds active heavy instances by LRU and calls dispose on eviction', () => {
        const disposed = [];
        const manager = new TokenizerResidencyManager({ maxActive: 2, idleTtlMs: 0 });

        manager.touch('tok-a', () => disposed.push('tok-a'));
        manager.touch('tok-b', () => disposed.push('tok-b'));
        expect(manager.getActiveKeys()).toEqual(['tok-a', 'tok-b']);

        // Refresh tok-a so tok-b becomes least-recently-used.
        manager.touch('tok-a', () => disposed.push('tok-a'));
        manager.touch('tok-c', () => disposed.push('tok-c'));

        expect(disposed).toEqual(['tok-b']);
        expect(manager.getActiveKeys()).toEqual(['tok-a', 'tok-c']);
    });

    test('disposes idle instances via an unref-ed TTL timer', () => {
        jest.useFakeTimers();
        const unrefMock = jest.fn();
        const setTimeoutSpy = jest.fn((fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref = unrefMock;
            return handle;
        });
        const disposed = [];
        const manager = new TokenizerResidencyManager({
            maxActive: ANDROID_MAX_ACTIVE_TOKENIZERS,
            idleTtlMs: ANDROID_TOKENIZER_IDLE_TTL_MS,
            setTimeoutFn: setTimeoutSpy,
            clearTimeoutFn: clearTimeout,
        });

        manager.touch('sp:llama', () => disposed.push('sp:llama'));
        expect(unrefMock).toHaveBeenCalledTimes(1);
        expect(manager.size).toBe(1);

        jest.advanceTimersByTime(ANDROID_TOKENIZER_IDLE_TTL_MS - 1);
        expect(disposed).toEqual([]);

        jest.advanceTimersByTime(1);
        expect(disposed).toEqual(['sp:llama']);
        expect(manager.size).toBe(0);
    });

    test('detects Android/Termux low-memory hosts and applies expected defaults', () => {
        expect(isLowMemoryTokenizerHost({ TERMUX_VERSION: '0.118.0' })).toBe(true);
        expect(isLowMemoryTokenizerHost({ ANDROID_ROOT: '/system' })).toBe(true);
        expect(isLowMemoryTokenizerHost({ SILLYBUNNY_ANDROID_APP: '1' })).toBe(true);
        expect(ANDROID_MAX_ACTIVE_TOKENIZERS).toBe(1);
        expect(DESKTOP_MAX_ACTIVE_TOKENIZERS).toBe(2);
        expect(ANDROID_TOKENIZER_IDLE_TTL_MS).toBe(90_000);
        expect(DESKTOP_TOKENIZER_IDLE_TTL_MS).toBe(300_000);
    });

    test('evicts real Tiktoken WASM encoders with .free(), preserves JS count cache, and lazily reloads', async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        tokenizerResidencyManager.configure({ maxActive: 1, idleTtlMs: 300_000 });

        const app = express();
        app.use(express.json());
        app.use('/api/tokenizers', tokenizersRouter);
        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        try {
            const gpt4 = getTiktokenTokenizer('gpt-4');
            const freeSpy = jest.spyOn(gpt4, 'free');
            expect(getTokenizerResidencyStatus().activeKeys).toEqual(['tiktoken:gpt-4']);

            // Count via HTTP to populate the lightweight JS count cache.
            const firstCountRes = await openRawHttpRequest(`${baseUrl}/api/tokenizers/openai/count?model=gpt-4`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ role: 'user', content: 'Residency cache check phrase' }]),
            });
            const firstCount = JSON.parse(firstCountRes.body.toString('utf8')).token_count;
            expect(firstCount).toBeGreaterThan(0);
            expect(getTokenizerResidencyStatus().countCacheSize).toBeGreaterThan(0);

            // Loading a second model with maxActive=1 evicts gpt-4 and calls .free().
            getTiktokenTokenizer('gpt-4o');
            expect(freeSpy).toHaveBeenCalledTimes(1);
            expect(getTokenizerResidencyStatus().activeKeys).toEqual(['tiktoken:gpt-4o']);

            // Evicting all WASM instances still preserves the lightweight JS count cache.
            disposeAllTokenizers();
            expect(getTokenizerResidencyStatus().activeCount).toBe(0);
            expect(getTokenizerResidencyStatus().countCacheSize).toBeGreaterThan(0);

            // Counting the already-cached phrase hits the JS cache without even reloading WASM!
            const cachedCountRes = await openRawHttpRequest(`${baseUrl}/api/tokenizers/openai/count?model=gpt-4`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ role: 'user', content: 'Residency cache check phrase' }]),
            });
            expect(JSON.parse(cachedCountRes.body.toString('utf8')).token_count).toBe(firstCount);
            expect(getTokenizerResidencyStatus().activeCount).toBe(0);

            // Next request for uncached text transparently reloads the WASM encoder.
            const reloaded = getTiktokenTokenizer('gpt-4');
            expect(reloaded).not.toBe(gpt4);
            expect(reloaded.encode('fresh reload').length).toBeGreaterThan(0);
            expect(getTokenizerResidencyStatus().activeKeys).toEqual(['tiktoken:gpt-4']);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('keeps a digest and the count in the token count cache, never the text', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/tokenizers', tokenizersRouter);
        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const countTokens = async (model, text) => {
            const response = await openRawHttpRequest(`${baseUrl}/api/tokenizers/openai/count?model=${model}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ role: 'user', content: text }]),
            });
            return JSON.parse(response.body.toString('utf8')).token_count;
        };

        const storedKeys = [];
        const originalSet = Map.prototype.set;
        const setSpy = jest.spyOn(Map.prototype, 'set').mockImplementation(function (key, value) {
            if (typeof key === 'string') {
                storedKeys.push(key);
            }
            return originalSet.call(this, key, value);
        });

        try {
            // One request per cached code path: Tiktoken values, the Claude web tokenizer and Sentencepiece.
            for (const model of ['gpt-4', 'claude', 'llama']) {
                const text = `private chat line for ${model} `.repeat(200);
                const sizeBefore = getTokenizerResidencyStatus().countCacheSize;

                const firstCount = await countTokens(model, text);
                expect(firstCount).toBeGreaterThan(0);
                expect(getTokenizerResidencyStatus().countCacheSize).toBeGreaterThan(sizeBefore);
                expect(storedKeys.filter(key => key.includes('private chat line'))).toEqual([]);

                const cacheKeys = storedKeys.filter(key => key.includes('\0'));
                expect(cacheKeys.length).toBeGreaterThan(0);
                for (const key of cacheKeys) {
                    expect(key.length).toBeLessThan(128);
                }

                disposeAllTokenizers();
                expect(await countTokens(model, text)).toBe(firstCount);
                expect(getTokenizerResidencyStatus().activeCount).toBe(0);
            }
        } finally {
            setSpy.mockRestore();
            await new Promise(resolve => server.close(resolve));
        }
    }, 60_000);

    test('disposes SentencePieceProcessor and ClaudeTokenizer WASM instances cleanly and reloads on demand', async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        tokenizerResidencyManager.configure({ maxActive: 1, idleTtlMs: 300_000 });

        const claudeWrapper = getWebTokenizer('claude');
        const claudeFirst = await claudeWrapper.get();
        expect(claudeFirst).toBeTruthy();
        const claudeFreeSpy = jest.spyOn(claudeFirst.tokenizer, 'free');
        expect(getTokenizerResidencyStatus().activeKeys).toEqual(['web:claude']);

        const spWrapper = getSentencepiceTokenizer('llama');
        const spFirst = await spWrapper.get();
        expect(spFirst).toBeTruthy();
        expect(claudeFreeSpy).toHaveBeenCalledTimes(1);
        expect(getTokenizerResidencyStatus().activeKeys).toEqual(['sp:llama']);

        const deleteSpy = jest.spyOn(spFirst.processor, 'delete');
        disposeAllTokenizers();
        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(spFirst.processor).toBeNull();
        expect(spFirst.sentencepiece).toBeNull();
        expect(getTokenizerResidencyStatus().activeCount).toBe(0);

        const claudeReloaded = await claudeWrapper.get();
        expect(claudeReloaded).not.toBe(claudeFirst);
        expect(claudeReloaded.encode('hello world').length).toBeGreaterThan(0);
    }, 30_000);
});

describe('2. Image & Thumbnail Pipeline Modernization', () => {
    const originalThumbnailSettings = getThumbnailRuntimeSettings();
    const originalMobileSettings = getThumbnailMobileRuntimeSettings();
    let tempRoot;

    beforeEach(() => {
        global.fetch = fetchWithFileSupport;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-media-'));
    });

    afterEach(() => {
        global.fetch = nativeFetch;
        setThumbnailRuntimeSettings(originalThumbnailSettings);
        setThumbnailMobileRuntimeSettings(originalMobileSettings);
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('safeCover enlarges by default and keeps the source size only with withoutEnlargement', () => {
        const enlarged = new Jimp({ width: 400, height: 600, color: 0x336699ff });
        safeCover(enlarged, { w: 864, h: 1280 });
        expect(enlarged.bitmap.width).toBe(864);
        expect(enlarged.bitmap.height).toBe(1280);

        const smallCard = new Jimp({ width: 400, height: 600, color: 0x336699ff });
        safeCover(smallCard, { w: 864, h: 1280, withoutEnlargement: true });
        expect(smallCard.bitmap.width).toBe(400);
        expect(smallCard.bitmap.height).toBe(593);

        const largeCard = new Jimp({ width: 1600, height: 2400, color: 0x336699ff });
        safeCover(largeCard, { w: 400, h: 600 });
        expect(largeCard.bitmap.width).toBe(400);
        expect(largeCard.bitmap.height).toBe(600);
    });

    test('a 300x300 source is enlarged by the avatar crop path and not by the thumbnail path', async () => {
        const { applyAvatarCropResize } = await import('../src/endpoints/characters.js');
        const sourcePng = createMinimalPng(300, 300);

        const cropped = await applyAvatarCropResize(await Jimp.read(sourcePng), {
            x: 0,
            y: 0,
            width: 300,
            height: 300,
            want_resize: true,
        });
        expect(imageSize(cropped)).toMatchObject({ width: 512, height: 768 });

        const directories = {
            characters: path.join(tempRoot, 'characters'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(directories.characters, 'Small.png'), sourcePng);
        setThumbnailRuntimeSettings({ enabled: true, format: 'png', quality: 90 });

        const result = await generateThumbnail(directories, 'avatar', 'Small.png', true);
        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, 'Small.png'));
        const thumbnailSize = imageSize(fs.readFileSync(result.path));
        const [boxWidth, boxHeight] = getThumbnailDimensions().avatar;
        expect(thumbnailSize.width).toBeLessThanOrEqual(300);
        expect(thumbnailSize.height).toBeLessThanOrEqual(300);
        expect(thumbnailSize.width / thumbnailSize.height).toBeCloseTo(boxWidth / boxHeight, 1);
    });

    test('stripped Jimp keeps resize + WebP MIME and drops unused plugins', () => {
        const img = new Jimp({ width: 16, height: 16, color: 0xff0000ff });
        expect(typeof img.resize).toBe('function');
        expect(JimpMime.webp).toBe('image/webp');
        for (const removedMethod of ['fisheye', 'displace', 'circle', 'blit', 'quantize', 'threshold', 'sepia']) {
            expect(img[removedMethod]).toBeUndefined();
        }
    });

    test('thumbnails support WebP format validation, encoding, and RIFF/WEBP content-type sniffing', async () => {
        expect(normalizeThumbnailFormat('webp')).toBe('webp');
        expect(normalizeThumbnailFormat('WEBP')).toBe('webp');
        expect(normalizeThumbnailFormat('png')).toBe('png');
        expect(normalizeThumbnailFormat('jpg')).toBe('jpg');
        expect(normalizeThumbnailFormat('invalid', 'jpg')).toBe('jpg');

        const directories = {
            root: tempRoot,
            avatars: path.join(tempRoot, 'User Avatars'),
            backgrounds: path.join(tempRoot, 'backgrounds'),
            characters: path.join(tempRoot, 'characters'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            thumbnailsBg: path.join(tempRoot, 'thumbnails', 'bg'),
            thumbnailsBgMobile: path.join(tempRoot, 'thumbnails', 'bg', 'mobile'),
            thumbnailsPersona: path.join(tempRoot, 'thumbnails', 'persona'),
            thumbnailsPersonaMobile: path.join(tempRoot, 'thumbnails', 'persona', 'mobile'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const sourcePng = createMinimalPng(32, 48);
        fs.writeFileSync(path.join(directories.characters, 'Card.png'), sourcePng);
        setThumbnailRuntimeSettings({ enabled: true, format: 'webp', quality: 82 });
        expect(getThumbnailRuntimeSettings().format).toBe('webp');

        const app = express();
        app.use((req, _res, next) => {
            req.user = { profile: { handle: 'thumb-webp' }, directories };
            next();
        });
        app.use('/thumbnail', thumbnailPublicRouter);
        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });

        try {
            const res = await openRawHttpRequest(`http://127.0.0.1:${server.address().port}/thumbnail?type=avatar&file=Card.png`);
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toMatch(/^image\/webp\b/);
            expect(res.body.subarray(0, 4).toString('ascii')).toBe('RIFF');
            expect(res.body.subarray(8, 12).toString('ascii')).toBe('WEBP');
            expect(imageSize(res.body).type).toBe('webp');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('warm thumbnail dimension check uses bounded header read without full-file fs.readFileSync', async () => {
        const directories = {
            characters: path.join(tempRoot, 'characters'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const largePng = createMinimalPng(64, 96, { idatPaddingBytes: 256 * 1024 });
        const origPath = path.join(directories.characters, 'Big.png');
        const thumbPath = path.join(directories.thumbnailsAvatar, 'Big.png');
        fs.writeFileSync(origPath, largePng);
        fs.writeFileSync(thumbPath, largePng);
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(origPath, past, past);

        const header = await readFileHeader(thumbPath, 512);
        expect(header.length).toBe(512);
        expect(await readImageDimensionsHeaderFirst(thumbPath, largePng.length)).toMatchObject({ width: 64, height: 96, type: 'png' });

        const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
        const readFileAsyncSpy = jest.spyOn(fs.promises, 'readFile');
        const result = await generateThumbnail(directories, 'avatar', 'Big.png', false, false, 'desktop');

        expect(result.path).toBe(thumbPath);
        expect(result.aspectRatio).toBeCloseTo(64 / 96, 4);
        expect(readFileSyncSpy).not.toHaveBeenCalled();
        expect(readFileAsyncSpy).not.toHaveBeenCalled();
    });

    test('getAverageColorWithJimp downscales >256px images before 1x1 reduction and preserves hex output', async () => {
        const img = new Jimp({ width: 320, height: 320, color: 0x336699ff });
        const pngBuffer = await img.getBuffer(JimpMime.png);
        expect(AVERAGE_COLOR_MAX_DIMENSION).toBe(256);

        const resizeCalls = [];
        const originalRead = Jimp.read.bind(Jimp);
        jest.spyOn(Jimp, 'read').mockImplementation(async (...args) => {
            const decoded = await originalRead(...args);
            const originalResize = decoded.resize.bind(decoded);
            decoded.resize = (opts) => {
                resizeCalls.push(opts);
                return originalResize(opts);
            };
            return decoded;
        });

        const hex = await getAverageColorWithJimp(pngBuffer);

        expect(hex).toBe('#336699');
        expect(resizeCalls).toHaveLength(2);
        expect(resizeCalls[0].w).toBeLessThanOrEqual(256);
        expect(resizeCalls[0].h).toBeLessThanOrEqual(256);
        expect(resizeCalls[1]).toEqual({ w: 1, h: 1 });
    });
});

describe('3. Lazy Startup, Native Zstd, Async Locks, SQLite & Endpoint Caches', () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-perf-platform-'));
    });

    afterEach(() => {
        clearEntityDateAddedCache();
        clearEntityLastChatCache();
        clearGroupsCache();
        clearSpritesCache();
        clearAssetsCache();
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('createLazyRouter defers module loading until the first request', async () => {
        const routerLoader = jest.fn(async () => {
            const router = express.Router();
            router.get('/ping', (_req, res) => res.json({ pong: true }));
            return { router };
        });
        const app = express();
        app.use('/lazy', createLazyRouter(routerLoader));
        expect(routerLoader).not.toHaveBeenCalled();

        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        try {
            const first = await openRawHttpRequest(`http://127.0.0.1:${server.address().port}/lazy/ping`);
            const second = await openRawHttpRequest(`http://127.0.0.1:${server.address().port}/lazy/ping`);
            expect(first.statusCode).toBe(200);
            expect(JSON.parse(first.body.toString('utf8'))).toEqual({ pong: true });
            expect(second.statusCode).toBe(200);
            expect(routerLoader).toHaveBeenCalledTimes(1);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('createLazyRouter answers through next(error) when the cold router throws synchronously or fails to load', async () => {
        const unhandledRejections = [];
        const recordRejection = reason => unhandledRejections.push(reason);
        process.on('unhandledRejection', recordRejection);

        const app = express();
        const throwingLoader = jest.fn(async () => ({
            router: () => {
                throw new Error('router threw on dispatch');
            },
        }));
        const failingLoader = jest.fn(async () => {
            throw new Error('router failed to load');
        });
        app.use('/throws', createLazyRouter(throwingLoader));
        app.use('/fails', createLazyRouter(failingLoader));
        app.use((error, _req, res, _next) => {
            res.status(500).json({ message: error.message });
        });

        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        try {
            const thrown = await openRawHttpRequest(`${baseUrl}/throws/any`, { timeoutMs: 3000 });
            expect(thrown.statusCode).toBe(500);
            expect(JSON.parse(thrown.body.toString('utf8'))).toEqual({ message: 'router threw on dispatch' });

            const failed = await openRawHttpRequest(`${baseUrl}/fails/any`, { timeoutMs: 3000 });
            expect(failed.statusCode).toBe(500);
            expect(JSON.parse(failed.body.toString('utf8'))).toEqual({ message: 'router failed to load' });

            expect(unhandledRejections).toEqual([]);
        } finally {
            process.off('unhandledRejection', recordRejection);
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('native zstd negotiation compresses JSON and streamed responses while respecting q-values and SSE/no-transform', async () => {
        expect(isZstdSupported()).toBe(true);
        expect(parseAcceptEncoding('gzip;q=0.5, zstd;q=1.0').get('zstd')).toBe(1);
        expect(negotiateCompressionEncoding('zstd;q=0, gzip')).toBe('gzip');
        expect(negotiateCompressionEncoding('gzip;q=1, zstd;q=0.5')).toBe('gzip');
        expect(negotiateCompressionEncoding('zstd', { zstdSupported: false })).toBeNull();

        const rawPayload = Buffer.from('zstd payload check '.repeat(200));
        const directCompressed = await compressZstdBuffer(rawPayload);
        expect(zlib.zstdDecompressSync(directCompressed).equals(rawPayload)).toBe(true);

        const largeJson = { payload: 'compressible zstd text '.repeat(200) };
        const pipedFilePath = path.join(tempRoot, 'large-static.css');
        const pipedPayload = Buffer.from('.zstd-rule { color: #123456; padding: 8px; }\n'.repeat(4500));
        fs.writeFileSync(pipedFilePath, pipedPayload);

        const app = express();
        app.use(getResponseCompressionMiddleware());
        app.get('/json', (_req, res) => res.json(largeJson));
        app.get('/stream', (_req, res) => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.write('stream chunk one '.repeat(120));
            res.end('stream chunk two '.repeat(120));
        });
        app.get('/piped-file', (_req, res) => {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            fs.createReadStream(pipedFilePath).pipe(res);
        });
        app.get('/small', (_req, res) => res.json({ ok: true }));
        app.get('/no-transform', (_req, res) => {
            res.setHeader('Cache-Control', 'public, no-transform');
            res.json(largeJson);
        });
        app.get('/sse', (_req, res) => {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.flushHeaders();
            res.end('data: hello\n\n');
        });

        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        try {
            const jsonRes = await openRawHttpRequest(`${baseUrl}/json`, { headers: { 'Accept-Encoding': 'gzip;q=0.5, zstd' } });
            expect(jsonRes.headers['content-encoding']).toBe('zstd');
            expect(jsonRes.headers.vary?.toLowerCase()).toContain('accept-encoding');
            expect(JSON.parse(zlib.zstdDecompressSync(jsonRes.body).toString('utf8'))).toEqual(largeJson);

            const streamRes = await openRawHttpRequest(`${baseUrl}/stream`, { headers: { 'Accept-Encoding': 'zstd' } });
            expect(streamRes.headers['content-encoding']).toBe('zstd');
            expect(zlib.zstdDecompressSync(streamRes.body).toString('utf8')).toBe('stream chunk one '.repeat(120) + 'stream chunk two '.repeat(120));

            const pipedRes = await openRawHttpRequest(`${baseUrl}/piped-file`, { headers: { 'Accept-Encoding': 'zstd' } });
            expect(pipedRes.headers['content-encoding']).toBe('zstd');
            expect(zlib.zstdDecompressSync(pipedRes.body).equals(pipedPayload)).toBe(true);

            const smallRes = await openRawHttpRequest(`${baseUrl}/small`, { headers: { 'Accept-Encoding': 'zstd' } });
            expect(smallRes.headers['content-encoding']).toBeUndefined();

            const noTransformRes = await openRawHttpRequest(`${baseUrl}/no-transform`, { headers: { 'Accept-Encoding': 'zstd' } });
            expect(noTransformRes.headers['content-encoding']).toBeUndefined();

            const sseRes = await openRawHttpRequest(`${baseUrl}/sse`, { headers: { 'Accept-Encoding': 'zstd' } });
            expect(sseRes.headers['content-encoding']).toBeUndefined();
            expect(sseRes.body.toString('utf8')).toBe('data: hello\n\n');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('encoding negotiation picks zstd only when the client ranks it strictly above brotli and gzip', () => {
        const browserHeader = 'gzip, deflate, br, zstd';
        expect(negotiateCompressionEncoding(browserHeader)).toBe('br');
        expect(negotiateCompressionEncoding(browserHeader, { zstdSupported: false })).toBe('br');
        expect(negotiateCompressionEncoding('zstd, br')).toBe('br');
        expect(negotiateCompressionEncoding('br, zstd;q=0.9')).toBe('br');
        expect(negotiateCompressionEncoding('br;q=0.5, zstd;q=0.5, gzip;q=0.4')).toBe('br');
        expect(negotiateCompressionEncoding('gzip, br, zstd;q=0.5')).toBe('br');
        expect(negotiateCompressionEncoding('gzip, br;q=0.5, zstd;q=0.5')).toBe('gzip');

        expect(negotiateCompressionEncoding('gzip, zstd')).toBe('gzip');
        expect(negotiateCompressionEncoding('gzip, deflate, zstd')).toBe('gzip');
        expect(negotiateCompressionEncoding('gzip, br;q=0, zstd')).toBe('gzip');
        expect(negotiateCompressionEncoding('gzip, br;q=0.5, zstd')).toBe('gzip');
        expect(negotiateCompressionEncoding('gzip, deflate, zstd', { zstdSupported: false })).toBe('gzip');

        expect(negotiateCompressionEncoding('gzip;q=0.5, zstd;q=1')).toBe('zstd');
        expect(negotiateCompressionEncoding('gzip;q=0.5, br;q=0.5, zstd')).toBe('zstd');
        expect(negotiateCompressionEncoding('br;q=0.8, zstd')).toBe('zstd');
        expect(negotiateCompressionEncoding('br;q=0.8, zstd;q=0.9, gzip;q=0.7')).toBe('zstd');
        expect(negotiateCompressionEncoding('zstd')).toBe('zstd');
    });

    test('every Accept-Encoding that does not rank zstd strictly first gets the compression package answer byte for byte', async () => {
        const payload = { text: 'compressible response body for the negotiation order check '.repeat(150) };
        const mount = middleware => {
            const app = express();
            app.use(middleware);
            app.get('/json', (_req, res) => res.json(payload));
            return new Promise(resolve => {
                const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
            });
        };
        const servers = [
            await mount(getResponseCompressionMiddleware()),
            await mount(compression({ filter: shouldCompressResponse })),
        ];
        const [ours, reference] = servers.map(srv => `http://127.0.0.1:${srv.address().port}/json`);

        try {
            const request = (url, acceptEncoding) => openRawHttpRequest(url, { headers: { 'Accept-Encoding': acceptEncoding } });
            const expectedJson = JSON.stringify(payload);

            const browser = await request(ours, 'gzip, deflate, br, zstd');
            expect(browser.headers['content-encoding']).toBe('br');
            expect(zlib.brotliDecompressSync(browser.body).toString('utf8')).toBe(expectedJson);
            expect(browser.body.equals((await request(reference, 'gzip, deflate, br, zstd')).body)).toBe(true);

            const gzipOnly = await request(ours, 'gzip, deflate');
            expect(gzipOnly.headers['content-encoding']).toBe('gzip');
            expect(zlib.gunzipSync(gzipOnly.body).toString('utf8')).toBe(expectedJson);
            expect(gzipOnly.body.equals((await request(reference, 'gzip, deflate')).body)).toBe(true);

            for (const header of ['gzip, zstd', 'gzip, deflate, zstd']) {
                const gzipAndZstd = await request(ours, header);
                expect(gzipAndZstd.headers['content-encoding']).toBe('gzip');
                expect(zlib.gunzipSync(gzipAndZstd.body).toString('utf8')).toBe(expectedJson);
                expect(gzipAndZstd.body.equals((await request(reference, header)).body)).toBe(true);
            }

            const brotliAheadOfZstd = await request(ours, 'br, zstd;q=0.9');
            expect(brotliAheadOfZstd.headers['content-encoding']).toBe('br');
            expect(brotliAheadOfZstd.body.equals((await request(reference, 'br, zstd;q=0.9')).body)).toBe(true);

            const zstdRankedFirst = await request(ours, 'gzip;q=0.5, zstd;q=1');
            expect(zstdRankedFirst.headers['content-encoding']).toBe('zstd');
            expect(zlib.zstdDecompressSync(zstdRankedFirst.body).toString('utf8')).toBe(expectedJson);
        } finally {
            await Promise.all(servers.map(srv => new Promise(resolve => srv.close(resolve))));
        }
    });

    test('async lock queues serialize concurrent callers without calling Atomics.wait', async () => {
        const atomicsWaitSpy = jest.spyOn(Atomics, 'wait');
        const chatPath = path.join(tempRoot, 'chats', 'hero', 'chat.jsonl');
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.writeFileSync(chatPath, '{"chat_metadata":{}}\n', 'utf8');

        const order = [];
        const first = withChatFileLockAsync(chatPath, async () => {
            order.push('first-enter');
            await new Promise(resolve => setTimeout(resolve, 25));
            order.push('first-exit');
        });
        const second = (async () => {
            const release = await acquireChatFileLockAsync(chatPath);
            try {
                order.push('second-enter');
            } finally {
                await release();
            }
        })();

        await Promise.all([first, second]);
        expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);

        // Also test async mutex queues on entity-date-added & entity-last-chat.
        const userRoot = path.join(tempRoot, 'user-root');
        await Promise.all([
            reconcileEntityDateAddedAsync(userRoot, 'characters', [{ id: 'Alice.png', fallback: 1000 }], 2000),
            withEntityDateAddedLockAsync(userRoot, async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
            }),
            setEntityLastChatAsync(userRoot, 'Alice.png', 'chat-1'),
            withEntityLastChatLockAsync(userRoot, async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
            }),
        ]);

        // Warm steady-state reads hit stat-validated caches without acquiring locks or re-reading JSON.
        const readFileSpy = jest.spyOn(fs, 'readFileSync');
        expect(reconcileEntityDateAdded(userRoot, 'characters', [{ id: 'Alice.png', fallback: 9999 }], 3000).get('Alice.png')).toBe(1000);
        expect(ensureEntityDateAdded(userRoot, 'characters', 'Alice.png', 9999, 3000)).toBe(1000);
        expect(getEntityLastChat(userRoot, 'Alice.png')).toBe('chat-1');
        expect(setEntityLastChat(userRoot, 'Alice.png', 'chat-1')).toBe('chat-1');
        expect(readFileSpy).not.toHaveBeenCalled();
        expect(atomicsWaitSpy).not.toHaveBeenCalled();
    });

    test('the synchronous chat file lock waits for another process that holds the lock for a few seconds', async () => {
        const chatPath = path.join(tempRoot, 'chats', 'held-elsewhere.jsonl');
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        const holdMs = 2500;
        const holderScript = `
            const { createRequire } = require('node:module');
            const lockfile = createRequire(${JSON.stringify(path.join(repoRoot, 'package.json'))})('proper-lockfile');
            const release = lockfile.lockSync(${JSON.stringify(chatPath)}, {
                lockfilePath: ${JSON.stringify(getChatFileLockPath(chatPath))},
                realpath: false,
                stale: 300000,
            });
            process.stdout.write('held\\n');
            setTimeout(() => { release(); process.exit(0); }, ${holdMs});
        `;
        const holder = spawn(process.execPath, ['-e', holderScript], { stdio: ['ignore', 'pipe', 'inherit'] });
        const holderExit = new Promise(resolve => holder.once('exit', resolve));

        try {
            await new Promise((resolve, reject) => {
                holder.stdout.once('data', resolve);
                holder.once('error', reject);
                holder.once('exit', () => reject(new Error('The lock holder exited before it held the lock')));
            });

            const startedAt = Date.now();
            const release = acquireChatFileLock(chatPath);
            const waitedMs = Date.now() - startedAt;
            release();

            expect(waitedMs).toBeGreaterThan(holdMs - 500);
        } finally {
            holder.kill('SIGKILL');
            await holderExit;
        }
    }, 20_000);

    test('CharacterIndex tunes SQLite pragmas and wraps prune deletes in transactions with capped vacuum', async () => {
        const desktopPragmas = getCharacterIndexPragmas({ isAndroid: false });
        const androidPragmas = getCharacterIndexPragmas({ isAndroid: true });
        expect(desktopPragmas).toContain('PRAGMA temp_store = MEMORY');
        expect(desktopPragmas).toContain(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_KIB}`);
        expect(desktopPragmas).toContain(`PRAGMA mmap_size = ${DESKTOP_SQLITE_MMAP_SIZE}`);
        expect(androidPragmas).toContain(`PRAGMA mmap_size = ${ANDROID_SQLITE_MMAP_SIZE}`);

        const prevDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = tempRoot;
        const index = new CharacterIndex({ enabled: true });
        try {
            const charsDir = path.join(tempRoot, 'user', 'characters');
            fs.mkdirSync(charsDir, { recursive: true });
            const keepFile = path.join(charsDir, 'Keep.png');
            const dropFile = path.join(charsDir, 'Drop.png');
            fs.writeFileSync(keepFile, 'keep');
            fs.writeFileSync(dropFile, 'drop');

            index.set(keepFile, fs.statSync(keepFile), 'keep-data');
            index.set(dropFile, fs.statSync(dropFile), 'drop-data');

            index.pruneDirectory(charsDir, ['Keep.png']);
            expect(index.get(keepFile, fs.statSync(keepFile))).toBe('keep-data');
            expect(index.get(dropFile, fs.statSync(dropFile))).toBeUndefined();

            // Re-add Drop.png and remove file on disk so prune() deletes it inside BEGIN IMMEDIATE ... COMMIT + incremental_vacuum(200).
            index.set(dropFile, fs.statSync(dropFile), 'drop-data');
            fs.rmSync(dropFile);
            await index.prune([{ characters: charsDir }]);
            expect(index.get(keepFile, fs.statSync(keepFile))).toBe('keep-data');
        } finally {
            index.close();
            globalThis.DATA_ROOT = prevDataRoot;
        }
    });

    test('groups, sprites, and assets endpoints cache reads by (mtimeMs, size) and invalidate on writes/deletes', async () => {
        const directories = {
            root: tempRoot,
            groups: path.join(tempRoot, 'groups'),
            groupChats: path.join(tempRoot, 'group chats'),
            backups: path.join(tempRoot, 'backups'),
            characters: path.join(tempRoot, 'characters'),
            assets: path.join(tempRoot, 'assets'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Seed a group, a sprite, and an asset.
        const groupPath = path.join(directories.groups, 'g1.json');
        fs.writeFileSync(groupPath, JSON.stringify({ id: 'g1', name: 'Guild One', members: [], chats: [] }), 'utf8');
        const spriteDir = path.join(directories.characters, 'Alice');
        fs.mkdirSync(spriteDir, { recursive: true });
        fs.writeFileSync(path.join(spriteDir, 'joy.png'), createMinimalPng(4, 4));
        const bgmDir = path.join(directories.assets, 'bgm');
        fs.mkdirSync(bgmDir, { recursive: true });
        fs.writeFileSync(path.join(bgmDir, 'theme.mp3'), 'audio-bytes');

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle: 'cache-test' }, directories };
            next();
        });
        app.use('/api/groups', groupsRouter);
        app.use('/api/sprites', spritesRouter);
        app.use('/api/assets', assetsRouter);
        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        try {
            // Groups: second POST /all reuses parsed JSON cache without re-reading g1.json.
            const gFirst = await openRawHttpRequest(`${baseUrl}/api/groups/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(JSON.parse(gFirst.body.toString('utf8'))[0].name).toBe('Guild One');
            expect(getGroupsCacheStats().size).toBe(1);

            const readFileSpy = jest.spyOn(fs, 'readFileSync');
            const gSecond = await openRawHttpRequest(`${baseUrl}/api/groups/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(JSON.parse(gSecond.body.toString('utf8'))[0].name).toBe('Guild One');
            expect(readFileSpy).not.toHaveBeenCalledWith(groupPath, 'utf8');
            readFileSpy.mockRestore();

            // Group edit invalidates cache immediately.
            await openRawHttpRequest(`${baseUrl}/api/groups/edit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: 'g1', name: 'Guild Renamed', members: [], chats: [] }),
            });
            const gAfterEdit = await openRawHttpRequest(`${baseUrl}/api/groups/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(JSON.parse(gAfterEdit.body.toString('utf8'))[0].name).toBe('Guild Renamed');

            // Sprites: second GET /get hits cache; POST /delete invalidates.
            const sFirst = await openRawHttpRequest(`${baseUrl}/api/sprites/get?name=Alice`);
            expect(JSON.parse(sFirst.body.toString('utf8'))).toHaveLength(1);
            expect(getSpritesCacheStats().size).toBe(1);

            const readdirSpy = jest.spyOn(fs, 'readdirSync');
            const sSecond = await openRawHttpRequest(`${baseUrl}/api/sprites/get?name=Alice`);
            expect(JSON.parse(sSecond.body.toString('utf8'))).toHaveLength(1);
            expect(readdirSpy).not.toHaveBeenCalledWith(spriteDir);
            readdirSpy.mockRestore();

            await openRawHttpRequest(`${baseUrl}/api/sprites/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Alice', label: 'joy' }),
            });
            const sAfterDelete = await openRawHttpRequest(`${baseUrl}/api/sprites/get?name=Alice`);
            expect(JSON.parse(sAfterDelete.body.toString('utf8'))).toEqual([]);

            // Assets: second POST /get hits cache; POST /delete invalidates.
            const aFirst = await openRawHttpRequest(`${baseUrl}/api/assets/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(JSON.parse(aFirst.body.toString('utf8')).bgm).toEqual(['assets/bgm/theme.mp3']);
            expect(getAssetsCacheStats().size).toBe(1);

            const assetsReaddirSpy = jest.spyOn(fs, 'readdirSync');
            const aSecond = await openRawHttpRequest(`${baseUrl}/api/assets/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(JSON.parse(aSecond.body.toString('utf8')).bgm).toEqual(['assets/bgm/theme.mp3']);
            expect(assetsReaddirSpy).not.toHaveBeenCalled();
            assetsReaddirSpy.mockRestore();

            await openRawHttpRequest(`${baseUrl}/api/assets/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: 'bgm', filename: 'theme.mp3' }),
            });
            const aAfterDelete = await openRawHttpRequest(`${baseUrl}/api/assets/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            expect(JSON.parse(aAfterDelete.body.toString('utf8')).bgm).toEqual([]);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe('4. Per-Turn charStats Delta & Browser Memory / Off-Thread Helpers', () => {
    afterEach(() => {
        invalidateWorldInfoSearchCache();
        resetSearchContextAccessor();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('POST /api/stats/increment applies single and batched deltas while preserving /get and /update', async () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle: 'stats-delta-user' }, directories: {} };
            next();
        });
        app.use('/api/stats', statsRouter);
        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        try {
            // Seed via /update (backwards compatibility).
            const updateRes = await openRawHttpRequest(`${baseUrl}/api/stats/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    'Alice.png': {
                        total_gen_time: 1000,
                        user_word_count: 10,
                        non_user_word_count: 20,
                        user_msg_count: 1,
                        non_user_msg_count: 1,
                        total_swipe_count: 0,
                        date_first_chat: 1_700_000_000_000,
                        date_last_chat: 1_700_000_000_000,
                    },
                }),
            });
            expect(updateRes.statusCode).toBe(200);

            // Apply batched increment via /increment.
            const incRes = await openRawHttpRequest(`${baseUrl}/api/stats/increment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    increments: {
                        'Alice.png': {
                            total_gen_time: 500,
                            user_word_count: 4,
                            non_user_word_count: 12,
                            user_msg_count: 1,
                            non_user_msg_count: 1,
                            total_swipe_count: 2,
                            date_last_chat: 1_700_000_050_000,
                            date_first_chat: 1_700_000_050_000,
                        },
                        'Bob.png': {
                            user_msg_count: 1,
                            user_word_count: 7,
                            date_first_chat: 1_700_000_060_000,
                            date_last_chat: 1_700_000_060_000,
                        },
                    },
                }),
            });
            expect(incRes.statusCode).toBe(200);

            // Verify merged values via /get.
            const getRes = await openRawHttpRequest(`${baseUrl}/api/stats/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            const stats = JSON.parse(getRes.body.toString('utf8'));
            expect(stats['Alice.png']).toMatchObject({
                total_gen_time: 1500,
                user_word_count: 14,
                non_user_word_count: 32,
                user_msg_count: 2,
                non_user_msg_count: 2,
                total_swipe_count: 2,
                date_first_chat: 1_700_000_000_000,
                date_last_chat: 1_700_000_050_000,
            });
            expect(stats['Bob.png']).toMatchObject({
                user_msg_count: 1,
                user_word_count: 7,
                non_user_word_count: 0,
            });

            // Reject invalid / prototype-pollution payloads with 400.
            expect(applyStatIncrements('stats-delta-user', { avatar: '__proto__', delta: { user_msg_count: 1 } })).toBe(false);
            const badRes = await openRawHttpRequest(`${baseUrl}/api/stats/increment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(badRes.statusCode).toBe(400);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('client stats.js batches multiple turns into one debounced POST /api/stats/increment', async () => {
        jest.useFakeTimers();
        const savedFetch = globalThis.fetch;
        const savedToastr = globalThis.toastr;
        const fetchCalls = [];
        globalThis.toastr = { error: jest.fn(), success: jest.fn() };
        globalThis.fetch = jest.fn(async (url, init) => {
            fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
            return { ok: true, status: 200, json: async () => ({}) };
        });

        await jest.unstable_mockModule('../public/lib.js', () => ({ moment: () => ({}) }));
        await jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}), characters: [], this_chid: '0' }));
        await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ humanizeGenTime: () => '' }));
        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: jest.fn(), POPUP_TYPE: {} }));
        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ registerDebugFunction: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (s, ...v) => String.raw({ raw: s }, ...v), translate: v => v }));

        const statsClient = await import('../public/scripts/stats.js?perf-batch');
        statsClient.resetPendingStatIncrements();
        const chars = [{ name: 'Reisen', avatar: 'Reisen.png' }];

        try {
            await statsClient.statMesProcess({ is_user: true, mes: 'hello world' }, 'user', chars, '0', '');
            await statsClient.statMesProcess({ is_user: false, mes: 'one two three four' }, 'swipe', chars, '0', '');
            expect(fetchCalls).toHaveLength(0);
            expect(statsClient.getPendingStatIncrementsCount()).toBe(1);

            await jest.advanceTimersByTimeAsync(1500);
            expect(fetchCalls).toHaveLength(1);
            expect(fetchCalls[0].url).toBe('/api/stats/increment');
            expect(fetchCalls[0].body.increments['Reisen.png']).toMatchObject({
                user_msg_count: 1,
                user_word_count: 2,
                non_user_msg_count: 1,
                non_user_word_count: 4,
                total_swipe_count: 1,
            });
        } finally {
            statsClient.resetPendingStatIncrements();
            globalThis.fetch = savedFetch;
            globalThis.toastr = savedToastr;
        }
    });

    test('request-compression uses native CompressionStream("gzip") when available and falls back to fflate', async () => {
        const source = fs.readFileSync(path.join(repoRoot, 'public/scripts/request-compression.js'), 'utf8')
            .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/m, '')
            .replace(/\bexport\s+(?=async\s+function|function)/g, '');

        const fflateGzipMock = jest.fn((input, callback) => {
            const compressed = zlib.gzipSync(Buffer.from(input));
            callback(null, new Uint8Array(compressed));
            return () => {};
        });

        const loadModule = (gzipImpl) => new Function('gzip', `${source}\nreturn { setRequestCompressionConfig, compressRequest };`)(gzipImpl);
        const { setRequestCompressionConfig, compressRequest } = loadModule(fflateGzipMock);
        setRequestCompressionConfig({ enabled: true, minPayloadSize: 64, maxPayloadSize: 1024 * 1024, timeout: 4000 });

        const payload = JSON.stringify({ data: 'repeat compressible string '.repeat(80) });

        // Native CompressionStream path (available on Node 24 / Bun 1.4 / modern browsers).
        const nativeResult = await compressRequest({ body: payload, headers: { 'Content-Type': 'application/json' } });
        expect(nativeResult.headers.get('Content-Encoding')).toBe('gzip');
        expect(fflateGzipMock).not.toHaveBeenCalled();
        expect(zlib.gunzipSync(Buffer.from(nativeResult.body)).toString('utf8')).toBe(payload);

        // Automatic fallback to fflate when CompressionStream is unavailable.
        const originalCS = globalThis.CompressionStream;
        try {
            globalThis.CompressionStream = undefined;
            const fallbackResult = await compressRequest({ body: payload, headers: { 'Content-Type': 'application/json' } });
            expect(fallbackResult.headers.get('Content-Encoding')).toBe('gzip');
            expect(fflateGzipMock).toHaveBeenCalledTimes(1);
            expect(zlib.gunzipSync(Buffer.from(fallbackResult.body)).toString('utf8')).toBe(payload);

            // Automatic fallback to fflate when CompressionStream throws on construction.
            fflateGzipMock.mockClear();
            globalThis.CompressionStream = class BrokenCompressionStream {
                constructor() {
                    throw new TypeError('Unsupported format');
                }
            };
            const brokenFallback = await compressRequest({ body: payload, headers: { 'Content-Type': 'application/json' } });
            expect(brokenFallback.headers.get('Content-Encoding')).toBe('gzip');
            expect(fflateGzipMock).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.CompressionStream = originalCS;
        }
    });

    test('zero-copy DataView extractDataFromPng skips large IDAT payloads and bounds dateCache LRU at 500', () => {
        const utilsSource = fs.readFileSync(path.join(repoRoot, 'public/scripts/utils.js'), 'utf8');
        const extractFnSource = extractTopLevelFunctionSource(utilsSource, 'extractDataFromPng').replace(/^export\s+/, '');
        const extractDataFromPng = new Function(`${extractFnSource}\nreturn extractDataFromPng;`)();
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const cardPayload = { name: 'Reisen', description: 'Moon rabbit' };
        const base64Json = Buffer.from(JSON.stringify(cardPayload), 'utf8').toString('base64');
        const pngWithLargeIdat = createMinimalPng(64, 64, {
            idatPaddingBytes: 2 * 1024 * 1024,
            extraChunks: [
                ['tEXt', Buffer.from(`chara2\0${Buffer.from('{"wrong":true}').toString('base64')}`, 'latin1')],
                ['tEXt', Buffer.from(`chara\0${base64Json}`, 'latin1')],
            ],
        });

        // Wrap inside a larger ArrayBuffer with non-zero byteOffset to verify DataView offset handling.
        const padded = new Uint8Array(pngWithLargeIdat.length + 17);
        padded.set(pngWithLargeIdat, 17);
        const slicedView = padded.subarray(17);

        const startedAt = performance.now();
        const extracted = extractDataFromPng(slicedView, 'chara');
        const elapsedMs = performance.now() - startedAt;

        expect(extracted).toEqual(cardPayload);
        expect(elapsedMs).toBeLessThan(100);
        expect(extractDataFromPng(new Uint8Array([1, 2, 3, 4]))).toBeNull();

        // Verify dateCache LRU bound of 500 entries in public/scripts/utils.js.
        expect(utilsSource).toContain('const DATE_CACHE_MAX_ENTRIES = 500;');
        const timestampFnSource = extractTopLevelFunctionSource(utilsSource, 'timestampToMoment').replace(/^export\s+/, '');
        let momentInvocations = 0;
        const fakeMoment = (iso) => {
            momentInvocations++;
            return { iso, locale: () => ({ iso }) };
        };
        fakeMoment.invalid = () => ({ invalid: true });
        const { timestampToMoment, dateCache } = new Function('moment', 'parseTimestamp', 'getCurrentLocale', `
            const DATE_CACHE_MAX_ENTRIES = 500;
            const dateCache = new Map();
            ${timestampFnSource}
            return { timestampToMoment, dateCache };
        `)(fakeMoment, v => String(v), () => 'en');

        for (let i = 0; i < 600; i++) {
            timestampToMoment(`2026-01-01T00:00:${String(i).padStart(4, '0')}Z`);
        }
        expect(dateCache.size).toBe(500);
        const beforeHit = momentInvocations;
        timestampToMoment('2026-01-01T00:00:0599Z');
        expect(momentInvocations).toBe(beforeHit);
    });

    test('vectors/index.js bounds hashCache LRU at 2,000 entries', () => {
        const vectorsSource = fs.readFileSync(path.join(repoRoot, 'public/scripts/extensions/vectors/index.js'), 'utf8');
        expect(vectorsSource).toContain('const HASH_CACHE_MAX_ENTRIES = 2000;');
        const getStringHashSource = extractTopLevelFunctionSource(vectorsSource, 'getStringHash');

        let computeCalls = 0;
        const { getStringHash, hashCache } = new Function('calculateHash', `
            const HASH_CACHE_MAX_ENTRIES = 2000;
            const hashCache = new Map();
            ${getStringHashSource}
            return { getStringHash, hashCache };
        `)(str => {
            computeCalls++;
            return str.length;
        });

        for (let i = 0; i < 2200; i++) {
            getStringHash(`msg-${i}`);
        }
        expect(hashCache.size).toBe(2000);
        expect(hashCache.has('msg-0')).toBe(false);
        expect(hashCache.has('msg-2199')).toBe(true);

        const callsBeforeHit = computeCalls;
        expect(getStringHash('msg-2199')).toBe('msg-2199'.length);
        expect(computeCalls).toBe(callsBeforeHit);
    });

    test('sillybunny-search-entities.js bounds worldInfoSearchCache LRU and supports invalidation', async () => {
        expect(WORLD_INFO_SEARCH_CACHE_MAX_ENTRIES).toBe(256);
        const listeners = new Map();
        const eventSource = {
            on(event, handler) {
                listeners.set(event, handler);
            },
        };
        const names = Array.from({ length: 270 }, (_, i) => `Book-${i}`);
        setSearchContextAccessor(() => ({
            eventSource,
            eventTypes: { WORLDINFO_UPDATED: 'worldinfo_updated' },
            loadWorldInfo: async (name) => ({
                entries: { 0: { comment: `comment-${name}`, key: [`key-${name}`] } },
            }),
        }));

        await primeWorldInfoSearchCache({ names, budgetMs: 5000 });
        expect(getWorldInfoSearchCacheSize()).toBe(WORLD_INFO_SEARCH_CACHE_MAX_ENTRIES);
        expect(getWorldInfoEntrySearchText('Book-269')).toContain('comment-book-269');

        // Explicit single-book invalidation via WORLDINFO_UPDATED event.
        listeners.get('worldinfo_updated')('Book-269');
        expect(getWorldInfoEntrySearchText('Book-269')).toBe('');

        // Pruning drops books no longer in the active list.
        pruneWorldInfoSearchCache(['Book-268']);
        expect(getWorldInfoSearchCacheSize()).toBe(1);
        expect(getWorldInfoEntrySearchText('Book-268')).toContain('comment-book-268');

        invalidateWorldInfoSearchCache();
        expect(getWorldInfoSearchCacheSize()).toBe(0);
    });
});
