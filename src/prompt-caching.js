import { createHmac } from 'node:crypto';
import fetch from 'node-fetch';
import { getConfigValue } from './util.js';

export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
export const OPENROUTER_MODELS_CACHE_TTL_MS = 15 * 60 * 1000;

const API_OPENROUTER = 'https://openrouter.ai/api/v1';

/**
 * @typedef {object} PromptCachingConfig
 * @property {{ enableSystemPromptCache: boolean, cachingAtDepth: number, extendedTTL: boolean, cacheTTL: '1h'|'5m' }} claude
 * @property {{ enableSystemPromptCache: boolean, cachingAtDepth: number }} gemini
 */

/** @type {{ claude?: { enableSystemPromptCache?: boolean, cachingAtDepth?: number, extendedTTL?: boolean }, gemini?: { enableSystemPromptCache?: boolean, cachingAtDepth?: number } } | null} */
let runtimeCachingOverrides = null;

/** @type {Map<string, boolean> | null} */
let openRouterCacheableMap = null;
let openRouterCacheableExpiresAt = 0;
/** @type {Promise<Map<string, boolean> | null> | null} */
let openRouterCacheableInFlight = null;

/**
 * Normalizes a depth setting into a non-negative integer, or -1 when disabled.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeCachingDepth(value) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? -1), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

/**
 * Reads active prompt caching configuration, preferring live runtime overrides saved through server-admin.
 * @returns {PromptCachingConfig}
 */
export function getPromptCachingConfig() {
    const claudeSystemPromptCache = runtimeCachingOverrides?.claude?.enableSystemPromptCache
        ?? getConfigValue('claude.enableSystemPromptCache', false, 'boolean');
    const claudeCachingAtDepth = normalizeCachingDepth(
        runtimeCachingOverrides?.claude?.cachingAtDepth
        ?? getConfigValue('claude.cachingAtDepth', -1, 'number'),
    );
    const claudeExtendedTTL = runtimeCachingOverrides?.claude?.extendedTTL
        ?? getConfigValue('claude.extendedTTL', false, 'boolean');
    const geminiSystemPromptCache = runtimeCachingOverrides?.gemini?.enableSystemPromptCache
        ?? getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');
    const geminiCachingAtDepth = normalizeCachingDepth(
        runtimeCachingOverrides?.gemini?.cachingAtDepth
        ?? getConfigValue('gemini.cachingAtDepth', -1, 'number'),
    );

    return {
        claude: {
            enableSystemPromptCache: Boolean(claudeSystemPromptCache),
            cachingAtDepth: claudeCachingAtDepth,
            extendedTTL: Boolean(claudeExtendedTTL),
            cacheTTL: claudeExtendedTTL ? '1h' : '5m',
        },
        gemini: {
            enableSystemPromptCache: Boolean(geminiSystemPromptCache),
            cachingAtDepth: geminiCachingAtDepth,
        },
    };
}

/**
 * Applies prompt caching configuration in memory so saves take effect without waiting for a restart.
 * @param {{ claude?: object, gemini?: object }} [settings]
 */
export function setPromptCachingRuntimeConfig(settings = {}) {
    const next = {
        claude: { ...(runtimeCachingOverrides?.claude ?? {}) },
        gemini: { ...(runtimeCachingOverrides?.gemini ?? {}) },
    };

    if (settings?.claude && typeof settings.claude === 'object') {
        if ('enableSystemPromptCache' in settings.claude) {
            next.claude.enableSystemPromptCache = Boolean(settings.claude.enableSystemPromptCache);
        }
        if ('cachingAtDepth' in settings.claude) {
            next.claude.cachingAtDepth = normalizeCachingDepth(settings.claude.cachingAtDepth);
        }
        if ('extendedTTL' in settings.claude) {
            next.claude.extendedTTL = Boolean(settings.claude.extendedTTL);
        }
    }

    if (settings?.gemini && typeof settings.gemini === 'object') {
        if ('enableSystemPromptCache' in settings.gemini) {
            next.gemini.enableSystemPromptCache = Boolean(settings.gemini.enableSystemPromptCache);
        }
        if ('cachingAtDepth' in settings.gemini) {
            next.gemini.cachingAtDepth = normalizeCachingDepth(settings.gemini.cachingAtDepth);
        }
    }

    runtimeCachingOverrides = next;
}

/**
 * Clears in-memory runtime overrides so config.yaml values apply again.
 */
export function resetPromptCachingRuntimeConfig() {
    runtimeCachingOverrides = null;
}

