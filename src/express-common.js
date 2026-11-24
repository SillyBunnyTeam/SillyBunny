import ipaddr from 'ipaddr.js';
import ipMatching from 'ip-matching';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { getConfigValue } from './util.js';

const noopMiddleware = (_req, _res, next) => next();
/** @deprecated Do not use. A global middleware is provided at the application level. */
export const jsonParser = noopMiddleware;
/** @deprecated Do not use. A global middleware is provided at the application level. */
export const urlencodedParser = noopMiddleware;

/**
 * @typedef {object} CompiledIpPatterns
 * @property {string[]} snapshot
 * @property {ReturnType<typeof ipMatching.getMatch>[]} matchers
 * @property {boolean} allowsIpv4Loopback
 * @property {boolean} allowsIpv6Loopback
 */

/** @type {WeakMap<string[], CompiledIpPatterns>} */
const compiledPatternsCache = new WeakMap();

function isSamePatternList(snapshot, patterns) {
    if (snapshot.length !== patterns.length) {
        return false;
    }
    for (let index = 0; index < snapshot.length; index++) {
        if (snapshot[index] !== patterns[index]) {
            return false;
        }
    }
    return true;
}

/**
 * Pre-compiles IP/CIDR whitelist patterns once per array snapshot and caches loopback booleans.
 * @param {string[]} patterns Valid IP/CIDR pattern strings
 * @returns {CompiledIpPatterns}
 */
export function compileIpPatterns(patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        return {
            snapshot: [],
            matchers: [],
            allowsIpv4Loopback: false,
            allowsIpv6Loopback: false,
        };
    }

    const cached = compiledPatternsCache.get(patterns);
    if (cached && isSamePatternList(cached.snapshot, patterns)) {
        return cached;
    }

    const matchers = [];
    for (const pattern of patterns) {
        try {
            matchers.push(ipMatching.getMatch(pattern));
        } catch {
            // Invalid patterns are ignored so untrusted lookups never throw.
        }
    }

    const compiled = {
        snapshot: patterns.slice(),
        matchers,
        allowsIpv4Loopback: matchers.some(matcher => ipMatching.matches('127.0.0.1', matcher)),
        allowsIpv6Loopback: matchers.some(matcher => ipMatching.matches('::1', matcher)),
    };
    compiledPatternsCache.set(patterns, compiled);
    return compiled;
}

/**
 * Gets the IP address of the client from the request object.
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getIpFromRequest(req) {
    let clientIp = req.socket.remoteAddress;
    if (!clientIp) {
        return 'unknown';
    }
    // SillyBunny: fast-path loopback socket addresses before parsing with ipaddr.js.
    if (clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1') {
        return '127.0.0.1';
    }
    if (clientIp === '::1') {
        return '::1';
    }
    let ip = ipaddr.parse(clientIp);
    // Check if the IP address is IPv4-mapped IPv6 address
    if (ip.kind() === 'ipv6' && ip instanceof ipaddr.IPv6 && ip.isIPv4MappedAddress()) {
        const ipv4 = ip.toIPv4Address().toString();
        clientIp = ipv4;
    } else {
        clientIp = ip.toString();
    }
    return clientIp;
}

/**
 * Gets the IP address of the client when behind reverse proxy using x-real-ip header, falls back to socket remote address.
 * This function should be used when the application is running behind a reverse proxy (e.g., Nginx, traefik, Caddy...).
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getRealIpFromHeader(req) {
    if (req.headers['x-real-ip']) {
        return req.headers['x-real-ip'].toString();
    }

    return getIpFromRequest(req);
}

// SillyBunny: a forwarded value can come from a client, so addresses are parsed strictly, and a value that is not an IP address matches nothing instead of throwing.
/**
 * Parses an IP address for matching against IP patterns.
 * @param {unknown} address Address text
 * @returns {string|null} The address in canonical form, with an IPv4-mapped IPv6 address as IPv4 and without an IPv6 zone index, or null when the text is not an IP address
 */
function normalizeIpAddress(address) {
    if (typeof address !== 'string') {
        return null;
    }
    if (address === '127.0.0.1' || address === '::ffff:127.0.0.1') {
        return '127.0.0.1';
    }
    if (address === '::1') {
        return '::1';
    }
    const text = address.trim();
    if (!ipaddr.IPv4.isValidFourPartDecimal(text) && !ipaddr.IPv6.isValid(text)) {
        return null;
    }
    const ip = ipaddr.process(text);
    return ip instanceof ipaddr.IPv6 ? new ipaddr.IPv6(ip.parts).toString() : ip.toString();
}

/**
 * Checks if an address matches any of the IP patterns.
 * @param {unknown} address Address text
 * @param {string[]} patterns Valid IP patterns, such as whitelist entries
 * @returns {boolean} True if the address matches a pattern, false for a value that is not an IP address
 */
export function isIpInPatterns(address, patterns) {
    // SillyBunny: match against pre-compiled CIDR entries and O(1) loopback flags.
    const compiled = compileIpPatterns(patterns);
    if (compiled.matchers.length === 0) {
        return false;
    }
    if (address === '127.0.0.1' || address === '::ffff:127.0.0.1') {
        return compiled.allowsIpv4Loopback;
    }
    if (address === '::1') {
        return compiled.allowsIpv6Loopback;
    }
    const ip = normalizeIpAddress(address);
    if (ip === null) {
        return false;
    }
    if (ip === '127.0.0.1') {
        return compiled.allowsIpv4Loopback;
    }
    if (ip === '::1') {
        return compiled.allowsIpv6Loopback;
    }
    return compiled.matchers.some(matcher => ipMatching.matches(ip, matcher));
}

