import { localforage } from '../lib.js';
import { characters, event_types, eventSource, main_api, nai_settings, online_status, this_chid } from '../script.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { chat_completion_sources, getChatCompletionModel, model_list, oai_settings } from './openai.js';
// SillyBunny: KoboldCpp counts Chat Completion tokens with its own tokenizer, which lives in the KoboldCpp module.
import { countKoboldCppChatTokens, isKoboldCppChatCompletion } from './sillybunny-koboldcpp-models.js';
import { groups, selected_group } from './group-chats.js';
import { getStringHash } from './utils.js';
import { kai_flags, kai_settings } from './kai-settings.js';
import { textgen_types, textgenerationwebui_settings as textgen_settings, getTextGenServer, getTextGenModel } from './textgen-settings.js';
import { getCurrentDreamGenModelTokenizer, getCurrentOpenRouterModelTokenizer, openRouterModels } from './textgen-models.js';
export { BYTES_PER_TOKEN as CHARACTERS_PER_TOKEN_RATIO };

export const BYTES_PER_TOKEN = 3.35;
export const TOKENIZER_WARNING_KEY = 'tokenizationWarningShown';
export const TOKENIZER_SUPPORTED_KEY = 'tokenizationSupported';

export const tokenizers = {
    NONE: 0,
    GPT2: 1,
    OPENAI: 2,
    LLAMA: 3,
    NERD: 4,
    NERD2: 5,
    API_CURRENT: 6,
    MISTRAL: 7,
    YI: 8,
    API_TEXTGENERATIONWEBUI: 9,
    API_KOBOLD: 10,
    CLAUDE: 11,
    LLAMA3: 12,
    GEMMA: 13,
    JAMBA: 14,
    QWEN2: 15,
    COMMAND_R: 16,
    NEMO: 17,
    DEEPSEEK: 18,
    COMMAND_A: 19,
    BEST_MATCH: 99,
};

// A list of local tokenizers that support encoding and decoding token ids.
export const ENCODE_TOKENIZERS = [
    tokenizers.LLAMA,
    tokenizers.MISTRAL,
    tokenizers.YI,
    tokenizers.LLAMA3,
    tokenizers.GEMMA,
    tokenizers.JAMBA,
    tokenizers.QWEN2,
    tokenizers.COMMAND_R,
    tokenizers.COMMAND_A,
    tokenizers.NEMO,
    tokenizers.DEEPSEEK,
    // uncomment when NovelAI releases Kayra and Clio weights, lol
    //tokenizers.NERD,
    //tokenizers.NERD2,
];

/**
 * A list of Text Completion sources that support remote tokenization.
 * Populated in initTokenziers due to circular dependencies.
 * @type {string[]}
 */
export const TEXTGEN_TOKENIZERS = [];

const TOKENIZER_URLS = {
    [tokenizers.GPT2]: {
        encode: '/api/tokenizers/gpt2/encode',
        decode: '/api/tokenizers/gpt2/decode',
        count: '/api/tokenizers/gpt2/encode',
    },
    [tokenizers.OPENAI]: {
        encode: '/api/tokenizers/openai/encode',
        decode: '/api/tokenizers/openai/decode',
        count: '/api/tokenizers/openai/encode',
    },
    [tokenizers.LLAMA]: {
        encode: '/api/tokenizers/llama/encode',
        decode: '/api/tokenizers/llama/decode',
        count: '/api/tokenizers/llama/encode',
    },
    [tokenizers.NERD]: {
        encode: '/api/tokenizers/nerdstash/encode',
        decode: '/api/tokenizers/nerdstash/decode',
        count: '/api/tokenizers/nerdstash/encode',
    },
    [tokenizers.NERD2]: {
        encode: '/api/tokenizers/nerdstash_v2/encode',
        decode: '/api/tokenizers/nerdstash_v2/decode',
        count: '/api/tokenizers/nerdstash_v2/encode',
    },
    [tokenizers.API_KOBOLD]: {
        count: '/api/tokenizers/remote/kobold/count',
        encode: '/api/tokenizers/remote/kobold/count',
    },
    [tokenizers.MISTRAL]: {
        encode: '/api/tokenizers/mistral/encode',
        decode: '/api/tokenizers/mistral/decode',
        count: '/api/tokenizers/mistral/encode',
    },
    [tokenizers.YI]: {
        encode: '/api/tokenizers/yi/encode',
        decode: '/api/tokenizers/yi/decode',
        count: '/api/tokenizers/yi/encode',
    },
    [tokenizers.CLAUDE]: {
        encode: '/api/tokenizers/claude/encode',
        decode: '/api/tokenizers/claude/decode',
        count: '/api/tokenizers/claude/encode',
    },
    [tokenizers.LLAMA3]: {
        encode: '/api/tokenizers/llama3/encode',
        decode: '/api/tokenizers/llama3/decode',
        count: '/api/tokenizers/llama3/encode',
    },
    [tokenizers.GEMMA]: {
        encode: '/api/tokenizers/gemma/encode',
        decode: '/api/tokenizers/gemma/decode',
        count: '/api/tokenizers/gemma/encode',
    },
    [tokenizers.JAMBA]: {
        encode: '/api/tokenizers/jamba/encode',
        decode: '/api/tokenizers/jamba/decode',
        count: '/api/tokenizers/jamba/encode',
    },
    [tokenizers.QWEN2]: {
        encode: '/api/tokenizers/qwen2/encode',
        decode: '/api/tokenizers/qwen2/decode',
        count: '/api/tokenizers/qwen2/encode',
    },
    [tokenizers.COMMAND_R]: {
        encode: '/api/tokenizers/command-r/encode',
        decode: '/api/tokenizers/command-r/decode',
        count: '/api/tokenizers/command-r/encode',
    },
    [tokenizers.COMMAND_A]: {
        encode: '/api/tokenizers/command-a/encode',
        decode: '/api/tokenizers/command-a/decode',
        count: '/api/tokenizers/command-a/encode',
    },
    [tokenizers.NEMO]: {
        encode: '/api/tokenizers/nemo/encode',
        decode: '/api/tokenizers/nemo/decode',
        count: '/api/tokenizers/nemo/encode',
    },
    [tokenizers.DEEPSEEK]: {
        encode: '/api/tokenizers/deepseek/encode',
        decode: '/api/tokenizers/deepseek/decode',
        count: '/api/tokenizers/deepseek/encode',
    },
    [tokenizers.API_TEXTGENERATIONWEBUI]: {
        encode: '/api/tokenizers/remote/textgenerationwebui/encode',
        count: '/api/tokenizers/remote/textgenerationwebui/encode',
    },
};

const textEncoder = new TextEncoder();
const objectStore = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });

// SillyBunny: O(1) Map-based two-level LRU token cache (chatId -> (cacheKey -> tokenCount))
// with dirty-flag tracking so saveTokenCache() is a 0ms no-op when no counts changed.
export const MAX_CACHED_CHATS = 20;
export const MAX_CACHE_ENTRIES_PER_CHAT = 500;
const COUNT_BATCH_MAX_TEXTS = 500;
const COUNT_BATCH_MAX_TEXT_LENGTH = 500_000;
const COUNT_BATCH_MAX_TOTAL_CHARS = 2_000_000;
const MULTIMODAL_STRING_FINGERPRINT_THRESHOLD = 256;

const LOCAL_TOKENIZER_BATCH_MODELS = Object.freeze({
    [tokenizers.GPT2]: 'gpt2',
    [tokenizers.OPENAI]: '',
    [tokenizers.LLAMA]: 'llama',
    [tokenizers.NERD]: 'nerdstash',
    [tokenizers.NERD2]: 'nerdstash_v2',
    [tokenizers.MISTRAL]: 'mistral',
    [tokenizers.YI]: 'yi',
    [tokenizers.CLAUDE]: 'claude',
    [tokenizers.LLAMA3]: 'llama3',
    [tokenizers.GEMMA]: 'gemma',
    [tokenizers.JAMBA]: 'jamba',
    [tokenizers.QWEN2]: 'qwen2',
    [tokenizers.COMMAND_R]: 'command-r',
    [tokenizers.COMMAND_A]: 'command-a',
    [tokenizers.NEMO]: 'nemo',
    [tokenizers.DEEPSEEK]: 'deepseek',
});

/** @type {Map<string, Map<string, number>>} */
const tokenCache = new Map();
let tokenCacheDirty = false;
let tokenCacheMutationVersion = 0;

/** @type {boolean | null} */
let countBatchEndpointAvailable = null;

/** @type {Map<string, Promise<number>>} */
const inFlightTokenCounts = new Map();

