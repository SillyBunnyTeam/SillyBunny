import { describe, expect, test } from '@jest/globals';

import { setPublicAssetHeaders } from '../src/middleware/frontend-assets.js';

function getHeadersFor(requestPath) {
    const headers = new Map();

    setPublicAssetHeaders({
        setHeader: (name, value) => headers.set(name, value),
    }, requestPath);

    return headers;
}

function getCacheControlFor(requestPath) {
    return getHeadersFor(requestPath).get('Cache-Control');
}

describe('frontend asset fallback headers', () => {
    test('keeps html, json, and maps revalidating', () => {
        expect(getCacheControlFor('/index.html')).toBe('no-cache');
        expect(getCacheControlFor('/login.html')).toBe('no-cache');
        expect(getCacheControlFor('/manifest.json')).toBe('no-cache');
        expect(getCacheControlFor('/script.js.map')).toBe('no-cache');
    });

    test('revalidates public JavaScript modules for every browser', () => {
        expect(getCacheControlFor('/script.js')).toBe('no-cache');
        expect(getCacheControlFor('/scripts/chat-render-lifecycle/render-window.js')).toBe('no-cache');
        expect(getCacheControlFor('/scripts/bootstrap.mjs')).toBe('no-cache');
    });

    test('revalidates unversioned stylesheets alongside their scripts', () => {
        expect(getCacheControlFor('/style.css')).toBe('no-cache');
        expect(getCacheControlFor('/scripts/extensions/in-chat-agents/style.css')).toBe('no-cache');
    });

    test('keeps static non-code fallback assets short-lived', () => {
        expect(getCacheControlFor('/img/logo.png')).toBe('public, max-age=3600');
    });

});
