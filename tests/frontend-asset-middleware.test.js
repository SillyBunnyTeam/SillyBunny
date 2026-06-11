import { describe, expect, test } from '@jest/globals';

import { setPublicAssetHeaders } from '../src/middleware/frontend-assets.js';

function getCacheControlFor(requestPath) {
    const headers = new Map();
    setPublicAssetHeaders({
        setHeader: (name, value) => headers.set(name, value),
    }, requestPath);
    return headers.get('Cache-Control');
}

describe('frontend asset fallback headers', () => {
    test('keeps html, json, and maps revalidating', () => {
        expect(getCacheControlFor('/index.html')).toBe('no-cache');
        expect(getCacheControlFor('/login.html')).toBe('no-cache');
        expect(getCacheControlFor('/manifest.json')).toBe('no-cache');
        expect(getCacheControlFor('/script.js.map')).toBe('no-cache');
    });

    test('bypasses the browser cache for unversioned public JavaScript modules', () => {
        expect(getCacheControlFor('/script.js')).toBe('no-store, no-cache, must-revalidate');
        expect(getCacheControlFor('/scripts/chat-render-lifecycle/render-window.js')).toBe('no-store, no-cache, must-revalidate');
        expect(getCacheControlFor('/scripts/bootstrap.mjs')).toBe('no-store, no-cache, must-revalidate');
    });

    test('keeps static non-code fallback assets short-lived', () => {
        expect(getCacheControlFor('/img/logo.png')).toBe('public, max-age=3600');
    });
});
