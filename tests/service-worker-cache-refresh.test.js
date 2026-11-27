/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { importScriptModule } from './util/script-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swPath = path.join(repoRoot, 'public', 'sw.js');

let loaded = null;
const restoreFns = [];

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    while (restoreFns.length) restoreFns.pop()();
    jest.restoreAllMocks();
});

function defineRestorable(target, key, value) {
    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const prevDesc = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    restoreFns.push(() => {
        if (hadOwn && prevDesc) {
            Object.defineProperty(target, key, prevDesc);
        } else {
            delete target[key];
        }
    });
}

function createFakeResponse(body, { ok = true, status = 200, type = 'basic' } = {}) {
    return {
        body,
        ok,
        status,
        type,
        clone() {
            return createFakeResponse(body, { ok, status, type });
        },
    };
}

function createFakeCacheStorage(initialCaches = {}) {
    const stores = new Map();

    for (const [cacheName, entries] of Object.entries(initialCaches)) {
        stores.set(cacheName, new Map(Object.entries(entries)));
    }

    const getOrCreateStore = (cacheName) => {
        if (!stores.has(cacheName)) {
            stores.set(cacheName, new Map());
        }
        return stores.get(cacheName);
    };

    const keyOf = request => (typeof request === 'string' ? request : request.url);

    return {
        stores,
        api: {
            keys: async () => [...stores.keys()],
            delete: async name => stores.delete(name),
            open: async name => {
                const store = getOrCreateStore(name);
                return {
                    match: async request => store.get(keyOf(request)),
                    put: async (request, response) => {
                        store.set(keyOf(request), response);
                    },
                };
            },
        },
    };
}

function createServiceWorkerSandbox({ initialCaches = {}, fetchImpl = async () => createFakeResponse('fresh') } = {}) {
    const swSource = readFileSync(swPath, 'utf8');
    const listeners = new Map();
    const skipWaiting = jest.fn(() => Promise.resolve());
    const claim = jest.fn(() => Promise.resolve());
    const cacheStorage = createFakeCacheStorage(initialCaches);

    const self = {
        location: { origin: 'https://sillybunny.local' },
        skipWaiting,
        clients: { claim },
        addEventListener: (type, handler) => {
            listeners.set(type, handler);
        },
    };

    const context = vm.createContext({
        self,
        caches: cacheStorage.api,
        fetch: jest.fn(fetchImpl),
        URL,
        Object,
        Promise,
        console: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    });

    vm.runInContext(swSource, context);

    const versionMatch = swSource.match(/const\s+SB_SW_CACHE_VERSION\s*=\s*'([^']+)'/);
    const cacheVersion = versionMatch?.[1] ?? '';

    return {
        context,
        self,
        listeners,
        skipWaiting,
        claim,
        cacheStorage,
        cacheVersion,
        fetch: context.fetch,
    };
}

