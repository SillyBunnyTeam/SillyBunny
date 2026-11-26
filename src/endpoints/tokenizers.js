import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { Tokenizer } from '@agnai/web-tokenizers';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';
import tiktoken from 'tiktoken';

import { convertClaudePrompt } from '../prompt-converters.js';
import { TEXTGEN_TYPES } from '../constants.js';
import { setAdditionalHeaders } from '../additional-headers.js';
import { getConfigValue, isValidUrl, trimV1 } from '../util.js';
// SillyBunny: detect Termux/Android low-RAM hosts to bound resident WASM tokenizers.
import { isNativeTermuxEnvironment } from '../runtime.js';

const require = createRequire(import.meta.url);
const { getTokenizer: getClaudeTokenizer } = require('@anthropic-ai/tokenizer');
const WEB_TOKENIZERS_MODULE_URL = pathToFileURL(require.resolve('@agnai/web-tokenizers')).href;

/**
 * @typedef { (req: import('express').Request, res: import('express').Response) => Promise<any> } TokenizationHandler
 */

/**
 * @type {{[key: string]: import('tiktoken').Tiktoken}} Tokenizers cache
 */
const tokenizersCache = {};

// SillyBunny: bound active off-heap WASM tokenizer instances (1 on Android/Termux, 2 on desktop)
// and dispose idle instances via an unref'd timer while keeping lightweight JS count caches warm.
export const DESKTOP_MAX_ACTIVE_TOKENIZERS = 2;
export const ANDROID_MAX_ACTIVE_TOKENIZERS = 1;
export const DESKTOP_TOKENIZER_IDLE_TTL_MS = 300_000;
export const ANDROID_TOKENIZER_IDLE_TTL_MS = 90_000;
const TOKEN_COUNT_CACHE_MAX_ENTRIES = 2048;
const TOKEN_COUNT_CACHE_MAX_TEXT_LENGTH = 8192;

/**
 * Detects whether the current host is an Android/Termux low-memory environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isLowMemoryTokenizerHost(env = process.env) {
    if (env === process.env && isNativeTermuxEnvironment()) {
        return true;
    }

    return Boolean(env?.TERMUX_VERSION)
        || env?.PREFIX === '/data/data/com.termux/files/usr'
        || Boolean(env?.ANDROID_ROOT)
        || env?.SILLYBUNNY_ANDROID_APP === '1'
        || env?.SILLYBUNNY_LOW_RAM === '1'
        || process.platform === 'android';
}

/**
 * Manages LRU residency and idle TTL disposal for heavy WASM tokenizer instances.
 */
export class TokenizerResidencyManager {
    /** @type {number} */
    #maxActive;
    /** @type {number} */
    #idleTtlMs;
    /** @type {() => number} */
    #now;
    /** @type {typeof setTimeout} */
    #setTimeoutFn;
    /** @type {typeof clearTimeout} */
    #clearTimeoutFn;
    /** @type {Map<string, { dispose: () => void, lastUsedAt: number, timer: any }>} */
    #entries = new Map();

    /**
     * @param {object} [options]
     * @param {number} [options.maxActive]
     * @param {number} [options.idleTtlMs]
     * @param {() => number} [options.now]
     * @param {typeof setTimeout} [options.setTimeoutFn]
     * @param {typeof clearTimeout} [options.clearTimeoutFn]
     */
    constructor({
        maxActive = isLowMemoryTokenizerHost() ? ANDROID_MAX_ACTIVE_TOKENIZERS : DESKTOP_MAX_ACTIVE_TOKENIZERS,
        idleTtlMs = isLowMemoryTokenizerHost() ? ANDROID_TOKENIZER_IDLE_TTL_MS : DESKTOP_TOKENIZER_IDLE_TTL_MS,
        now = () => Date.now(),
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
    } = {}) {
        this.#maxActive = Math.max(1, Math.trunc(Number(maxActive) || 1));
        this.#idleTtlMs = Math.max(0, Math.trunc(Number(idleTtlMs) || 0));
        this.#now = now;
        this.#setTimeoutFn = setTimeoutFn;
        this.#clearTimeoutFn = clearTimeoutFn;
    }

    get size() {
        return this.#entries.size;
    }

    getActiveKeys() {
        return [...this.#entries.keys()];
    }

    getConfig() {
        return {
            maxActive: this.#maxActive,
            idleTtlMs: this.#idleTtlMs,
        };
    }

    /**
     * Updates residency limits and immediately enforces maxActive.
     * @param {{ maxActive?: number, idleTtlMs?: number }} [options]
     */
    configure({ maxActive, idleTtlMs } = {}) {
        if (maxActive !== undefined) {
            this.#maxActive = Math.max(1, Math.trunc(Number(maxActive) || 1));
        }
        if (idleTtlMs !== undefined) {
            this.#idleTtlMs = Math.max(0, Math.trunc(Number(idleTtlMs) || 0));
            for (const [key, entry] of this.#entries.entries()) {
                this.#scheduleIdleTimer(key, entry);
            }
        }
        this.#evictOverflow();
    }

    /**
     * Registers or refreshes an active heavy tokenizer instance.
     * @param {string} key Unique residency key
     * @param {() => void} dispose Disposal callback freeing off-heap WASM resources
     */
    touch(key, dispose) {
        const existing = this.#entries.get(key);
        if (existing) {
            if (existing.timer) {
                this.#clearTimeoutFn(existing.timer);
                existing.timer = null;
            }
            this.#entries.delete(key);
        }

        const entry = {
            dispose: typeof dispose === 'function' ? dispose : (existing?.dispose ?? (() => {})),
            lastUsedAt: this.#now(),
            timer: null,
        };
        this.#entries.set(key, entry);
        this.#scheduleIdleTimer(key, entry);
        this.#evictOverflow(key);
    }

    /**
     * Evicts a specific tokenizer key and invokes its dispose callback once.
     * @param {string} key
     * @returns {boolean} True if an active entry was evicted
     */
    evict(key) {
        const entry = this.#entries.get(key);
        if (!entry) {
            return false;
        }
        this.#entries.delete(key);
        if (entry.timer) {
            this.#clearTimeoutFn(entry.timer);
            entry.timer = null;
        }
        try {
            entry.dispose();
        } catch (error) {
            console.warn(`Failed to dispose tokenizer '${key}':`, error);
        }
        return true;
    }

    /**
     * Evicts all entries whose idle duration has reached idleTtlMs.
     * @param {number} [currentTime]
     * @returns {string[]} Evicted keys
     */
    evictIdle(currentTime = this.#now()) {
        if (this.#idleTtlMs <= 0) {
            return [];
        }
        const evicted = [];
        for (const [key, entry] of [...this.#entries.entries()]) {
            if (currentTime - entry.lastUsedAt >= this.#idleTtlMs) {
                if (this.evict(key)) {
                    evicted.push(key);
                }
            }
        }
        return evicted;
    }

    /**
     * Evicts all resident tokenizers and cancels all idle timers.
     * @returns {string[]} Evicted keys
     */
    evictAll() {
        const evicted = [];
        for (const key of [...this.#entries.keys()]) {
            if (this.evict(key)) {
                evicted.push(key);
            }
        }
        return evicted;
    }

    #scheduleIdleTimer(key, entry) {
        if (entry.timer) {
            this.#clearTimeoutFn(entry.timer);
            entry.timer = null;
        }
        if (this.#idleTtlMs <= 0) {
            return;
        }
        const timer = this.#setTimeoutFn(() => {
            entry.timer = null;
            this.evict(key);
        }, this.#idleTtlMs);
        timer?.unref?.();
        entry.timer = timer;
    }

    #evictOverflow(protectedKey = null) {
        while (this.#entries.size > this.#maxActive) {
            let victimKey = null;
            for (const candidateKey of this.#entries.keys()) {
                if (candidateKey !== protectedKey) {
                    victimKey = candidateKey;
                    break;
                }
            }
            if (victimKey === null) {
                break;
            }
            this.evict(victimKey);
        }
    }
}