/** @type {Map<string, { isOpenAI: boolean, model: string, tokenizerType: number, items: Array<{ text: string, cacheKey: string, chatKey: string, resolve: (value: number) => void }> }>} */
const pendingPlainTextBatches = new Map();
let plainTextBatchScheduled = false;

/** @type {Map<string, Array<{ message: object, cacheKey: string, chatKey: string, cacheable: boolean, resolve: (value: number | null) => void }>>} */
const pendingOpenAIMessageBatches = new Map();
let openAIMessageBatchScheduled = false;

function markTokenCacheDirty() {
    tokenCacheDirty = true;
    tokenCacheMutationVersion += 1;
}

function getCurrentTokenCacheChatKey() {
    let chatId = 'undefined';

    try {
        if (selected_group) {
            chatId = groups.find(x => x.id == selected_group)?.chat_id;
        } else if (this_chid !== undefined) {
            chatId = characters[this_chid].chat;
        }
    } catch {
        console.log('No character / group selected. Using default cache item');
    }

    return String(chatId);
}

/**
 * Gets (and optionally creates) the per-chat LRU Map, promoting it in O(1).
 * Eviction happens strictly on insert when size exceeds MAX_CACHED_CHATS.
 * @param {string} chatKey
 * @param {{ create?: boolean }} [options]
 * @returns {Map<string, number> | null}
 */
function getChatTokenCacheMap(chatKey = getCurrentTokenCacheChatKey(), { create = false } = {}) {
    const existing = tokenCache.get(chatKey);
    if (existing) {
        tokenCache.delete(chatKey);
        tokenCache.set(chatKey, existing);
        return existing;
    }

    if (!create) {
        return null;
    }

    const created = new Map();
    tokenCache.set(chatKey, created);
    while (tokenCache.size > MAX_CACHED_CHATS) {
        const oldestChatKey = tokenCache.keys().next().value;
        if (oldestChatKey === undefined) {
            break;
        }
        tokenCache.delete(oldestChatKey);
        markTokenCacheDirty();
    }
    return created;
}

/**
 * Looks up a cached token count and promotes the entry in O(1) without scanning keys.
 * @param {string} cacheKey
 * @param {string} [chatKey]
 * @returns {number | undefined}
 */
function getCachedTokenCount(cacheKey, chatKey = getCurrentTokenCacheChatKey()) {
    const chatMap = getChatTokenCacheMap(chatKey, { create: false });
    if (!chatMap || !chatMap.has(cacheKey)) {
        return undefined;
    }

    const value = chatMap.get(cacheKey);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        chatMap.delete(cacheKey);
        return undefined;
    }

    chatMap.delete(cacheKey);
    chatMap.set(cacheKey, value);
    return value;
}

/**
 * Inserts or updates a cached token count in O(1), evicting oldest entries only on insert overflow.
 * @param {string} cacheKey
 * @param {number} value
 * @param {string} [chatKey]
 */
function setCachedTokenCount(cacheKey, value, chatKey = getCurrentTokenCacheChatKey()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
    }

    const chatMap = getChatTokenCacheMap(chatKey, { create: true });
    const hadKey = chatMap.has(cacheKey);
    const previous = hadKey ? chatMap.get(cacheKey) : undefined;
    if (hadKey) {
        chatMap.delete(cacheKey);
    }
    chatMap.set(cacheKey, value);

    if (!hadKey || previous !== value) {
        markTokenCacheDirty();
    }

    while (chatMap.size > MAX_CACHE_ENTRIES_PER_CHAT) {
        const oldestEntryKey = chatMap.keys().next().value;
        if (oldestEntryKey === undefined) {
            break;
        }
        chatMap.delete(oldestEntryKey);
        markTokenCacheDirty();
    }
}

function serializeTokenCache() {
    /** @type {Record<string, Record<string, number>>} */
    const plain = {};
    for (const [chatKey, chatMap] of tokenCache.entries()) {
        if (!(chatMap instanceof Map) || chatMap.size === 0) {
            continue;
        }
        plain[chatKey] = Object.fromEntries(chatMap);
    }
    return plain;
}

function hydrateTokenCache(rawCache) {
    tokenCache.clear();
    if (!rawCache || typeof rawCache !== 'object') {
        return;
    }

    const chatEntries = rawCache instanceof Map
        ? Array.from(rawCache.entries())
        : Object.entries(rawCache);
    const boundedChats = chatEntries.slice(-MAX_CACHED_CHATS);

    for (const [chatKey, rawChatEntries] of boundedChats) {
        if (!rawChatEntries || typeof rawChatEntries !== 'object') {
            continue;
        }
        const innerEntries = rawChatEntries instanceof Map
            ? Array.from(rawChatEntries.entries())
            : Object.entries(rawChatEntries);
        const chatMap = new Map();
        const startIdx = Math.max(0, innerEntries.length - MAX_CACHE_ENTRIES_PER_CHAT);
        for (let i = startIdx; i < innerEntries.length; i++) {
            const [entryKey, count] = innerEntries[i];
            if (typeof count === 'number' && Number.isFinite(count)) {
                chatMap.set(String(entryKey), count);
            }
        }
        tokenCache.set(String(chatKey), chatMap);
    }
}

/**
 * Guesstimates the token count for a string.
 * @param {string} str String to tokenize.
 * @returns {number} Token count.
 */