/**
 * Resets cached OpenRouter model capability metadata.
 */
export function resetOpenRouterCacheableModelsCache() {
    openRouterCacheableMap = null;
    openRouterCacheableExpiresAt = 0;
    openRouterCacheableInFlight = null;
}

/**
 * Matches Claude models routed through OpenRouter, including `~` latest aliases.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isOpenRouterClaudeModel(model) {
    return /^~?anthropic\/claude/i.test(String(model ?? '').trim());
}

/**
 * Matches Gemini models routed through OpenRouter, including `~` latest aliases.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isOpenRouterGeminiModel(model) {
    return /^~?google\/gemini/i.test(String(model ?? '').trim());
}

/**
 * Matches Claude models routed through NanoGPT.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isNanoGptClaudeModel(model) {
    return /(?:^|[/:])claude[-_]/i.test(String(model ?? '').trim());
}

/**
 * Matches Claude models routed through Electron Hub.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isElectronHubClaudeModel(model) {
    return /(?:^|\/)claude[-_]/i.test(String(model ?? '').trim());
}

/**
 * Strips an OpenRouter routing suffix (`:online`, `:nitro`, `:floor`, etc.) from a model ID.
 * @param {unknown} modelId
 * @returns {string}
 */
export function stripOpenRouterModelSuffix(modelId) {
    const normalized = String(modelId ?? '').trim();
    if (!normalized) {
        return '';
    }
    const colonIndex = normalized.lastIndexOf(':');
    const slashIndex = normalized.lastIndexOf('/');
    return colonIndex > slashIndex ? normalized.slice(0, colonIndex) : normalized;
}

/**
 * Checks whether an OpenRouter model advertises explicit cache-write support.
 * Caches the catalog for 15 minutes and falls back to the base model ID when a routing suffix is used.
 * @param {string} modelId
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, ttlMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function isOpenRouterModelCacheable(modelId, { fetchImpl = fetch, now = Date.now, ttlMs = OPENROUTER_MODELS_CACHE_TTL_MS } = {}) {
    const normalized = String(modelId ?? '').trim();
    if (!normalized) {
        return false;
    }

    const lookupInMap = (map) => {
        if (!map) {
            return false;
        }
        if (map.has(normalized)) {
            return Boolean(map.get(normalized));
        }
        const stripped = stripOpenRouterModelSuffix(normalized);
        if (stripped && stripped !== normalized && map.has(stripped)) {
            return Boolean(map.get(stripped));
        }
        return false;
    };

    if (openRouterCacheableMap && now() < openRouterCacheableExpiresAt) {
        return lookupInMap(openRouterCacheableMap);
    }

    if (!openRouterCacheableInFlight) {
        openRouterCacheableInFlight = (async () => {
            try {
                const response = await fetchImpl(`${API_OPENROUTER}/models`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(5000),
                });

                if (!response.ok) {
                    console.warn(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
                    return null;
                }

                /** @type {any} */
                const data = await response.json();
                if (!Array.isArray(data?.data)) {
                    console.warn('OpenRouter API response format unexpected');
                    return null;
                }

                const nextMap = new Map();
                for (const entry of data.data) {
                    if (typeof entry?.id !== 'string' || !entry.id) {
                        continue;
                    }
                    const writePrice = entry?.pricing?.input_cache_write;
                    nextMap.set(entry.id, writePrice != null && writePrice !== '');
                }

                openRouterCacheableMap = nextMap;
                openRouterCacheableExpiresAt = now() + ttlMs;
                return nextMap;
            } catch (error) {
                console.warn(`Failed to check OpenRouter cache support for ${normalized}:`, error?.message ?? error);
                return null;
            } finally {
                openRouterCacheableInFlight = null;
            }
        })();
    }

    const loadedMap = await openRouterCacheableInFlight;
    return lookupInMap(loadedMap ?? openRouterCacheableMap);
}

/**
 * Checks whether the request represents a main chat turn eligible for session-level cache routing.
 * @param {any} requestBody
 * @returns {boolean}
 */
export function shouldAttachSessionCacheKey(requestBody) {
    if (!requestBody || typeof requestBody !== 'object') {
        return false;
    }
    if (requestBody.type === 'quiet' || requestBody.cacheScope === 'auxiliary') {
        return false;
    }
    return typeof requestBody.chat_id === 'string' && requestBody.chat_id.trim().length > 0;
}

