import { createHmac } from 'node:crypto';
import fetch from 'node-fetch';
import { getConfigValue } from './util.js';

export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
export const OPENROUTER_MODELS_CACHE_TTL_MS = 15 * 60 * 1000;
export const OPENROUTER_MODELS_FAILURE_BACKOFF_MS = 30 * 1000;

const API_OPENROUTER = 'https://openrouter.ai/api/v1';
const CACHEABLE_CLAUDE_BLOCK_TYPES = new Set([
    'text',
    'image',
    'document',
    'tool_use',
    'tool_result',
    'search_result',
]);

/**
 * @typedef {object} PromptCachingConfig
 * @property {{ enableSystemPromptCache: boolean, cachingAtDepth: number, extendedTTL: boolean, cacheTTL: '1h'|'5m' }} claude
 * @property {{ enableSystemPromptCache: boolean }} gemini
 */

/** @type {Map<string, boolean> | null} */
let openRouterCacheableMap = null;
let openRouterCacheableExpiresAt = 0;
let openRouterCacheableRetryAfter = 0;
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
 * Reads the active prompt caching configuration. Environment variables take precedence over config.yaml.
 * @returns {PromptCachingConfig}
 */
export function getPromptCachingConfig() {
    const extendedTTL = Boolean(getConfigValue('claude.extendedTTL', false, 'boolean'));

    return {
        claude: {
            enableSystemPromptCache: Boolean(getConfigValue('claude.enableSystemPromptCache', false, 'boolean')),
            cachingAtDepth: normalizeCachingDepth(getConfigValue('claude.cachingAtDepth', -1, 'number')),
            extendedTTL,
            cacheTTL: extendedTTL ? '1h' : '5m',
        },
        gemini: {
            enableSystemPromptCache: Boolean(getConfigValue('gemini.enableSystemPromptCache', false, 'boolean')),
        },
    };
}

/**
 * Resets cached OpenRouter model capability metadata and failure backoff.
 */
