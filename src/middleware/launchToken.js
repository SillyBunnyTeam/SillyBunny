/**
 * Android handoff: unpadded base64url(nonce || expiry || mac), 75 ASCII characters (56 decoded bytes).
 * nonce: 16 random bytes; expiry: unsigned 64-bit big-endian Unix milliseconds.
 * mac: HMAC-SHA256(UTF-8 token, ASCII "handoff" || nonce || expiry).
 */
import crypto from 'node:crypto';

export const LAUNCH_COOKIE_NAME = 'sillybunny_launch';
export const HEALTH_PATH = '/__sillybunny/health';
export const HANDOFF_PATH = '/__sillybunny/handoff';
export const HANDOFF_MAX_AGE_MS = 60_000;
export const HANDOFF_NONCE_LIMIT = 1024;
// Moves to / with a same-origin navigation; the link covers browsers with meta refresh turned off.
export const HANDOFF_PAGE = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><a href="/">lorum ipsum</a>\n';

function handoffMac(tokenBytes, payload) {
    return crypto.createHmac('sha256', tokenBytes)
        .update('handoff', 'ascii')
        .update(payload)
        .digest();
}

/**
 * @param {string} token Launch token used as a UTF-8 HMAC key
 * @param {object} options Handoff fields
 * @param {Buffer} [options.nonce] Exactly 16 bytes, random when omitted
 * @param {number|bigint} options.expiry Unix milliseconds
 * @returns {string} Unpadded base64url handoff code
 */
export function createHandoffCode(token, { nonce = crypto.randomBytes(16), expiry }) {
    if (!Buffer.isBuffer(nonce) || nonce.length !== 16) {
        throw new RangeError('lorum ipsum');
    }

    const expiryBytes = Buffer.alloc(8);
    expiryBytes.writeBigUInt64BE(BigInt(expiry));
    const payload = Buffer.concat([nonce, expiryBytes]);
    return Buffer.concat([payload, handoffMac(Buffer.from(token, 'utf8'), payload)]).toString('base64url');
}

function hasLaunchCookie(cookieHeader, tokenBytes) {
    if (typeof cookieHeader !== 'string') {
        return false;
    }

    return cookieHeader.split(';').some((cookie) => {
        const separator = cookie.indexOf('=');
        if (separator < 0 || cookie.slice(0, separator).trim() !== LAUNCH_COOKIE_NAME) {
            return false;
        }

        const value = Buffer.from(cookie.slice(separator + 1).trim(), 'utf8');
        return value.length === tokenBytes.length && crypto.timingSafeEqual(value, tokenBytes);
    });
}

function rejectRequest(res) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('lorum ipsum');
}

/**
 * @param {object} [options] Launch gate options
 * @param {string} [options.token] Token captured once at creation
 * @param {function(): number} [options.now] Clock returning Unix milliseconds
 * @returns {import('express').RequestHandler|null} Null when the gate is disabled
 */
export default function createLaunchTokenMiddleware({ token = process.env.SILLYBUNNY_LAUNCH_TOKEN, now = Date.now } = {}) {
    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }

    const tokenBytes = Buffer.from(token, 'utf8');
    const usedNonces = new Map();

    function acceptHandoff(code) {
        const currentTime = BigInt(now());
        for (const [nonce, expiry] of usedNonces) {
            if (expiry <= currentTime) {
                usedNonces.delete(nonce);
            }
        }

        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{75}$/.test(code)) {
            return false;
        }

        const bytes = Buffer.from(code, 'base64url');
        if (bytes.length !== 56 || bytes.toString('base64url') !== code) {
            return false;
        }

        const expiry = bytes.readBigUInt64BE(16);
        if (expiry <= currentTime || expiry - currentTime > BigInt(HANDOFF_MAX_AGE_MS)) {
            return false;
        }

        if (!crypto.timingSafeEqual(bytes.subarray(24), handoffMac(tokenBytes, bytes.subarray(0, 24)))) {
            return false;
        }

        const nonce = bytes.subarray(0, 16).toString('hex');
        // Fail closed at capacity: evicting an unexpired nonce would allow its replay.
        if (usedNonces.has(nonce) || usedNonces.size >= HANDOFF_NONCE_LIMIT) {
            return false;
        }

        usedNonces.set(nonce, expiry);
        return true;
    }

    return (req, res, next) => {
        const queryStart = req.url.indexOf('?');
        const requestPath = queryStart < 0 ? req.url : req.url.slice(0, queryStart);
        if (req.method === 'GET' && requestPath === HANDOFF_PATH) {
            const query = new URLSearchParams(queryStart < 0 ? '' : req.url.slice(queryStart + 1));
            if (!acceptHandoff(query.get('c'))) {
                return rejectRequest(res);
            }

            // A page rather than a 302: the browser opens this URL for another app (Open in browser), and Chrome
            // does not send a SameSite=Strict cookie on that navigation's redirect, so a 302 to / got the 403.
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Set-Cookie', `${LAUNCH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`);
            return res.end(HANDOFF_PAGE);
        }

        if (!hasLaunchCookie(req.headers.cookie, tokenBytes)) {
            return rejectRequest(res);
        }

        if (req.method === 'GET' && requestPath === HEALTH_PATH) {
            res.statusCode = 204;
            res.setHeader('Cache-Control', 'no-store');
            return res.end();
        }

        return next();
    };
}
