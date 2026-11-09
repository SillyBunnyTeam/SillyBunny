import crypto from 'node:crypto';
import storage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { color, getConfigValue } from '../util.js';
import { getAllUserHandles, toKey, getPasswordHash } from '../users.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import getWhitelistMiddleware from './whitelist.js';
import hostWhitelistMiddleware from './hostWhitelist.js';

const SESSION_DURATION_MS = getConfigValue('sessionAuth.durationMinutes', 480, 'number') * 60 * 1000;
const SESSION_AUTH_ENABLED = getConfigValue('sessionAuth.enabled', false, 'boolean');
const PREFER_REAL_IP_HEADER = !!getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_ATTEMPTS = getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number');

/** @type {Map<string, {username: string, expires: number}>} */
const sessions = new Map();

const loginLimiter = new RateLimiterMemory({
    points: LOGIN_ATTEMPTS > 0 ? LOGIN_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});

/**
 * Creates a new session for the given username.
 * @param {string} username
 * @returns {string} Session token
 */
export function createSession(username) {
    const token = crypto.randomBytes(48).toString('base64url');
    sessions.set(token, {
        username,
        expires: Date.now() + SESSION_DURATION_MS,
    });
    return token;
}

/**
 * Validates a session token and returns the session if valid.
 * @param {string} token
 * @returns {{username: string, expires: number}|null}
 */
export function validateSession(token) {
    const session = sessions.get(token);
    if (!session) {
        return null;
    }
    if (Date.now() > session.expires) {
        sessions.delete(token);
        return null;
    }
    return session;
}

/**
 * Destroys a session by token.
 * @param {string} token
 */
export function destroySession(token) {
    sessions.delete(token);
}

/**
 * Checks if session auth is enabled.
 * @returns {boolean}
 */
export function isSessionAuthEnabled() {
    return SESSION_AUTH_ENABLED;
}

/**
 * Checks if session logins use the account passwords instead of basicAuthUser.
 * @returns {boolean}
 */
function usesAccountPasswords() {
    return getConfigValue('perUserBasicAuth', false, 'boolean') && getConfigValue('enableUserAccounts', false, 'boolean');
}

/**
 * Reads the single-user credentials from basicAuthUser.
 * @returns {{username: unknown, password: unknown}|null} The configured values, or null when either one is not set or empty
 */
function getConfiguredCredentials() {
    const username = getConfigValue('basicAuthUser.username');
    const password = getConfigValue('basicAuthUser.password');
    return username && password ? { username, password } : null;
}

/**
 * Checks credentials from a request against basicAuthUser in constant time.
 * Both sides are hashed first, because timingSafeEqual needs inputs of the same length.
 * @param {string} username Username from the request
 * @param {string} password Password from the request
 * @returns {boolean} False when a configured value is empty or not a string
 */
function matchesConfiguredUser(username, password) {
    const configured = getConfiguredCredentials();
    if (!configured || typeof configured.username !== 'string' || typeof configured.password !== 'string') {
        return false;
    }

    const digest = value => crypto.createHash('sha256').update(value).digest();
    const usernameMatches = crypto.timingSafeEqual(digest(username), digest(configured.username));
    const passwordMatches = crypto.timingSafeEqual(digest(password), digest(configured.password));
    return usernameMatches && passwordMatches;
}

/**
 * Validates credentials against configured users.
 * Supports both single-user basic auth and per-user accounts.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function validateCredentials(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') {
        return false;
    }

    if (!usesAccountPasswords()) {
        return matchesConfiguredUser(username, password);
    }

    const userHandles = await getAllUserHandles();
    for (const userHandle of userHandles) {
        if (username === userHandle) {
            const user = await storage.getItem(toKey(userHandle));
            if (user && user.enabled && user.password && user.password === getPasswordHash(password, user.salt)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Answers a session login with a new session token.
 * @param {import('express').Request} request Request
 * @param {import('express').Response} response Response
 */
async function handleLogin(request, response) {
    try {
        const { username, password } = request.body || {};
        if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
            return response.status(400).json({ error: 'Username and password are required.' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        const valid = await validateCredentials(username, password);
        if (!valid) {
            return response.status(401).json({ error: 'Invalid credentials.' });
        }

        await loginLimiter.delete(ip);
        const token = createSession(username);
        return response.json({ token });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Session login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).json({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Session login failed:', error);
        return response.sendStatus(500);
    }
}

/**
 * Ends the session whose token the request carries.
 * @param {import('express').Request} request Request
 * @param {import('express').Response} response Response
 */
function handleLogout(request, response) {
    const authHeader = request.headers.authorization;
    if (authHeader) {
        const [scheme, token] = authHeader.split(' ');
        if (scheme === 'Bearer' && token) {
            destroySession(token);
        }
    }
    return response.json({ success: true });
}

/**
 * Registers the session login and logout routes behind the IP and host whitelist checks.
 * @param {import('express').Express|import('express').Router} app App or router that receives the routes
 * @param {object} options Options
 * @param {boolean} options.whitelistMode Whether the IP whitelist is on
 * @returns {Promise<void>}
 */
export async function registerSessionAuthRoutes(app, { whitelistMode }) {
    if (!usesAccountPasswords() && !getConfiguredCredentials()) {
        console.warn(color.yellow('Session auth is enabled, but basicAuthUser.username or basicAuthUser.password is not set or empty. Session logins are refused until both are set.'));
    }

    const guards = whitelistMode
        ? [await getWhitelistMiddleware(), hostWhitelistMiddleware]
        : [hostWhitelistMiddleware];

    app.post('/api/auth/login', ...guards, handleLogin);
    app.post('/api/auth/logout', ...guards, handleLogout);
}