export function resetOpenRouterCacheableModelsCache() {
    openRouterCacheableMap = null;
    openRouterCacheableExpiresAt = 0;
    openRouterCacheableRetryAfter = 0;
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
 * Downloads the OpenRouter model catalog into a map of lowercase model id to "charges for cache writes".
 * Never rejects: a failure starts the backoff and resolves to null.
 * @param {{ fetchImpl: typeof fetch, now: () => number, ttlMs: number, failureBackoffMs: number }} options
 * @returns {Promise<Map<string, boolean> | null>}
 */
async function fetchOpenRouterCacheableModels({ fetchImpl, now, ttlMs, failureBackoffMs }) {
    const startBackoff = () => {
        if (failureBackoffMs > 0) {
            openRouterCacheableRetryAfter = now() + failureBackoffMs;
        }
    };

    try {
        const response = await fetchImpl(`${API_OPENROUTER}/models`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            console.warn(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
            startBackoff();
            return null;
        }

        /** @type {any} */
        const data = await response.json();
        if (!Array.isArray(data?.data)) {
            console.warn('OpenRouter API response format unexpected');
            startBackoff();
            return null;
        }

        const nextMap = new Map();
        for (const entry of data.data) {
            if (typeof entry?.id !== 'string' || !entry.id) {
                continue;
            }
            // A write price of zero means the provider caches on its own and takes no markers.
            nextMap.set(entry.id.trim().toLowerCase(), Number(entry?.pricing?.input_cache_write) > 0);
        }

        openRouterCacheableMap = nextMap;
        openRouterCacheableExpiresAt = now() + ttlMs;
        openRouterCacheableRetryAfter = 0;
        return nextMap;
    } catch (error) {
        console.warn('Failed to load the OpenRouter model catalog:', error?.message ?? error);
        startBackoff();
        return null;
    }
}

/**
 * Checks whether an OpenRouter model charges for cache writes, which marks it as one that takes explicit cache markers.
 * The catalog is cached for 15 minutes, shared by concurrent callers, and kept as a stale copy during an outage.
 * An exact id match wins before stacked routing suffixes (`:online`, `:nitro`) are peeled off.
 * @param {string} modelId
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, ttlMs?: number, failureBackoffMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function isOpenRouterModelCacheable(
    modelId,
    {
        fetchImpl = fetch,
        now = Date.now,
        ttlMs = OPENROUTER_MODELS_CACHE_TTL_MS,
        failureBackoffMs = OPENROUTER_MODELS_FAILURE_BACKOFF_MS,
    } = {},
) {
    const normalized = String(modelId ?? '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const lookupInMap = (map) => {
        if (!map) {
            return false;
        }
        const slashIndex = normalized.lastIndexOf('/');
        let candidate = normalized;
        while (candidate) {
            if (map.has(candidate)) {
                return Boolean(map.get(candidate));
            }
            const colonIndex = candidate.lastIndexOf(':');
            if (colonIndex <= slashIndex) {
                break;
            }
            candidate = candidate.slice(0, colonIndex);
        }
        return false;
    };

    const currentTime = now();
    if (openRouterCacheableMap && currentTime < openRouterCacheableExpiresAt) {
        return lookupInMap(openRouterCacheableMap);
    }

    if (currentTime < openRouterCacheableRetryAfter) {
        return lookupInMap(openRouterCacheableMap);
    }

    if (!openRouterCacheableInFlight) {
        const pending = fetchOpenRouterCacheableModels({ fetchImpl, now, ttlMs, failureBackoffMs });
        openRouterCacheableInFlight = pending;
        // The slot is cleared from outside the fetch, so a fetch that settles before this line cannot leave it set.
        void pending.finally(() => {
            if (openRouterCacheableInFlight === pending) {
                openRouterCacheableInFlight = null;
            }
        });
    }

    const loadedMap = await openRouterCacheableInFlight;
    return lookupInMap(loadedMap ?? openRouterCacheableMap);
}

/**
 * `cacheScope: 'none'` is the only opt-out. Every other request carries markers and session keys, including
 * quiet and auxiliary ones, because a provider reads a cache entry only through a breakpoint of its own.
 * @param {any} requestBody
 * @returns {boolean}
 */
function isCachingDisabled(requestBody) {
    return requestBody?.cacheScope === 'none';
}

/**
 * Checks whether a request may carry an opaque session routing key: caching is not opted out and the client sent a chat id.
 * @param {any} requestBody
 * @returns {boolean}
 */
function shouldAttachSessionCacheKey(requestBody) {
    if (isCachingDisabled(requestBody)) {
        return false;
    }
    return typeof requestBody?.chat_id === 'string' && requestBody.chat_id.trim().length > 0;
}

/**
 * Derives an opaque HMAC session key so chat names never leave the server.
 * Includes userHandle when provided so multi-user instances with identical chat_id values stay isolated.
 * @param {string} chatId
 * @param {string} secret
 * @param {{ namespace?: string, userHandle?: string, prefix?: string, length?: number }} [options]
 * @returns {string | null}
 */
export function deriveSessionCacheKey(chatId, secret, { namespace = '', userHandle = '', prefix = 'sb_', length = 32 } = {}) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId || !secret) {
        return null;
    }
    const normalizedUser = String(userHandle ?? '').trim();
    const parts = [];
    if (namespace) {
        parts.push(namespace);
    }
    if (normalizedUser) {
        parts.push(`u:${normalizedUser}`);
    }
    parts.push(normalizedChatId);
    const digest = createHmac('sha256', String(secret)).update(parts.join(':')).digest('hex').slice(0, length);
    return `${prefix}${digest}`;
}

/**
 * Builds an ephemeral cache_control object, omitting ttl when unset.
 * @param {string | undefined} [ttl]
 * @returns {{ type: 'ephemeral', ttl?: string }}
 */
function buildCacheControl(ttl = undefined) {
    return typeof ttl === 'string' && ttl.length > 0
        ? { type: 'ephemeral', ttl }
        : { type: 'ephemeral' };
}

/**
 * Normalizes a cache_control marker into its effective Anthropic TTL ('1h' or '5m').
 * @param {any} cacheControl
 * @returns {'1h'|'5m'}
 */
function getEffectiveTTL(cacheControl) {
    return cacheControl?.ttl === '1h' ? '1h' : '5m';
}

