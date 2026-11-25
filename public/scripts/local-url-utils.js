const LOCAL_HOSTNAMES = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
]);

const PRIVATE_IPV4_PATTERNS = [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
];

const FALLBACK_LOCAL_URL_PATTERN = /(^|[^\w:])(?:localhost|\[::1\]|::1|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)([^\w.]|$)/i;

function normalizeUrlHostname(hostname) {
    const host = String(hostname ?? '').trim().toLowerCase();

    if (host.startsWith('[') && host.endsWith(']')) {
        return host.slice(1, -1);
    }

    return host;
}

function isPrivateIpv4Hostname(hostname) {
    return PRIVATE_IPV4_PATTERNS.some(pattern => pattern.test(hostname));
}

/**
 * Checks whether an API server URL points at a likely local backend.
 * @param {string} serverUrl API server URL
 * @param {string} [baseUrl] Optional base URL for resolving browser-relative URLs
 * @returns {boolean} True if the URL points at a likely local backend
 */
export function isLikelyLocalServerUrl(serverUrl, baseUrl = undefined) {
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        return false;
    }

    try {
        const url = baseUrl === undefined ? new URL(serverUrl) : new URL(serverUrl, baseUrl);
        const host = normalizeUrlHostname(url.hostname);

        return LOCAL_HOSTNAMES.has(host) || host.endsWith('.local') || isPrivateIpv4Hostname(host);
    } catch {
        return FALLBACK_LOCAL_URL_PATTERN.test(serverUrl);
    }
}

/**
 * Gets the llama.cpp-compatible prompt cache flag for a generation lane.
 * @param {'main'|'auxiliary'|'none'|string|undefined|null} cacheScope Prompt cache lane
 * @returns {boolean} True only for the main chat lane
 */
export function getLocalPromptCacheValue(cacheScope) {
    return String(cacheScope ?? 'auxiliary') === 'main';
}

/**
 * Chat Completion sources whose server code turns the chat id into an opaque cache routing key.
 * The server never sends the chat id itself to the provider.
 */
export const CHAT_ID_FORWARDING_SOURCES = Object.freeze([
    'fireworks',
    'openrouter',
    'openai',
    'openai_responses',
    'xai',
    'mistralai',
    'azure_openai',
]);

/**
 * Decides whether a generation request carries the current chat id to the server.
 * A quiet request that repeats the chat prefix, such as a summary, needs the key of its chat: without it a router can
 * send the request to a provider that holds no cache entry for that prefix, and the request then pays for a new one.
 * @param {string | undefined} source Chat Completion source
 * @param {string} type Generation type
 * @param {string | null | undefined} cacheScope Prompt cache lane of the request
 * @returns {boolean}
 */
export function shouldForwardChatId(source, type, cacheScope) {
    if (!CHAT_ID_FORWARDING_SOURCES.includes(String(source)) || cacheScope === 'none') {
        return false;
    }
    // Fireworks keeps upstream's rule, which sends no chat id with a quiet request.
    return source !== 'fireworks' || type !== 'quiet';
}
