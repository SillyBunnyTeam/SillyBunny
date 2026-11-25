import crypto from 'node:crypto';
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

import { convertClaudePrompt } from '../prompt-converters.js';
import { TEXTGEN_TYPES } from '../constants.js';
import { setAdditionalHeaders } from '../additional-headers.js';
import { getConfigValue, isValidUrl, trimV1 } from '../util.js';

const require = createRequire(import.meta.url);

// SillyBunny: lazy-load heavy tokenizer packages (WASM/BPE tables) on first use so importing
// tokenizers.js at server boot does not pay ~35 MB RSS before tokenization is requested.
let webTokenizersModuleUrl = null;
let tiktokenModule = null;
let tiktokenModulePromise = null;
let webTokenizersModulePromise = null;
let sentencePieceModulePromise = null;
let claudeTokenizerModulePromise = null;

function getWebTokenizersModuleUrl() {
    if (!webTokenizersModuleUrl) {
        webTokenizersModuleUrl = pathToFileURL(require.resolve('@agnai/web-tokenizers')).href;
    }
    return webTokenizersModuleUrl;
}

async function loadTiktokenModule() {
    if (tiktokenModule) {
        return tiktokenModule;
    }
    if (!tiktokenModulePromise) {
        tiktokenModulePromise = import('tiktoken')
            .then(mod => {
                tiktokenModule = mod.encoding_for_model ? mod : (mod.default ?? mod);
                return tiktokenModule;
            })
            .catch(error => {
                tiktokenModulePromise = null;
                throw error;
            });
    }
    return tiktokenModulePromise;
}

function loadTiktokenModuleSync() {
    if (!tiktokenModule) {
        tiktokenModule = require('tiktoken');
    }
    return tiktokenModule;
}

async function loadWebTokenizersModule() {
    if (!webTokenizersModulePromise) {
        webTokenizersModulePromise = import('@agnai/web-tokenizers')
            .then(mod => (mod.Tokenizer ? mod : (mod.default ?? mod)))
            .catch(error => {
                webTokenizersModulePromise = null;
                throw error;
            });
    }
    return webTokenizersModulePromise;
}

async function loadSentencePieceModule() {
    if (!sentencePieceModulePromise) {
        sentencePieceModulePromise = import('@agnai/sentencepiece-js')
            .then(mod => (mod.SentencePieceProcessor ? mod : (mod.default ?? mod)))
            .catch(error => {
                sentencePieceModulePromise = null;
                throw error;
            });
    }
    return sentencePieceModulePromise;
}

async function loadClaudeTokenizerModule() {
    if (!claudeTokenizerModulePromise) {
        claudeTokenizerModulePromise = import('@anthropic-ai/tokenizer')
            .then(mod => (mod.getTokenizer ? mod : (mod.default ?? mod)))
            .catch(error => {
                claudeTokenizerModulePromise = null;
                throw error;
            });
    }
    return claudeTokenizerModulePromise;
}

/**
 * @typedef { (req: import('express').Request, res: import('express').Response) => Promise<any> } TokenizationHandler
 */

/**
 * @type {{[key: string]: import('tiktoken').Tiktoken}} Tokenizers cache keyed by Tiktoken encoding name
 */
const tokenizersCache = {};

// SillyBunny: bounded LRU token-count cache keyed by (encoding/model, sha1(text)) plus in-flight dedupe.
const TOKEN_COUNT_CACHE_MAX = 4096;
const SENTENCEPIECE_PIECE_CACHE_MAX = 65536;
const COUNT_BATCH_MAX_TEXTS = 500;
const COUNT_BATCH_MAX_TEXT_LENGTH = 500_000;
const COUNT_BATCH_MAX_TOTAL_CHARS = 2_000_000;

/** @type {Map<string, number>} */
const tokenCountCache = new Map();
/** @type {Map<string, Promise<number>>} */
const inFlightTokenCounts = new Map();

/**
 * Builds a cache key from a canonical tokenizer namespace and SHA-1 digest of the text.
 * @param {string} namespace Canonical encoding or tokenizer namespace
 * @param {string} text Text to hash
 * @returns {string}
 */