/**
 * Derives an opaque HMAC session key so chat names never leave the server.
 * @param {string} chatId
 * @param {string} secret
 * @param {{ namespace?: string, prefix?: string, length?: number }} [options]
 * @returns {string | null}
 */
export function deriveSessionCacheKey(chatId, secret, { namespace = '', prefix = 'sb_', length = 32 } = {}) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId || !secret) {
        return null;
    }
    const input = namespace ? `${namespace}:${normalizedChatId}` : normalizedChatId;
    const digest = createHmac('sha256', String(secret)).update(input).digest('hex').slice(0, length);
    return `${prefix}${digest}`;
}

/**
 * Builds an ephemeral cache_control object, omitting ttl when unset.
 * @param {string | undefined} [ttl]
 * @returns {{ type: 'ephemeral', ttl?: string }}
 */
export function buildCacheControl(ttl = undefined) {
    return typeof ttl === 'string' && ttl.length > 0
        ? { type: 'ephemeral', ttl }
        : { type: 'ephemeral' };
}

/**
 * Checks whether a message already carries a cache_control marker.
 * @param {any} message
 * @returns {boolean}
 */
function hasCacheControl(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    if (message.cache_control) {
        return true;
    }
    if (Array.isArray(message.content)) {
        return message.content.some(part => Boolean(part && typeof part === 'object' && part.cache_control));
    }
    return false;
}

/**
 * Counts existing cache_control markers across system prompt, tools, and messages.
 * @param {{ systemPrompt?: any[], tools?: any[], messages?: any[] }} [payload]
 * @returns {number}
 */
export function countCacheControlMarkers({ systemPrompt, tools, messages } = {}) {
    let count = 0;

    if (Array.isArray(systemPrompt)) {
        for (const block of systemPrompt) {
            if (block && typeof block === 'object' && block.cache_control) {
                count += 1;
            }
        }
    }

    if (Array.isArray(tools)) {
        for (const tool of tools) {
            if (tool && typeof tool === 'object' && tool.cache_control) {
                count += 1;
            }
        }
    }

    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (!message || typeof message !== 'object') {
                continue;
            }
            if (message.cache_control) {
                count += 1;
            }
            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part && typeof part === 'object' && part.cache_control) {
                        count += 1;
                    }
                }
            }
        }
    }

    return count;
}

/**
 * Checks whether a native Anthropic content block can hold cache_control.
 * Anthropic rejects cache_control on thinking blocks and empty text blocks.
 * @param {any} part
 * @returns {boolean}
 */
function isCacheableClaudeBlock(part) {
    if (!part || typeof part !== 'object') {
        return false;
    }
    if (part.type === 'thinking' || part.type === 'redacted_thinking') {
        return false;
    }
    if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.trim().length > 0;
    }
    return true;
}

/**
 * Checks whether an OpenAI/OpenRouter content part can hold cache_control.
 * @param {any} part
 * @returns {boolean}
 */
function isCacheableOpenRouterPart(part) {
    if (!part || typeof part !== 'object') {
        return false;
    }
    if (part.type === 'thinking' || part.type === 'redacted_thinking') {
        return false;
    }
    return part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0;
}

/**
 * Marks the last cacheable block of a native Anthropic message.
 * @param {any} message
 * @param {string | undefined} ttl
 * @returns {boolean}
 */
function markClaudeMessageCacheControl(message, ttl) {
    if (!message || typeof message !== 'object' || hasCacheControl(message)) {
        return false;
    }

    if (Array.isArray(message.content)) {
        for (let i = message.content.length - 1; i >= 0; i--) {
            if (isCacheableClaudeBlock(message.content[i])) {
                message.content[i].cache_control = buildCacheControl(ttl);
                return true;
            }
        }
        return false;
    }

    if (typeof message.content === 'string' && message.content.trim().length > 0) {
        message.content = [{
            type: 'text',
            text: message.content,
            cache_control: buildCacheControl(ttl),
        }];
        return true;
    }

    return false;
}

/**
 * Marks the last non-empty text part of an OpenRouter/OpenAI-style message.
 * @param {any} message
 * @param {string | undefined} ttl
 * @returns {boolean}
 */
function markOpenRouterMessageCacheControl(message, ttl) {
    if (!message || typeof message !== 'object' || hasCacheControl(message)) {
        return false;
    }

    if (typeof message.content === 'string') {
        if (message.content.trim().length === 0) {
            return false;
        }
        message.content = [{
            type: 'text',
            text: message.content,
            cache_control: buildCacheControl(ttl),
        }];
        return true;
    }

    if (Array.isArray(message.content)) {
        for (let i = message.content.length - 1; i >= 0; i--) {
            if (isCacheableOpenRouterPart(message.content[i])) {
                message.content[i].cache_control = buildCacheControl(ttl);
                return true;
            }
        }
    }

    return false;
}