/**
 * Resolves a legal auto-placed Anthropic TTL obeying monotonic non-increasing ordering (1h -> 5m).
 * Never silently upgrades a user's 5m preference to 1h; clamps 1h down to 5m after an existing 5m marker.
 * @param {string | undefined} requestedTTL
 * @param {{ hasEarlier5m?: boolean, hasLater1h?: boolean }} [bounds]
 * @returns {string | undefined | null} Allowed TTL, or null if no legal marker can be placed
 */
function resolveAllowedAutoTTL(requestedTTL, { hasEarlier5m = false, hasLater1h = false } = {}) {
    const effective = requestedTTL === '1h' ? '1h' : '5m';
    if (effective === '1h' && hasEarlier5m) {
        return hasLater1h ? null : '5m';
    }
    if (effective === '5m' && hasLater1h) {
        return null;
    }
    return requestedTTL;
}

/**
 * Collects cache_control objects attached to a tools array (Anthropic top-level or OpenAI function-level).
 * @param {any[] | undefined} tools
 * @returns {any[]}
 */
function getToolCacheControls(tools) {
    const markers = [];
    if (!Array.isArray(tools)) {
        return markers;
    }
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') {
            continue;
        }
        if (tool.cache_control) {
            markers.push(tool.cache_control);
        }
        if (tool.function && typeof tool.function === 'object' && tool.function.cache_control) {
            markers.push(tool.function.cache_control);
        }
    }
    return markers;
}

/**
 * Collects cache_control objects attached to an Anthropic system prompt array.
 * @param {any[] | undefined} systemPrompt
 * @returns {any[]}
 */
function getSystemCacheControls(systemPrompt) {
    const markers = [];
    if (!Array.isArray(systemPrompt)) {
        return markers;
    }
    for (const block of systemPrompt) {
        if (block && typeof block === 'object' && block.cache_control) {
            markers.push(block.cache_control);
        }
    }
    return markers;
}

/**
 * Collects cache_control objects attached to a single message.
 * @param {any} message
 * @returns {any[]}
 */
function getMessageCacheControls(message) {
    const markers = [];
    if (!message || typeof message !== 'object') {
        return markers;
    }
    if (message.cache_control) {
        markers.push(message.cache_control);
    }
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part && typeof part === 'object' && part.cache_control) {
                markers.push(part.cache_control);
            }
        }
    }
    return markers;
}

/**
 * @param {any[]} markers
 * @returns {boolean}
 */
function has1hTTL(markers) {
    return markers.some(marker => getEffectiveTTL(marker) === '1h');
}

/**
 * An omitted ttl counts as '5m'.
 * @param {any[]} markers
 * @returns {boolean}
 */
function has5mTTL(markers) {
    return markers.some(marker => getEffectiveTTL(marker) === '5m');
}

/**
 * Checks whether any message in a slice [start, end) carries a marker matching predicate.
 * @param {any[] | undefined} messages
 * @param {number} start
 * @param {number} end
 * @param {(marker: any) => boolean} predicate
 * @returns {boolean}
 */
function messagesRangeHasMarker(messages, start, end, predicate) {
    if (!Array.isArray(messages)) {
        return false;
    }
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.min(messages.length, end);
    for (let i = clampedStart; i < clampedEnd; i++) {
        if (getMessageCacheControls(messages[i]).some(predicate)) {
            return true;
        }
    }
    return false;
}

/**
 * Checks whether any cache_control marker in the payload uses extended 1h TTL.
 * @param {{ systemPrompt?: any[], tools?: any[], messages?: any[] }} [payload]
 * @returns {boolean}
 */
function hasExtendedTTLMarker({ systemPrompt, tools, messages } = {}) {
    if (has1hTTL(getToolCacheControls(tools)) || has1hTTL(getSystemCacheControls(systemPrompt))) {
        return true;
    }
    return messagesRangeHasMarker(messages, 0, Array.isArray(messages) ? messages.length : 0, marker => getEffectiveTTL(marker) === '1h');
}

/**
 * @param {any} message
 * @returns {boolean}
 */
function hasCacheControl(message) {
    return getMessageCacheControls(message).length > 0;
}

/**
 * Counts existing cache_control markers across system prompt, tools, and messages.
 * @param {{ systemPrompt?: any[], tools?: any[], messages?: any[] }} [payload]
 * @returns {number}
 */
