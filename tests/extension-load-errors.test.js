/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { createExtensionScriptLoadError, formatExtensionLoadError } from '../public/scripts/extension-load-errors.js';
import { importExtensionsModule } from './util/extensions-module-harness.js';

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('extension load error diagnostics', () => {
    test('wraps script load events with extension and script details', () => {
        const event = { type: 'error', target: { src: 'https://example.test/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1' } };
        const error = createExtensionScriptLoadError('third-party/Extension-WebSearch', '/fallback.js', event);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Could not load extension script for "third-party/Extension-WebSearch": https://example.test/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1');
        expect(error.cause).toBe(event);
        expect(error.extensionName).toBe('third-party/Extension-WebSearch');
        expect(error.extensionScriptUrl).toBe('https://example.test/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1');
    });

    test('formats raw browser events without object Object output', () => {
        expect(formatExtensionLoadError({ type: 'error', target: { src: '/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1' } }))
            .toBe('Load failed for /scripts/extensions/third-party/Extension-WebSearch/index.js?v=1');

        expect(formatExtensionLoadError({ type: 'error' })).toBe('Load failed (error)');
    });

    test('preserves useful error and object messages', () => {
        expect(formatExtensionLoadError(new Error('Extension context is not available yet.'))).toBe('Extension context is not available yet.');
        expect(formatExtensionLoadError({ message: 'WebSearch failed during module evaluation' })).toBe('WebSearch failed during module evaluation');
        expect(formatExtensionLoadError({ reason: new Error('SillyTavern.getContext is not ready') })).toBe('SillyTavern.getContext is not ready');
        expect(formatExtensionLoadError({ code: 'ERR_WEBSEARCH', extension: 'WebSearch' })).toBe('{"code":"ERR_WEBSEARCH","extension":"WebSearch"}');
        expect(formatExtensionLoadError({})).toBe('Unknown extension load error');
    });

    test('formats real extension script load failures during activation without [object Object]', async () => {
        document.body.innerHTML = '<div id="extensions_details"></div>';
        Object.defineProperty(globalThis.navigator, 'connection', { value: {}, configurable: true });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const originalAppend = document.body.appendChild.bind(document.body);
        jest.spyOn(document.body, 'appendChild').mockImplementation((node) => {
            const appended = originalAppend(node);
            if (node?.tagName === 'SCRIPT') {
                queueMicrotask(() => {
                    node.onerror?.({ type: 'error', target: { src: node.getAttribute('src') } });
                });
            }
            return appended;
        });

        const fetchMock = jest.fn(async (url) => {
            const text = String(url);
            if (text.endsWith('/api/extensions/discover')) {
                return { ok: true, json: async () => [{ name: 'third-party/Broken-Ext', type: 'local' }] };
            }
            if (text.includes('/scripts/extensions/third-party/Broken-Ext/manifest.json')) {
                return {
                    ok: true,
                    json: async () => ({
                        display_name: 'Broken Ext',
                        loading_order: 100,
                        js: 'index.js',
                    }),
                };
            }
            return { ok: false, json: async () => ({}) };
        });

        const { extensions } = await importExtensionsModule({ fetch: fetchMock });
        await extensions.loadExtensionSettings({
            extension_settings: { lockedExtensionsUnlockApplied: true, disabledExtensions: [] },
        }, false, false);

        expect(document.getElementById('extensions_details').classList.contains('warning')).toBe(true);
        expect(errorSpy).toHaveBeenCalledWith(
            'Could not activate extension',
            'third-party/Broken-Ext',
            'Could not load extension script for "third-party/Broken-Ext": /scripts/extensions/third-party/Broken-Ext/index.js',
            expect.objectContaining({
                extensionName: 'third-party/Broken-Ext',
                extensionScriptUrl: '/scripts/extensions/third-party/Broken-Ext/index.js',
            }),
        );
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('[object Object]');
    });
});
