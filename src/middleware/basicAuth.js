/**
 * When applied, this middleware will ensure the request contains the required header for basic authentication and only
 * allow access to the endpoint after successful authentication.
 * Also supports session-based Bearer token authentication when sessionAuth is enabled.
 */
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';
import storage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getAllUserHandles, toKey, getPasswordHash } from '../users.js';
import { getConfigValue, safeReadFileSync } from '../util.js';
import { validateSession, isSessionAuthEnabled } from './sessionAuth.js';
import { getIpAddress, retryAfter } from '../express-common.js';

const PER_USER_BASIC_AUTH = !!getConfigValue('perUserBasicAuth', false, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const PREFER_REAL_IP_HEADER = !!getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const BASIC_AUTH_ATTEMPTS = getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number');

const basicAuthLimiter = new RateLimiterMemory({
    points: BASIC_AUTH_ATTEMPTS > 0 ? BASIC_AUTH_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});

/**
 * Checks credentials from the request against the configured user in constant time.
 * Both sides are hashed first, because timingSafeEqual needs inputs of the same length.
 * @param {string} username Username from the request
 * @param {string} password Password from the request
 * @param {unknown} configuredUsername Configured username
 * @param {unknown} configuredPassword Configured password
 * @returns {boolean} False when a configured value is empty or not a string
 */
function matchesConfiguredUser(username, password, configuredUsername, configuredPassword) {
    if (typeof configuredUsername !== 'string' || typeof configuredPassword !== 'string' || !configuredUsername || !configuredPassword) {
        return false;
    }
    const digest = value => crypto.createHash('sha256').update(value).digest();
    const usernameMatches = crypto.timingSafeEqual(digest(username), digest(configuredUsername));
    const passwordMatches = crypto.timingSafeEqual(digest(password), digest(configuredPassword));
    return usernameMatches && passwordMatches;
}

const basicAuthMiddleware = async function (request, response, callback) {
    const unauthorizedResponse = (res) => {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0',
        });
        res.vary('Authorization');
        res.vary('Cookie');
        const unauthorizedWebpage = safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'unauthorized.html')) ?? '';
        res.set('WWW-Authenticate', 'Basic realm="SillyBunny", charset="UTF-8"');
        return res.status(401).send(unauthorizedWebpage);
    };

    const authHeader = request.headers.authorization;

    // Check for session-based Bearer token authentication first
    if (authHeader && isSessionAuthEnabled()) {
        const [scheme, token] = authHeader.split(' ');
        if (scheme === 'Bearer' && token) {
            const session = validateSession(token);
            if (session) {
                return callback();
            }
        }
    }

    if (ENABLE_ACCOUNTS && request.session?.handle) {
        return callback();
    }

    try {
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);

        const basicAuthUserName = getConfigValue('basicAuthUser.username');
        const basicAuthUserPassword = getConfigValue('basicAuthUser.password');

        if (!authHeader) {
            return unauthorizedResponse(response);
        }

        const [scheme, credentials] = authHeader.split(' ');

        if (scheme !== 'Basic' || !credentials) {
            return unauthorizedResponse(response);
        }

        const rateLimit = await basicAuthLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints > basicAuthLimiter.points) {
            throw rateLimit;
        }

        const usePerUserAuth = PER_USER_BASIC_AUTH && ENABLE_ACCOUNTS;
        const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
            .toString('utf8')
            .split(':');
        const password = passwordParts.join(':');

        // SillyBunny: an empty configured credential matches nothing, and the time of the comparison does not depend on how much of the input is correct.
        if (!usePerUserAuth && matchesConfiguredUser(username, password, basicAuthUserName, basicAuthUserPassword)) {
            await basicAuthLimiter.delete(ip);
            return callback();
        } else if (usePerUserAuth) {
            const userHandles = await getAllUserHandles();
            for (const userHandle of userHandles) {
                if (username === userHandle) {
                    const user = await storage.getItem(toKey(userHandle));
                    if (user && user.enabled && (user.password && user.password === getPasswordHash(password, user.salt))) {
                        await basicAuthLimiter.delete(ip);
                        return callback();
                    }
                }
            }
        }

        await basicAuthLimiter.consume(ip);
        return unauthorizedResponse(response);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Basic auth failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER), request.method, request.originalUrl);
            return retryAfter(response, error).sendStatus(429);
        }
        console.error('Basic auth error:', error);
        return response.sendStatus(500);
    }
};

export default basicAuthMiddleware;