export function guesstimate(str) {
    const byteLength = textEncoder.encode(str).length;
    return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

export async function loadTokenCache() {
    try {
        console.debug('Chat Completions: loading token cache');
        const stored = await objectStore.getItem('tokenCache');
        hydrateTokenCache(stored);
        tokenCacheDirty = false;
    } catch (e) {
        console.log('Chat Completions: unable to load token cache, using default value', e);
        tokenCache.clear();
        tokenCacheDirty = false;
    }
}

export async function saveTokenCache() {
    // SillyBunny: skip IDB serialization and write entirely when no token counts changed.
    if (!tokenCacheDirty) {
        return;
    }

    const snapshotVersion = tokenCacheMutationVersion;
    const serialized = serializeTokenCache();
    tokenCacheDirty = false;

    try {
        console.debug('Chat Completions: saving token cache');
        await objectStore.setItem('tokenCache', serialized);
        if (tokenCacheMutationVersion !== snapshotVersion) {
            tokenCacheDirty = true;
        }
    } catch (e) {
        tokenCacheDirty = true;
        console.log('Chat Completions: unable to save token cache', e);
    }
}

export async function resetTokenCache({ toast = true } = {}) {
    try {
        console.debug('Chat Completions: resetting token cache');
        tokenCache.clear();
        tokenCacheDirty = false;
        tokenCacheMutationVersion = 0;
        await objectStore.removeItem('tokenCache');
        if (toast) {
            toastr.success('Token cache cleared.');
        }
    } catch (e) {
        console.log('Chat Completions: unable to reset token cache', e);
    }
}

export function isTokenCacheDirty() {
    return tokenCacheDirty;
}

export function getTokenCacheStatsForTests() {
    const currentChatKey = getCurrentTokenCacheChatKey();
    const currentChatMap = tokenCache.get(currentChatKey);
    return {
        chatCount: tokenCache.size,
        chatKeys: Array.from(tokenCache.keys()),
        currentChatKey,
        currentChatSize: currentChatMap ? currentChatMap.size : 0,
        currentChatKeys: currentChatMap ? Array.from(currentChatMap.keys()) : [],
        dirty: tokenCacheDirty,
        countBatchEndpointAvailable,
    };
}

export function resetTokenizerPerfStateForTests() {
    tokenCache.clear();
    tokenCacheDirty = false;
    tokenCacheMutationVersion = 0;
    countBatchEndpointAvailable = null;
    inFlightTokenCounts.clear();
    pendingPlainTextBatches.clear();
    plainTextBatchScheduled = false;
    pendingOpenAIMessageBatches.clear();
    openAIMessageBatchScheduled = false;
}

/**
 * @typedef {object} Tokenizer
 * @property {number} tokenizerId - The id of the tokenizer option
 * @property {string} tokenizerKey - Internal name/key of the tokenizer
 * @property {string} tokenizerName - Human-readable detailed name of the tokenizer (as displayed in the UI)
 */

/**
 * Gets all tokenizers available to the user.
 * @returns {Tokenizer[]} Tokenizer info.
 */
export function getAvailableTokenizers() {
    const tokenizerOptions = $('#tokenizer').find('option').toArray();
    return tokenizerOptions.map(tokenizerOption => ({
        tokenizerId: Number(tokenizerOption.value),
        tokenizerKey: Object.entries(tokenizers).find(([_, value]) => value === Number(tokenizerOption.value))[0].toLocaleLowerCase(),
        tokenizerName: tokenizerOption.text,
    }));
}

/**
 * Selects tokenizer if not already selected.
 * @param {number} tokenizerId Tokenizer ID.
 */
export function selectTokenizer(tokenizerId) {
    if (tokenizerId !== power_user.tokenizer) {
        const tokenizer = getAvailableTokenizers().find(tokenizer => tokenizer.tokenizerId === tokenizerId);
        if (!tokenizer) {
            console.warn('Failed to find tokenizer with id', tokenizerId);
            return;
        }
        $('#tokenizer').val(tokenizer.tokenizerId).trigger('change');
        toastr.info(`Tokenizer: "${tokenizer.tokenizerName}" selected`);
    }
}

/**
 * Gets the friendly name of the current tokenizer.
 * @param {string} forApi API to get the tokenizer for. Defaults to the main API.
 * @returns {Tokenizer} Tokenizer info
 */
export function getFriendlyTokenizerName(forApi) {
    if (!forApi) {
        forApi = main_api;
    }

    const tokenizerOption = $('#tokenizer').find(':selected');
    let tokenizerId = Number(tokenizerOption.val());
    let tokenizerName = tokenizerOption.text();

    if (forApi !== 'openai' && tokenizerId === tokenizers.BEST_MATCH) {
        tokenizerId = getTokenizerBestMatch(forApi);

        switch (tokenizerId) {
            case tokenizers.API_KOBOLD:
                tokenizerName = 'API (KoboldAI Classic)';
                break;
            case tokenizers.API_TEXTGENERATIONWEBUI:
                tokenizerName = 'API (Text Completion)';
                break;
            default:
                tokenizerName = $(`#tokenizer option[value="${tokenizerId}"]`).text();
                break;
        }
    }

    tokenizerName = forApi == 'openai'
        ? getTokenizerModel()
        : tokenizerName;

    tokenizerId = forApi == 'openai'
        ? tokenizers.OPENAI
        : tokenizerId;

    const tokenizerKey = Object.entries(tokenizers).find(([_, value]) => value === tokenizerId)[0].toLocaleLowerCase();

    return { tokenizerName, tokenizerKey, tokenizerId };
}

/**
 * Gets the best tokenizer for the current API.
 * @param {string} forApi API to get the tokenizer for. Defaults to the main API.
 * @returns {number} Tokenizer type.
 */
export function getTokenizerBestMatch(forApi) {
    if (!forApi) {
        forApi = main_api;
    }

    if (forApi === 'novel') {
        if (nai_settings.model_novel.includes('clio')) {
            return tokenizers.NERD;
        }
        if (nai_settings.model_novel.includes('kayra')) {
            return tokenizers.NERD2;
        }
        if (nai_settings.model_novel.includes('erato')) {
            return tokenizers.LLAMA3;
        }
    }
    if (forApi === 'kobold' || forApi === 'textgenerationwebui' || forApi === 'koboldhorde') {
        // Try to use the API tokenizer if possible:
        // - API must be connected
        // - Kobold must pass a version check
        // - Tokenizer haven't reported an error previously
        const hasTokenizerError = sessionStorage.getItem(TOKENIZER_WARNING_KEY);
        const hasValidEndpoint = sessionStorage.getItem(TOKENIZER_SUPPORTED_KEY);
        const isConnected = online_status !== 'no_connection';
        const isTokenizerSupported = TEXTGEN_TOKENIZERS.includes(textgen_settings.type) && (textgen_settings.type !== textgen_types.OOBA || hasValidEndpoint);

        if (!hasTokenizerError && isConnected) {
            if (forApi === 'kobold' && kai_flags.can_use_tokenization) {
                return tokenizers.API_KOBOLD;
            }

            if (forApi === 'textgenerationwebui' && isTokenizerSupported) {
                return tokenizers.API_TEXTGENERATIONWEBUI;
            }
            if (forApi === 'textgenerationwebui' && textgen_settings.type === textgen_types.OPENROUTER) {
                return getCurrentOpenRouterModelTokenizer();
            }
            if (forApi === 'textgenerationwebui' && textgen_settings.type === textgen_types.DREAMGEN) {
                return getCurrentDreamGenModelTokenizer();
            }
        }

        if (forApi === 'textgenerationwebui') {
            const model = String(getTextGenModel() || online_status).toLowerCase();
            if (model.includes('llama3') || model.includes('llama-3')) {
                return tokenizers.LLAMA3;
            }
            if (model.includes('mistral') || model.includes('mixtral')) {
                return tokenizers.MISTRAL;
            }
            if (model.includes('gemma')) {
                return tokenizers.GEMMA;
            }
            if (model.includes('nemo') || model.includes('pixtral')) {
                return tokenizers.NEMO;
            }
            if (model.includes('deepseek')) {
                return tokenizers.DEEPSEEK;
            }
            if (model.includes('yi')) {
                return tokenizers.YI;
            }
            if (model.includes('jamba')) {
                return tokenizers.JAMBA;
            }
            if (model.includes('command-r')) {
                return tokenizers.COMMAND_R;
            }
            if (model.includes('command-a')) {
                return tokenizers.COMMAND_A;
            }
            if (model.includes('qwen2')) {
                return tokenizers.QWEN2;
            }
        }

        return tokenizers.LLAMA;
    }

    return tokenizers.NONE;
}

// Get the current remote tokenizer API based on the current text generation API.
function currentRemoteTokenizerAPI() {
    switch (main_api) {
        case 'kobold':
            return tokenizers.API_KOBOLD;
        case 'textgenerationwebui':
            return tokenizers.API_TEXTGENERATIONWEBUI;
        default:
            return tokenizers.NONE;
    }
}

/**
 * Calls the underlying tokenizer model to the token count for a string.
 * @param {number} type Tokenizer type.
 * @param {string} str String to tokenize.
 * @returns {number} Token count.
 */
function callTokenizer(type, str) {
    if (type === tokenizers.NONE) return guesstimate(str);

    switch (type) {
        case tokenizers.API_CURRENT:
            return callTokenizer(currentRemoteTokenizerAPI(), str);
        case tokenizers.API_KOBOLD:
            return countTokensFromKoboldAPI(str);
        case tokenizers.API_TEXTGENERATIONWEBUI:
            return countTokensFromTextgenAPI(str);
        default: {
            const endpointUrl = TOKENIZER_URLS[type]?.count;
            if (!endpointUrl) {
                console.warn('Unknown tokenizer type', type);
                return apiFailureTokenCount(str);
            }
            return countTokensFromServer(endpointUrl, str);
        }
    }
}

/**
 * Calls the underlying tokenizer model to the token count for a string.
 * @param {number} type Tokenizer type.
 * @param {string} str String to tokenize.
 * @returns {Promise<number>} Token count.
 */
function callTokenizerAsync(type, str) {
    return new Promise(resolve => {
        if (type === tokenizers.NONE) {
            return resolve(guesstimate(str));
        }

        switch (type) {
            case tokenizers.API_CURRENT:
                return callTokenizerAsync(currentRemoteTokenizerAPI(), str).then(resolve);
            case tokenizers.API_KOBOLD:
                return countTokensFromKoboldAPI(str, resolve);
            case tokenizers.API_TEXTGENERATIONWEBUI:
                return countTokensFromTextgenAPI(str, resolve);
            default: {
                const endpointUrl = TOKENIZER_URLS[type]?.count;
                if (!endpointUrl) {
                    console.warn('Unknown tokenizer type', type);
                    return resolve(apiFailureTokenCount(str));
                }
                return countTokensFromServer(endpointUrl, str, resolve);
            }
        }
    });
}

function isNotFoundAjaxError(error) {
    const status = Number(error?.status ?? error?.jqXHR?.status ?? error?.response?.status);
    return status === 404;
}

function splitPlainTextBatchChunks(items) {
    const chunks = [];
    let current = [];
    let currentChars = 0;

    for (const item of items) {
        const len = item.text.length;
        if (current.length > 0 && (current.length >= COUNT_BATCH_MAX_TEXTS || currentChars + len > COUNT_BATCH_MAX_TOTAL_CHARS)) {
            chunks.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(item);
        currentChars += len;
    }

    if (current.length > 0) {
        chunks.push(current);
    }

    return chunks;
}

async function requestOpenAIPerMessageCounts(model, messages) {
    try {
        const data = await jQuery.ajax({
            async: true,
            type: 'POST',
            url: `/api/tokenizers/openai/count?model=${model}&per_message=1`,
            data: JSON.stringify(messages),
            dataType: 'json',
            contentType: 'application/json',
        });

        const counts = data?.token_counts;
        if (!Array.isArray(counts) || counts.length !== messages.length) {
            return null;
        }

        return counts.map(value => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        });
    } catch (error) {
        console.error('Failed to count token batch with OpenAI per_message fallback.', error);
        return null;
    }
}

async function flushPlainTextBucket(bucket) {
    const chunks = splitPlainTextBatchChunks(bucket.items);

    for (const chunk of chunks) {
        if (chunk.length === 1 && !bucket.isOpenAI) {
            const [single] = chunk;
            const count = await callTokenizerAsync(bucket.tokenizerType, single.text);
            if (Number.isFinite(count)) {
                setCachedTokenCount(single.cacheKey, count, single.chatKey);
            }
            single.resolve(count);
            continue;
        }

        if (chunk.length === 1 && bucket.isOpenAI && countBatchEndpointAvailable !== true) {
            const [single] = chunk;
            const message = { content: single.text };
            const count = await requestOpenAITokenCount(`/api/tokenizers/openai/count?model=${bucket.model}`, [message]);
            if (count === null) {
                single.resolve(guesstimate(JSON.stringify(message)));
            } else {
                if (bucket.model !== chat_completion_sources.KOBOLDCPP) {
                    setCachedTokenCount(single.cacheKey, count, single.chatKey);
                }
                single.resolve(count);
            }
            continue;
        }

        const texts = chunk.map(item => item.text);
        let resolvedCounts = null;

        if (countBatchEndpointAvailable !== false) {
            try {
                const data = await jQuery.ajax({
                    async: true,
                    type: 'POST',
                    url: '/api/tokenizers/count-batch',
                    data: JSON.stringify({ model: bucket.model, texts }),
                    dataType: 'json',
                    contentType: 'application/json',
                });

                if (Array.isArray(data?.counts) && data.counts.length === chunk.length) {
                    countBatchEndpointAvailable = true;
                    resolvedCounts = data.counts.map(value => {
                        const parsed = Number(value);
                        return Number.isFinite(parsed) ? parsed : null;
                    });
                }
            } catch (error) {
                if (isNotFoundAjaxError(error)) {
                    // SillyBunny: graceful cross-PR fallback when /api/tokenizers/count-batch is not present yet.
                    countBatchEndpointAvailable = false;
                } else {
                    console.error('Failed to count tokens via /api/tokenizers/count-batch.', error);
                }
            }
        }

        if (!resolvedCounts) {
            if (bucket.isOpenAI) {
                const messages = texts.map(text => ({ content: text }));
                resolvedCounts = await requestOpenAIPerMessageCounts(bucket.model, messages);
                if (!resolvedCounts) {
                    resolvedCounts = messages.map(msg => guesstimate(JSON.stringify(msg)));
                } else {
                    for (let i = 0; i < chunk.length; i++) {
                        const val = resolvedCounts[i];
                        if (val !== null && bucket.model !== chat_completion_sources.KOBOLDCPP) {
                            setCachedTokenCount(chunk[i].cacheKey, val, chunk[i].chatKey);
                        }
                    }
                    for (let i = 0; i < chunk.length; i++) {
                        const val = resolvedCounts[i];
                        chunk[i].resolve(val ?? guesstimate(JSON.stringify(messages[i])));
                    }
                    continue;
                }
                for (let i = 0; i < chunk.length; i++) {
                    chunk[i].resolve(resolvedCounts[i]);
                }
                continue;
            }

            const counts = await Promise.all(chunk.map(item => callTokenizerAsync(bucket.tokenizerType, item.text)));
            for (let i = 0; i < chunk.length; i++) {
                const count = counts[i];
                if (Number.isFinite(count)) {
                    setCachedTokenCount(chunk[i].cacheKey, count, chunk[i].chatKey);
                }
                chunk[i].resolve(count);
            }
            continue;
        }

        for (let i = 0; i < chunk.length; i++) {
            const val = resolvedCounts[i];
            if (val !== null && (!bucket.isOpenAI || bucket.model !== chat_completion_sources.KOBOLDCPP)) {
                setCachedTokenCount(chunk[i].cacheKey, val, chunk[i].chatKey);
            }
            chunk[i].resolve(val ?? guesstimate(chunk[i].text));
        }
    }
}

function flushPlainTextBatches() {
    plainTextBatchScheduled = false;
    if (pendingPlainTextBatches.size === 0) {
        return;
    }

    const buckets = Array.from(pendingPlainTextBatches.values());
    pendingPlainTextBatches.clear();
    for (const bucket of buckets) {
        void flushPlainTextBucket(bucket);
    }
}

function enqueuePlainTextBatchCount({ bucketKey, isOpenAI, model, tokenizerType = tokenizers.NONE, text, cacheKey, chatKey }) {
    const inFlightKey = `${chatKey}::${bucketKey}::${cacheKey}`;
    const existingPromise = inFlightTokenCounts.get(inFlightKey);
    if (existingPromise) {
        return existingPromise;
    }

    const promise = new Promise((resolve) => {
        let bucket = pendingPlainTextBatches.get(bucketKey);
        if (!bucket) {
            bucket = { isOpenAI, model, tokenizerType, items: [] };
            pendingPlainTextBatches.set(bucketKey, bucket);
        }
        bucket.items.push({ text, cacheKey, chatKey, resolve });
        if (!plainTextBatchScheduled) {
            plainTextBatchScheduled = true;
            queueMicrotask(flushPlainTextBatches);
        }
    }).finally(() => {
        inFlightTokenCounts.delete(inFlightKey);
    });

    inFlightTokenCounts.set(inFlightKey, promise);
    return promise;
}

/**
 * Gets the token count for a string using the current model tokenizer.
 * @param {string} str String to tokenize
 * @param {number | undefined} padding Optional padding tokens. Defaults to 0.
 * @returns {Promise<number>} Token count.
 */
export async function getTokenCountAsync(str, padding = undefined) {
    if (typeof str !== 'string' || !str?.length) {
        return 0;
    }

    let tokenizerType = power_user.tokenizer;
    let modelHash = '';

    if (main_api === 'openai') {
        if (padding === power_user.token_padding) {
            // For main "shadow" prompt building
            tokenizerType = tokenizers.NONE;
        } else {
            // For extensions and WI
            return counterWrapperOpenAIAsync(str);
        }
    }

    if (tokenizerType === tokenizers.BEST_MATCH) {
        tokenizerType = getTokenizerBestMatch(main_api);
    }

    if (tokenizerType === tokenizers.API_CURRENT) {
        tokenizerType = currentRemoteTokenizerAPI();
    }

    if (tokenizerType === tokenizers.API_TEXTGENERATIONWEBUI) {
        modelHash = getStringHash(getTextGenModel() || online_status).toString();
    }

    if (padding === undefined) {
        padding = 0;
    }

    const chatKey = getCurrentTokenCacheChatKey();
    const hash = getStringHash(str);
    const cacheKey = `${tokenizerType}-${hash}${modelHash}+${padding}`;
    const cached = getCachedTokenCount(cacheKey, chatKey);

    if (typeof cached === 'number') {
        return cached;
    }

    let baseCount;
    if (
        tokenizerType !== tokenizers.NONE &&
        Object.hasOwn(LOCAL_TOKENIZER_BATCH_MODELS, tokenizerType) &&
        str.length <= COUNT_BATCH_MAX_TEXT_LENGTH
    ) {
        const rawCacheKey = `${tokenizerType}-${hash}${modelHash}+0`;
        const cachedRaw = padding === 0 ? undefined : getCachedTokenCount(rawCacheKey, chatKey);
        if (typeof cachedRaw === 'number') {
            baseCount = cachedRaw;
        } else {
            baseCount = await enqueuePlainTextBatchCount({
                bucketKey: `local:${tokenizerType}:${modelHash}`,
                isOpenAI: false,
                model: LOCAL_TOKENIZER_BATCH_MODELS[tokenizerType],
                tokenizerType,
                text: str,
                cacheKey: rawCacheKey,
                chatKey,
            });
        }
    } else {
        const inFlightKey = `${chatKey}::direct::${cacheKey}`;
        let pending = inFlightTokenCounts.get(inFlightKey);
        if (!pending) {
            pending = callTokenizerAsync(tokenizerType, str).finally(() => {
                inFlightTokenCounts.delete(inFlightKey);
            });
            inFlightTokenCounts.set(inFlightKey, pending);
        }
        baseCount = await pending;
    }

    const result = baseCount + padding;

    if (isNaN(result)) {
        console.warn('Token count calculation returned NaN');
        return 0;
    }

    setCachedTokenCount(cacheKey, result, chatKey);
    return result;
}

/**
 * Gets the token count for a string using the current model tokenizer.
 * @param {string} str String to tokenize
 * @param {number | undefined} padding Optional padding tokens. Defaults to 0.
 * @returns {number} Token count.
 * @deprecated Use getTokenCountAsync instead.
 */
export function getTokenCount(str, padding = undefined) {
    if (typeof str !== 'string' || !str?.length) {
        return 0;
    }

    let tokenizerType = power_user.tokenizer;
    let modelHash = '';

    if (main_api === 'openai') {
        if (padding === power_user.token_padding) {
            // For main "shadow" prompt building
            tokenizerType = tokenizers.NONE;
        } else {
            // For extensions and WI
            return counterWrapperOpenAI(str);
        }
    }

    if (tokenizerType === tokenizers.BEST_MATCH) {
        tokenizerType = getTokenizerBestMatch(main_api);
    }

    if (tokenizerType === tokenizers.API_TEXTGENERATIONWEBUI) {
        modelHash = getStringHash(getTextGenModel() || online_status).toString();
    }

    if (padding === undefined) {
        padding = 0;
    }

    const chatKey = getCurrentTokenCacheChatKey();
    const hash = getStringHash(str);
    const cacheKey = `${tokenizerType}-${hash}${modelHash}+${padding}`;
    const cached = getCachedTokenCount(cacheKey, chatKey);

    if (typeof cached === 'number') {
        return cached;
    }

    const result = callTokenizer(tokenizerType, str) + padding;

    if (isNaN(result)) {
        console.warn('Token count calculation returned NaN');
        return 0;
    }

    setCachedTokenCount(cacheKey, result, chatKey);
    return result;
}

/**
 * Gets the token count for a string using the OpenAI tokenizer.
 * @param {string} text Text to tokenize.
 * @returns {number} Token count.
 * @deprecated Use counterWrapperOpenAIAsync instead.
 */
function counterWrapperOpenAI(text) {
    const message = { content: text };
    return countTokensOpenAI(message, true);
}

/**
 * Gets the token count for a string using the OpenAI tokenizer.
 * @param {string} text Text to tokenize.
 * @returns {Promise<number>} Token count.
 */
function counterWrapperOpenAIAsync(text) {
    const message = { content: text };
    return countTokensOpenAIAsync(message, true);
}

export function getTokenizerModel() {
    // SillyBunny: both native OpenAI API modes use the selected model for token counting.
    if ([chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES].includes(oai_settings.chat_completion_source)) {
        return oai_settings.openai_model;
    }

    // SillyBunny: KoboldCpp counts with the model it has loaded, so its counts are cached per model.
    if (isKoboldCppChatCompletion()) {
        return getChatCompletionModel() || chat_completion_sources.KOBOLDCPP;
    }

    const turboTokenizer = 'gpt-3.5-turbo';
    const gpt4Tokenizer = 'gpt-4';
    const gpt4oTokenizer = 'gpt-4o';
    const gpt2Tokenizer = 'gpt2';
    const claudeTokenizer = 'claude';
    const llamaTokenizer = 'llama';
    const llama3Tokenizer = 'llama3';
    const mistralTokenizer = 'mistral';
    const yiTokenizer = 'yi';
    const gemmaTokenizer = 'gemma';
    const jambaTokenizer = 'jamba';
    const qwen2Tokenizer = 'qwen2';
    const commandRTokenizer = 'command-r';
    const commandATokenizer = 'command-a';
    const nemoTokenizer = 'nemo';
    const deepseekTokenizer = 'deepseek';

    if (oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI) {
        return oai_settings.azure_openai_model || turboTokenizer;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK) {
        return deepseekTokenizer;
    }

    // And for OpenRouter (if not a site model, then it's impossible to determine the tokenizer)
    if (main_api == 'openai' && oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER && oai_settings.openrouter_model ||
        main_api == 'textgenerationwebui' && textgen_settings.type === textgen_types.OPENROUTER && textgen_settings.openrouter_model) {
        const model = main_api == 'openai'
            ? model_list.find(x => x.id === oai_settings.openrouter_model)
            : openRouterModels.find(x => x.id === textgen_settings.openrouter_model);

        if (model?.architecture?.tokenizer === 'Llama2') {
            return llamaTokenizer;
        } else if (model?.architecture?.tokenizer === 'Llama3') {
            return llama3Tokenizer;
        } else if (model?.architecture?.tokenizer === 'Mistral') {
            return mistralTokenizer;
        } else if (model?.architecture?.tokenizer === 'Yi') {
            return yiTokenizer;
        } else if (model?.architecture?.tokenizer === 'Gemini') {
            return gemmaTokenizer;
        } else if (model?.architecture?.tokenizer === 'Qwen') {
            return qwen2Tokenizer;
        } else if (model?.architecture?.tokenizer === 'Cohere') {
            if (model?.id && model?.id.includes('command-a')) {
                return commandATokenizer;
            }
            return commandRTokenizer;
        } else if (oai_settings.openrouter_model.includes('gpt-4o')) {
            return gpt4oTokenizer;
        } else if (oai_settings.openrouter_model.includes('gpt-4')) {
            return gpt4Tokenizer;
        } else if (oai_settings.openrouter_model.includes('gpt-3.5-turbo')) {
            return turboTokenizer;
        } else if (oai_settings.openrouter_model.includes('claude')) {
            return claudeTokenizer;
        } else if (oai_settings.openrouter_model.includes('GPT-NeoXT')) {
            return gpt2Tokenizer;
        } else if (oai_settings.openrouter_model.includes('jamba')) {
            return jambaTokenizer;
        } else if (oai_settings.openrouter_model.includes('deepseek')) {
            return deepseekTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB && oai_settings.electronhub_model) {
        if (oai_settings.electronhub_model.includes('gpt-4o') || oai_settings.electronhub_model.includes('gpt-5') || oai_settings.electronhub_model.includes('gpt-6-')) {
            return gpt4oTokenizer;
        } else if (oai_settings.electronhub_model.includes('gpt-4.1') || oai_settings.electronhub_model.includes('gpt-4.5')) {
            return gpt4oTokenizer;
        } else if (oai_settings.electronhub_model.includes('gpt-4')) {
            return gpt4Tokenizer;
        } else if (oai_settings.electronhub_model.includes('gpt-3.5-turbo')) {
            return turboTokenizer;
        } else if (oai_settings.electronhub_model.includes('claude')) {
            return claudeTokenizer;
        } else if (oai_settings.electronhub_model.includes('jamba')) {
            return jambaTokenizer;
        } else if (oai_settings.electronhub_model.includes('deepseek') || oai_settings.electronhub_model.includes('sonar-reasoning') || oai_settings.electronhub_model.includes('r1')) {
            return deepseekTokenizer;
        } else if (oai_settings.electronhub_model.includes('qwen')) {
            return qwen2Tokenizer;
        } else if (oai_settings.electronhub_model.includes('gemma')) {
            return gemmaTokenizer;
        } else if (oai_settings.electronhub_model.includes('mistral')) {
            return mistralTokenizer;
        } else if (oai_settings.electronhub_model.includes('yi')) {
            return yiTokenizer;
        } else if (oai_settings.electronhub_model.includes('llama3') || oai_settings.electronhub_model.includes('llama-3') || oai_settings.electronhub_model.startsWith('l3')) {
            return llama3Tokenizer;
        } else if (oai_settings.electronhub_model.includes('llama')) {
            return llamaTokenizer;
        } else if (oai_settings.electronhub_model.includes('command-a')) {
            return commandATokenizer;
        } else if (oai_settings.electronhub_model.includes('command-r')) {
            return commandRTokenizer;
        } else if (oai_settings.electronhub_model.includes('nemo')) {
            return nemoTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CHUTES && oai_settings.chutes_model) {
        const model = oai_settings.chutes_model.toLowerCase();

        if (model.includes('deepseek') || model.includes('mai-ds')) {
            return deepseekTokenizer;
        } else if (model.includes('qwen') || model.includes('qwq') || model.includes('tongyi') || model.includes('kimi')) {
            return qwen2Tokenizer;
        } else if (model.includes('llama') || model.includes('longcat') || model.includes('hermes')) {
            return llama3Tokenizer;
        } else if (model.includes('gemma')) {
            return gemmaTokenizer;
        } else if (model.includes('nemo')) {
            return nemoTokenizer;
        } else if (model.includes('mistral')) {
            return mistralTokenizer;
        } else if (model.includes('gpt-oss')) {
            return gpt4oTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MINIMAX) {
        // MiniMax uses a proprietary tokenizer; fall back to a coarse OpenAI estimation.
        return 'gpt-3.5-turbo';
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.WORKERS_AI && oai_settings.workers_ai_model) {
        const model = oai_settings.workers_ai_model.toLowerCase();

        if (model.includes('deepseek')) {
            return deepseekTokenizer;
        } else if (model.includes('qwen') || model.includes('qwq') || model.includes('kimi')) {
            return qwen2Tokenizer;
        } else if (model.includes('llama-3') || model.includes('llama-4')) {
            return llama3Tokenizer;
        } else if (model.includes('llama')) {
            return llamaTokenizer;
        } else if (model.includes('gemma')) {
            return gemmaTokenizer;
        } else if (model.includes('mistral')) {
            return mistralTokenizer;
        } else if (model.includes('phi')) {
            return turboTokenizer;
        } else if (model.includes('gpt-oss')) {
            return gpt4oTokenizer;
        }
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.COHERE) {
        if (oai_settings.cohere_model.includes('command-a')) {
            return commandATokenizer;
        }
        return commandRTokenizer;
    }

    if ([chat_completion_sources.MAKERSUITE, chat_completion_sources.GEMINI_INTERACTIONS].includes(oai_settings.chat_completion_source)) {
        return gemmaTokenizer;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI) {
        return gemmaTokenizer;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.AI21) {
        return jambaTokenizer;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CLAUDE) {
        return claudeTokenizer;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        if (oai_settings.mistralai_model.includes('nemo') || oai_settings.mistralai_model.includes('pixtral')) {
            return nemoTokenizer;
        }
        return mistralTokenizer;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        return oai_settings.custom_model;
    }

    if (oai_settings.chat_completion_source == chat_completion_sources.LINKAPI) {
        // Mixed vendor list; the server-side tokenizer resolver maps the raw id by name.
        return oai_settings.linkapi_model;
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.PERPLEXITY) {
        if (oai_settings.perplexity_model.includes('sonar-reasoning') || oai_settings.perplexity_model.includes('r1-1776')) {
            return deepseekTokenizer;
        }
        if (oai_settings.perplexity_model.includes('llama-3') || oai_settings.perplexity_model.includes('llama3')) {
            return llama3Tokenizer;
        }
        if (oai_settings.perplexity_model.includes('llama')) {
            return llamaTokenizer;
        }
        if (oai_settings.perplexity_model.includes('mistral') || oai_settings.perplexity_model.includes('mixtral')) {
            return mistralTokenizer;
        }
    }

    if (oai_settings.chat_completion_source === chat_completion_sources.GROQ) {
        if (oai_settings.groq_model.includes('qwen')) {
            return qwen2Tokenizer;
        }
        if (oai_settings.groq_model.includes('llama-3') || oai_settings.groq_model.includes('llama3')) {
            return llama3Tokenizer;
        }
        if (oai_settings.groq_model.includes('mistral') || oai_settings.groq_model.includes('mixtral')) {
            return mistralTokenizer;
        }
        if (oai_settings.groq_model.includes('gemma')) {
            return gemmaTokenizer;
        }
    }

    // Default to Turbo 3.5
    return turboTokenizer;
}

function isMultimodalOrLargeDataMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return false;
    }
    if (Array.isArray(message.content) || (message.content && typeof message.content === 'object')) {
        return true;
    }
    if ('image_url' in message || 'images' in message || 'inlineData' in message || 'audio' in message || 'video' in message) {
        return true;
    }
    if (typeof message.content === 'string' && message.content.length > 1024 && (message.content.includes(';base64,') || message.content.startsWith('data:'))) {
        return true;
    }
    return false;
}

function buildCompactMessageFingerprint(value, depth = 0) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'string') {
        if (value.length <= MULTIMODAL_STRING_FINGERPRINT_THRESHOLD) {
            return `s:${value.length}:${value}`;
        }
        const mid = value.length >> 1;
        return `L:${value.length}:${value.slice(0, 64)}:${value.slice(mid, mid + 32)}:${value.slice(-64)}`;
    }
    if (Array.isArray(value)) {
        if (depth > 6) {
            return `[arr:${value.length}]`;
        }
        return `[${value.map(item => buildCompactMessageFingerprint(item, depth + 1)).join(',')}]`;
    }
    if (typeof value === 'object') {
        if (depth > 6) {
            return '{obj}';
        }
        const keys = Object.keys(value);
        return `{${keys.map(key => `${key}:${buildCompactMessageFingerprint(value[key], depth + 1)}`).join(',')}}`;
    }
    return String(value);
}

