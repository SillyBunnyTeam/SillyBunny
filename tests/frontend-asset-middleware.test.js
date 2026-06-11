import { describe, expect, test } from '@jest/globals';

import { isIosWebKitUserAgent, setPublicAssetHeaders } from '../src/middleware/frontend-assets.js';

function getHeadersFor(requestPath, { userAgent = '', vary = '' } = {}) {
    const headers = new Map(vary ? [['Vary', vary]] : []);

    setPublicAssetHeaders({
        req: {
            headers: { 'user-agent': userAgent },
            get: name => (name.toLowerCase() === 'user-agent' ? userAgent : undefined),
        },
        getHeader: name => headers.get(name),
        setHeader: (name, value) => headers.set(name, value),
    }, requestPath);

    return headers;
}

function getCacheControlFor(requestPath, options) {
    return getHeadersFor(requestPath, options).get('Cache-Control');
}

describe('frontend asset fallback headers', () => {
    test('keeps html, json, and maps revalidating', () => {
        expect(getCacheControlFor('/index.html')).toBe('no-cache');
        expect(getCacheControlFor('/login.html')).toBe('no-cache');
        expect(getCacheControlFor('/manifest.json')).toBe('no-cache');
        expect(getCacheControlFor('/script.js.map')).toBe('no-cache');
    });

    test('keeps non-iOS public JavaScript modules short-lived', () => {
        expect(getCacheControlFor('/script.js')).toBe('public, max-age=3600');
        expect(getCacheControlFor('/script.js', {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
        })).toBe('public, max-age=3600');
        expect(getCacheControlFor('/scripts/bootstrap.mjs', {
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Firefox/126.0',
        })).toBe('public, max-age=3600');
    });

    test('revalidates public JavaScript modules only for iOS WebKit', () => {
        expect(getCacheControlFor('/script.js', {
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        })).toBe('no-cache');
        expect(getCacheControlFor('/scripts/chat-render-lifecycle/render-window.js', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        })).toBe('no-cache');
    });

    test('marks JavaScript cache headers as user-agent variant', () => {
        expect(getHeadersFor('/script.js', { vary: 'Accept-Encoding' }).get('Vary')).toBe('Accept-Encoding, User-Agent');
        expect(getHeadersFor('/script.js', { vary: 'user-agent' }).get('Vary')).toBe('user-agent');
        expect(getHeadersFor('/script.js', { vary: '*' }).get('Vary')).toBe('*');
    });

    test('keeps static non-code fallback assets short-lived', () => {
        expect(getCacheControlFor('/img/logo.png')).toBe('public, max-age=3600');
    });

    test('detects iOS WebKit user agents', () => {
        expect(isIosWebKitUserAgent('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe(true);
        expect(isIosWebKitUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1')).toBe(true);
        expect(isIosWebKitUserAgent('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36')).toBe(false);
        expect(isIosWebKitUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36')).toBe(false);
    });
});
