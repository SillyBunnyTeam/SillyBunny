/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    copyPerformanceReport,
    disable,
    getPerformanceDiagnosticsUrl,
    init,
    runPerformanceDiagnostics,
    measureScrollFps,
    sanitizeLocation,
    sanitizeUrlForReport,
    serializeDiagnosticValue,
    startPerformanceLogging,
    stopPerformanceLogging,
    summarizePerformanceResources,
} from '../public/scripts/extensions/performance-diagnostics/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('browser performance diagnostics helpers', () => {
    test('sanitizes location details without query values', () => {
        expect(sanitizeLocation({
            protocol: 'https:',
            pathname: '/chat',
            search: '?token=secret&performance-diagnostics=1',
            hash: '#performance-logging/debug/token=secret',
        })).toEqual({
            protocol: 'https:',
            queryParameterCount: 2,
        });
    });

    test('summarizes resource timing bytes by transfer and body sizes', () => {
        expect(summarizePerformanceResources([
            {
                name: 'https://example.test/script.js',
                transferSize: 0,
                encodedBodySize: 120,
                decodedBodySize: 240,
            },
            {
                name: 'https://example.test/style.css',
                transferSize: 30,
                encodedBodySize: 40,
                decodedBodySize: 80,
            },
        ])).toEqual({
            transfer: {
                count: 2,
                js: 0,
                css: 30,
                font: 0,
                image: 0,
                other: 0,
            },
            encoded: {
                count: 2,
                js: 120,
                css: 40,
                font: 0,
                image: 0,
                other: 0,
            },
            decoded: {
                count: 2,
                js: 240,
                css: 80,
                font: 0,
                image: 0,
                other: 0,
            },
            zeroTransferCount: 1,
            zeroTransferWithEncodedBodyCount: 1,
        });
    });

    test('sanitizes resource URLs without query values', () => {
        expect(sanitizeUrlForReport('https://example.test/script.js?token=secret&foo=bar')).toEqual({
            origin: 'cross-origin',
            protocol: 'https:',
            category: 'script',
            extension: 'js',
            queryParameterCount: 2,
        });
    });

    test('omits hosts, paths, fragments, and media identifiers from URL metadata', () => {
        const metadata = sanitizeUrlForReport(
            'https://private.example/users/alice/avatars/character-123.png?user=alice&cache=private#secret-fragment',
            'https://deployment.example/install/private/index.html',
            'img',
        );

        expect(metadata).toEqual({
            origin: 'cross-origin',
            protocol: 'https:',
            category: 'image',
            extension: 'png',
            queryParameterCount: 2,
        });
        expect(JSON.stringify(metadata)).not.toMatch(/private\.example|deployment\.example|alice|character-123|secret-fragment|\/users|\/install/);
    });

    test('serializes circular and long diagnostic values safely', () => {
        const value = {
            longText: 'x'.repeat(600),
        };
        value.self = value;

        const serialized = serializeDiagnosticValue(value);

        expect(serialized.longText).toHaveLength(503);
        expect(serialized.longText.endsWith('...')).toBe(true);
        expect(serialized.self).toBe('[circular]');

        const serializedError = serializeDiagnosticValue(new Error('token=secret'));
        expect(serializedError.message).toBe('token=[redacted]');

        expect(serializeDiagnosticValue({ access_token: 'secret', password: 'secret' })).toEqual({
            access_token: '[redacted]',
            password: '[redacted]',
        });
    });

    test('redacts adversarial headers, encoded secrets, URLs, private fields, and getter errors', () => {
        const value = {
            json: '{"api_key":"json-secret","client_secret":"client-secret","set_cookie":"json-cookie-secret","safe":true}',
            colon: 'password: colon secret value',
            basic: 'Authorization: Basic dXNlcjpwYXNz',
            bearer: 'Authorization: Bearer bearer-secret',
            cookies: 'Cookie: session=cookie-secret; theme=dark\nSet-Cookie: id=set-cookie-secret; HttpOnly',
            encoded: 'token%3Dencoded-secret%26secret%3Aencoded-colon-secret',
            embeddedUrl: 'failed at https://private.example/home/alice/media/avatar-123.png?name=alice&token=url-secret#hash-secret',
            encodedUrls: [
                'failed at https://private.example/User%20Avatars/Alice%20Smith%22Private.png',
                'failed at https%3A%2F%2Fprivate.example%2FUser%2520Avatars%2FAlice%2520Smith.png',
            ],
            network: 'connect private.internal.example:8443 from 10.0.0.1 using public/scripts/private.js',
            avatar: 'avatar-123.png',
            pathname: '/home/alice/SillyBunny/data/default-user',
        };
        Object.defineProperty(value, 'getterFailure', {
            enumerable: true,
            get() {
                throw new Error('Authorization: Bearer getter-secret at /home/alice/private.js');
            },
        });

        const serialized = serializeDiagnosticValue(value);
        const text = JSON.stringify(serialized);

        expect(text).not.toMatch(/json-secret|client-secret|json-cookie-secret|colon secret|dXNlcjpwYXNz|bearer-secret|cookie-secret|set-cookie-secret|encoded-secret|encoded-colon-secret|url-secret|getter-secret/);
        expect(text).not.toMatch(/private\.example|private\.internal\.example|10\.0\.0\.1|public\/scripts|\/home\/alice|avatar-123|hash-secret|Alice|Smith|Private/);
        expect(text).toContain('query-count(2)');
        expect(serialized.avatar).toBe('[redacted]');
        expect(serialized.pathname).toBe('[redacted]');
        expect(serialized.getterFailure).toContain('[unserializable:');
    });

    test('classifies extensionless resources by initiator type', () => {
        const summary = summarizePerformanceResources([
            { name: 'https://example.test/script', initiatorType: 'script', transferSize: 10, encodedBodySize: 10, decodedBodySize: 10 },
            { name: 'https://example.test/style', initiatorType: 'link', transferSize: 20, encodedBodySize: 20, decodedBodySize: 20 },
            { name: 'https://example.test/avatar', initiatorType: 'img', transferSize: 30, encodedBodySize: 30, decodedBodySize: 30 },
            { name: 'https://example.test/font', initiatorType: 'font', transferSize: 40, encodedBodySize: 40, decodedBodySize: 40 },
        ]);

        expect(summary.transfer).toEqual({
            count: 4,
            js: 10,
            css: 20,
            font: 40,
            image: 30,
            other: 0,
        });
    });

    test('creates a diagnostics URL without dropping existing params', () => {
        expect(getPerformanceDiagnosticsUrl('https://example.test/?foo=1#section'))
            .toBe('https://example.test/?foo=1&performance-diagnostics=1#section');
    });

    test('base startup files do not load diagnostics directly', () => {
        const script = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
        const index = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
        const powerUser = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'power-user.js'), 'utf8');

        expect(script).not.toContain('performance-diagnostics');
        expect(script).not.toContain('SillyBunnyPerformanceDiagnostics');
        expect(index).not.toContain('performance-diagnostics');
        expect(index).not.toContain('performance.setResourceTimingBufferSize?.(2000)');
        expect(powerUser).not.toContain('performance-diagnostics');
    });

    test('diagnostics are packaged as a toggleable built-in extension', () => {
        const extensionRoot = path.join(repoRoot, 'public', 'scripts', 'extensions', 'performance-diagnostics');
        const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
        const script = fs.readFileSync(path.join(extensionRoot, 'index.js'), 'utf8');

        expect(manifest).toEqual(expect.objectContaining({
            js: 'index.js',
            css: 'style.css',
            bundled_opt_in: true,
            hooks: expect.objectContaining({
                activate: 'init',
                disable: 'disable',
            }),
        }));
        expect(script).toContain('export function init()');
        expect(script).toContain('export function disable()');
        expect(script).toContain('SillyBunnyPerformanceDiagnostics');
        expect(JSON.stringify(manifest)).not.toContain('lorum ipsum');
        expect(script).not.toContain('lorum ipsum');
    });
});