/**
 * Marks the last cacheable block in an Anthropic system prompt array.
 * @param {any[]} systemPrompt
 * @param {string | undefined} ttl
 * @param {{ existingBreakpoints?: number, maxBreakpoints?: number }} [options]
 * @returns {boolean}
 */
export function markClaudeSystemPromptCache(systemPrompt, ttl, { existingBreakpoints = null, maxBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS } = {}) {
    if (!Array.isArray(systemPrompt) || systemPrompt.length === 0) {
        return false;
    }
    if (systemPrompt.some(block => block && typeof block === 'object' && block.cache_control)) {
        return false;
    }
    const used = existingBreakpoints ?? countCacheControlMarkers({ systemPrompt });
    if (used >= maxBreakpoints) {
        return false;
    }

    for (let i = systemPrompt.length - 1; i >= 0; i--) {
        if (isCacheableClaudeBlock(systemPrompt[i])) {
            systemPrompt[i].cache_control = buildCacheControl(ttl);
            return true;
        }
    }
    return false;
}

/**
 * Marks the last tool definition in an Anthropic tools array.
 * @param {any[]} tools
 * @param {string | undefined} ttl
 * @param {{ existingBreakpoints?: number, maxBreakpoints?: number }} [options]
 * @returns {boolean}
 */
export function markClaudeToolsCache(tools, ttl, { existingBreakpoints = null, maxBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS } = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return false;
    }
    if (tools.some(tool => tool && typeof tool === 'object' && tool.cache_control)) {
        return false;
    }
    const used = existingBreakpoints ?? countCacheControlMarkers({ tools });
    if (used >= maxBreakpoints) {
        return false;
    }

    const lastTool = tools[tools.length - 1];
    if (!lastTool || typeof lastTool !== 'object') {
        return false;
    }
    lastTool.cache_control = buildCacheControl(ttl);
    return true;
}

/**
 * Adds cache_control to the end of the leading system/developer prompt block for OpenRouter-style messages.
 * Marks the last non-empty leading system/developer message so multi-message system prompts cache as one prefix.
 * @param {object[]} messages
 * @param {string | undefined} [ttl]
 * @param {{ existingBreakpoints?: number, maxBreakpoints?: number }} [options]
 * @returns {boolean}
 */
export function applySystemPromptCacheForOpenRouter(messages, ttl = undefined, { existingBreakpoints = null, maxBreakpoints = Infinity } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }

    let prefixEnd = -1;
    for (let i = 0; i < messages.length; i++) {
        const role = messages[i]?.role;
        if (role === 'system' || role === 'developer') {
            prefixEnd = i;
        } else {
            break;
        }
    }

    if (prefixEnd === -1) {
        return false;
    }

    for (let i = 0; i <= prefixEnd; i++) {
        if (hasCacheControl(messages[i])) {
            return false;
        }
    }

    const used = existingBreakpoints ?? countCacheControlMarkers({ messages });
    if (used >= maxBreakpoints) {
        return false;
    }

    for (let i = prefixEnd; i >= 0; i--) {
        if (markOpenRouterMessageCacheControl(messages[i], ttl)) {
            return true;
        }
    }

    return false;
}

/**
 * Places depth-based cache_control breakpoints walking backwards from the end of the conversation.
 * Skips trailing assistant prefills and uncacheable/empty blocks, and respects breakpoint budgets.
 * @param {any[]} messages
 * @param {number} cachingAtDepth
 * @param {string | undefined} [ttl]
 * @param {{ openRouterStyle?: boolean, singleBreakpoint?: boolean, existingBreakpoints?: number | null, maxBreakpoints?: number }} [options]
 * @returns {number} Number of breakpoints added
 */