// SillyBunny: the server cannot tell which forwarded header its proxy set and which one a client sent through it, so every enabled header counts.
/**
 * Lists the client addresses that the enabled forwarded headers name.
 * Each proxy adds the address it received the request from at the end of X-Forwarded-For, so the list is read from the right:
 * entries of trusted hops are skipped, and the first other entry is the client. When every entry is a trusted hop, the leftmost entry is the client.
 * @param {import('express').Request} req Express request object
 * @param {string[]} trustedProxies IP patterns of the hops whose X-Forwarded-For entries are believed
 * @returns {string[]} The addresses as the headers carry them, in the order X-Real-IP, CF-Connecting-IP, X-Forwarded-For
 */
export function getForwardedIps(req, trustedProxies, { readConfig = getConfigValue } = {}) {
    const headers = req?.headers;
    if (!headers) {
        return [];
    }
    const rawRealIp = headers['x-real-ip'];
    const rawCfConnectingIp = headers['cf-connecting-ip'];
    const rawForwardedFor = headers['x-forwarded-for'];
    // SillyBunny: short-circuit before reading config when no forwarded IP headers are present.
    if (!rawRealIp && !rawCfConnectingIp && !rawForwardedFor) {
        return [];
    }

    const forwardedIps = [];

    if (rawRealIp && readConfig('forwardedHeaders.xRealIp', true, 'boolean')) {
        forwardedIps.push(rawRealIp.toString());
    }

    if (rawCfConnectingIp && readConfig('forwardedHeaders.cfConnectingIp', false, 'boolean')) {
        forwardedIps.push(rawCfConnectingIp.toString());
    }

    if (rawForwardedFor && readConfig('forwardedHeaders.xForwardedFor', true, 'boolean')) {
        const ipList = rawForwardedFor.toString().split(',').map(ip => ip.trim()).filter(ip => ip);
        let clientIp = ipList.pop();
        while (ipList.length > 0 && isIpInPatterns(clientIp, trustedProxies)) {
            clientIp = ipList.pop();
        }
        if (clientIp) {
            forwardedIps.push(clientIp);
        }
    }

    return forwardedIps;
}

let trustedProxies = null;
let trustedProxiesSource = undefined;

/**
 * Gets the IP patterns of the hops whose forwarded headers are believed.
 * @returns {string[]} The valid whitelist entries
 */
export function getTrustedProxies() {
    const configuredWhitelist = getConfigValue('whitelist', []);
    if (trustedProxies === null || trustedProxiesSource !== configuredWhitelist) {
        trustedProxiesSource = configuredWhitelist;
        trustedProxies = filterValidIpPatterns(configuredWhitelist);
        compileIpPatterns(trustedProxies);
    }
    return trustedProxies;
}

/**
 * Gets the IP address of the client, optionally including real/forwarded headers.
 * @param {import('express').Request} request Request object
 * @param {boolean} includeHeaderIp Whether to include the real/forwarded IP from headers
 * @returns {string} IP address of the client
 */
export function getIpAddress(request, includeHeaderIp) {
    const socketIp = getIpFromRequest(request);
    // SillyBunny: a forwarded address counts only from a trusted hop and only when every enabled header names it, so the result is never a value that the client chooses.
    const forwardedIp = includeHeaderIp && getTrustedForwardedIp(request, socketIp);
    return forwardedIp ? `${socketIp} (forwarded: ${forwardedIp})` : socketIp;
}

/**
 * Gets the client address that a trusted hop forwarded.
 * @param {import('express').Request} request Request object
 * @param {string} socketIp Socket address of the request
 * @returns {string|null} The address, or null when the socket is not a trusted hop or the enabled headers do not name one valid address
 */
function getTrustedForwardedIp(request, socketIp) {
    const proxies = getTrustedProxies();
    if (!isIpInPatterns(socketIp, proxies)) {
        return null;
    }
    const forwardedIps = new Set(getForwardedIps(request, proxies).map(normalizeIpAddress));
    return forwardedIps.size === 1 ? [...forwardedIps][0] : null;
}

/**
 * Checks if the request is coming from a Firefox browser.
 * @param {import('express').Request} req Request object
 * @returns {boolean} True if the request is from Firefox, false otherwise.
 */
export function isFirefox(req) {
    const userAgent = req.headers['user-agent'] || '';
    return /firefox/i.test(userAgent);
}

/**
 * Filters and validates IP patterns.
 * @param {string[]} entries The list of IP patterns to validate
 * @param {(entry: string, message: string) => string} formatLog Function to format warnings for invalid entries
 * @returns {string[]} The list of valid IP patterns
 */
export function filterValidIpPatterns(entries, formatLog) {
    const validEntries = [];

    if (!Array.isArray(entries)) {
        return validEntries;
    }

    for (const entry of entries) {
        try {
            ipMatching.getMatch(entry);
            validEntries.push(entry);
        } catch (e) {
            if (typeof formatLog === 'function') {
                console.warn(formatLog(entry, e?.message || 'Unknown error'));
            }
        }
    }

    return validEntries;
}

/**
 * Sets the Retry-After header based on rate limit information.
 * @param {import('express').Response} response Express response object
 * @param {RateLimiterRes} rateLimit The rate limit information
 * @returns {import('express').Response} The response object
 */
export function retryAfter(response, rateLimit) {
    if (response.headersSent || !(rateLimit instanceof RateLimiterRes)) {
        return response;
    }
    const retryAfter = Math.ceil(rateLimit.msBeforeNext / 1000);
    response.set('Retry-After', retryAfter.toString());
    return response;
}