/**
 * Computes a stable cache hash for an OpenAI message without JSON.stringifying multi-MB base64 media payloads.
 * Plain-text messages keep exact `getStringHash(JSON.stringify(message))` parity.
 * @param {object} message
 * @returns {number}
 */
export function getOpenAIMessageHash(message) {
    if (isMultimodalOrLargeDataMessage(message)) {
        return getStringHash(buildCompactMessageFingerprint(message));
    }
    return getStringHash(JSON.stringify(message));
}

function guesstimateOpenAIMessage(message) {
    if (isMultimodalOrLargeDataMessage(message)) {
        return guesstimate(buildCompactMessageFingerprint(message));
    }
    return guesstimate(JSON.stringify(message));
}

function isBareContentMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return false;
    }
    if (typeof message.content !== 'string' || message.content.length > COUNT_BATCH_MAX_TEXT_LENGTH) {
        return false;
    }
    const keys = Object.keys(message);
    return keys.length === 1 && keys[0] === 'content' && !isMultimodalOrLargeDataMessage(message);
}

async function flushOpenAIMessageBucket(model, items) {
    if (items.length === 1) {
        const [single] = items;
        const count = await requestOpenAITokenCount(`/api/tokenizers/openai/count?model=${model}`, [single.message]);
        if (count !== null && single.cacheable) {
            setCachedTokenCount(single.cacheKey, count, single.chatKey);
        }
        single.resolve(count);
        return;
    }

    const counts = await requestOpenAIPerMessageCounts(model, items.map(item => item.message));
    if (!counts) {
        for (const item of items) {
            item.resolve(null);
        }
        return;
    }

    for (let i = 0; i < items.length; i++) {
        const count = counts[i];
        if (count !== null && items[i].cacheable) {
            setCachedTokenCount(items[i].cacheKey, count, items[i].chatKey);
        }
        items[i].resolve(count);
    }
}