export function applyDepthCacheBreakpoints(
    messages,
    cachingAtDepth,
    ttl = undefined,
    { openRouterStyle = false, singleBreakpoint = false, existingBreakpoints = null, maxBreakpoints = Infinity } = {},
) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return 0;
    }

    if (!Number.isInteger(cachingAtDepth) || cachingAtDepth < 0) {
        return 0;
    }

    let usedBreakpoints = existingBreakpoints ?? countCacheControlMarkers({ messages });
    if (usedBreakpoints >= maxBreakpoints) {
        return 0;
    }

    const targetDepths = singleBreakpoint
        ? [cachingAtDepth]
        : [cachingAtDepth, cachingAtDepth + 2];
    const maxTargetDepth = targetDepths[targetDepths.length - 1];
    const targetDepthSet = new Set(targetDepths);
    const markMessage = openRouterStyle ? markOpenRouterMessageCacheControl : markClaudeMessageCacheControl;

    let passedThePrefill = false;
    let depth = 0;
    let previousRoleName = '';
    let pendingMark = false;
    let added = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || typeof message !== 'object') {
            continue;
        }

        if (!passedThePrefill && message.role === 'assistant') {
            continue;
        }
        passedThePrefill = true;

        if (openRouterStyle && (message.role === 'system' || message.role === 'developer')) {
            continue;
        }

        if (message.role !== previousRoleName) {
            if (targetDepthSet.has(depth)) {
                pendingMark = true;
            }
            depth += 1;
            previousRoleName = message.role;
        }

        if (pendingMark) {
            if (hasCacheControl(message)) {
                pendingMark = false;
            } else if (usedBreakpoints < maxBreakpoints && markMessage(message, ttl)) {
                usedBreakpoints += 1;
                added += 1;
                pendingMark = false;
            }
        }

        if ((depth > maxTargetDepth && !pendingMark) || usedBreakpoints >= maxBreakpoints) {
            break;
        }
    }

    return added;
}

/**
 * Applies native Anthropic prompt caching to tools, system prompt, messages, and beta headers.
 * @param {{ systemPrompt?: any[], tools?: any[], messages?: any[], useSystemPrompt?: boolean, betaHeaders?: string[], config?: PromptCachingConfig }} params
 */
export function applyClaudeRequestCaching({ systemPrompt, tools, messages, useSystemPrompt = false, betaHeaders = [], config = getPromptCachingConfig() }) {
    const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;
    let usedBreakpoints = countCacheControlMarkers({ systemPrompt: useSystemPrompt ? systemPrompt : undefined, tools, messages });

    if (enableSystemPromptCache) {
        if (useSystemPrompt && markClaudeSystemPromptCache(systemPrompt, cacheTTL, { existingBreakpoints: usedBreakpoints, maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS })) {
            usedBreakpoints += 1;
        }
        if (markClaudeToolsCache(tools, cacheTTL, { existingBreakpoints: usedBreakpoints, maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS })) {
            usedBreakpoints += 1;
        }
    }

    if (cachingAtDepth !== -1) {
        usedBreakpoints += applyDepthCacheBreakpoints(messages, cachingAtDepth, cacheTTL, {
            openRouterStyle: false,
            existingBreakpoints: usedBreakpoints,
            maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
        });
    }

    if (enableSystemPromptCache || cachingAtDepth !== -1) {
        if (!betaHeaders.includes('prompt-caching-2024-07-31')) {
            betaHeaders.push('prompt-caching-2024-07-31');
        }
        if (cacheTTL === '1h' && !betaHeaders.includes('extended-cache-ttl-2025-04-11')) {
            betaHeaders.push('extended-cache-ttl-2025-04-11');
        }
    }

    return usedBreakpoints;
}

/**
 * Resolves an affinity key lazily so callers without chat_id never read disk secrets.
 * @param {string | (() => string | undefined) | undefined} affinityKey
 * @returns {string | null}
 */
