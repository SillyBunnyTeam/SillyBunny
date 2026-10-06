import { getServerBootId } from '../server-boot-marker.js';
import { getConfigValue } from '../util.js';

/**
 * Cookie carrying the current server boot ID to the page. Readable by the
 * page script, which runs the browser-side purge.
 */
export const RESTART_CACHE_CLEAR_BOOT_COOKIE = 'sillybunny_cache_boot';

/**
 * Cookie the page writes after each purge: `<bootId>.<passes>`.
 */
export const RESTART_CACHE_CLEAR_PROGRESS_COOKIE = 'sillybunny_cache_cleared';

/**
 * Number of cache clears every browser receives after each server start.
 * A single clear is not enough: a still-controlling service worker can
 * re-populate its caches during the reload navigation that follows it.
 */
export const RESTART_CACHE_CLEAR_PASSES = 2;

/**
 * Reads one cookie value from a raw Cookie header.
 * @param {string | undefined} cookieHeader Raw Cookie header
 * @param {string} name Cookie name
 * @returns {string | null} Decoded value, or null when absent
 */
function readCookie(cookieHeader, name) {
    for (const part of String(cookieHeader || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1 || part.slice(0, separator).trim() !== name) {
            continue;
        }
        try {
            return decodeURIComponent(part.slice(separator + 1).trim());
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Number of passes this browser has completed for the given boot.
 * @param {string | undefined} cookieHeader Raw Cookie header
 * @param {string} bootId Current server boot ID
 * @returns {number} Completed passes for this boot; 0 for an older boot
 */
function getCompletedPasses(cookieHeader, bootId) {
    const progress = readCookie(cookieHeader, RESTART_CACHE_CLEAR_PROGRESS_COOKIE);
    if (!progress) {
        return 0;
    }
    const separator = progress.lastIndexOf('.');
    if (separator === -1 || progress.slice(0, separator) !== bootId) {
        return 0;
    }
    const passes = Number(progress.slice(separator + 1));
    return Number.isInteger(passes) && passes > 0 ? passes : 0;
}

/**
 * Creates the middleware that clears each browser's cache twice after every
 * server start. While a browser has passes left, its index responses carry
 * `Clear-Site-Data: "cache"` and the boot cookie; the page script then purges
 * Cache Storage and service workers, records the pass and reloads.
 * @param {object} [options]
 * @param {boolean} [options.enabled] Whether the feature is enabled
 * @param {string} [options.bootId] Current server boot ID
 * @returns {import('express').RequestHandler}
 */
export function createRestartCacheClearMiddleware({
    enabled = getConfigValue('restartCacheClear.enabled', true, 'boolean'),
    bootId = getServerBootId(),
} = {}) {
    return function restartCacheClear(request, response, next) {
        if (!enabled || response.headersSent) {
            return next();
        }

        if (getCompletedPasses(request.headers.cookie, bootId) >= RESTART_CACHE_CLEAR_PASSES) {
            return next();
        }

        response.setHeader('Clear-Site-Data', '"cache"');
        response.cookie(RESTART_CACHE_CLEAR_BOOT_COOKIE, bootId, {
            path: '/',
            sameSite: 'lax',
            httpOnly: false,
        });
        next();
    };
}

export default createRestartCacheClearMiddleware();