function installDiagnosticsBrowserHarness() {
    const globalNames = [
        'HTMLElement',
        'PerformanceObserver',
        'SillyBunnyPerformanceDiagnostics',
        'SillyTavern',
        'cancelAnimationFrame',
        'document',
        'location',
        'matchMedia',
        'navigator',
        'performance',
        'requestAnimationFrame',
        'screen',
        'visualViewport',
        'window',
    ];
    const originalDescriptors = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const setGlobal = (name, value) => Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
    });
    const elementsById = new Map();
    const createdElements = [];

    function createElement(tagName) {
        const controls = new Map();
        const children = [];
        const element = {
            tagName: String(tagName).toUpperCase(),
            style: {},
            value: '',
            textContent: '',
            checked: false,
            removed: false,
            controls,
            addEventListener: jest.fn(),
            appendChild(child) {
                children.push(child);
                if (child.id) {
                    elementsById.set(child.id, child);
                }
                return child;
            },
            click: jest.fn(),
            querySelector(selector) {
                if (!controls.has(selector)) {
                    controls.set(selector, createElement('button'));
                }
                return controls.get(selector);
            },
            querySelectorAll: jest.fn(() => []),
            remove() {
                this.removed = true;
                if (this.id) {
                    elementsById.delete(this.id);
                }
            },
            select: jest.fn(),
            setAttribute: jest.fn(),
        };
        createdElements.push(element);
        return element;
    }

    const body = createElement('body');
    const documentTarget = {
        body,
        scrollingElement: null,
        visibilityState: 'visible',
        addEventListener: jest.fn(),
        createElement: jest.fn(createElement),
        execCommand: jest.fn(() => true),
        getElementById: jest.fn(id => elementsById.get(id) ?? null),
        removeEventListener: jest.fn(),
    };
    const windowTarget = {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };
    const location = {
        href: 'https://deployment.example/home/alice/SillyBunny/?existing=private#private-fragment',
        origin: 'https://deployment.example',
        protocol: 'https:',
        pathname: '/home/alice/SillyBunny/',
        search: '',
        hash: '',
    };
    const resources = [];
    let now = 0;
    const HTMLElementClass = class HTMLElement {};
    const cancelAnimationFrame = jest.fn();
    const requestAnimationFrame = jest.fn(() => 1);

    setGlobal('HTMLElement', HTMLElementClass);
    setGlobal('PerformanceObserver', undefined);
    setGlobal('SillyBunnyPerformanceDiagnostics', undefined);
    setGlobal('SillyTavern', undefined);
    setGlobal('cancelAnimationFrame', cancelAnimationFrame);
    setGlobal('document', documentTarget);
    setGlobal('location', location);
    setGlobal('matchMedia', jest.fn(() => ({ matches: false })));
    setGlobal('navigator', {
        connection: null,
        hardwareConcurrency: 8,
        languages: ['en'],
        maxTouchPoints: 0,
        platform: 'test',
        userAgent: 'test-agent',
    });
    setGlobal('performance', {
        getEntriesByType: jest.fn(type => type === 'resource' ? resources : []),
        now: jest.fn(() => ++now),
        setResourceTimingBufferSize: jest.fn(),
    });
    setGlobal('requestAnimationFrame', requestAnimationFrame);
    setGlobal('screen', { width: 1000, height: 800, availWidth: 1000, availHeight: 800 });
    setGlobal('visualViewport', null);
    setGlobal('window', windowTarget);

    return {
        createdElements,
        document: documentTarget,
        location,
        resources,
        cancelAnimationFrame,
        requestAnimationFrame,
        getElement: id => elementsById.get(id),
        makeAppReady() {
            const chatElement = Object.assign(new HTMLElementClass(), createElement('div'), {
                clientHeight: 800,
                scrollHeight: 1600,
                scrollTop: 0,
            });
            elementsById.set('chat', chatElement);
            globalThis.SillyTavern = {
                getContext: () => ({
                    chat: [],
                    messageFormatting: value => value,
                }),
            };
        },
        restore() {
            for (const [name, descriptor] of originalDescriptors) {
                if (descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    delete globalThis[name];
                }
            }
        },
    };
}