export const tokenizerResidencyManager = new TokenizerResidencyManager();

/** @type {Map<string, number>} Lightweight JS token count LRU preserved across WASM evictions. */
const tokenCountCache = new Map();

function getCachedTokenCount(cacheKey) {
    if (!tokenCountCache.has(cacheKey)) {
        return undefined;
    }
    const count = tokenCountCache.get(cacheKey);
    tokenCountCache.delete(cacheKey);
    tokenCountCache.set(cacheKey, count);
    return count;
}

function setCachedTokenCount(cacheKey, count) {
    if (tokenCountCache.has(cacheKey)) {
        tokenCountCache.delete(cacheKey);
    } else if (tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX_ENTRIES) {
        const oldestKey = tokenCountCache.keys().next().value;
        tokenCountCache.delete(oldestKey);
    }
    tokenCountCache.set(cacheKey, count);
}

/**
 * Returns a snapshot of active WASM tokenizer residency and JS count cache state.
 */
export function getTokenizerResidencyStatus() {
    return {
        ...tokenizerResidencyManager.getConfig(),
        activeCount: tokenizerResidencyManager.size,
        activeKeys: tokenizerResidencyManager.getActiveKeys(),
        countCacheSize: tokenCountCache.size,
    };
}

/**
 * Disposes all resident WASM tokenizers while preserving lightweight JS count caches.
 * @returns {string[]} Evicted residency keys
 */
export function disposeAllTokenizers() {
    return tokenizerResidencyManager.evictAll();
}

/**
 * Clears the lightweight JS token count cache.
 */
export function clearTokenCountCache() {
    tokenCountCache.clear();
}

/**
 * @type {string[]}
 */
export const TEXT_COMPLETION_MODELS = [
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-instruct-0914',
    'text-davinci-003',
    'text-davinci-002',
    'text-davinci-001',
    'text-curie-001',
    'text-babbage-001',
    'text-ada-001',
    'code-davinci-002',
    'code-davinci-001',
    'code-cushman-002',
    'code-cushman-001',
    'text-davinci-edit-001',
    'code-davinci-edit-001',
    'text-embedding-ada-002',
    'text-similarity-davinci-001',
    'text-similarity-curie-001',
    'text-similarity-babbage-001',
    'text-similarity-ada-001',
    'text-search-davinci-doc-001',
    'text-search-curie-doc-001',
    'text-search-babbage-doc-001',
    'text-search-ada-doc-001',
    'code-search-babbage-code-001',
    'code-search-ada-code-001',
];

const BYTES_PER_TOKEN = 3.35;
const IS_DOWNLOAD_ALLOWED = getConfigValue('enableDownloadableTokenizers', true, 'boolean');
const gunzip = promisify(zlib.gunzip);

/**
 * Guesstimates the token count for a string.
 * @param {string} str String to tokenize.
 * @returns {number} Token count.
 */