function flushOpenAIMessageBatches() {
    openAIMessageBatchScheduled = false;
    if (pendingOpenAIMessageBatches.size === 0) {
        return;
    }

    const entries = Array.from(pendingOpenAIMessageBatches.entries());
    pendingOpenAIMessageBatches.clear();
    for (const [model, items] of entries) {
        void flushOpenAIMessageBucket(model, items);
    }
}

function enqueueOpenAIMessageCount({ model, message, cacheKey, chatKey, cacheable }) {
    const inFlightKey = `${chatKey}::oai-msg::${cacheKey}`;
    const existing = inFlightTokenCounts.get(inFlightKey);
    if (existing) {
        return existing;
    }

    const promise = new Promise((resolve) => {
        let items = pendingOpenAIMessageBatches.get(model);
        if (!items) {
            items = [];
            pendingOpenAIMessageBatches.set(model, items);
        }
        items.push({ message, cacheKey, chatKey, cacheable, resolve });
        if (!openAIMessageBatchScheduled) {
            openAIMessageBatchScheduled = true;
            queueMicrotask(flushOpenAIMessageBatches);
        }
    }).finally(() => {
        inFlightTokenCounts.delete(inFlightKey);
    });

    inFlightTokenCounts.set(inFlightKey, promise);
    return promise;
}