function resolveAffinityKey(affinityKey) {
    try {
        const value = typeof affinityKey === 'function' ? affinityKey() : affinityKey;
        return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

/**
 * Applies OpenRouter sticky session routing and explicit cache markers for Claude and Gemini models.
 * @param {{ requestBody: any, bodyParams: Record<string, any>, affinityKey?: string | (() => string | undefined), config?: PromptCachingConfig, isModelCacheable?: (modelId: string) => Promise<boolean> }} params
 */
export async function applyOpenRouterRequestCaching({
    requestBody,
    bodyParams,
    affinityKey,
    config = getPromptCachingConfig(),
    isModelCacheable = isOpenRouterModelCacheable,
}) {
    if (shouldAttachSessionCacheKey(requestBody) && !bodyParams.session_id) {
        const resolvedKey = resolveAffinityKey(affinityKey);
        const sessionId = deriveSessionCacheKey(requestBody.chat_id, resolvedKey, { namespace: 'openrouter' });
        if (sessionId) {
            bodyParams.session_id = sessionId;
        }
    }

    const messages = requestBody?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        return;
    }

    const model = requestBody?.model;

    if (isOpenRouterClaudeModel(model)) {
        const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;
        let usedBreakpoints = countCacheControlMarkers({ messages });

        if (enableSystemPromptCache && applySystemPromptCacheForOpenRouter(messages, cacheTTL, {
            existingBreakpoints: usedBreakpoints,
            maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
        })) {
            usedBreakpoints += 1;
        }

        if (cachingAtDepth !== -1) {
            applyDepthCacheBreakpoints(messages, cachingAtDepth, cacheTTL, {
                openRouterStyle: true,
                existingBreakpoints: usedBreakpoints,
                maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
            });
        }
        return;
    }

    if (isOpenRouterGeminiModel(model)) {
        const { enableSystemPromptCache, cachingAtDepth } = config.gemini;
        if (!enableSystemPromptCache && cachingAtDepth === -1) {
            return;
        }

        const cacheable = await isModelCacheable(model);
        if (!cacheable) {
            return;
        }

        if (enableSystemPromptCache) {
            applySystemPromptCacheForOpenRouter(messages);
        }

        if (cachingAtDepth !== -1) {
            // OpenRouter uses only the final cache_control breakpoint for Gemini and drops Anthropic TTLs.
            applyDepthCacheBreakpoints(messages, cachingAtDepth, undefined, {
                openRouterStyle: true,
                singleBreakpoint: true,
            });
        }
    }
}

/**
 * Applies NanoGPT prompt caching for Claude models (top-level toggle plus optional inline depth markers).
 * @param {{ messages?: any[], bodyParams: Record<string, any>, model: unknown, config?: PromptCachingConfig }} params
 */
export function applyNanoGptRequestCaching({ messages, bodyParams, model, config = getPromptCachingConfig() }) {
    if (!isNanoGptClaudeModel(model)) {
        return;
    }

    const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;
    if (!enableSystemPromptCache && cachingAtDepth === -1) {
        return;
    }

    if (Array.isArray(messages) && cachingAtDepth !== -1) {
        let usedBreakpoints = countCacheControlMarkers({ messages });
        if (enableSystemPromptCache && applySystemPromptCacheForOpenRouter(messages, cacheTTL, {
            existingBreakpoints: usedBreakpoints,
            maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
        })) {
            usedBreakpoints += 1;
        }
        applyDepthCacheBreakpoints(messages, cachingAtDepth, cacheTTL, {
            openRouterStyle: true,
            existingBreakpoints: usedBreakpoints,
            maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
        });
    }

    bodyParams.cache_control = {
        enabled: true,
        ttl: cacheTTL,
    };
}

/**
 * Applies Electron Hub inline prompt caching for Claude models.
 * @param {{ messages?: any[], model: unknown, config?: PromptCachingConfig }} params
 */
export function applyElectronHubRequestCaching({ messages, model, config = getPromptCachingConfig() }) {
    if (!Array.isArray(messages) || !isElectronHubClaudeModel(model)) {
        return;
    }

    const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;
    let usedBreakpoints = countCacheControlMarkers({ messages });

    if (enableSystemPromptCache && applySystemPromptCacheForOpenRouter(messages, cacheTTL, {
        existingBreakpoints: usedBreakpoints,
        maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
    })) {
        usedBreakpoints += 1;
    }

    if (cachingAtDepth !== -1) {
        applyDepthCacheBreakpoints(messages, cachingAtDepth, cacheTTL, {
            openRouterStyle: true,
            existingBreakpoints: usedBreakpoints,
            maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
        });
    }
}

/**
 * Attaches an opaque prompt_cache_key for direct OpenAI Chat Completions and Responses requests.
 * Skipped when a reverse proxy is configured so strict third-party proxies never reject the field.
 * @param {{ requestBody: any, targetBody: Record<string, any>, affinityKey?: string | (() => string | undefined) }} params
 */
export function applyOpenAiSessionCacheKey({ requestBody, targetBody, affinityKey }) {
    if (requestBody?.reverse_proxy || targetBody.prompt_cache_key) {
        return;
    }
    if (!shouldAttachSessionCacheKey(requestBody)) {
        return;
    }
    const resolvedKey = resolveAffinityKey(affinityKey);
    const cacheKey = deriveSessionCacheKey(requestBody.chat_id, resolvedKey, { namespace: 'openai' });
    if (cacheKey) {
        targetBody.prompt_cache_key = cacheKey;
    }
}