export function countCacheControlMarkers({ systemPrompt, tools, messages } = {}) {
    let count = getSystemCacheControls(systemPrompt).length + getToolCacheControls(tools).length;

    if (Array.isArray(messages)) {
        for (const message of messages) {
            count += getMessageCacheControls(message).length;
        }
    }

    return count;
}

/**
 * Checks whether a native Anthropic content block can hold cache_control.
 * Uses an explicit allowlist and rejects empty/whitespace text blocks.
 * @param {any} part
 * @returns {boolean}
 */
function isCacheableClaudeBlock(part) {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
        return false;
    }
    if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.trim().length > 0;
    }
    return CACHEABLE_CLAUDE_BLOCK_TYPES.has(part.type);
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
function markClaudeSystemPromptCache(systemPrompt, ttl, { existingBreakpoints = null, maxBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS } = {}) {
    if (!Array.isArray(systemPrompt) || systemPrompt.length === 0) {
        return false;
    }
    if (getSystemCacheControls(systemPrompt).length > 0) {
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
function markClaudeToolsCache(tools, ttl, { existingBreakpoints = null, maxBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS } = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return false;
    }
    if (getToolCacheControls(tools).length > 0) {
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
 * Finds the end index of the leading contiguous system/developer prompt block.
 * @param {any[]} messages
 * @returns {number}
 */
function findLeadingSystemPrefixEnd(messages) {
    let prefixEnd = -1;
    for (let i = 0; i < messages.length; i++) {
        const role = messages[i]?.role;
        if (role === 'system' || role === 'developer') {
            prefixEnd = i;
        } else {
            break;
        }
    }
    return prefixEnd;
}

/**
 * Adds cache_control to the end of the leading system/developer prompt block for OpenRouter-style messages.
 * Marks the last non-empty leading system/developer message so multi-message system prompts cache as one prefix.
 * @param {object[]} messages
 * @param {string | undefined} [ttl]
 * @param {{ existingBreakpoints?: number, maxBreakpoints?: number, resolveTTLForIndex?: (index: number) => string | undefined | null }} [options]
 * @returns {boolean}
 */
export function applySystemPromptCacheForOpenRouter(
    messages,
    ttl = undefined,
    { existingBreakpoints = null, maxBreakpoints = Infinity, resolveTTLForIndex = null } = {},
) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }

    const prefixEnd = findLeadingSystemPrefixEnd(messages);
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
        const effectiveTTL = resolveTTLForIndex ? resolveTTLForIndex(i) : ttl;
        if (effectiveTTL === null) {
            return false;
        }
        if (markOpenRouterMessageCacheControl(messages[i], effectiveTTL)) {
            return true;
        }
    }

    return false;
}

/**
 * Places depth-based cache_control breakpoints walking backwards from the end of the conversation.
 * Skips trailing assistant prefills (even when followed by trailing system/developer injections),
 * skips uncacheable/empty blocks, and respects breakpoint budgets and optional TTL constraints.
 * @param {any[]} messages
 * @param {number} cachingAtDepth
 * @param {string | undefined} [ttl]
 * @param {{ openRouterStyle?: boolean, existingBreakpoints?: number | null, maxBreakpoints?: number, resolveTTLForIndex?: ((index: number) => string | undefined | null) | null }} [options]
 * @returns {number} Number of breakpoints added
 */
export function applyDepthCacheBreakpoints(
    messages,
    cachingAtDepth,
    ttl = undefined,
    {
        openRouterStyle = false,
        existingBreakpoints = null,
        maxBreakpoints = Infinity,
        resolveTTLForIndex = null,
    } = {},
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

    const targetDepthSet = new Set([cachingAtDepth, cachingAtDepth + 2]);
    const maxTargetDepth = cachingAtDepth + 2;
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

        // Skip system/developer messages before checking trailing assistant prefill so
        // Post-History Instructions / depth-0 system injections never unmask an assistant prefill.
        if (openRouterStyle && (message.role === 'system' || message.role === 'developer')) {
            continue;
        }

        if (!passedThePrefill && message.role === 'assistant') {
            continue;
        }
        passedThePrefill = true;

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
            } else if (usedBreakpoints < maxBreakpoints) {
                const effectiveTTL = resolveTTLForIndex ? resolveTTLForIndex(i) : ttl;
                if (effectiveTTL === null) {
                    pendingMark = false;
                } else if (markMessage(message, effectiveTTL)) {
                    usedBreakpoints += 1;
                    added += 1;
                    pendingMark = false;
                }
            }
        }

        if ((depth > maxTargetDepth && !pendingMark) || usedBreakpoints >= maxBreakpoints) {
            break;
        }
    }

    return added;
}

