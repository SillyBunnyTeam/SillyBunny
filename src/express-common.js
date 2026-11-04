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
 * Gets the IP address of the client from the request object.
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getIpFromRequest(req) {
    let clientIp = req.socket.remoteAddress;
    if (!clientIp) {
        return 'unknown';
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
    const ip = normalizeIpAddress(address);
    return ip !== null && patterns.some(pattern => ipMatching.matches(ip, ipMatching.getMatch(pattern)));
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
export function getForwardedIps(req, trustedProxies) {
    const xRealIpEnabled = !!getConfigValue('forwardedHeaders.xRealIp', true, 'boolean');
    const cfConnectingIpEnabled = !!getConfigValue('forwardedHeaders.cfConnectingIp', false, 'boolean');
    const xForwardedForEnabled = !!getConfigValue('forwardedHeaders.xForwardedFor', true, 'boolean');
    const forwardedIps = [];

    if (req.headers['x-real-ip'] && xRealIpEnabled) {
        forwardedIps.push(req.headers['x-real-ip'].toString());
    }

    if (req.headers['cf-connecting-ip'] && cfConnectingIpEnabled) {
        forwardedIps.push(req.headers['cf-connecting-ip'].toString());
    }

    if (req.headers['x-forwarded-for'] && xForwardedForEnabled) {
        const ipList = req.headers['x-forwarded-for'].toString().split(',').map(ip => ip.trim()).filter(ip => ip);
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

/**
 * Get the client IP address from the request headers.
 * @param {import('express').Request} req Express request object
 * @returns {string|undefined} The client IP address
 */
export function getRealOrForwardedIp(req) {
    const xRealIpEnabled = !!getConfigValue('forwardedHeaders.xRealIp', true, 'boolean');
    const cfConnectingIpEnabled = !!getConfigValue('forwardedHeaders.cfConnectingIp', false, 'boolean');
    const xForwardedForEnabled = !!getConfigValue('forwardedHeaders.xForwardedFor', true, 'boolean');

    if (req.headers['x-real-ip'] && xRealIpEnabled) {
        return req.headers['x-real-ip'].toString();
    }

    if (req.headers['cf-connecting-ip'] && cfConnectingIpEnabled) {
        return req.headers['cf-connecting-ip'].toString();
    }

    if (req.headers['x-forwarded-for'] && xForwardedForEnabled) {
        const ipList = req.headers['x-forwarded-for'].toString().split(',').map(ip => ip.trim());
        return ipList[0];
    }

    return undefined;
}

/**
 * Gets the IP address of the client, optionally including real/forwarded headers.
 * @param {import('express').Request} request Request object
 * @param {boolean} includeHeaderIp Whether to include the real/forwarded IP from headers
 * @returns {string} IP address of the client
 */
export function getIpAddress(request, includeHeaderIp) {
    const socketIp = getIpFromRequest(request);
    const forwardedIp = includeHeaderIp && getRealOrForwardedIp(request);
    return forwardedIp ? `${socketIp} (forwarded: ${forwardedIp})` : socketIp;
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