function getTokenCountCacheKey(namespace, text) {
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    return `${namespace}\0${hash}`;
}

/**
 * Stores a token count in the bounded LRU cache.
 * @param {string} key Cache key
 * @param {number} count Token count
 */
function setTokenCountCache(key, count) {
    tokenCountCache.delete(key);
    tokenCountCache.set(key, count);
    if (tokenCountCache.size > TOKEN_COUNT_CACHE_MAX) {
        tokenCountCache.delete(tokenCountCache.keys().next().value);
    }
}

/**
 * Returns a cached token count or computes it once with in-flight deduplication.
 * @param {string} namespace Canonical encoding or tokenizer namespace
 * @param {string} text Text to count
 * @param {() => Promise<number>} compute Async token-count computation
 * @returns {Promise<number>}
 */
async function getCachedTokenCount(namespace, text, compute) {
    const key = getTokenCountCacheKey(namespace, text);
    const cached = tokenCountCache.get(key);
    if (cached !== undefined) {
        tokenCountCache.delete(key);
        tokenCountCache.set(key, cached);
        return cached;
    }

    const inFlight = inFlightTokenCounts.get(key);
    if (inFlight) {
        return inFlight;
    }

    const promise = Promise.resolve()
        .then(compute)
        .then(count => {
            setTokenCountCache(key, count);
            return count;
        })
        .finally(() => {
            inFlightTokenCounts.delete(key);
        });

    inFlightTokenCounts.set(key, promise);
    return promise;
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
    /**
     * @type {import('@agnai/sentencepiece-js').SentencePieceProcessor|undefined} Sentencepiece tokenizer instance
     */
    #instance;
    /**
     * @type {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>|null} In-flight load promise
     */
    #loadPromise = null;
    /**
     * @type {Map<string, number>} Cached piece-string -> token-id lookup for single-pass encode
     */
    #pieceIdCache = new Map();
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;
    /**
     * @type {string|undefined} Path to the fallback model
     */
    #fallbackModel;

    /**
     * Creates a new Sentencepiece tokenizer.
     * @param {string} model Path to the tokenizer model
     * @param {string} [fallbackModel] Path to the fallback model
     */
    constructor(model, fallbackModel) {
        this.#model = model;
        this.#fallbackModel = fallbackModel;
    }

    /**
     * Gets the Sentencepiece tokenizer instance.
     * @returns {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>} Sentencepiece tokenizer instance
     */
    async get() {
        if (this.#instance) {
            return this.#instance;
        }

        // SillyBunny: coalesce concurrent loads so only one SentencePiece WASM instance is allocated.
        if (this.#loadPromise) {
            return this.#loadPromise;
        }

        this.#loadPromise = (async () => {
            try {
                const [{ SentencePieceProcessor }, pathToModel] = await Promise.all([
                    loadSentencePieceModule(),
                    getPathToTokenizer(this.#model, this.#fallbackModel),
                ]);
                const instance = new SentencePieceProcessor();
                await instance.load(pathToModel);
                this.#instance = instance;
                console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
                return this.#instance;
            } catch (error) {
                console.error('Sentencepiece tokenizer failed to load: ' + this.#model, error);
                return null;
            } finally {
                this.#loadPromise = null;
            }
        })();

        return this.#loadPromise;
    }

    /**
     * Encodes text to both token IDs and piece strings in a single SentencePiece pass.
     * @param {import('@agnai/sentencepiece-js').SentencePieceProcessor} instance Loaded processor
     * @param {string} text Text to encode
     * @returns {{ ids: number[], count: number, chunks: string[] }}
     */
    encodeWithChunks(instance, text) {
        // SillyBunny: run SentencePiece segmentation once (encodePieces) and resolve token IDs
        // via cached PieceToId instead of running full Viterbi/BPE encoding twice.
        const chunks = instance.encodePieces(text);
        if (instance.processor && typeof instance.processor.PieceToId === 'function' && instance.sentencepiece?.StringView) {
            const sp = instance.sentencepiece;
            const ids = new Array(chunks.length);
            for (let i = 0; i < chunks.length; i++) {
                const piece = chunks[i];
                let id = this.#pieceIdCache.get(piece);
                if (id === undefined) {
                    const stringView = new sp.StringView(piece);
                    let abslView = null;
                    try {
                        abslView = stringView.getView();
                        id = instance.processor.PieceToId(abslView);
                    } finally {
                        abslView?.delete();
                        stringView.delete();
                    }
                    if (this.#pieceIdCache.size < SENTENCEPIECE_PIECE_CACHE_MAX) {
                        this.#pieceIdCache.set(piece, id);
                    }
                }
                ids[i] = id;
            }
            return { ids, count: ids.length, chunks };
        }

        const ids = instance.encodeIds(text);
        return { ids, count: ids.length, chunks };
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

let webTokenizerLocationPatchDepth = 0;
let webTokenizerOriginalLocationDescriptor = undefined;

/**
 * @template T
 * @param {() => Promise<T>} callback Initializer that may load the tokenizer WASM module
 * @returns {Promise<T>}
 */
async function withWebTokenizerRuntimeLocation(callback) {
    if (webTokenizerLocationPatchDepth === 0 && !shouldPatchWebTokenizerRuntimeLocation()) {
        return callback();
    }

    let patched = false;
    if (webTokenizerLocationPatchDepth === 0) {
        webTokenizerOriginalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
        try {
            // SillyBunny: some Bun/ARM server surfaces expose an empty location.href,
            // which makes @agnai/web-tokenizers pass '' to createRequire during WASM bootstrap.
            Object.defineProperty(globalThis, 'location', {
                value: { href: getWebTokenizersModuleUrl() },
                configurable: true,
                writable: true,
            });
            webTokenizerLocationPatchDepth = 1;
            patched = true;
        } catch {
            return callback();
        }
    } else {
        webTokenizerLocationPatchDepth++;
        patched = true;
    }

    try {
        return await callback();
    } finally {
        if (patched) {
            webTokenizerLocationPatchDepth--;
            if (webTokenizerLocationPatchDepth === 0) {
                if (webTokenizerOriginalLocationDescriptor) {
                    Object.defineProperty(globalThis, 'location', webTokenizerOriginalLocationDescriptor);
                } else {
                    delete globalThis.location;
                }
                webTokenizerOriginalLocationDescriptor = undefined;
            }
        }
    }
}

/**
 * Web tokenizer for tokenizing text.
 */
class WebTokenizer {
    /**
     * @type {import('@agnai/web-tokenizers').Tokenizer|undefined} Web tokenizer instance
     */
    #instance;
    /**
     * @type {Promise<import('@agnai/web-tokenizers').Tokenizer|null>|null} In-flight load promise
     */
    #loadPromise = null;
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;
    /**
     * @type {string|undefined} Path to the fallback model
     */
    #fallbackModel;

    /**
     * Creates a new Web tokenizer.
     * @param {string} model Path to the tokenizer model
     * @param {string} [fallbackModel] Path to the fallback model
     */
    constructor(model, fallbackModel) {
        this.#model = model;
        this.#fallbackModel = fallbackModel;
    }

    /**
     * Gets the Web tokenizer instance.
     * @returns {Promise<import('@agnai/web-tokenizers').Tokenizer|null>} Web tokenizer instance
     */
    async get() {
        if (this.#instance) {
            return this.#instance;
        }

        // SillyBunny: coalesce concurrent loads so only one WebTokenizer WASM instance is allocated.
        if (this.#loadPromise) {
            return this.#loadPromise;
        }

        this.#loadPromise = (async () => {
            let pathToModel = '';
            try {
                const [{ Tokenizer }, resolvedPath] = await Promise.all([
                    loadWebTokenizersModule(),
                    getPathToTokenizer(this.#model, this.#fallbackModel),
                ]);
                pathToModel = resolvedPath;
                const fileBuffer = await fs.promises.readFile(pathToModel);
                const instance = await withWebTokenizerRuntimeLocation(() => Tokenizer.fromJSON(fileBuffer.toString('utf-8')));
                this.#instance = instance;
                console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
                return this.#instance;
            } catch (error) {
                console.error(`Web tokenizer failed to load model '${this.#model}' from path '${pathToModel}':`, error);
                return null;
            } finally {
                this.#loadPromise = null;
            }
        })();

        return this.#loadPromise;
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
    /**
     * @param {any} tokenizer
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
}

/**
 * Bun-safe Claude tokenizer.
 */
class ClaudeTokenizer {
    /**
     * @type {ClaudeTokenizerInstance | null | undefined}
     */
    #instance;
    /**
     * @type {Promise<ClaudeTokenizerInstance | null> | null}
     */
    #loadPromise = null;

    /**
     * Gets the Claude tokenizer instance.
     * @returns {Promise<ClaudeTokenizerInstance | null>}
     */
    async get() {
        if (this.#instance) {
            return this.#instance;
        }

        // SillyBunny: lazy-load @anthropic-ai/tokenizer and coalesce concurrent loads.
        if (this.#loadPromise) {
            return this.#loadPromise;
        }

        this.#loadPromise = (async () => {
            try {
                const { getTokenizer: getClaudeTokenizer } = await loadClaudeTokenizerModule();
                this.#instance = new ClaudeTokenizerInstance(getClaudeTokenizer());
                console.info('Instantiated the tokenizer for claude');
                return this.#instance;
            } catch (error) {
                console.error('Claude tokenizer failed to load', error);
                return null;
            } finally {
                this.#loadPromise = null;
            }
        })();

        return this.#loadPromise;
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
 * Counts tokens for a text string using a Sentencepiece tokenizer with LRU caching and in-flight dedupe.
 * Falls back to uncached guesstimate when the tokenizer cannot be loaded.
 * @param {string} namespace Cache namespace for this tokenizer
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @param {string} text Text to count
 * @returns {Promise<number>} Token count
 */
async function countCachedSentencepieceText(namespace, tokenizer, text) {
    const instance = await tokenizer?.get();
    if (!instance) {
        return guesstimate(text);
    }

    return getCachedTokenCount(namespace, text, async () => instance.encodeIds(text).length);
}

/**
 * Counts the tokens in the given array of objects using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer
 * @param {object[]} array Array of objects to tokenize
 * @param {string} [namespace] Optional cache namespace for LRU token-count caching
 * @returns {Promise<number>} Number of tokens
 */
async function countSentencepieceArrayTokens(tokenizer, array, namespace = undefined) {
    // SillyBunny: Use convertClaudePrompt for consistent token counting across all tokenizers.
    // The previous implementation using Object.values().join('\n\n') overcounted tokens by
    // including metadata (role, name, tool_calls) and adding separators between every value.
    // This caused false "Pre-generation intercepts exceed context" errors at large context sizes.
    const convertedPrompt = convertClaudePrompt(array, false, '', false, false, '', false);
    if (namespace) {
        return await countCachedSentencepieceText(namespace, tokenizer, convertedPrompt);
    }
    const result = await countSentencepieceTokens(tokenizer, convertedPrompt);
    return result.count;
}

/**
 * Decodes each Tiktoken token ID into its display chunk synchronously.
 * @param {import('tiktoken').Tiktoken} tokenizer Tiktoken instance
 * @param {ArrayLike<number>} ids Token IDs
 * @returns {string[]} Token chunks
 */
function getTiktokenChunks(tokenizer, ids) {
    // SillyBunny: tokenizer.decode is synchronous; drop per-token await and reuse one Uint32Array(1).
    const decoder = new TextDecoder();
    const chunks = new Array(ids.length);
    const singleId = new Uint32Array(1);

    for (let i = 0; i < ids.length; i++) {
        singleId[0] = ids[i];
        const chunkTextBytes = tokenizer.decode(singleId);
        chunks[i] = decoder.decode(chunkTextBytes);
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

/**
 * Resolves the canonical Tiktoken encoding name for a model when known.
 * @param {any} tiktokenMod Loaded tiktoken module
 * @param {string} model Model name
 * @returns {string|null} Encoding name or null if unknown
 */
function resolveTiktokenEncoding(tiktokenMod, model) {
    if (typeof tiktokenMod.get_encoding_name_for_model === 'function') {
        try {
            return tiktokenMod.get_encoding_name_for_model(model);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Gets or instantiates a Tiktoken tokenizer keyed by its canonical encoding name.
 * @param {any} tiktokenMod Loaded tiktoken module
 * @param {string} model Model name
 * @returns {{ tokenizer: import('tiktoken').Tiktoken, encoding: string }}
 */
function getTiktokenTokenizerWithEncoding(tiktokenMod, model) {
    // SillyBunny: key Tiktoken cache by encoding (o200k_base, cl100k_base, ...) so models
    // sharing an encoding reuse one instance instead of duplicating ~10 MB BPE tables per model name.
    const encoding = resolveTiktokenEncoding(tiktokenMod, model);
    if (encoding) {
        if (!tokenizersCache[encoding]) {
            tokenizersCache[encoding] = tiktokenMod.get_encoding(encoding);
            console.info('Instantiated the tokenizer for', encoding);
        }
        return { tokenizer: tokenizersCache[encoding], encoding };
    }

    if (!tokenizersCache[model]) {
        tokenizersCache[model] = tiktokenMod.encoding_for_model(model);
        console.info('Instantiated the tokenizer for', model);
    }
    return { tokenizer: tokenizersCache[model], encoding: model };
}

/**
 * Lazily loads tiktoken via dynamic import and returns the encoding-cached tokenizer.
 * @param {string} model Model name
 * @returns {Promise<{ tokenizer: import('tiktoken').Tiktoken, encoding: string }>}
 */
async function getTiktokenTokenizerAsync(model) {
    const tiktokenMod = await loadTiktokenModule();
    return getTiktokenTokenizerWithEncoding(tiktokenMod, model);
}

export function getTiktokenTokenizer(model) {
    const tiktokenMod = loadTiktokenModuleSync();
    return getTiktokenTokenizerWithEncoding(tiktokenMod, model).tokenizer;
}

/**
 * Counts the tokens for the given messages using the WebTokenizer and Claude prompt conversion.
 * @param {import('@agnai/web-tokenizers').Tokenizer|ClaudeTokenizerInstance} tokenizer Web tokenizer
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
 * Counts tokens for messages with a WebTokenizer using the bounded LRU cache and in-flight dedupe.
 * @param {string} namespace Cache namespace for this web tokenizer
 * @param {import('@agnai/web-tokenizers').Tokenizer|ClaudeTokenizerInstance} tokenizer Loaded web tokenizer
 * @param {object[]} messages Array of messages
 * @returns {Promise<number>}
 */
async function countCachedWebTokenizerTokens(namespace, tokenizer, messages) {
    const jsonBody = messages.flatMap(x => Object.values(x)).join('\n\n');
    if (!tokenizer) {
        return guesstimate(jsonBody);
    }

    return getCachedTokenCount(namespace, jsonBody, async () => tokenizer.encode(jsonBody).length);
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
            if (!instance) {
                return response.send({ ids: [], count: guesstimate(text), chunks: undefined });
            }

            const { ids, count, chunks } = tokenizer.encodeWithChunks(instance, text);
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
            // SillyBunny: decodeIds is synchronous; skip allocating per-token Promises for Promise.all.
            const chunks = ids.map(id => instance.decodeIds([id]));
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
            const { tokenizer } = await getTiktokenTokenizerAsync(modelId);
            // SillyBunny: use Array.from instead of Object.values on Uint32Array and call sync getTiktokenChunks.
            const encoded = tokenizer.encode(text);
            const tokens = Array.from(encoded);
            const chunks = getTiktokenChunks(tokenizer, encoded);
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
            const { tokenizer } = await getTiktokenTokenizerAsync(modelId);
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
async function countOpenAIChatTokens(model, queryModel, messages) {
    if (model === 'claude') {
        const instance = await claude_tokenizer.get();
        if (!instance) throw new Error('Failed to load the Claude tokenizer');
        return countCachedWebTokenizerTokens('web:claude', instance, messages);
    }

    if (model === 'llama3' || model === 'llama-3') {
        const instance = await llama3_tokenizer.get();
        if (!instance) throw new Error('Failed to load the Llama3 tokenizer');
        return countCachedWebTokenizerTokens('web:llama3', instance, messages);
    }

    if (model === 'llama') {
        return await countSentencepieceArrayTokens(spp_llama, messages, 'sp:llama');
    }

    if (model === 'mistral') {
        return await countSentencepieceArrayTokens(spp_mistral, messages, 'sp:mistral');
    }

    if (model === 'yi') {
        return await countSentencepieceArrayTokens(spp_yi, messages, 'sp:yi');
    }

    if (model === 'gemma' || model === 'gemini') {
        return await countSentencepieceArrayTokens(spp_gemma, messages, 'sp:gemma');
    }

    if (model === 'jamba') {
        return await countSentencepieceArrayTokens(spp_jamba, messages, 'sp:jamba');
    }

    if (model === 'qwen2') {
        const instance = await qwen2Tokenizer.get();
        if (!instance) throw new Error('Failed to load the Qwen2 tokenizer');
        return countCachedWebTokenizerTokens('web:qwen2', instance, messages);
    }

    if (model === 'command-r') {
        const instance = await commandRTokenizer.get();
        if (!instance) throw new Error('Failed to load the Command-R tokenizer');
        return countCachedWebTokenizerTokens('web:command-r', instance, messages);
    }

    if (model === 'command-a') {
        const instance = await commandATokenizer.get();
        if (!instance) throw new Error('Failed to load the Command-A tokenizer');
        return countCachedWebTokenizerTokens('web:command-a', instance, messages);
    }

    if (model === 'nemo') {
        const instance = await nemoTokenizer.get();
        if (!instance) throw new Error('Failed to load the Nemo tokenizer');
        return countCachedWebTokenizerTokens('web:nemo', instance, messages);
    }

    if (model === 'deepseek') {
        const instance = await deepseekTokenizer.get();
        if (!instance) throw new Error('Failed to load the DeepSeek tokenizer');
        return countCachedWebTokenizerTokens('web:deepseek', instance, messages);
    }

    const tokensPerName = queryModel.includes('gpt-3.5-turbo-0301') ? -1 : 1;
    const tokensPerMessage = queryModel.includes('gpt-3.5-turbo-0301') ? 4 : 3;
    const tokensPadding = 3;

    const { tokenizer, encoding } = await getTiktokenTokenizerAsync(model);
    const cacheNamespace = `tiktoken:${encoding}`;

    let num_tokens = 0;

    for (const msg of messages) {
        try {
            num_tokens += tokensPerMessage;
            for (const [key, value] of Object.entries(msg)) {
                if (typeof value === 'string') {
                    num_tokens += await getCachedTokenCount(cacheNamespace, value, async () => tokenizer.encode(value).length);
                } else {
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

    // not needed for cached tokenizers
    //tokenizer.free();

    return num_tokens;
}

/**
 * Counts a single batch entry with LRU caching, isolating per-entry errors (such as disallowed
 * Tiktoken special tokens like `<|endoftext|>`) to an uncached guesstimate fallback so one entry
 * cannot fail the rest of the batch.
 * @param {string} namespace Canonical cache namespace
 * @param {string} text Text to count
 * @param {() => Promise<number>} compute Async token-count computation
 * @returns {Promise<number>}
 */
async function countBatchEntry(namespace, text, compute) {
    try {
        return await getCachedTokenCount(namespace, text, compute);
    } catch (error) {
        console.warn('Error counting batch token entry, using fallback estimation:', error?.message ?? error);
        return guesstimate(text);
    }
}

/**
 * Counts tokens for a batch of plain text strings for a requested model using the bounded LRU cache.
 * @param {string} rawModel Requested model string
 * @param {string[]} texts Texts to count
 * @returns {Promise<number[]>} Token counts in input order
 */
async function countBatchTexts(rawModel, texts) {
    if (texts.length === 0) {
        return [];
    }

    const normalizedRaw = String(rawModel || '').trim();
    const lowerRaw = normalizedRaw.toLowerCase();
    if (lowerRaw === 'nerdstash_v2') {
        const instance = await spp_nerd_v2.get();
        if (!instance) return texts.map(t => guesstimate(t));
        return Promise.all(texts.map(text => countBatchEntry('sp:nerdstash_v2', text, async () => instance.encodeIds(text).length)));
    }
    if (lowerRaw === 'nerdstash') {
        const instance = await spp_nerd.get();
        if (!instance) return texts.map(t => guesstimate(t));
        return Promise.all(texts.map(text => countBatchEntry('sp:nerdstash', text, async () => instance.encodeIds(text).length)));
    }
    if (lowerRaw === 'gpt2') {
        const { tokenizer, encoding } = await getTiktokenTokenizerAsync('gpt2');
        const namespace = `tiktoken:${encoding}`;
        return Promise.all(texts.map(text => countBatchEntry(namespace, text, async () => tokenizer.encode(text).length)));
    }

    const model = getTokenizerModel(normalizedRaw);

    /** @type {Record<string, SentencePieceTokenizer>} */
    const spMap = {
        llama: spp_llama,
        mistral: spp_mistral,
        yi: spp_yi,
        gemma: spp_gemma,
        gemini: spp_gemma,
        jamba: spp_jamba,
    };
    if (Object.hasOwn(spMap, model)) {
        const spTokenizer = spMap[model];
        const canonical = model === 'gemini' ? 'gemma' : model;
        const instance = await spTokenizer.get();
        if (!instance) {
            return texts.map(t => guesstimate(t));
        }
        const namespace = `sp:${canonical}`;
        return Promise.all(texts.map(text => countBatchEntry(namespace, text, async () => instance.encodeIds(text).length)));
    }

    /** @type {Record<string, WebTokenizer|ClaudeTokenizer>} */
    const webMap = {
        claude: claude_tokenizer,
        llama3: llama3_tokenizer,
        'llama-3': llama3_tokenizer,
        qwen2: qwen2Tokenizer,
        'command-r': commandRTokenizer,
        'command-a': commandATokenizer,
        nemo: nemoTokenizer,
        deepseek: deepseekTokenizer,
    };
    if (Object.hasOwn(webMap, model)) {
        const webTokenizer = webMap[model];
        const canonical = model === 'llama-3' ? 'llama3' : model;
        const instance = await webTokenizer.get();
        if (!instance) {
            return texts.map(t => guesstimate(t));
        }
        const namespace = `web:${canonical}`;
        return Promise.all(texts.map(text => countBatchEntry(namespace, text, async () => instance.encode(text).length)));
    }

    const { tokenizer, encoding } = await getTiktokenTokenizerAsync(model);
    const namespace = `tiktoken:${encoding}`;
    return Promise.all(texts.map(text => countBatchEntry(namespace, text, async () => tokenizer.encode(text).length)));
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

// SillyBunny: batch plain-text token counting endpoint backed by the encoding-keyed LRU cache
// and in-flight deduplication so callers can count many strings in a single round trip.
router.post('/count-batch', async function (req, res) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).send({ error: 'Invalid request body' });
    }

    const { model, texts } = req.body;
    if (model !== undefined && typeof model !== 'string') {
        return res.status(400).send({ error: 'model must be a string' });
    }

    if (!Array.isArray(texts)) {
        return res.status(400).send({ error: 'texts must be an array of strings' });
    }

    if (texts.length > COUNT_BATCH_MAX_TEXTS) {
        return res.status(400).send({ error: `texts exceeds maximum batch size of ${COUNT_BATCH_MAX_TEXTS}` });
    }

    let totalChars = 0;
    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (typeof text !== 'string') {
            return res.status(400).send({ error: 'Each entry in texts must be a string' });
        }
        if (text.length > COUNT_BATCH_MAX_TEXT_LENGTH) {
            return res.status(400).send({ error: `Text entry exceeds maximum length of ${COUNT_BATCH_MAX_TEXT_LENGTH}` });
        }
        totalChars += text.length;
        if (totalChars > COUNT_BATCH_MAX_TOTAL_CHARS) {
            return res.status(400).send({ error: `Batch exceeds maximum total size of ${COUNT_BATCH_MAX_TOTAL_CHARS} characters` });
        }
    }

    try {
        const counts = await countBatchTexts(model || '', texts);
        return res.send({ counts });
    } catch (error) {
        console.error('An error counting batch tokens, using fallback estimation method', error);
        return res.send({ counts: texts.map(text => guesstimate(text)) });
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