/**
 * Builds a monotonic Anthropic TTL resolver for message index `i` given enclosing tools/systemPrompt.
 * @param {string | undefined} requestedTTL
 * @param {{ tools?: any[], systemPrompt?: any[], messages?: any[] }} payload
 * @returns {(index: number) => string | undefined | null}
 */
function createMessageTTLResolver(requestedTTL, { tools, systemPrompt, messages }) {
    return (index) => {
        const hasEarlier5m = has5mTTL(getToolCacheControls(tools))
            || has5mTTL(getSystemCacheControls(systemPrompt))
            || messagesRangeHasMarker(messages, 0, index, marker => getEffectiveTTL(marker) === '5m');
        const hasLater1h = messagesRangeHasMarker(messages, index + 1, Array.isArray(messages) ? messages.length : 0, marker => getEffectiveTTL(marker) === '1h');
        return resolveAllowedAutoTTL(requestedTTL, { hasEarlier5m, hasLater1h });
    };
}

/**
 * Applies native Anthropic prompt caching to tools, system prompt, messages, and beta headers.
 * Enforces Anthropic's 4-breakpoint cap and monotonic non-increasing TTL ordering (tools -> system -> messages).
 * @param {{ requestBody?: any, systemPrompt?: any[], tools?: any[], allTools?: any[], messages?: any[], useSystemPrompt?: boolean, betaHeaders?: string[], config?: PromptCachingConfig }} params
 */
