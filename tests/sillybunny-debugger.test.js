/* global globalThis */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, jest, test } from '@jest/globals';

import {
    createRing,
    disableCapture,
    getRequests,
    installCapture,
    makeEntry,
    redactSensitiveText,
    sanitizeMethod,
    sanitizeUrl,
    serializeArg,
} from '../public/scripts/extensions/sillybunny-debugger/src/capture.js';
import { buildReport } from '../public/scripts/extensions/sillybunny-debugger/src/report.js';
import { destroyEruda, getEnabledThirdPartyExtensions, openDebugger, setActive } from '../public/scripts/extensions/sillybunny-debugger/src/ui.js';

const extensionRoot = new URL('../public/scripts/extensions/sillybunny-debugger/', import.meta.url);

describe('SillyBunny Debugger', () => {
    test('bounds capture without inspecting application objects', () => {
        const ring = createRing(3);
        for (let value = 1; value <= 5; value += 1) ring.push(value);

        let accesses = 0;
        const object = {
            get secret() {
                accesses += 1;
                return 'secret';
            },
        };

        expect(ring.entries()).toEqual([3, 4, 5]);
        expect(serializeArg(object)).toBe('[object]');
        expect(accesses).toBe(0);
    });

    test('redacts failed request credentials, query values, and fragments', () => {
        expect(sanitizeUrl('https://alice:secret@example.com/api/run?token=abc#private'))
            .toBe('https://example.com/[redacted]?[redacted]');
        expect(sanitizeUrl('/api/run?token=abc#private')).toBe('/[redacted]?[redacted]');
        expect(sanitizeUrl('/api/token=path-secret')).toBe('/[redacted]');
        expect(sanitizeUrl('/api/x;api_key=path-secret')).toBe('/[redacted]');
        expect(sanitizeUrl('https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789'))
            .toBe('https://example.com/[redacted]');
        expect(sanitizeUrl('https://api.telegram.org/bot123456789:AAExampleTelegramTokenLengthThirtyFive/sendMessage'))
            .toBe('https://api.telegram.org/[redacted]');
        expect(sanitizeUrl('credential-marker-741://private/path')).toBe('[unsupported URL]');
    });

    test('allows only fixed HTTP methods in request metadata', () => {
        expect(sanitizeMethod('post')).toBe('POST');
        expect(sanitizeMethod('PRIVATE_METHOD_SECRET_741')).toBe('OTHER');
        expect(sanitizeMethod({ private: 'method-object-secret', toString: () => 'PATCH' })).toBe('PATCH');
    });

    test('redacts credentials and structured payloads from captured console text', () => {
        const credentialText = redactSensitiveText(
            'Authorization: Bearer test-secret-741\nX-Api-Token: header-secret-741; '
            + 'at https://alice:password@example.com/run?token=query-secret',
        );
        const payloadText = redactSensitiveText('{"prompt":"private prompt","api_key":"sk-private-key-741"}');
        const plainPayloadText = redactSensitiveText('prompt: private prompt text');
        const longPayloadText = redactSensitiveText(`{"prompt":"${'private'.repeat(500)}"}`);
        const authorizationText = redactSensitiveText(
            'Authorization: Digest username=alice, response=digest-secret\n'
            + 'Authorization: "Bearer quoted-secret"',
        );
        const multilinePayloadText = redactSensitiveText('prompt: first line\nsecond-private-line');
        const protocolRelativeText = redactSensitiveText(
            'failed at //alice:password@example.com/private/path?token=query-secret',
        );

        expect(credentialText).toBe('[text redacted]');
        expect(credentialText).not.toContain('test-secret-741');
        expect(credentialText).not.toContain('header-secret-741');
        expect(credentialText).not.toContain('password');
        expect(credentialText).not.toContain('query-secret');
        expect(payloadText).toBe('[structured data redacted]');
        expect(plainPayloadText).toBe('[text redacted]');
        expect(longPayloadText).toBe('[structured data redacted]');
        expect(authorizationText).not.toContain('digest-secret');
        expect(authorizationText).not.toContain('quoted-secret');
        expect(authorizationText).toBe('[text redacted]');
        expect(multilinePayloadText).toBe('[text redacted]');
        expect(protocolRelativeText).toBe('[text redacted]');
    });

    test('redacts sensitive values split across console arguments', () => {
        const promptEntry = makeEntry('error', ['prompt:', 'private chat content'], 0);
        const authorizationEntry = makeEntry('error', ['Authorization: Bearer %s', 'provider-secret'], 0);

        expect(promptEntry.text).toBe('[text redacted] [text redacted]');
        expect(authorizationEntry.text).toBe('[text redacted] [text redacted]');
    });

    test('keeps useful Error details while redacting messages and stacks', () => {
        const error = new Error('request failed with Bearer test-secret-741');
        error.stack = 'Error: request failed with Bearer test-secret-741\n'
            + '    at https://example.com/run?token=query-secret:1:1';
        const entry = makeEntry('error', [error], 0, error.stack);
        const structuredError = new Error('{"content":"private chat"}');

        expect(serializeArg(error)).toBe('Error: [message redacted]');
        expect(entry.text).toBe('Error: [message redacted]');
        expect(entry.stack).toContain('https://example.com/[redacted]?[redacted]');
        expect(entry.stack).not.toContain('test-secret-741');
        expect(entry.stack).not.toContain('query-secret');
        expect(serializeArg(structuredError)).toBe('Error: [message redacted]');
    });

    test('allows only fixed Error classes in reports', () => {
        const typeError = new TypeError('private type error');
        const customError = new Error('private custom error');
        customError.name = 'ApiKeySecret741';

        expect(serializeArg(typeError)).toBe('TypeError: [message redacted]');
        expect(serializeArg(customError)).toBe('Error: [message redacted]');
        expect(serializeArg(customError)).not.toContain('ApiKeySecret741');
    });

    test('preserves the first location in headerless WebKit stacks', () => {
        const entry = makeEntry(
            'error',
            [new Error('private error')],
            0,
            'captureFailure@https://example.com/private/first.js?token=first-secret:10:2\n'
                + 'dispatch@https://example.com/private/second.js?token=second-secret:20:4',
        );

        expect(entry.stack).toBe(
            '    at https://example.com/[redacted]?[redacted]\n'
            + '    at https://example.com/[redacted]?[redacted]',
        );
        expect(entry.stack).not.toContain('first-secret');
        expect(entry.stack).not.toContain('second-secret');
    });

    test('omits oversized stack positions', () => {
        const entry = makeEntry(
            'error',
            [new Error('private error')],
            0,
            'Error: private error\n'
                + '    at https://example.com/private/source.js:12345678901234567890:98765432109876543210',
        );

        expect(entry.stack).toBe('    at https://example.com/[redacted]');
        expect(entry.stack).not.toContain('12345678901234567890');
        expect(entry.stack).not.toContain('98765432109876543210');
    });

    test('does not treat numeric URL suffixes as shareable stack positions', () => {
        const entry = makeEntry(
            'error',
            [new Error('private error')],
            0,
            'Error: private error\n    at https://example.com/private/token:123:456',
        );

        expect(entry.stack).toBe('    at https://example.com/[redacted]');
        expect(entry.stack).not.toContain('123:456');
    });

    test('sanitizes Fetch URLs before asynchronous callbacks retain them', async () => {
        const originalWindow = globalThis.window;
        const originalXhr = globalThis.XMLHttpRequest;
        let resolveFetch;
        let urlReads = 0;
        const mutableRequest = {
            method: 'POST',
            get url() {
                urlReads += 1;
                if (urlReads > 1) {
                    throw new Error('URL should have been read and sanitized before fetch resolved');
                }
                return 'https://alice:secret@example.com/api/run?token=abc#private';
            },
        };
        const fakeWindow = {
            addEventListener: () => {},
            removeEventListener: () => {},
            fetch: jest.fn(() => new Promise((resolve) => {
                resolveFetch = resolve;
            })),
        };
        class FakeXHR {
            open() {}
            send() {}
        }

        globalThis.window = fakeWindow;
        globalThis.XMLHttpRequest = FakeXHR;
        try {
            installCapture();
            const pending = fakeWindow.fetch(mutableRequest);
            // URL getter ran synchronously before the async continuation existed.
            expect(urlReads).toBe(1);

            resolveFetch({ status: 500 });
            await pending;

            expect(getRequests()).toEqual([
                expect.objectContaining({
                    method: 'POST',
                    url: 'https://example.com/[redacted]?[redacted]',
                    status: 500,
                }),
            ]);
        } finally {
            disableCapture();
            if (originalWindow === undefined) delete globalThis.window;
            else globalThis.window = originalWindow;
            if (originalXhr === undefined) delete globalThis.XMLHttpRequest;
            else globalThis.XMLHttpRequest = originalXhr;
        }
    });

    test('reports only useful events and remain bounded', () => {
        const entries = [
            { ts: 0, kind: 'log', text: 'ordinary log' },
            ...Array.from({ length: 300 }, (_, index) => ({
                ts: index,
                kind: 'error',
                text: `error ${index} ${'x'.repeat(400)}`,
            })),
        ];
        const report = buildReport({ entries, counters: { total: entries.length } });

        expect(report).not.toContain('ordinary log');
        expect(report).toContain('error 299');
        expect(report.length).toBeLessThanOrEqual(15000);
    });

    test('reports normalized third-party extension states without listing its shadowed alias', () => {
        const enabled = getEnabledThirdPartyExtensions([
            'third-party/Enabled-Extension',
            'third-party/Disabled-Extension',
            'third-party/SillyBunny-Debugger',
            'vectors',
        ], [
            'DISABLED-EXTENSION',
            'sillybunny-debugger',
        ]);

        expect(enabled).toEqual(['third-party/Enabled-Extension']);
    });

    test('is a default-off lifecycle extension with the safe Eruda tool profile', async () => {
        const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));

        expect(manifest).toMatchObject({
            bundled_opt_in: true,
            requires: [],
            optional: [],
            hooks: { activate: 'init', enable: 'init', disable: 'deactivate' },
        });

        const originalDocument = globalThis.document;
        const consoleConfigSet = jest.fn();
        const elementsConfigSet = jest.fn();
        const fakeEruda = {
            sillyBunnyDebuggerBuild: 'eruda-3.4.3-chobitsu-1.8.6-sbdbg',
            _isInit: false,
            init: jest.fn(() => { fakeEruda._isInit = true; }),
            show: jest.fn(),
            destroy: jest.fn(() => { fakeEruda._isInit = false; }),
            get: jest.fn((tool) => {
                if (tool === 'console') return { config: { set: consoleConfigSet } };
                if (tool === 'elements') return { config: { set: elementsConfigSet } };
                return null;
            }),
        };

        const fakeDocument = {
            currentScript: null,
            createElement: () => ({ remove() {} }),
            body: {
                appendChild(script) {
                    fakeDocument.currentScript = script;
                    globalThis.__sillyBunnyDebuggerEruda = fakeEruda;
                    fakeDocument.currentScript = null;
                    return script;
                },
            },
        };

        globalThis.document = fakeDocument;
        try {
            setActive(true);
            await openDebugger();

            expect(fakeEruda.init).toHaveBeenCalledWith({ tool: ['console', 'elements', 'network', 'info'] });
            expect(consoleConfigSet).toHaveBeenCalledWith('maxLogNum', '250');
            expect(consoleConfigSet).toHaveBeenCalledWith('displayGetterVal', false);
            expect(elementsConfigSet).toHaveBeenCalledWith('overrideEventTarget', false);
            expect(fakeEruda.show).toHaveBeenCalledTimes(1);
        } finally {
            setActive(false);
            destroyEruda();
            if (originalDocument === undefined) delete globalThis.document;
            else globalThis.document = originalDocument;
        }
    });

    test('keeps the reviewed Eruda bundle and imports without browser globals', async () => {
        const bundle = await readFile(new URL('lib/eruda.js', extensionRoot));
        const hash = createHash('sha256').update(bundle).digest('hex');

        expect(hash).toBe('caff41e30297b7893be28c5365cc2e74152644becf91ebd9aaead454498bc00f');
        await expect(import('../public/scripts/extensions/sillybunny-debugger/index.js')).resolves.toBeDefined();
    });
});
