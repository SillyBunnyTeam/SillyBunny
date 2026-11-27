/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { importExtensionsModule } from './util/extensions-module-harness.js';

function createDiscoveryFetch(entries, localePayloads = {}) {
    return jest.fn(async (url) => {
        const text = String(url);
        if (text.endsWith('/api/extensions/discover')) {
            return {
                ok: true,
                json: async () => entries.map(({ name, type = 'system' }) => ({ name, type })),
            };
        }
        for (const entry of entries) {
            if (text.includes(`/scripts/extensions/${entry.name}/manifest.json`)) {
                return {
                    ok: true,
                    json: async () => ({
                        display_name: entry.name,
                        loading_order: 100,
                        requires: [],
                        optional: [],
                        ...entry.manifest,
                    }),
                };
            }
            if (entry.manifest?.i18n) {
                for (const localeFile of Object.values(entry.manifest.i18n)) {
                    if (text.includes(`/scripts/extensions/${entry.name}/${localeFile}`)) {
                        return {
                            ok: true,
                            json: async () => localePayloads[entry.name] ?? { hello: 'world' },
                        };
                    }
                }
            }
        }
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    });
}

function autoCompleteInjectedScripts(onScript) {
    const originalAppend = document.body.appendChild.bind(document.body);
    return jest.spyOn(document.body, 'appendChild').mockImplementation((node) => {
        const appended = originalAppend(node);
        if (node?.tagName === 'SCRIPT') {
            onScript?.(node);
            queueMicrotask(() => node.onload?.());
        }
        return appended;
    });
}