/**
 * @param {any[] | Object} messages
 * @deprecated Use countTokensOpenAIAsync instead.
 */
export function countTokensOpenAI(messages, full = false) {
    const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${getTokenizerModel()}`;
    const chatKey = getCurrentTokenCacheChatKey();

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    let token_count = 0;

    for (const message of messages) {
        const model = getTokenizerModel();

        if (model === 'claude') {
            full = true;
        }

        const hash = getOpenAIMessageHash(message);
        const cacheKey = `${model}-${hash}`;
        const cachedCount = getCachedTokenCount(cacheKey, chatKey);

        if (typeof cachedCount === 'number') {
            token_count += cachedCount;
        } else if (isKoboldCppChatCompletion()) {
            // SillyBunny: The server picks a tokenizer by model name, and that tokenizer can differ from KoboldCpp's. Counts under this model name come only from KoboldCpp, so an estimate stands in and stays out of the cache.
            token_count += guesstimateOpenAIMessage(message);
        } else {
            jQuery.ajax({
                async: false,
                type: 'POST', //
                url: tokenizerEndpoint,
                data: JSON.stringify([message]),
                dataType: 'json',
                contentType: 'application/json',
                success: function (data) {
                    const parsed = Number(data.token_count);
                    token_count += parsed;
                    setCachedTokenCount(cacheKey, parsed, chatKey);
                },
            });
        }
    }

    if (!full) token_count -= 2;

    return token_count;
}

/**
 * Posts messages to the OpenAI token counting endpoint.
 * SillyBunny: jQuery rejects with the jqXHR object, which has no message or stack.
 * If that escapes into an async jQuery ready callback, jQuery rethrows it and the
 * whole startup aborts with an unreadable "[object Object]" error, so failures are
 * downgraded to the guesstimate fallback used everywhere else in this module.
 * @param {string} endpoint Tokenizer endpoint URL.
 * @param {object[]} messages Messages to count.
 * @returns {Promise<number|null>} Token count, or null when the request failed.
 */
async function requestOpenAITokenCount(endpoint, messages) {
    // SillyBunny: KoboldCpp counts with the tokenizer of the model it has loaded.
    if (isKoboldCppChatCompletion()) {
        return countKoboldCppChatTokens(messages);
    }

    try {
        const data = await jQuery.ajax({
            async: true,
            type: 'POST', //
            url: endpoint,
            data: JSON.stringify(messages),
            dataType: 'json',
            contentType: 'application/json',
        });

        const tokenCount = Number(data?.token_count);
        return Number.isFinite(tokenCount) ? tokenCount : null;
    } catch (error) {
        console.error('Failed to count tokens with the OpenAI tokenizer.', error);
        return null;
    }
}

/**
 * Returns the token count for a message using the OpenAI tokenizer.
 * @param {object[]|object} messages
 * @param {boolean} full
 * @returns {Promise<number>} Token count.
 */
export async function countTokensOpenAIAsync(messages, full = false) {
    const chatKey = getCurrentTokenCacheChatKey();
    const usingKoboldCpp = isKoboldCppChatCompletion();

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    let token_count = 0;
    /** @type {Array<Promise<number>>} */
    const pendingPromises = [];

    for (const message of messages) {
        const model = getTokenizerModel();

        if (model === 'claude') {
            full = true;
        }

        const hash = getOpenAIMessageHash(message);
        const cacheKey = `${model}-${hash}`;
        const cachedCount = getCachedTokenCount(cacheKey, chatKey);

        if (typeof cachedCount === 'number') {
            token_count += cachedCount;
            continue;
        }

        const cacheable = model !== chat_completion_sources.KOBOLDCPP;

        if (usingKoboldCpp) {
            const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${model}`;
            const tokenCount = await requestOpenAITokenCount(tokenizerEndpoint, [message]);
            if (tokenCount === null) {
                token_count += guesstimateOpenAIMessage(message);
                continue;
            }
            token_count += tokenCount;
            if (cacheable) {
                setCachedTokenCount(cacheKey, tokenCount, chatKey);
            }
            continue;
        }

        if (isBareContentMessage(message)) {
            pendingPromises.push(enqueuePlainTextBatchCount({
                bucketKey: `openai:${model}`,
                isOpenAI: true,
                model,
                text: message.content,
                cacheKey,
                chatKey,
            }));
            continue;
        }

        pendingPromises.push(
            enqueueOpenAIMessageCount({ model, message, cacheKey, chatKey, cacheable }).then(count => (
                count === null ? guesstimateOpenAIMessage(message) : count
            )),
        );
    }

    if (pendingPromises.length > 0) {
        const resolved = await Promise.all(pendingPromises);
        for (const value of resolved) {
            token_count += value;
        }
    }

    if (!full) token_count -= 2;

    return token_count;
}

