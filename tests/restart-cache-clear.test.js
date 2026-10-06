import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, defaultValue) => defaultValue,
}));

const {
    createRestartCacheClearMiddleware,
    RESTART_CACHE_CLEAR_BOOT_COOKIE,
} = await import('../src/middleware/restartCacheClear.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageScriptSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-restart-cache-clear.js'), 'utf8');

/**
 * A browser with a cookie jar that loads the index page from a server boot:
 * runs the middleware, applies its Set-Cookie, then runs the page script.
 */
class FakeBrowser {
    constructor({ acceptsPageCookies = true } = {}) {
        this.jar = new Map();
        this.acceptsPageCookies = acceptsPageCookies;
        this.cacheStorage = new Set(['sillybunny-cache-v1-static', 'sillybunny-cache-v1-shell']);
        this.registrations = 1;
        this.serviceWorkerPurges = 0;
    }

    get cookieHeader() {
        return [...this.jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
    }

    /**
     * Loads the index page and follows script-initiated reloads.
     * @returns {Promise<{ clearSiteDataLoads: number, loads: number }>}
     */
    async open(middleware, { maxLoads = 10 } = {}) {
        let loads = 0;
        let clearSiteDataLoads = 0;
        let reload = true;
        while (reload && loads < maxLoads) {
            loads++;
            const headers = new Map();
            const response = {
                headersSent: false,
                setHeader: (name, value) => headers.set(name, value),
                cookie: (name, value) => this.jar.set(name, value),
            };
            middleware({ headers: { cookie: this.cookieHeader } }, response, () => {});
            if (headers.get('Clear-Site-Data') === '"cache"') {
                clearSiteDataLoads++;
            }
            reload = await this.#runPageScript();
        }
        return { clearSiteDataLoads, loads };
    }

    async #runPageScript() {
        const browser = this;
        let reloaded = false;
        let resolveReload;
        const reloadPromise = new Promise(resolve => {
            resolveReload = resolve;
        });
        const document = {
            get cookie() {
                return browser.cookieHeader;
            },
            set cookie(value) {
                if (!browser.acceptsPageCookies) {
                    return;
                }
                const [pair] = value.split(';');
                const separator = pair.indexOf('=');
                browser.jar.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1)));
            },
        };
        class MessageChannel {
            constructor() {
                this.port1 = { onmessage: null };
                this.port2 = { postMessage: data => this.port1.onmessage?.({ data }) };
            }
        }
        const window = {
            setTimeout,
            clearTimeout,
            caches: {
                keys: async () => [...browser.cacheStorage],
                delete: async key => browser.cacheStorage.delete(key),
            },
            location: {
                protocol: 'http:',
                reload: () => {
                    reloaded = true;
                    resolveReload();
                },
            },
        };
        const navigator = {
            serviceWorker: {
                controller: browser.registrations > 0 ? {
                    postMessage: (message, [port]) => {
                        if (message?.type === 'SB_CLEAR_CACHES') {
                            browser.serviceWorkerPurges++;
                            port.postMessage({ type: 'SB_CLEAR_CACHES_DONE', ok: true });
                        }
                    },
                } : null,
                getRegistrations: async () => Array.from({ length: browser.registrations }, () => ({
                    unregister: async () => {
                        browser.registrations = 0;
                        return true;
                    },
                })),
            },
        };
        const context = vm.createContext({
            window,
            document,
            navigator,
            location: window.location,
            MessageChannel,
            console: { info: () => {}, warn: () => {} },
            Promise,
        });
        vm.runInContext(pageScriptSource, context);
        await Promise.race([reloadPromise, new Promise(resolve => setTimeout(resolve, 50))]);
        return reloaded;
    }
}

describe('restart cache clear', () => {
    test('clears each browser exactly twice per server start, then stops', async () => {
        const browser = new FakeBrowser();
        const middleware = createRestartCacheClearMiddleware({ enabled: true, bootId: 'boot-a' });

        const first = await browser.open(middleware);
        expect(first).toEqual({ clearSiteDataLoads: 2, loads: 3 });
        expect(browser.serviceWorkerPurges).toBe(1);
        expect(browser.cacheStorage.size).toBe(0);
        expect(browser.registrations).toBe(0);

        const later = await browser.open(middleware);
        expect(later).toEqual({ clearSiteDataLoads: 0, loads: 1 });
    });

    test('a new server boot clears twice again', async () => {
        const browser = new FakeBrowser();
        await browser.open(createRestartCacheClearMiddleware({ enabled: true, bootId: 'boot-a' }));

        const restarted = await browser.open(createRestartCacheClearMiddleware({ enabled: true, bootId: 'boot-b' }));
        expect(restarted).toEqual({ clearSiteDataLoads: 2, loads: 3 });
        expect(browser.jar.get(RESTART_CACHE_CLEAR_BOOT_COOKIE)).toBe('boot-b');
    });

    test('does nothing when disabled', async () => {
        const browser = new FakeBrowser();
        const result = await browser.open(createRestartCacheClearMiddleware({ enabled: false, bootId: 'boot-a' }));

        expect(result).toEqual({ clearSiteDataLoads: 0, loads: 1 });
        expect(browser.cacheStorage.size).toBe(2);
    });

    test('never reload-loops when the browser rejects the progress cookie', async () => {
        const browser = new FakeBrowser({ acceptsPageCookies: false });
        const result = await browser.open(createRestartCacheClearMiddleware({ enabled: true, bootId: 'boot-a' }));

        expect(result.loads).toBe(1);
    });
});