function guesstimate(str) {
    const byteLength = Buffer.byteLength(str, 'utf8');
    return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

/**
 * Gets a path to the tokenizer model. Downloads the model if it's a URL.
 * @param {string} model Model URL or path
 * @param {string|undefined} fallbackModel Fallback model path
 * @returns {Promise<string>} Path to the tokenizer model
 */
async function getPathToTokenizer(model, fallbackModel) {
    if (!isValidUrl(model)) {
        return model;
    }

    try {
        const url = new URL(model);

        if (!['https:', 'http:'].includes(url.protocol)) {
            throw new Error('Invalid URL protocol');
        }

        const fileName = url.pathname.split('/').pop();

        if (!fileName) {
            throw new Error('Failed to extract the file name from the URL');
        }

        const CACHE_PATH = path.join(globalThis.DATA_ROOT, '_cache');
        if (!fs.existsSync(CACHE_PATH)) {
            fs.mkdirSync(CACHE_PATH, { recursive: true });
        }

        // If an uncompressed version exists, return it
        const isCompressed = path.extname(fileName) === '.gz';
        const uncompressedName = path.basename(fileName, '.gz');
        const uncompressedPath = path.join(CACHE_PATH, uncompressedName);
        if (isCompressed && fs.existsSync(uncompressedPath)) {
            return uncompressedPath;
        }

        const cachedFile = path.join(CACHE_PATH, fileName);
        if (fs.existsSync(cachedFile)) {
            // If the file was downloaded manually
            if (isCompressed) {
                const compressedBuffer = await fs.promises.readFile(cachedFile);
                const decompressedBuffer = await gunzip(compressedBuffer);
                writeFileAtomicSync(uncompressedPath, decompressedBuffer);
                await fs.promises.unlink(cachedFile);
                return uncompressedPath;
            }
            return cachedFile;
        }

        if (!IS_DOWNLOAD_ALLOWED) {
            throw new Error('Downloading tokenizers is disabled, the model is not cached');
        }

        console.info('Downloading tokenizer model:', model);
        const response = await fetch(model);
        if (!response.ok) {
            throw new Error(`Failed to fetch the model: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (isCompressed) {
            const decompressedBuffer = await gunzip(arrayBuffer);
            writeFileAtomicSync(uncompressedPath, decompressedBuffer);
            return uncompressedPath;
        }

        writeFileAtomicSync(cachedFile, Buffer.from(arrayBuffer));
        return cachedFile;
    } catch (error) {
        const getLastSegment = str => str?.split('/')?.pop() || '';
        if (fallbackModel) {
            console.error(`Could not get a tokenizer from ${getLastSegment(model)}. Reason: ${error.message}. Using a fallback model: ${getLastSegment(fallbackModel)}.`);
            return fallbackModel;
        }

        throw new Error(`Failed to instantiate a tokenizer and fallback is not provided. Reason: ${error.message}`);
    }
}

/**
 * Sentencepiece tokenizer for tokenizing text.
 */
class SentencePieceTokenizer {
    // SillyBunny: track loading state, residency key, and piece cache for bounded WASM eviction and lazy reload.
    /**
     * @type {import('@agnai/sentencepiece-js').SentencePieceProcessor|null} Sentencepiece tokenizer instance
     */
    #instance = null;
    /**
     * @type {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>|null}
     */
    #loadingPromise = null;
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;
    /**
     * @type {string|undefined} Path to the fallback model
     */
    #fallbackModel;
    /**
     * @type {string} Residency key for LRU and idle eviction
     */
    #residencyKey;
    /**
     * @type {Map<string, number>} Piece cache cleared on WASM disposal
     */
    #pieceIdCache = new Map();

    /**
     * Creates a new Sentencepiece tokenizer.
     * @param {string} model Path to the tokenizer model
     * @param {string} [fallbackModel] Path to the fallback model
     */
    constructor(model, fallbackModel) {
        this.#model = model;
        this.#fallbackModel = fallbackModel;
        this.#residencyKey = `sp:${path.parse(model).name || model}`;
    }

    get residencyKey() {
        return this.#residencyKey;
    }

    // SillyBunny: dispose Emscripten SentencePiece WASM heap and piece caches on residency eviction or idle TTL.
    dispose() {
        const instance = this.#instance;
        this.#instance = null;
        this.#pieceIdCache.clear();
        if (!instance) {
            return;
        }
        try {
            instance.processor?.delete?.();
        } catch {
            // Ignore cleanup errors during disposal.
        }
        try {
            instance.sentencepiece?.FS?.unlink?.('sentencepiece.model');
        } catch {
            // Ignore missing virtual FS entry.
        }
        instance.processor = null;
        instance.sentencepiece = null;
    }

    /**
     * Gets the Sentencepiece tokenizer instance.
     * @returns {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>} Sentencepiece tokenizer instance
     */
    async get() {
        if (this.#instance) {
            // SillyBunny: refresh residency timestamp on reuse.
            tokenizerResidencyManager.touch(this.#residencyKey, () => this.dispose());
            return this.#instance;
        }

        if (this.#loadingPromise) {
            return this.#loadingPromise;
        }

        this.#loadingPromise = (async () => {
            try {
                const pathToModel = await getPathToTokenizer(this.#model, this.#fallbackModel);
                const instance = new SentencePieceProcessor();
                await instance.load(pathToModel);
                this.#instance = instance;
                // SillyBunny: track resident WASM instance for LRU and idle TTL eviction.
                tokenizerResidencyManager.touch(this.#residencyKey, () => this.dispose());
                console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
                return this.#instance;
            } catch (error) {
                console.error('Sentencepiece tokenizer failed to load: ' + this.#model, error);
                return null;
            } finally {
                this.#loadingPromise = null;
            }
        })();

        return this.#loadingPromise;
    }
}

/**
 * @returns {boolean} True when the server runtime needs a stable file URL for the tokenizer bootstrap.
 */
function shouldPatchWebTokenizerRuntimeLocation() {
    if (typeof document !== 'undefined') {
        return false;
    }

    const href = String(globalThis.location?.href ?? '').trim();
    if (!href) {
        return true;
    }

    try {
        createRequire(href);
        return false;
    } catch {
        return true;
    }
}

/**
 * @template T
 * @param {() => Promise<T>} callback Initializer that may load the tokenizer WASM module
 * @returns {Promise<T>}
 */
async function withWebTokenizerRuntimeLocation(callback) {
    if (!shouldPatchWebTokenizerRuntimeLocation()) {
        return callback();
    }

    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');

    try {
        // SillyBunny: some Bun/ARM server surfaces expose an empty location.href,
        // which makes @agnai/web-tokenizers pass '' to createRequire during WASM bootstrap.
        Object.defineProperty(globalThis, 'location', {
            value: { href: WEB_TOKENIZERS_MODULE_URL },
            configurable: true,
            writable: true,
        });
    } catch {
        return callback();
    }

    try {
        return await callback();
    } finally {
        if (originalDescriptor) {
            Object.defineProperty(globalThis, 'location', originalDescriptor);
        } else {
            delete globalThis.location;
        }
    }
}

/**
 * Web tokenizer for tokenizing text.
 */
class WebTokenizer {
    // SillyBunny: track loading state and residency key for bounded WASM eviction and lazy reload.
    /**
     * @type {Tokenizer|null} Web tokenizer instance
     */
    #instance = null;
    /**
     * @type {Promise<Tokenizer|null>|null}
     */
    #loadingPromise = null;
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;
    /**
     * @type {string|undefined} Path to the fallback model
     */
    #fallbackModel;
    /**
     * @type {string} Residency key for LRU and idle eviction
     */
    #residencyKey;

    /**
     * Creates a new Web tokenizer.
     * @param {string} model Path to the tokenizer model
     * @param {string} [fallbackModel] Path to the fallback model
     */
    constructor(model, fallbackModel) {
        this.#model = model;
        this.#fallbackModel = fallbackModel;
        const modelLeaf = model.split('/').pop() || model;
        this.#residencyKey = `web:${modelLeaf.replace(/\.(json|gz)+$/gi, '')}`;
    }

    get residencyKey() {
        return this.#residencyKey;
    }

    // SillyBunny: free off-heap WebTokenizer WASM memory on residency eviction or idle TTL.
    dispose() {
        const instance = this.#instance;
        this.#instance = null;
        if (!instance) {
            return;
        }
        try {
            instance.dispose?.();
        } catch {
            // Ignore disposal errors.
        }
        try {
            instance.free?.();
        } catch {
            // Ignore disposal errors.
        }
    }

    /**
     * Gets the Web tokenizer instance.
     * @returns {Promise<Tokenizer|null>} Web tokenizer instance
     */
    async get() {
        if (this.#instance) {
            // SillyBunny: refresh residency timestamp on reuse.
            tokenizerResidencyManager.touch(this.#residencyKey, () => this.dispose());
            return this.#instance;
        }

        if (this.#loadingPromise) {
            return this.#loadingPromise;
        }

        this.#loadingPromise = (async () => {
            let pathToModel = '';
            try {
                pathToModel = await getPathToTokenizer(this.#model, this.#fallbackModel);
                const fileBuffer = await fs.promises.readFile(pathToModel);
                const instance = await withWebTokenizerRuntimeLocation(() => Tokenizer.fromJSON(fileBuffer.toString('utf-8')));
                this.#instance = instance;
                // SillyBunny: track resident WASM instance for LRU and idle TTL eviction.
                tokenizerResidencyManager.touch(this.#residencyKey, () => this.dispose());
                console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
                return this.#instance;
            } catch (error) {
                console.error(`Web tokenizer failed to load model '${this.#model}' from path '${pathToModel}':`, error);
                return null;
            } finally {
                this.#loadingPromise = null;
            }
        })();

        return this.#loadingPromise;
    }
}

/**
 * Normalizes token ids into a Uint32Array so Bun-safe Tiktoken decode can consume them.
 * @param {ArrayLike<number> | number[]} ids
 * @returns {Uint32Array}
 */
function toUint32Array(ids) {
    if (ids instanceof Uint32Array) {
        return ids;
    }

    return Uint32Array.from(Array.from(ids || []), Number);
}

/**
 * Claude-compatible tokenizer wrapper backed by @anthropic-ai/tokenizer.
 */
class ClaudeTokenizerInstance {
    // SillyBunny: guard single .free() disposal when evicted by TokenizerResidencyManager.
    /** @type {boolean} */
    #disposed = false;

    /**
     * @param {ReturnType<typeof getClaudeTokenizer>} tokenizer
     */
    constructor(tokenizer) {
        this.tokenizer = tokenizer;
        this.decoder = new TextDecoder();
    }

    /**
     * @param {string} text
     * @returns {Uint32Array}
     */
    encode(text) {
        return this.tokenizer.encode(String(text).normalize('NFKC'), 'all');
    }

    /**
     * @param {ArrayLike<number> | number[]} ids
     * @returns {string}
     */
    decode(ids) {
        const textBytes = this.tokenizer.decode(toUint32Array(ids));
        return this.decoder.decode(textBytes);
    }

    // SillyBunny: free underlying tiktoken WASM encoder once without double-free risk.
    dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        try {
            this.tokenizer?.free?.();
        } catch {
            // Ignore disposal errors.
        }
        this.tokenizer = null;
    }
}

/**
 * Bun-safe Claude tokenizer.
 */
class ClaudeTokenizer {
    /**
     * @type {ClaudeTokenizerInstance | null}
     */
    #instance = null;

    get residencyKey() {
        return 'web:claude';
    }

    // SillyBunny: dispose Claude WASM tokenizer on residency eviction or idle TTL.
    dispose() {
        const instance = this.#instance;
        this.#instance = null;
        instance?.dispose?.();
    }

    /**
     * Gets the Claude tokenizer instance.
     * @returns {Promise<ClaudeTokenizerInstance | null>}
     */
    async get() {
        if (this.#instance) {
            // SillyBunny: refresh residency timestamp on reuse.
            tokenizerResidencyManager.touch(this.residencyKey, () => this.dispose());
            return this.#instance;
        }

        try {
            this.#instance = new ClaudeTokenizerInstance(getClaudeTokenizer());
            // SillyBunny: track resident WASM instance for LRU and idle TTL eviction.
            tokenizerResidencyManager.touch(this.residencyKey, () => this.dispose());
            console.info('Instantiated the tokenizer for claude');
            return this.#instance;
        } catch (error) {
            console.error('Claude tokenizer failed to load', error);
            return null;
        }
    }
}

const spp_llama = new SentencePieceTokenizer('src/tokenizers/llama.model');
const spp_nerd = new SentencePieceTokenizer('src/tokenizers/nerdstash.model');
const spp_nerd_v2 = new SentencePieceTokenizer('src/tokenizers/nerdstash_v2.model');
const spp_mistral = new SentencePieceTokenizer('src/tokenizers/mistral.model');
const spp_yi = new SentencePieceTokenizer('src/tokenizers/yi.model');
const spp_gemma = new SentencePieceTokenizer('src/tokenizers/gemma.model');
const spp_jamba = new SentencePieceTokenizer('src/tokenizers/jamba.model');
const claude_tokenizer = new ClaudeTokenizer();
const llama3_tokenizer = new WebTokenizer('src/tokenizers/llama3.json');
const commandRTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-r.json.gz', 'src/tokenizers/llama3.json');
const commandATokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-a.json.gz', 'src/tokenizers/llama3.json');
const qwen2Tokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz', 'src/tokenizers/llama3.json');
const nemoTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/nemo.json.gz', 'src/tokenizers/llama3.json');
const deepseekTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/deepseek.json.gz', 'src/tokenizers/llama3.json');

export const sentencepieceTokenizers = [
    'llama',
    'nerdstash',
    'nerdstash_v2',
    'mistral',
    'yi',
    'gemma',
    'jamba',
];

export const webTokenizers = [
    'claude',
    'llama3',
    'command-r',
    'command-a',
    'qwen2',
    'nemo',
    'deepseek',
];

/**
 * Gets the Sentencepiece tokenizer by the model name.
 * @param {string} model Sentencepiece model name
 * @returns {SentencePieceTokenizer|null} Sentencepiece tokenizer
 */
export function getSentencepiceTokenizer(model) {
    if (model.includes('llama')) {
        return spp_llama;
    }

    if (model.includes('nerdstash')) {
        return spp_nerd;
    }

    if (model.includes('mistral')) {
        return spp_mistral;
    }

    if (model.includes('nerdstash_v2')) {
        return spp_nerd_v2;
    }

    if (model.includes('yi')) {
        return spp_yi;
    }

    if (model.includes('gemma')) {
        return spp_gemma;
    }

    if (model.includes('jamba')) {
        return spp_jamba;
    }

    return null;
}

/**
 * Gets the Web tokenizer by the model name.
 * @param {string} model Web tokenizer model name
 * @returns {WebTokenizer|null} Web tokenizer
 */
export function getWebTokenizer(model) {
    if (model.includes('llama3')) {
        return llama3_tokenizer;
    }

    if (model.includes('claude')) {
        return claude_tokenizer;
    }

    if (model.includes('command-r')) {
        return commandRTokenizer;
    }

    if (model.includes('command-a')) {
        return commandATokenizer;
    }

    if (model.includes('qwen2')) {
        return qwen2Tokenizer;
    }

    if (model.includes('nemo')) {
        return nemoTokenizer;
    }

    if (model.includes('deepseek')) {
        return deepseekTokenizer;
    }

    return null;
}

/**
 * Counts the token ids for the given text using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @param {string} text Text to tokenize
 * @returns { Promise<{ids: number[], count: number}> } Tokenization result
 */
async function countSentencepieceTokens(tokenizer, text) {
    const instance = await tokenizer?.get();

    // Fallback to strlen estimation
    if (!instance) {
        return {
            ids: [],
            count: guesstimate(text),
        };
    }

    let cleaned = text; // cleanText(text); <-- cleaning text can result in an incorrect tokenization

    let ids = instance.encodeIds(cleaned);
    return {
        ids,
        count: ids.length,
    };
}

/**
 * Counts the tokens in the given array of objects using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer
 * @param {object[]} array Array of objects to tokenize
 * @returns {Promise<number>} Number of tokens
 */
async function countSentencepieceArrayTokens(tokenizer, array) {
    // SillyBunny: Use convertClaudePrompt for consistent token counting across all tokenizers.
    // The previous implementation using Object.values().join('\n\n') overcounted tokens by
    // including metadata (role, name, tool_calls) and adding separators between every value.
    // This caused false "Pre-generation intercepts exceed context" errors at large context sizes.
    const convertedPrompt = convertClaudePrompt(array, false, '', false, false, '', false);
    // SillyBunny: serve repeat counts from the lightweight JS count cache even after WASM eviction.
    const cacheKey = tokenizer?.residencyKey && convertedPrompt.length <= TOKEN_COUNT_CACHE_MAX_TEXT_LENGTH
        ? `${tokenizer.residencyKey}\0${convertedPrompt}`
        : null;
    if (cacheKey) {
        const cached = getCachedTokenCount(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
    }
    const result = await countSentencepieceTokens(tokenizer, convertedPrompt);
    if (cacheKey && result.ids.length === result.count && (convertedPrompt.length === 0 || result.ids.length > 0)) {
        setCachedTokenCount(cacheKey, result.count);
    }
    return result.count;
}

async function getTiktokenChunks(tokenizer, ids) {
    const decoder = new TextDecoder();
    const chunks = [];

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const chunkTextBytes = await tokenizer.decode(new Uint32Array([id]));
        const chunkText = decoder.decode(chunkTextBytes);
        chunks.push(chunkText);
    }

    return chunks;
}

/**
 * Gets the token chunks for the given token IDs using the Web tokenizer.
 * @param {Tokenizer} tokenizer Web tokenizer instance
 * @param {number[]} ids Token IDs
 * @returns {string[]} Token chunks
 */
function getWebTokenizersChunks(tokenizer, ids) {
    const chunks = [];

    for (let i = 0, lastProcessed = 0; i < ids.length; i++) {
        const chunkIds = ids.slice(lastProcessed, i + 1);
        const chunkText = tokenizer.decode(new Int32Array(chunkIds));
        if (chunkText === '�') {
            continue;
        }
        chunks.push(chunkText);
        lastProcessed = i + 1;
    }

    return chunks;
}

/**
 * Gets the tokenizer model by the model name.
 * @param {string} requestModel Models to use for tokenization
 * @returns {string} Tokenizer model to use
 */
export function getTokenizerModel(requestModel) {
    if (requestModel === 'o1' || requestModel.includes('o1-preview') || requestModel.includes('o1-mini') || requestModel.includes('o3-mini')) {
        return 'o1';
    }

    if (requestModel.includes('gpt-5') || requestModel.includes('gpt-6-') || requestModel.includes('o3') || requestModel.includes('o4-mini')) {
        return 'o1';
    }

    if (requestModel.includes('gpt-4o') || requestModel.includes('chatgpt-4o-latest')) {
        return 'gpt-4o';
    }

    if (requestModel.includes('gpt-4.1') || requestModel.includes('gpt-4.5')) {
        return 'gpt-4o';
    }

    if (requestModel.includes('gpt-4-32k')) {
        return 'gpt-4-32k';
    }

    if (requestModel.includes('gpt-4')) {
        return 'gpt-4';
    }

    if (requestModel.includes('gpt-3.5-turbo-0301')) {
        return 'gpt-3.5-turbo-0301';
    }

    if (requestModel.includes('gpt-3.5-turbo')) {
        return 'gpt-3.5-turbo';
    }

    if (TEXT_COMPLETION_MODELS.includes(requestModel)) {
        return requestModel;
    }

    if (requestModel.includes('claude')) {
        return 'claude';
    }

    if (requestModel.includes('llama3') || requestModel.includes('llama-3')) {
        return 'llama3';
    }

    if (requestModel.includes('llama')) {
        return 'llama';
    }

    if (requestModel.includes('mistral')) {
        return 'mistral';
    }

    if (requestModel.includes('yi')) {
        return 'yi';
    }

    if (requestModel.includes('deepseek')) {
        return 'deepseek';
    }

    if (requestModel.includes('gemma') || requestModel.includes('gemini') || requestModel.includes('learnlm')) {
        return 'gemma';
    }

    if (requestModel.includes('jamba')) {
        return 'jamba';
    }

    if (requestModel.includes('qwen2')) {
        return 'qwen2';
    }

    if (requestModel.includes('command-r')) {
        return 'command-r';
    }

    if (requestModel.includes('command-a')) {
        return 'command-a';
    }

    if (requestModel.includes('nemo')) {
        return 'nemo';
    }

    // default
    return 'gpt-3.5-turbo';
}

export function getTiktokenTokenizer(model) {
    const residencyKey = `tiktoken:${model}`;
    if (tokenizersCache[model]) {
        // SillyBunny: refresh residency timestamp on reuse.
        tokenizerResidencyManager.touch(residencyKey, () => disposeTiktokenModel(model));
        return tokenizersCache[model];
    }

    const tokenizer = tiktoken.encoding_for_model(model);
    console.info('Instantiated the tokenizer for', model);
    tokenizersCache[model] = tokenizer;
    // SillyBunny: track resident Tiktoken WASM instance so eviction/idle TTL calls .free().
    tokenizerResidencyManager.touch(residencyKey, () => disposeTiktokenModel(model));
    return tokenizer;
}

// SillyBunny: release Tiktoken WASM encoder memory cleanly when evicted from residency.
function disposeTiktokenModel(model) {
    const tokenizer = tokenizersCache[model];
    if (!tokenizer) {
        return;
    }
    delete tokenizersCache[model];
    try {
        tokenizer.free?.();
    } catch {
        // Ignore disposal errors.
    }
}

/**
 * Counts the tokens for the given messages using the WebTokenizer and Claude prompt conversion.
 * @param {Tokenizer} tokenizer Web tokenizer
 * @param {object[]} messages Array of messages
 * @returns {number} Number of tokens
 */
export function countWebTokenizerTokens(tokenizer, messages) {
    const jsonBody = messages.flatMap(x => Object.values(x)).join('\n\n');

    // Fallback to strlen estimation
    if (!tokenizer) {
        return guesstimate(jsonBody);
    }

    const count = tokenizer.encode(jsonBody).length;
    return count;
}

/**
 * Creates an API handler for encoding Sentencepiece tokens.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @returns {TokenizationHandler} Handler function
 */
function createSentencepieceEncodingHandler(tokenizer) {
    /**
     * Request handler for encoding Sentencepiece tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const instance = await tokenizer?.get();
            const { ids, count } = await countSentencepieceTokens(tokenizer, text);
            const chunks = instance?.encodePieces(text);
            return response.send({ ids, count, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding Sentencepiece tokens.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @returns {TokenizationHandler} Handler function
 */
function createSentencepieceDecodingHandler(tokenizer) {
    /**
     * Request handler for decoding Sentencepiece tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const instance = await tokenizer?.get();
            if (!instance) throw new Error('Failed to load the Sentencepiece tokenizer');
            const ops = ids.map(id => instance.decodeIds([id]));
            const chunks = await Promise.all(ops);
            const text = chunks.join('');
            return response.send({ text, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ text: '', chunks: [] });
        }
    };
}

/**
 * Creates an API handler for encoding Tiktoken tokens.
 * @param {string} modelId Tiktoken model ID
 * @returns {TokenizationHandler} Handler function
 */
function createTiktokenEncodingHandler(modelId) {
    /**
     * Request handler for encoding Tiktoken tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const tokenizer = getTiktokenTokenizer(modelId);
            const tokens = Object.values(tokenizer.encode(text));
            const chunks = await getTiktokenChunks(tokenizer, tokens);
            return response.send({ ids: tokens, count: tokens.length, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding Tiktoken tokens.
 * @param {string} modelId Tiktoken model ID
 * @returns {TokenizationHandler} Handler function
 */
function createTiktokenDecodingHandler(modelId) {
    /**
     * Request handler for decoding Tiktoken tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const tokenizer = getTiktokenTokenizer(modelId);
            const textBytes = tokenizer.decode(new Uint32Array(ids));
            const text = new TextDecoder().decode(textBytes);
            return response.send({ text });
        } catch (error) {
            console.error(error);
            return response.send({ text: '' });
        }
    };
}

/**
 * Creates an API handler for encoding WebTokenizer tokens.
 * @param {WebTokenizer} tokenizer WebTokenizer instance
 * @returns {TokenizationHandler} Handler function
 */
function createWebTokenizerEncodingHandler(tokenizer) {
    /**
     * Request handler for encoding WebTokenizer tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const instance = await tokenizer?.get();
            if (!instance) throw new Error('Failed to load the Web tokenizer');
            const tokens = Array.from(instance.encode(text));
            const chunks = getWebTokenizersChunks(instance, tokens);
            return response.send({ ids: tokens, count: tokens.length, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding WebTokenizer tokens.
 * @param {WebTokenizer} tokenizer WebTokenizer instance
 * @returns {TokenizationHandler} Handler function
 */
function createWebTokenizerDecodingHandler(tokenizer) {
    /**
     * Request handler for decoding WebTokenizer tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     * @returns {Promise<any>}
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const instance = await tokenizer?.get();
            if (!instance) throw new Error('Failed to load the Web tokenizer');
            const chunks = getWebTokenizersChunks(instance, ids);
            const text = instance.decode(new Int32Array(ids));
            return response.send({ text, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ text: '', chunks: [] });
        }
    };
}

export const router = express.Router();

router.post('/llama/encode', createSentencepieceEncodingHandler(spp_llama));
router.post('/nerdstash/encode', createSentencepieceEncodingHandler(spp_nerd));
router.post('/nerdstash_v2/encode', createSentencepieceEncodingHandler(spp_nerd_v2));
router.post('/mistral/encode', createSentencepieceEncodingHandler(spp_mistral));
router.post('/yi/encode', createSentencepieceEncodingHandler(spp_yi));
router.post('/gemma/encode', createSentencepieceEncodingHandler(spp_gemma));
router.post('/jamba/encode', createSentencepieceEncodingHandler(spp_jamba));
router.post('/gpt2/encode', createTiktokenEncodingHandler('gpt2'));
router.post('/claude/encode', createWebTokenizerEncodingHandler(claude_tokenizer));
router.post('/llama3/encode', createWebTokenizerEncodingHandler(llama3_tokenizer));
router.post('/qwen2/encode', createWebTokenizerEncodingHandler(qwen2Tokenizer));
router.post('/command-r/encode', createWebTokenizerEncodingHandler(commandRTokenizer));
router.post('/command-a/encode', createWebTokenizerEncodingHandler(commandATokenizer));
router.post('/nemo/encode', createWebTokenizerEncodingHandler(nemoTokenizer));
router.post('/deepseek/encode', createWebTokenizerEncodingHandler(deepseekTokenizer));
router.post('/llama/decode', createSentencepieceDecodingHandler(spp_llama));
router.post('/nerdstash/decode', createSentencepieceDecodingHandler(spp_nerd));
router.post('/nerdstash_v2/decode', createSentencepieceDecodingHandler(spp_nerd_v2));
router.post('/mistral/decode', createSentencepieceDecodingHandler(spp_mistral));
router.post('/yi/decode', createSentencepieceDecodingHandler(spp_yi));
router.post('/gemma/decode', createSentencepieceDecodingHandler(spp_gemma));
router.post('/jamba/decode', createSentencepieceDecodingHandler(spp_jamba));
router.post('/gpt2/decode', createTiktokenDecodingHandler('gpt2'));
router.post('/claude/decode', createWebTokenizerDecodingHandler(claude_tokenizer));
router.post('/llama3/decode', createWebTokenizerDecodingHandler(llama3_tokenizer));
router.post('/qwen2/decode', createWebTokenizerDecodingHandler(qwen2Tokenizer));
router.post('/command-r/decode', createWebTokenizerDecodingHandler(commandRTokenizer));
router.post('/command-a/decode', createWebTokenizerDecodingHandler(commandATokenizer));
router.post('/nemo/decode', createWebTokenizerDecodingHandler(nemoTokenizer));
router.post('/deepseek/decode', createWebTokenizerDecodingHandler(deepseekTokenizer));

router.post('/openai/encode', async function (req, res) {
    try {
        const queryModel = String(req.query.model || '');

        if (queryModel.includes('llama3') || queryModel.includes('llama-3')) {
            const handler = createWebTokenizerEncodingHandler(llama3_tokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('llama')) {
            const handler = createSentencepieceEncodingHandler(spp_llama);
            return handler(req, res);
        }

        if (queryModel.includes('mistral')) {
            const handler = createSentencepieceEncodingHandler(spp_mistral);
            return handler(req, res);
        }

        if (queryModel.includes('yi')) {
            const handler = createSentencepieceEncodingHandler(spp_yi);
            return handler(req, res);
        }

        if (queryModel.includes('claude')) {
            const handler = createWebTokenizerEncodingHandler(claude_tokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('gemma') || queryModel.includes('gemini')) {
            const handler = createSentencepieceEncodingHandler(spp_gemma);
            return handler(req, res);
        }

        if (queryModel.includes('jamba')) {
            const handler = createSentencepieceEncodingHandler(spp_jamba);
            return handler(req, res);
        }

        if (queryModel.includes('qwen2')) {
            const handler = createWebTokenizerEncodingHandler(qwen2Tokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('command-r')) {
            const handler = createWebTokenizerEncodingHandler(commandRTokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('command-a')) {
            const handler = createWebTokenizerEncodingHandler(commandATokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('nemo')) {
            const handler = createWebTokenizerEncodingHandler(nemoTokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('deepseek')) {
            const handler = createWebTokenizerEncodingHandler(deepseekTokenizer);
            return handler(req, res);
        }

        const model = getTokenizerModel(queryModel);
        const handler = createTiktokenEncodingHandler(model);
        return handler(req, res);
    } catch (error) {
        console.error(error);
        return res.send({ ids: [], count: 0, chunks: [] });
    }
});

router.post('/openai/decode', async function (req, res) {
    try {
        const queryModel = String(req.query.model || '');

        if (queryModel.includes('llama3') || queryModel.includes('llama-3')) {
            const handler = createWebTokenizerDecodingHandler(llama3_tokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('llama')) {
            const handler = createSentencepieceDecodingHandler(spp_llama);
            return handler(req, res);
        }

        if (queryModel.includes('mistral')) {
            const handler = createSentencepieceDecodingHandler(spp_mistral);
            return handler(req, res);
        }

        if (queryModel.includes('yi')) {
            const handler = createSentencepieceDecodingHandler(spp_yi);
            return handler(req, res);
        }

        if (queryModel.includes('claude')) {
            const handler = createWebTokenizerDecodingHandler(claude_tokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('gemma') || queryModel.includes('gemini')) {
            const handler = createSentencepieceDecodingHandler(spp_gemma);
            return handler(req, res);
        }

        if (queryModel.includes('jamba')) {
            const handler = createSentencepieceDecodingHandler(spp_jamba);
            return handler(req, res);
        }

        if (queryModel.includes('qwen2')) {
            const handler = createWebTokenizerDecodingHandler(qwen2Tokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('command-r')) {
            const handler = createWebTokenizerDecodingHandler(commandRTokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('command-a')) {
            const handler = createWebTokenizerDecodingHandler(commandATokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('nemo')) {
            const handler = createWebTokenizerDecodingHandler(nemoTokenizer);
            return handler(req, res);
        }

        if (queryModel.includes('deepseek')) {
            const handler = createWebTokenizerDecodingHandler(deepseekTokenizer);
            return handler(req, res);
        }

        const model = getTokenizerModel(queryModel);
        const handler = createTiktokenDecodingHandler(model);
        return handler(req, res);
    } catch (error) {
        console.error(error);
        return res.send({ text: '' });
    }
});

/**
 * Counts tokens in an array of chat messages with an OpenAI-compatible tokenizer.
 * Split out of the /openai/count handler so the same counting can be reused per message.
 * @param {string} model Resolved tokenizer model
 * @param {string} queryModel Raw model string from the request query
 * @param {object[]} messages Messages to count
 * @returns {Promise<number>} Token count
 */
// SillyBunny: reuse lightweight JS token count cache for WebTokenizer chat counts across WASM evictions.
async function countCachedWebTokenizerMessages(tokenizerWrapper, label, messages) {
    const jsonBody = messages.flatMap(x => Object.values(x)).join('\n\n');
    const cacheKey = jsonBody.length <= TOKEN_COUNT_CACHE_MAX_TEXT_LENGTH
        ? `${tokenizerWrapper.residencyKey}\0${jsonBody}`
        : null;
    if (cacheKey) {
        const cached = getCachedTokenCount(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
    }
    const instance = await tokenizerWrapper.get();
    if (!instance) throw new Error(`Failed to load the ${label} tokenizer`);
    const count = instance.encode(jsonBody).length;
    if (cacheKey) {
        setCachedTokenCount(cacheKey, count);
    }
    return count;
}

async function countOpenAIChatTokens(model, queryModel, messages) {
    // SillyBunny: route web tokenizers through the lightweight JS count cache so evicted WASM stays cold on cache hits.
    if (model === 'claude') {
        return await countCachedWebTokenizerMessages(claude_tokenizer, 'Claude', messages);
    }

    if (model === 'llama3' || model === 'llama-3') {
        return await countCachedWebTokenizerMessages(llama3_tokenizer, 'Llama3', messages);
    }

    if (model === 'llama') {
        return await countSentencepieceArrayTokens(spp_llama, messages);
    }

    if (model === 'mistral') {
        return await countSentencepieceArrayTokens(spp_mistral, messages);
    }

    if (model === 'yi') {
        return await countSentencepieceArrayTokens(spp_yi, messages);
    }

    if (model === 'gemma' || model === 'gemini') {
        return await countSentencepieceArrayTokens(spp_gemma, messages);
    }

    if (model === 'jamba') {
        return await countSentencepieceArrayTokens(spp_jamba, messages);
    }

    if (model === 'qwen2') {
        return await countCachedWebTokenizerMessages(qwen2Tokenizer, 'Qwen2', messages);
    }

    if (model === 'command-r') {
        return await countCachedWebTokenizerMessages(commandRTokenizer, 'Command-R', messages);
    }

    if (model === 'command-a') {
        return await countCachedWebTokenizerMessages(commandATokenizer, 'Command-A', messages);
    }

    if (model === 'nemo') {
        return await countCachedWebTokenizerMessages(nemoTokenizer, 'Nemo', messages);
    }

    if (model === 'deepseek') {
        return await countCachedWebTokenizerMessages(deepseekTokenizer, 'DeepSeek', messages);
    }

    const tokensPerName = queryModel.includes('gpt-3.5-turbo-0301') ? -1 : 1;
    const tokensPerMessage = queryModel.includes('gpt-3.5-turbo-0301') ? 4 : 3;
    const tokensPadding = 3;

    // SillyBunny: defer instantiating Tiktoken WASM until a string misses the lightweight JS count cache.
    let tokenizer = null;

    let num_tokens = 0;

    for (const msg of messages) {
        try {
            num_tokens += tokensPerMessage;
            for (const [key, value] of Object.entries(msg)) {
                if (typeof value === 'string' && value.length <= TOKEN_COUNT_CACHE_MAX_TEXT_LENGTH) {
                    const cacheKey = `tiktoken:${model}\0${value}`;
                    const cached = getCachedTokenCount(cacheKey);
                    if (cached !== undefined) {
                        num_tokens += cached;
                    } else {
                        tokenizer ??= getTiktokenTokenizer(model);
                        const encodedLength = tokenizer.encode(value).length;
                        setCachedTokenCount(cacheKey, encodedLength);
                        num_tokens += encodedLength;
                    }
                } else {
                    tokenizer ??= getTiktokenTokenizer(model);
                    num_tokens += tokenizer.encode(value).length;
                }
                if (key == 'name') {
                    num_tokens += tokensPerName;
                }
            }
        } catch {
            console.warn('Error tokenizing message:', msg);
        }
    }
    num_tokens += tokensPadding;

    // NB: Since 2023-10-14, the GPT-3.5 Turbo 0301 model shoves in 7-9 extra tokens to every message.
    // More details: https://community.openai.com/t/gpt-3-5-turbo-0301-showing-different-behavior-suddenly/431326/14
    if (queryModel.includes('gpt-3.5-turbo-0301')) {
        num_tokens += 9;
    }

    return num_tokens;
}

router.post('/openai/count', async function (req, res) {
    try {
        if (!req.body) return res.sendStatus(400);

        const queryModel = String(req.query.model || '');
        const model = getTokenizerModel(queryModel);

        // SillyBunny divergence from upstream: `per_message=1` answers with one count per
        // message instead of a single total, so a caller that would otherwise count a chat
        // history one message at a time can prime its cache in a single request. Each entry
        // is counted exactly as a single-message request would be, which keeps the values
        // interchangeable with the ones the unbatched path caches.
        if (req.query.per_message) {
            const token_counts = [];
            for (const message of req.body) {
                token_counts.push(await countOpenAIChatTokens(model, queryModel, [message]));
            }
            return res.send({ 'token_counts': token_counts });
        }

        const num_tokens = await countOpenAIChatTokens(model, queryModel, req.body);
        res.send({ 'token_count': num_tokens });
    } catch (error) {
        console.error('An error counting tokens, using fallback estimation method', error);
        if (req.query.per_message && Array.isArray(req.body)) {
            const token_counts = req.body.map(message => guesstimate(JSON.stringify(message)));
            return res.send({ 'token_counts': token_counts });
        }
        const jsonBody = JSON.stringify(req.body);
        const num_tokens = guesstimate(jsonBody);
        res.send({ 'token_count': num_tokens });
    }
});

router.post('/remote/kobold/count', async function (request, response) {
    if (!request.body) {
        return response.sendStatus(400);
    }
    const text = String(request.body.text) || '';
    const baseUrl = String(request.body.url);

    try {
        const args = {
            method: 'POST',
            body: JSON.stringify({ 'prompt': text }),
            headers: { 'Content-Type': 'application/json' },
        };

        let url = String(baseUrl).replace(/\/$/, '');
        url += '/extra/tokencount';

        const result = await fetch(url, args);

        if (!result.ok) {
            console.warn(`API returned error: ${result.status} ${result.statusText}`);
            return response.send({ error: true });
        }

        /** @type {any} */
        const data = await result.json();
        const count = data.value;
        const ids = data.ids ?? [];
        return response.send({ count, ids });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/remote/textgenerationwebui/encode', async function (request, response) {
    if (!request.body) {
        return response.sendStatus(400);
    }
    const text = String(request.body.text) || '';
    const baseUrl = String(request.body.url);
    const model = String(request.body.model) || '';

    try {
        const args = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        };

        setAdditionalHeaders(request, args, baseUrl);

        // Convert to string + remove trailing slash + /v1 suffix
        let url = trimV1(baseUrl);

        switch (request.body.api_type) {
            case TEXTGEN_TYPES.TABBY:
                url += '/v1/token/encode';
                args.body = JSON.stringify({ 'text': text, 'add_bos_token': false, 'encode_special_tokens': false });
                break;
            case TEXTGEN_TYPES.KOBOLDCPP:
                url += '/api/extra/tokencount';
                args.body = JSON.stringify({ 'prompt': text, 'special': false });
                break;
            case TEXTGEN_TYPES.LLAMACPP:
                url += '/tokenize';
                args.body = JSON.stringify({ 'model': model, 'content': text });
                break;
            case TEXTGEN_TYPES.VLLM:
                url += '/tokenize';
                args.body = JSON.stringify({ 'model': model, 'prompt': text });
                break;
            case TEXTGEN_TYPES.APHRODITE:
                url += '/v1/tokenize';
                args.body = JSON.stringify({ 'model': model, 'prompt': text });
                break;
            case TEXTGEN_TYPES.OOBA:
                url += '/v1/internal/encode';
                args.body = JSON.stringify({ 'text': text });
                break;
            default:
                return response.sendStatus(400);
        }

        const result = await fetch(url, args);

        if (!result.ok) {
            console.warn(`API returned error: ${result.status} ${result.statusText}`);
            return response.send({ error: true });
        }

        /** @type {any} */
        const data = await result.json();
        const count = (data?.length ?? data?.count ?? data?.value ?? data?.tokens?.length);
        const ids = (data?.tokens ?? data?.ids ?? []);

        return response.send({ count, ids });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});