export function applyClaudeRequestCaching({
    requestBody = undefined,
    systemPrompt,
    tools,
    allTools = tools,
    messages,
    useSystemPrompt = false,
    betaHeaders = [],
    config = getPromptCachingConfig(),
}) {
    const activeSystemPrompt = useSystemPrompt ? systemPrompt : undefined;
    let usedBreakpoints = countCacheControlMarkers({ systemPrompt: activeSystemPrompt, tools: allTools, messages });

    if (!isCachingDisabled(requestBody)) {
        const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;

        // Anthropic evaluates breakpoints in strict order: tools -> system -> messages.
        if (enableSystemPromptCache) {
            const toolsHasLater1h = has1hTTL(getSystemCacheControls(activeSystemPrompt))
                || messagesRangeHasMarker(messages, 0, Array.isArray(messages) ? messages.length : 0, marker => getEffectiveTTL(marker) === '1h');
            const toolsTTL = resolveAllowedAutoTTL(cacheTTL, { hasEarlier5m: false, hasLater1h: toolsHasLater1h });
            if (toolsTTL !== null && markClaudeToolsCache(tools, toolsTTL, { existingBreakpoints: usedBreakpoints, maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS })) {
                usedBreakpoints += 1;
            }

            if (useSystemPrompt) {
                const systemHasEarlier5m = has5mTTL(getToolCacheControls(allTools));
                const systemHasLater1h = messagesRangeHasMarker(messages, 0, Array.isArray(messages) ? messages.length : 0, marker => getEffectiveTTL(marker) === '1h');
                const systemTTL = resolveAllowedAutoTTL(cacheTTL, { hasEarlier5m: systemHasEarlier5m, hasLater1h: systemHasLater1h });
                if (systemTTL !== null && markClaudeSystemPromptCache(systemPrompt, systemTTL, { existingBreakpoints: usedBreakpoints, maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS })) {
                    usedBreakpoints += 1;
                }
            }
        }

        if (cachingAtDepth !== -1) {
            usedBreakpoints += applyDepthCacheBreakpoints(messages, cachingAtDepth, cacheTTL, {
                openRouterStyle: false,
                existingBreakpoints: usedBreakpoints,
                maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
                resolveTTLForIndex: createMessageTTLResolver(cacheTTL, { tools: allTools, systemPrompt: activeSystemPrompt, messages }),
            });
        }
    }

    if (usedBreakpoints > 0) {
        if (!betaHeaders.includes('prompt-caching-2024-07-31')) {
            betaHeaders.push('prompt-caching-2024-07-31');
        }
        if (hasExtendedTTLMarker({ systemPrompt: activeSystemPrompt, tools: allTools, messages })
            && !betaHeaders.includes('extended-cache-ttl-2025-04-11')) {
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
 * Applies Anthropic-compatible inline system/depth markers on OpenAI-style messages (OpenRouter Claude, NanoGPT, ElectronHub).
 * @param {{ messages: any[], tools?: any[], enableSystemPromptCache: boolean, cachingAtDepth: number, cacheTTL: '1h'|'5m'|undefined }} params
 * @returns {number} Final total cache_control breakpoint count
 */
function applyOpenAiStyleClaudeCaching({ messages, tools, enableSystemPromptCache, cachingAtDepth, cacheTTL }) {
    let usedBreakpoints = countCacheControlMarkers({ tools, messages });
    const resolveTTLForIndex = createMessageTTLResolver(cacheTTL, { tools, messages });

    if (enableSystemPromptCache && applySystemPromptCacheForOpenRouter(messages, cacheTTL, {
        existingBreakpoints: usedBreakpoints,
        maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
        resolveTTLForIndex,
    })) {
        usedBreakpoints += 1;
    }

    if (cachingAtDepth !== -1) {
        usedBreakpoints += applyDepthCacheBreakpoints(messages, cachingAtDepth, cacheTTL, {
            openRouterStyle: true,
            existingBreakpoints: usedBreakpoints,
            maxBreakpoints: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
            resolveTTLForIndex,
        });
    }

    return usedBreakpoints;
}

/**
 * Applies OpenRouter sticky session routing and explicit cache markers.
 * Claude is matched by id. Gemini marks only the leading system prefix. Any other model whose catalog entry has a
 * cache-write price, except an OpenAI model, takes the same markers as Claude, without a ttl, because only Anthropic
 * prices a 1-hour write.
 * @param {{ requestBody: any, bodyParams: Record<string, any>, tools?: any[], affinityKey?: string | (() => string | undefined), userHandle?: string, config?: PromptCachingConfig, isModelCacheable?: (modelId: string) => Promise<boolean> }} params
 */
export async function applyOpenRouterRequestCaching({
    requestBody,
    bodyParams,
    tools = requestBody?.tools,
    affinityKey,
    userHandle = '',
    config = getPromptCachingConfig(),
    isModelCacheable = isOpenRouterModelCacheable,
}) {
    if (!bodyParams.session_id) {
        const sessionId = deriveRequestSessionKey({ requestBody, namespace: 'openrouter', affinityKey, userHandle });
        if (sessionId) {
            bodyParams.session_id = sessionId;
        }
    }

    if (isCachingDisabled(requestBody)) {
        return;
    }

    const messages = requestBody?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        return;
    }

    const model = requestBody?.model;
    const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;

    if (isOpenRouterClaudeModel(model)) {
        applyOpenAiStyleClaudeCaching({ messages, tools, enableSystemPromptCache, cachingAtDepth, cacheTTL });
        return;
    }

    if (isOpenRouterGeminiModel(model)) {
        // OpenRouter honors only the final explicit cache_control breakpoint on Gemini, so only
        // static leading system prompts use explicit markers; rolling history uses sticky session_id
        // plus Gemini's native implicit caching (zero write surcharge).
        if (!config.gemini.enableSystemPromptCache || !await isModelCacheable(model)) {
            return;
        }

        applySystemPromptCacheForOpenRouter(messages);
        return;
    }

    // OpenAI models cache without markers, although the catalog lists a cache-write price for them.
    if (/^~?openai\//i.test(String(model ?? '').trim())) {
        return;
    }

    if ((!enableSystemPromptCache && cachingAtDepth === -1) || !await isModelCacheable(model)) {
        return;
    }

    applyOpenAiStyleClaudeCaching({ messages, tools, enableSystemPromptCache, cachingAtDepth, cacheTTL: undefined });
}

/**
 * Applies NanoGPT prompt caching for Claude models.
 * With the system flag and no depth, only the body helper is sent and NanoGPT places the breakpoints.
 * With a depth, the inline markers decide, and the helper carries explicitCacheControl so NanoGPT adds none of its own.
 * @param {{ requestBody?: any, messages?: any[], tools?: any[], bodyParams: Record<string, any>, model: unknown, config?: PromptCachingConfig }} params
 */
export function applyNanoGptRequestCaching({
    requestBody = undefined,
    messages,
    tools = requestBody?.tools,
    bodyParams,
    model,
    config = getPromptCachingConfig(),
}) {
    if (!isNanoGptClaudeModel(model) || isCachingDisabled(requestBody)) {
        return;
    }

    const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;
    if (!enableSystemPromptCache && cachingAtDepth === -1) {
        return;
    }

    /** @type {{ enabled: true, ttl: string, explicitCacheControl?: true }} */
    const helper = { enabled: true, ttl: cacheTTL };

    if (cachingAtDepth !== -1) {
        const usedBreakpoints = Array.isArray(messages)
            ? applyOpenAiStyleClaudeCaching({ messages, tools, enableSystemPromptCache, cachingAtDepth, cacheTTL })
            : 0;

        if (usedBreakpoints > 0) {
            helper.explicitCacheControl = true;
        } else if (!enableSystemPromptCache) {
            return;
        }
    }

    bodyParams.cache_control = helper;
}

/**
 * Applies Electron Hub inline prompt caching for Claude models.
 * @param {{ requestBody?: any, messages?: any[], tools?: any[], model: unknown, config?: PromptCachingConfig }} params
 */
export function applyElectronHubRequestCaching({
    requestBody = undefined,
    messages,
    tools = requestBody?.tools,
    model,
    config = getPromptCachingConfig(),
}) {
    if (!Array.isArray(messages) || !isElectronHubClaudeModel(model)) {
        return;
    }

    if (isCachingDisabled(requestBody)) {
        return;
    }

    const { enableSystemPromptCache, cachingAtDepth, cacheTTL } = config.claude;
    applyOpenAiStyleClaudeCaching({
        messages,
        tools,
        enableSystemPromptCache,
        cachingAtDepth,
        cacheTTL,
    });
}

/**
 * Derives the opaque routing key of a request, or null when the request carries none.
 * @param {{ requestBody: any, namespace: string, affinityKey?: string | (() => string | undefined), userHandle?: string }} params
 * @returns {string | null}
 */
function deriveRequestSessionKey({ requestBody, namespace, affinityKey, userHandle = '' }) {
    if (!shouldAttachSessionCacheKey(requestBody)) {
        return null;
    }
    return deriveSessionCacheKey(requestBody.chat_id, resolveAffinityKey(affinityKey), { namespace, userHandle });
}

/**
 * Adds an opaque cache routing key to an outgoing request body or header set, under the field name the provider documents.
 * Nothing is added behind a reverse proxy, which may not accept the field, or when the target already holds one.
 * @param {{ requestBody: any, target: Record<string, any>, field: string, namespace: string, affinityKey?: string | (() => string | undefined), userHandle?: string }} params
 */
export function applySessionRoutingKey({ requestBody, target, field, namespace, affinityKey, userHandle = '' }) {
    if (requestBody?.reverse_proxy || target[field]) {
        return;
    }
    const routingKey = deriveRequestSessionKey({ requestBody, namespace, affinityKey, userHandle });
    if (routingKey) {
        target[field] = routingKey;
    }
}

/**
 * Attaches an opaque prompt_cache_key for direct OpenAI Chat Completions and Responses requests.
 * Legacy text completions send a string prompt and do not accept the field.
 * @param {{ requestBody: any, targetBody: Record<string, any>, affinityKey?: string | (() => string | undefined), userHandle?: string }} params
 */
export function applyOpenAiSessionCacheKey({ requestBody, targetBody, affinityKey, userHandle = '' }) {
    if (!Array.isArray(requestBody?.messages)) {
        return;
    }
    applySessionRoutingKey({ requestBody, target: targetBody, field: 'prompt_cache_key', namespace: 'openai', affinityKey, userHandle });
}