describe('performance diagnostics lifecycle', () => {
    let browser;

    beforeEach(() => {
        browser = installDiagnosticsBrowserHarness();
    });

    afterEach(() => {
        disable();
        browser.restore();
    });

    test('keeps manual logging and self-tests mutually exclusive', async () => {
        init();

        expect(startPerformanceLogging({ showPanel: false })).not.toBeNull();
        const blockedRun = await runPerformanceDiagnostics({ showPanel: false });
        expect(blockedRun.error).toEqual({
            name: 'InvalidStateError',
            message: 'performance-logging-active',
        });
        expect(stopPerformanceLogging({ showPanel: false })).not.toBeNull();

        const pendingRun = runPerformanceDiagnostics({ showPanel: false });
        expect(startPerformanceLogging({ showPanel: false })).toBeNull();
        disable();
        await expect(pendingRun).resolves.toEqual(expect.objectContaining({
            error: expect.objectContaining({ name: 'AbortError' }),
        }));
    });

    test('settles an app-ready wait promptly when disabled', async () => {
        init();
        const pendingRun = runPerformanceDiagnostics({ showPanel: false, timeoutMs: 60000 });

        disable();
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostics did not settle')), 100));
        await expect(Promise.race([pendingRun, timeout])).resolves.toEqual(expect.objectContaining({
            error: expect.objectContaining({ name: 'AbortError' }),
        }));
    });

    test('cancels pending animation-frame measurements when disabled', async () => {
        browser.makeAppReady();
        init();
        const pendingRun = runPerformanceDiagnostics({ showPanel: false });
        await Promise.resolve();
        await Promise.resolve();

        expect(browser.requestAnimationFrame).toHaveBeenCalled();
        disable();
        await expect(pendingRun).resolves.toEqual(expect.objectContaining({
            error: expect.objectContaining({ name: 'AbortError' }),
        }));
        expect(browser.cancelAnimationFrame).toHaveBeenCalledWith(1);
    });

    test('measures real scroll movement away from the nearest boundary', async () => {
        browser.makeAppReady();
        const chat = browser.getElement('chat');
        chat.scrollTop = 800;
        let frameTime = 0;
        globalThis.requestAnimationFrame = callback => {
            frameTime += 500;
            callback(frameTime);
            return frameTime;
        };

        const result = await measureScrollFps({ durationMs: 900 });

        expect(result).toEqual(expect.objectContaining({
            available: true,
            direction: 'up',
            scrollRange: 800,
            startScrollTop: 800,
            endScrollTop: 752,
            movedPixels: 48,
        }));
        expect(chat.scrollTop).toBe(800);
    });

    test('does not report FPS for a non-scrollable chat', async () => {
        browser.makeAppReady();
        const chat = browser.getElement('chat');
        chat.scrollHeight = chat.clientHeight;

        await expect(measureScrollFps()).resolves.toEqual({
            available: false,
            reason: 'not-scrollable',
            scrollRange: 0,
            movedPixels: 0,
        });
    });

    test('does not let a stale run clear a newer run owner', async () => {
        init();
        const staleRun = runPerformanceDiagnostics({ showPanel: false });
        disable();

        init();
        const currentRun = runPerformanceDiagnostics({ showPanel: false });
        await staleRun;

        expect(startPerformanceLogging({ showPanel: false })).toBeNull();
        disable();
        await expect(currentRun).resolves.toEqual(expect.objectContaining({
            error: expect.objectContaining({ name: 'AbortError' }),
        }));
    });

    test('initializes once and gives self-test priority to combined URL triggers', async () => {
        browser.location.search = '?performance-diagnostics=1&performance-logging=1';
        init();
        init();

        const root = browser.getElement('sb-performance-diagnostics-extension');
        expect(root.controls.get('[data-sb-performance-diagnostics-run]').addEventListener).toHaveBeenCalledTimes(1);
        expect(startPerformanceLogging({ showPanel: false })).toBeNull();

        disable();
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    test('omits private resource and deployment details from a complete report', () => {
        browser.resources.push({
            name: 'https://media.private.example/users/alice/avatar-123.png?user=alice&token=resource-secret#hash-secret',
            entryType: 'resource',
            initiatorType: 'img',
            startTime: 1,
            duration: 2,
            transferSize: 30,
            encodedBodySize: 20,
            decodedBodySize: 40,
        });
        init();
        startPerformanceLogging({ showPanel: false });

        const report = stopPerformanceLogging({ showPanel: false });
        const text = JSON.stringify(report);

        expect(report.schemaVersion).toBe(2);
        expect(report.snapshots.final.resources.largest[0].url).toEqual({
            origin: 'cross-origin',
            protocol: 'https:',
            category: 'image',
            extension: 'png',
            queryParameterCount: 2,
        });
        expect(text).not.toMatch(/media\.private\.example|deployment\.example|alice|avatar-123|resource-secret|hash-secret|SillyBunny/);
    });

    test('copies reports without the Clipboard API', async () => {
        await copyPerformanceReport({ kind: 'test-report' });

        const textarea = browser.createdElements.find(element => element.tagName === 'TEXTAREA');
        expect(browser.document.execCommand).toHaveBeenCalledWith('copy');
        expect(textarea.value).toContain('test-report');
        expect(textarea.select).toHaveBeenCalledTimes(1);
        expect(textarea.removed).toBe(true);
    });
});
