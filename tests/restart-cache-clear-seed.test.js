import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, defaultValue) => defaultValue,
}));

const {
    createRestartCacheClearMiddleware,
    RESTART_CACHE_CLEAR_BOOT_COOKIE,
    RESTART_CACHE_CLEAR_PASSES,
    RESTART_CACHE_CLEAR_PROGRESS_COOKIE,
} = await import('../src/middleware/restartCacheClear.js');
const { buildClearedCookies, parseRestartCacheClear, restartCacheClearStatePath } = await import('./helpers/restart-cache-clear-seed.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageScriptSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-restart-cache-clear.js'), 'utf8');

describe('the restart cache clear seed of the Firefox e2e config', () => {
    test('reads the cookie names and the pass count the server uses from the page script', () => {
        expect(parseRestartCacheClear(pageScriptSource)).toEqual({
            bootCookie: RESTART_CACHE_CLEAR_BOOT_COOKIE,
            progressCookie: RESTART_CACHE_CLEAR_PROGRESS_COOKIE,
            passes: RESTART_CACHE_CLEAR_PASSES,
        });
    });

    test('fails when the page script no longer has the line it reads', () => {
        expect(() => parseRestartCacheClear(pageScriptSource.replace('var PASSES = ', 'var PASS_COUNT = '))).toThrow(/var PASSES/);
    });

    test('seeds cookies that end the clear on the server', () => {
        const bootId = 'boot-a';
        const middleware = createRestartCacheClearMiddleware({ enabled: true, bootId });
        const cookies = buildClearedCookies(parseRestartCacheClear(pageScriptSource), { bootId, hostname: '127.0.0.1' });
        const respond = (cookieHeader) => {
            const headers = {};
            const response = { headersSent: false, setHeader: (name, value) => { headers[name] = value; }, cookie: jest.fn() };
            const next = jest.fn();
            middleware({ headers: { cookie: cookieHeader } }, response, next);
            return { headers, next, response };
        };

        expect(respond('').headers['Clear-Site-Data']).toBe('"cache"');
        const seeded = respond(cookies.map(({ name, value }) => `${name}=${value}`).join('; '));
        expect(seeded.headers['Clear-Site-Data']).toBeUndefined();
        expect(seeded.response.cookie).not.toHaveBeenCalled();
        expect(seeded.next).toHaveBeenCalled();
    });

    test('cookies of an earlier server start do not end the clear', () => {
        const middleware = createRestartCacheClearMiddleware({ enabled: true, bootId: 'boot-b' });
        const cookies = buildClearedCookies(parseRestartCacheClear(pageScriptSource), { bootId: 'boot-a', hostname: '127.0.0.1' });
        const headers = {};
        middleware({ headers: { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') } }, { headersSent: false, setHeader: (name, value) => { headers[name] = value; }, cookie: jest.fn() }, jest.fn());
        expect(headers['Clear-Site-Data']).toBe('"cache"');
    });

    test('keeps the state of each server apart', () => {
        expect(restartCacheClearStatePath('http://127.0.0.1:4444')).not.toBe(restartCacheClearStatePath('http://127.0.0.1:4468'));
    });
});
