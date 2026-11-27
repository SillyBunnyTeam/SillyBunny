import { isIpInPatterns } from './express-common.js';

const LOOPBACK_PATTERNS = Object.freeze(['127.0.0.0/8', '::1']);

/**
 * Whether the request carries one of the given forwarding headers. A header that is present counts even when its
 * value is empty. A proxy on this machine connects from a loopback address, so a request with a forwarding header
 * does not come straight from this machine.
 *
 * The caller passes its own list because a wrong answer costs differently. `requireHttps` is a security check: it
 * must keep deciding exactly as it always did, so it passes its five headers and a header added to the shared test
 * would change which requests skip HTTPS. The compression bypass only saves CPU, and for it a wrong "not local"
 * answer means that a response is compressed, so it passes a wider list.
 * @param {import('express').Request} request Express request
 * @param {readonly string[]} headerNames Lower-case header names to look for
 * @returns {boolean}
 */
export function hasForwardingHeaders(request, headerNames) {
    const headers = request?.headers;
    return Boolean(headers) && headerNames.some(name => headers[name] !== undefined);
}

/**
 * Whether an address is in 127.0.0.0/8 or is ::1, including the IPv4-mapped form.
 * @param {string | undefined} address Client or socket address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
    return typeof address === 'string' && isIpInPatterns(address, LOOPBACK_PATTERNS);
}