describe('service worker cache refresh and iOS clear flow (#380)', () => {
    test('sw.js activates immediately, deletes stale sillybunny-cache-* stores, and claims clients', async () => {
        const swProbe = createServiceWorkerSandbox();
        const currentStatic = `${swProbe.cacheVersion}-static`;
        const currentShell = `${swProbe.cacheVersion}-shell`;

        const sw = createServiceWorkerSandbox({
            initialCaches: {
                'sillybunny-cache-v20260603e-static': { 'https://sillybunny.local/css/old.css': createFakeResponse('old') },
                'sillybunny-cache-v20260603e-shell': { 'https://sillybunny.local/script.js': createFakeResponse('old-js') },
                [currentStatic]: { 'https://sillybunny.local/css/cur.css': createFakeResponse('cur') },
                [currentShell]: { 'https://sillybunny.local/': createFakeResponse('cur-html') },
                'unrelated-cache': { 'https://sillybunny.local/other': createFakeResponse('keep') },
            },
        });

        sw.listeners.get('install')({});
        expect(sw.skipWaiting).toHaveBeenCalledTimes(1);

        const waitPromises = [];
        sw.listeners.get('activate')({
            waitUntil: promise => waitPromises.push(promise),
        });
        await Promise.all(waitPromises);

        expect(sw.claim).toHaveBeenCalledTimes(1);
        expect([...sw.cacheStorage.stores.keys()].sort()).toEqual([
            currentShell,
            currentStatic,
            'unrelated-cache',
        ].sort());
    });

    test('sw.js handles SB_CLEAR_CACHES by deleting every sillybunny-cache-* store and replying done', async () => {
        const swProbe = createServiceWorkerSandbox();
        const currentStatic = `${swProbe.cacheVersion}-static`;
        const currentShell = `${swProbe.cacheVersion}-shell`;

        const sw = createServiceWorkerSandbox({
            initialCaches: {
                'sillybunny-cache-v20260603e-static': {},
                [currentStatic]: { 'https://sillybunny.local/css/app.css': createFakeResponse('css') },
                [currentShell]: { 'https://sillybunny.local/script.js': createFakeResponse('js') },
                'unrelated-cache': {},
            },
        });

        const reply = jest.fn();
        const waitPromises = [];
        const messageHandler = sw.listeners.get('message');
        expect(typeof messageHandler).toBe('function');

        messageHandler({
            data: { type: 'SB_CLEAR_CACHES' },
            ports: [{ postMessage: reply }],
            waitUntil: promise => waitPromises.push(promise),
        });
        await Promise.all(waitPromises);

        expect([...sw.cacheStorage.stores.keys()]).toEqual(['unrelated-cache']);
        expect(reply).toHaveBeenCalledWith({ type: 'SB_CLEAR_CACHES_DONE', ok: true });
    });

    test('sw.js serves JS and HTML network-first so updates override stale cached shell scripts', async () => {
        const swProbe = createServiceWorkerSandbox();
        const currentShell = `${swProbe.cacheVersion}-shell`;
        const scriptUrl = 'https://sillybunny.local/script.js';
        let online = true;

        const sw = createServiceWorkerSandbox({
            initialCaches: {
                [currentShell]: { [scriptUrl]: createFakeResponse('stale-script') },
            },
            fetchImpl: async () => {
                if (!online) {
                    throw new Error('offline');
                }
                return createFakeResponse('fresh-script');
            },
        });

        let firstResponse;
        sw.listeners.get('fetch')({
            request: { method: 'GET', url: scriptUrl },
            respondWith: promise => { firstResponse = promise; },
        });
        expect((await firstResponse).body).toBe('fresh-script');

        // When offline, falls back to the newly updated shell cache entry.
        online = false;
        let offlineResponse;
        sw.listeners.get('fetch')({
            request: { method: 'GET', url: scriptUrl },
            respondWith: promise => { offlineResponse = promise; },
        });
        expect((await offlineResponse).body).toBe('fresh-script');
    });

    test('script.js startup registers the matching sw.js version with updateViaCache none and triggers update()', async () => {
        const swSource = readFileSync(swPath, 'utf8');
        const versionMatch = swSource.match(/const\s+SB_SW_CACHE_VERSION\s*=\s*'sillybunny-cache-v([^']+)'/);
        expect(versionMatch).not.toBeNull();
        const expectedSwVersion = versionMatch[1];

        const update = jest.fn(async () => {});
        const register = jest.fn(async () => ({ update }));

        defineRestorable(window, 'isSecureContext', true);
        defineRestorable(navigator, 'serviceWorker', { register });
        defineRestorable(document, 'readyState', 'complete');

        loaded = await importScriptModule();
        await loaded.runReady();
        await new Promise(resolve => setTimeout(resolve, 25));

        expect(register).toHaveBeenCalledWith(
            `/sw.js?v=${expectedSwVersion}`,
            { updateViaCache: 'none' },
        );
        expect(update).toHaveBeenCalledTimes(1);
    });

    test('clearFrontendCache purges caches, messages the controlling service worker, and unregisters every service worker registration', async () => {
        const cacheStorage = createFakeCacheStorage({
            'sillybunny-cache-v20260603e-static': {},
            'sillybunny-cache-v20260622g-shell': {},
        });
        const unregisterA = jest.fn(async () => true);
        const unregisterB = jest.fn(async () => true);
        const getRegistrations = jest.fn(async () => [
            { unregister: unregisterA },
            { unregister: unregisterB },
        ]);
        const controllerMessages = [];
        const controller = {
            postMessage: jest.fn((message, [port]) => {
                controllerMessages.push(message);
                if (message?.type === 'SB_CLEAR_CACHES' && port) {
                    port.postMessage({ type: 'SB_CLEAR_CACHES_DONE', ok: true });
                }
            }),
        };

        class FakeMessageChannel {
            constructor() {
                this.port1 = { onmessage: null };
                this.port2 = {
                    postMessage: data => {
                        this.port1.onmessage?.({ data });
                    },
                };
            }
        }

        const droppedStores = [];
        const confirmSpy = jest.fn(async () => 1);
        const sessionStorageClear = jest.spyOn(Storage.prototype, 'clear');

        defineRestorable(window, 'caches', cacheStorage.api);
        defineRestorable(navigator, 'serviceWorker', { controller, getRegistrations });
        defineRestorable(window, 'MessageChannel', FakeMessageChannel);

        loaded = await importScriptModule({
            mocks: {
                'lib.js': base => ({
                    ...base,
                    localforage: {
                        ...base.localforage,
                        dropInstance: jest.fn(async ({ name }) => {
                            droppedStores.push(name);
                        }),
                    },
                }),
                'scripts/popup.js': base => ({
                    ...base,
                    Popup: Object.assign(base.Popup, {
                        show: {
                            ...base.Popup.show,
                            confirm: confirmSpy,
                        },
                    }),
                }),
            },
        });

        const cleared = await loaded.script.clearFrontendCache({ skipConfirmation: false, saveBeforeClear: false });

        expect(cleared).toBe(true);
        expect(cacheStorage.stores.size).toBe(0);
        expect(getRegistrations).toHaveBeenCalledTimes(1);
        expect(unregisterA).toHaveBeenCalledTimes(1);
        expect(unregisterB).toHaveBeenCalledTimes(1);
        expect(controllerMessages).toContainEqual({ type: 'SB_CLEAR_CACHES' });
        expect(confirmSpy).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringMatching(/service worker/i),
            expect.any(Object),
        );
        expect(droppedStores).toEqual([
            'SillyTavern_ChatCompletions',
            'SillyTavern_Prompts',
            'SillyTavern_Thumbnails',
            'SillyTavern_TextCompletions',
        ]);
        expect(sessionStorageClear).toHaveBeenCalledTimes(1);
    });
});