beforeEach(() => {
    document.body.innerHTML = '<div id="extensions_details"></div>';
    Object.defineProperty(globalThis.navigator, 'connection', { value: {}, configurable: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('extension boot lifecycle behaviour', () => {
    test('deduplicates third-party and core manifests with the same normalized boot id', async () => {
        const fetchMock = createDiscoveryFetch([
            { name: 'third-party/My-Ext', type: 'local', manifest: { display_name: 'External Copy', generate_interceptor: 'ext_fn' } },
            { name: 'my-ext', type: 'core', manifest: { display_name: 'Core Copy', generate_interceptor: 'core_fn' } },
        ]);
        const { extensions } = await importExtensionsModule({ fetch: fetchMock });

        await extensions.loadExtensionSettings({
            extension_settings: { lockedExtensionsUnlockApplied: true, disabledExtensions: [] },
        }, false, false);

        expect(extensions.findExtension('my-ext')).toEqual({ name: 'third-party/My-Ext', enabled: true });
        expect(extensions.findExtension('THIRD-PARTY/MY-EXT')).toEqual({ name: 'third-party/My-Ext', enabled: true });
        expect(extensions.getExtensionManifest('my-ext').display_name).toBe('External Copy');
    });

    test('activates extensions in loading_order and waits for declared dependencies before activating dependents', async () => {
        const activationOrder = [];
        const fetchMock = createDiscoveryFetch([
            { name: 'dependent', type: 'system', manifest: { loading_order: 20, dependencies: ['base-dep'], js: 'index.js' } },
            { name: 'base-dep', type: 'system', manifest: { loading_order: 5, js: 'index.js' } },
            { name: 'early', type: 'system', manifest: { loading_order: 1, js: 'index.js' } },
        ]);

        let releaseBase;
        const baseReady = new Promise(resolve => { releaseBase = resolve; });
        const originalAppend = document.body.appendChild.bind(document.body);
        jest.spyOn(document.body, 'appendChild').mockImplementation((node) => {
            const appended = originalAppend(node);
            if (node?.tagName === 'SCRIPT') {
                const src = node.getAttribute('src');
                activationOrder.push(src);
                if (src.includes('/base-dep/')) {
                    baseReady.then(() => node.onload?.());
                } else {
                    queueMicrotask(() => node.onload?.());
                }
            }
            return appended;
        });

        const { extensions } = await importExtensionsModule({ fetch: fetchMock });
        const loading = extensions.loadExtensionSettings({
            extension_settings: { lockedExtensionsUnlockApplied: true, disabledExtensions: [] },
        }, false, false);

        for (let i = 0; i < 15; i++) await Promise.resolve();
        // Dependent extension must wait until base-dep finishes loading.
        expect(activationOrder).toContain('/scripts/extensions/early/index.js');
        expect(activationOrder).toContain('/scripts/extensions/base-dep/index.js');
        expect(activationOrder).not.toContain('/scripts/extensions/dependent/index.js');

        releaseBase();
        await loading;
        expect(activationOrder.at(-1)).toBe('/scripts/extensions/dependent/index.js');
    });

    test('loads extension scripts with query-free module URLs while CSS, locale and non-script prefetches carry a version query', async () => {
        const scripts = [];
        const idleCallbacks = [];
        window.requestIdleCallback = jest.fn(cb => idleCallbacks.push(cb));
        autoCompleteInjectedScripts(node => scripts.push(node.getAttribute('src')));
        const fetchMock = createDiscoveryFetch([
            {
                name: 'sample',
                type: 'system',
                manifest: {
                    js: 'index.js',
                    css: 'style.css',
                    i18n: { en: 'locales/en.json' },
                },
            },
        ]);

        const { extensions, mocks } = await importExtensionsModule({
            fetch: fetchMock,
            clientVersion: 'SillyBunny:v2.4.0',
            locale: 'en',
        });

        try {
            await extensions.loadExtensionSettings({
                extension_settings: { lockedExtensionsUnlockApplied: true, disabledExtensions: [] },
            }, false, false);

            // Module scripts have no query string so static imports and entry scripts share one module graph entry.
            expect(scripts).toEqual(['/scripts/extensions/sample/index.js']);

            // CSS and locale assets include the version query.
            expect(mocks.dynamicStyles.loadStylesheetAsync).toHaveBeenCalledWith(
                expect.stringMatching(/^\/scripts\/extensions\/sample\/style\.css\?v=/),
                expect.objectContaining({ id: 'sample-css' }),
            );
            const localeFetchUrl = fetchMock.mock.calls.map(([url]) => String(url)).find(url => url.includes('locales/en.json'));
            expect(localeFetchUrl).toMatch(/^\/scripts\/extensions\/sample\/locales\/en\.json\?v=/);
            expect(mocks.i18n.addLocaleData).toHaveBeenCalledWith('en', { hello: 'world' });

            // Idle prefetch hints scripts by bare module URL and stylesheets by versioned asset URL.
            idleCallbacks.forEach(cb => cb());
            const scriptHints = mocks.dynamicStyles.prefetchAsset.mock.calls.filter(([, opts]) => opts?.as === 'script');
            const styleHints = mocks.dynamicStyles.prefetchAsset.mock.calls.filter(([, opts]) => opts?.as === 'style');
            expect(scriptHints.length).toBeGreaterThan(0);
            expect(styleHints.length).toBeGreaterThan(0);
            for (const [url] of scriptHints) {
                expect(url).toBe('/scripts/extensions/sample/index.js');
                expect(url).not.toContain('?');
            }
            for (const [url] of styleHints) {
                expect(url).toMatch(/^\/scripts\/extensions\/sample\/style\.css\?v=/);
            }
        } finally {
            delete window.requestIdleCallback;
        }
    });

    test('warns and marks extension errors for missing modules, disabled dependencies, missing dependencies and unsupported client versions', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const scripts = [];
        autoCompleteInjectedScripts(node => scripts.push(node.getAttribute('src')));

        const fetchMock = createDiscoveryFetch([
            { name: 'disabled-dep', type: 'system', manifest: { js: 'index.js' } },
            { name: 'needs-module', type: 'system', manifest: { display_name: 'Needs Module', requires: ['caption'], js: 'index.js' } },
            { name: 'needs-disabled', type: 'system', manifest: { display_name: 'Needs Disabled', dependencies: ['disabled-dep'], js: 'index.js' } },
            { name: 'needs-missing', type: 'system', manifest: { display_name: 'Needs Missing', dependencies: ['ghost-ext'], js: 'index.js' } },
            { name: 'needs-newer', type: 'system', manifest: { display_name: 'Needs Newer', minimum_client_version: '99.0.0', js: 'index.js' } },
        ]);

        const { extensions } = await importExtensionsModule({
            fetch: fetchMock,
            clientVersion: 'SillyBunny:v1.9.0-dev',
        });

        await extensions.loadExtensionSettings({
            extension_settings: {
                lockedExtensionsUnlockApplied: true,
                disabledExtensions: ['disabled-dep'],
            },
        }, false, false);

        expect(scripts).toEqual([]);
        expect(document.getElementById('extensions_details').classList.contains('warning')).toBe(true);
        const warnings = warn.mock.calls.map(([msg]) => String(msg));
        expect(warnings.some(msg => msg.includes('Missing required Extras module(s): "caption"'))).toBe(true);
        expect(warnings.some(msg => msg.includes('Required extensions exist but are disabled: "disabled-dep"'))).toBe(true);
        expect(warnings.some(msg => msg.includes('Missing required extensions: "ghost-ext"'))).toBe(true);
        expect(warnings.some(msg => msg.includes('Requires ST client version 99.0.0'))).toBe(true);
    });
});