/**
 * Counts several messages in one request and stores the results in the token cache.
 * SillyBunny addition: countTokensOpenAIAsync is awaited once per message by its callers,
 * so on a remotely hosted server each message costs a full round trip. Priming the cache
 * first collapses those into a single request; every entry it writes is the same value the
 * unbatched path would have cached. Failures are swallowed - callers then count individually.
 * @param {object[]} messages Messages that are about to be counted one at a time.
 * @returns {Promise<void>}
 */
export async function primeOpenAITokenCache(messages) {
    // SillyBunny: KoboldCpp counts one text per request, so its messages are counted when they are first needed.
    if (!Array.isArray(messages) || messages.length === 0 || isKoboldCppChatCompletion()) {
        return;
    }

    const model = getTokenizerModel();
    const chatKey = getCurrentTokenCacheChatKey();
    const pending = new Map();

    for (const message of messages) {
        const cacheKey = `${model}-${getOpenAIMessageHash(message)}`;

        if (typeof getCachedTokenCount(cacheKey, chatKey) === 'number' || pending.has(cacheKey)) {
            continue;
        }

        pending.set(cacheKey, message);
    }

    if (pending.size === 0) {
        return;
    }

    const cacheKeys = Array.from(pending.keys());
    const uncounted = Array.from(pending.values());

    try {
        const data = await jQuery.ajax({
            async: true,
            type: 'POST',
            url: `/api/tokenizers/openai/count?model=${model}&per_message=1`,
            data: JSON.stringify(uncounted),
            dataType: 'json',
            contentType: 'application/json',
        });

        const counts = data?.token_counts;

        if (!Array.isArray(counts) || counts.length !== cacheKeys.length) {
            return;
        }

        counts.forEach((count, index) => {
            const tokenCount = Number(count);

            if (Number.isFinite(tokenCount)) {
                setCachedTokenCount(cacheKeys[index], tokenCount, chatKey);
            }
        });
    } catch (error) {
        console.error('Failed to prime the OpenAI token cache.', error);
    }
}

/**
 * Returns the token count for a finalized chat completion payload using the OpenAI tokenizer.
 * @param {object[]} messages Final chat-completion messages.
 * @returns {Promise<number>} Token count.
 */
