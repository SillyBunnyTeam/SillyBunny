import { isIpInPatterns } from './express-common.js';

const LOOPBACK_PATTERNS = Object.freeze(['127.0.0.0/8', '::1']);

/**
 * Headers that a reverse proxy adds when it forwards a request for another client. A proxy on this machine
 * connects from a loopback address, so a request with any of them does not come straight from this machine.
 */
export const FORWARDING_HEADERS = Object.freeze([
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'cf-connecting-ip',
    'via',
]);

/**
 * Whether the request carries a forwarding header. A header that is present counts even when its value is empty.
 * @param {import('express').Request} request Express request
 * @returns {boolean}
 */
export function hasForwardingHeaders(request) {
    const headers = request?.headers;
    return Boolean(headers) && FORWARDING_HEADERS.some(name => headers[name] !== undefined);
}

/**
 * Whether an address is in 127.0.0.0/8 or is ::1, including the IPv4-mapped form.
 * @param {string | undefined} address Client or socket address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
    return typeof address === 'string' && isIpInPatterns(address, LOOPBACK_PATTERNS);
}