export async function countChatCompletionPayloadTokensOpenAIAsync(messages) {
    const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${getTokenizerModel()}`;

    // SillyBunny: count post-intercept payloads in one request so backend-specific
    // per-payload padding is applied once instead of once per message.
    const tokenCount = await requestOpenAITokenCount(tokenizerEndpoint, messages);

    return tokenCount === null ? guesstimate(JSON.stringify(messages)) : tokenCount;
}

/**
 * Count tokens using the server API.
 * @param {string} endpoint API endpoint.
 * @param {string} str String to tokenize.
 * @param {function} [resolve] Promise resolve function.s
 * @returns {number} Token count.
 */
function countTokensFromServer(endpoint, str, resolve) {
    const isAsync = typeof resolve === 'function';
    let tokenCount = 0;

    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: endpoint,
        data: JSON.stringify({ text: str }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            if (typeof data.count === 'number') {
                tokenCount = data.count;
            } else {
                tokenCount = apiFailureTokenCount(str);
            }

            isAsync && resolve(tokenCount);
        },
        error: function () {
            isAsync && resolve(apiFailureTokenCount(str));
        },
    });

    return tokenCount;
}

/**
 * Count tokens using the AI provider's API.
 * @param {string} str String to tokenize.
 * @param {function} [resolve] Promise resolve function.
 * @returns {number} Token count.
 */
function countTokensFromKoboldAPI(str, resolve) {
    const isAsync = typeof resolve === 'function';
    let tokenCount = 0;

    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: TOKENIZER_URLS[tokenizers.API_KOBOLD].count,
        data: JSON.stringify({
            text: str,
            url: kai_settings.api_server,
        }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            if (typeof data.count === 'number') {
                tokenCount = data.count;
            } else {
                tokenCount = apiFailureTokenCount(str);
            }

            isAsync && resolve(tokenCount);
        },
        error: function () {
            isAsync && resolve(apiFailureTokenCount(str));
        },
    });

    return tokenCount;
}

function getTextgenAPITokenizationParams(str) {
    return {
        text: str,
        api_type: textgen_settings.type,
        url: getTextGenServer(),
        model: getTextGenModel(),
    };
}

/**
 * Count tokens using the AI provider's API.
 * @param {string} str String to tokenize.
 * @param {function} [resolve] Promise resolve function.
 * @returns {number} Token count.
 */
function countTokensFromTextgenAPI(str, resolve) {
    const isAsync = typeof resolve === 'function';
    let tokenCount = 0;

    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: TOKENIZER_URLS[tokenizers.API_TEXTGENERATIONWEBUI].count,
        data: JSON.stringify(getTextgenAPITokenizationParams(str)),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            if (typeof data.count === 'number') {
                tokenCount = data.count;
            } else {
                tokenCount = apiFailureTokenCount(str);
            }

            isAsync && resolve(tokenCount);
        },
        error: function () {
            isAsync && resolve(apiFailureTokenCount(str));
        },
    });

    return tokenCount;
}

function apiFailureTokenCount(str) {
    console.error('Error counting tokens');
    let shouldTryAgain = false;

    if (!sessionStorage.getItem(TOKENIZER_WARNING_KEY)) {
        const bestMatchBefore = getTokenizerBestMatch(main_api);
        sessionStorage.setItem(TOKENIZER_WARNING_KEY, String(true));
        const bestMatchAfter = getTokenizerBestMatch(main_api);
        if ([tokenizers.API_TEXTGENERATIONWEBUI, tokenizers.API_KOBOLD].includes(bestMatchBefore) && bestMatchBefore !== bestMatchAfter) {
            shouldTryAgain = true;
        }
    }

    // Only try again if we guarantee not to be looped by the same error
    if (shouldTryAgain && power_user.tokenizer === tokenizers.BEST_MATCH) {
        return getTokenCount(str);
    }

    return guesstimate(str);
}

/**
 * Calls the underlying tokenizer model to encode a string to tokens.
 * @param {string} endpoint API endpoint.
 * @param {string} str String to tokenize.
 * @param {function} [resolve] Promise resolve function.
 * @returns {number[]} Array of token ids.
 */
function getTextTokensFromServer(endpoint, str, resolve) {
    const isAsync = typeof resolve === 'function';
    let ids = [];
    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: endpoint,
        data: JSON.stringify({ text: str }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            ids = data.ids;

            // Don't want to break reverse compatibility, so sprinkle in some of the JS magic
            if (Array.isArray(data.chunks)) {
                Object.defineProperty(ids, 'chunks', { value: data.chunks });
            }

            isAsync && resolve(ids);
        },
        error: function () {
            isAsync && resolve([]);
        },
    });
    return ids;
}

/**
 * Calls the AI provider's tokenize API to encode a string to tokens.
 * @param {string} str String to tokenize.
 * @param {function} [resolve] Promise resolve function.
 * @returns {number[]} Array of token ids.
 */
function getTextTokensFromTextgenAPI(str, resolve) {
    const isAsync = typeof resolve === 'function';
    let ids = [];
    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: TOKENIZER_URLS[tokenizers.API_TEXTGENERATIONWEBUI].encode,
        data: JSON.stringify(getTextgenAPITokenizationParams(str)),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            ids = data.ids;
            isAsync && resolve(ids);
        },
        error: function () {
            isAsync && resolve([]);
        },
    });
    return ids;
}

/**
 * Calls the AI provider's tokenize API to encode a string to tokens.
 * @param {string} str String to tokenize.
 * @param {function} [resolve] Promise resolve function.
 * @returns {number[]} Array of token ids.
 */
function getTextTokensFromKoboldAPI(str, resolve) {
    const isAsync = typeof resolve === 'function';
    let ids = [];

    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: TOKENIZER_URLS[tokenizers.API_KOBOLD].encode,
        data: JSON.stringify({
            text: str,
            url: kai_settings.api_server,
        }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            ids = data.ids;
            isAsync && resolve(ids);
        },
        error: function () {
            isAsync && resolve([]);
        },
    });

    return ids;
}

/**
 * Calls the underlying tokenizer model to decode token ids to text.
 * @param {string} endpoint API endpoint.
 * @param {number[]} ids Array of token ids
 * @param {function} [resolve] Promise resolve function.
 * @returns {({ text: string, chunks?: string[] })} Decoded token text as a single string and individual chunks (if available).
 */
function decodeTextTokensFromServer(endpoint, ids, resolve) {
    const isAsync = typeof resolve === 'function';
    let text = '';
    let chunks = [];
    jQuery.ajax({
        async: isAsync,
        type: 'POST',
        url: endpoint,
        data: JSON.stringify({ ids: ids }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            text = data.text;
            chunks = data.chunks;
            isAsync && resolve({ text, chunks });
        },
        error: function () {
            isAsync && resolve({ text: '', chunks: [] });
        },
    });
    return { text, chunks };
}

/**
 * Asynchronously encodes a string to tokens using the server API without blocking the main thread.
 * @param {number} tokenizerType Tokenizer type.
 * @param {string} str String to tokenize.
 * @returns {Promise<number[]>} Array of token ids.
 */
export function getTextTokensAsync(tokenizerType, str) {
    // SillyBunny: non-blocking counterpart to getTextTokens for live UI token counters.
    return new Promise((resolve) => {
        switch (tokenizerType) {
            case tokenizers.API_CURRENT:
                getTextTokensAsync(currentRemoteTokenizerAPI(), str).then(resolve);
                return;
            case tokenizers.API_TEXTGENERATIONWEBUI:
                getTextTokensFromTextgenAPI(str, resolve);
                return;
            case tokenizers.API_KOBOLD:
                getTextTokensFromKoboldAPI(str, resolve);
                return;
            default: {
                const tokenizerEndpoints = TOKENIZER_URLS[tokenizerType];
                if (!tokenizerEndpoints) {
                    apiFailureTokenCount(str);
                    console.warn('Unknown tokenizer type', tokenizerType);
                    resolve([]);
                    return;
                }
                let endpointUrl = tokenizerEndpoints.encode;
                if (!endpointUrl) {
                    apiFailureTokenCount(str);
                    console.warn('This tokenizer type does not support encoding', tokenizerType);
                    resolve([]);
                    return;
                }
                if (tokenizerType === tokenizers.OPENAI) {
                    endpointUrl += `?model=${getTokenizerModel()}`;
                }
                getTextTokensFromServer(endpointUrl, str, resolve);
            }
        }
    });
}

/**
 * Encodes a string to tokens using the server API.
 * @param {number} tokenizerType Tokenizer type.
 * @param {string} str String to tokenize.
 * @returns {number[]} Array of token ids.
 */
export function getTextTokens(tokenizerType, str) {
    switch (tokenizerType) {
        case tokenizers.API_CURRENT:
            return getTextTokens(currentRemoteTokenizerAPI(), str);
        case tokenizers.API_TEXTGENERATIONWEBUI:
            return getTextTokensFromTextgenAPI(str);
        case tokenizers.API_KOBOLD:
            return getTextTokensFromKoboldAPI(str);
        default: {
            const tokenizerEndpoints = TOKENIZER_URLS[tokenizerType];
            if (!tokenizerEndpoints) {
                apiFailureTokenCount(str);
                console.warn('Unknown tokenizer type', tokenizerType);
                return [];
            }
            let endpointUrl = tokenizerEndpoints.encode;
            if (!endpointUrl) {
                apiFailureTokenCount(str);
                console.warn('This tokenizer type does not support encoding', tokenizerType);
                return [];
            }
            if (tokenizerType === tokenizers.OPENAI) {
                endpointUrl += `?model=${getTokenizerModel()}`;
            }
            return getTextTokensFromServer(endpointUrl, str);
        }
    }
}

/**
 * Decodes token ids to text using the server API.
 * @param {number} tokenizerType Tokenizer type.
 * @param {number[]} ids Array of token ids
 * @returns {({ text: string, chunks?: string[] })} Decoded token text as a single string and individual chunks (if available).
 */
export function decodeTextTokens(tokenizerType, ids) {
    // Currently, neither remote API can decode, but this may change in the future. Put this guard here to be safe
    if (tokenizerType === tokenizers.API_CURRENT) {
        return decodeTextTokens(tokenizers.NONE, ids);
    }
    const tokenizerEndpoints = TOKENIZER_URLS[tokenizerType];
    if (!tokenizerEndpoints) {
        console.warn('Unknown tokenizer type', tokenizerType);
        return { text: '', chunks: [] };
    }
    let endpointUrl = tokenizerEndpoints.decode;
    if (!endpointUrl) {
        console.warn('This tokenizer type does not support decoding', tokenizerType);
        return { text: '', chunks: [] };
    }
    if (tokenizerType === tokenizers.OPENAI) {
        endpointUrl += `?model=${getTokenizerModel()}`;
    }
    return decodeTextTokensFromServer(endpointUrl, ids);
}

export async function initTokenizers() {
    TEXTGEN_TOKENIZERS.push(
        textgen_types.OOBA,
        textgen_types.TABBY,
        textgen_types.KOBOLDCPP,
        textgen_types.LLAMACPP,
        textgen_types.VLLM,
        textgen_types.APHRODITE,
    );
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, async () => {
        // Clear tokenizer warning when (re)connecting to an LLM backend that supports tokenization
        if (main_api === 'textgenerationwebui' && TEXTGEN_TOKENIZERS.includes(textgen_settings.type)) {
            sessionStorage.removeItem(TOKENIZER_WARNING_KEY);
        }
    });
    await loadTokenCache();
    registerDebugFunction('resetTokenCache', 'Reset token cache', 'Purges the calculated token counts. Use this if you want to force a full re-tokenization of all chats or suspect the token counts are wrong.', resetTokenCache);
}
