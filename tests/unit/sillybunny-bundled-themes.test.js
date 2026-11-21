/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a server route. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import http from 'node:http';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import nodeFetch from 'node-fetch';

import { setConfigFilePath } from '../../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { BUNDLED_THEMES, assertValidAllowlist } = await import('../../src/sillybunny-bundled-themes.js');
const { createBundledThemesRouter, router: productionRouter } = await import('../../src/endpoints/sillybunny-bundled-themes.js');

/** The test's own client, kept apart from the `fetch` that a test swaps in for the server. */
const httpFetch = globalThis.fetch;
const COMMIT = 'a'.repeat(40);
const sha256 = text => createHash('sha256').update(text).digest('hex');
const rawUrl = file => `https://raw.githubusercontent.com/example-author/example-themes/${COMMIT}/${file}`;

const THEME = Object.freeze({ name: 'Midnight Blue', main_text_color: 'rgba(220, 220, 210, 1)', blur_strength: 10, noShadows: false, custom_css: 'body { color: red; }' });
const THEME_TEXT = JSON.stringify(THEME, null, 4);

/** A fixture allowlist: `midnight` serves THEME_TEXT and carries its real hash. */
const fixtureAllowlist = (overrides = {}) => ({
    midnight: { url: rawUrl('midnight.json'), sha256: sha256(THEME_TEXT) },
    ...overrides,
});

/** A fake `fetch` that answers every call with the given body and records what it was asked. */
function fakeFetch(body, init = {}) {
    const calls = [];
    const fetchImpl = jest.fn(async (url, options) => {
        calls.push({ url, options });
        return new Response(body, { status: 200, ...init });
    });
    return Object.assign(fetchImpl, { calls });
}

describe('the bundled themes route', () => {
    let server;
    let baseUrl;
    let themesDirectory;
    let tempRoot;
    let currentRouter;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'bundled-themes-test-user' }, directories: { themes: themesDirectory } };
            next();
        });
        app.use('/api/sillybunny/themes', (request, response, next) => currentRouter(request, response, next));
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-bundled-themes-'));
        themesDirectory = path.join(tempRoot, 'themes');
        fs.mkdirSync(themesDirectory);
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });

    const install = async (body) => {
        const response = await httpFetch(`${baseUrl}/api/sillybunny/themes/install-bundled`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const use = options => { currentRouter = createBundledThemesRouter(options); };
    const savedFiles = () => fs.readdirSync(themesDirectory);

    describe('the request', () => {
        test('rejects an id that is not in the allowlist, and fetches nothing', async () => {
            const fetchImpl = fakeFetch(THEME_TEXT);
            use({ allowlist: fixtureAllowlist(), fetchImpl });

            const result = await install({ id: 'unknown-theme' });

            expect(result.status).toBe(404);
            expect(result.body).toEqual({ error: 'unknown_theme' });
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(savedFiles()).toEqual([]);
        });

        test.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('rejects the id %s, which only an object prototype has', async (id) => {
            const fetchImpl = fakeFetch(THEME_TEXT);
            use({ allowlist: fixtureAllowlist(), fetchImpl });

            const result = await install({ id });

            expect(result.status).toBe(404);
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        test.each([{}, { id: 5 }, { id: null }, { id: ['midnight'] }, { id: { toString: 'midnight' } }, { id: '' }])('rejects the body %j, which has no id string', async (body) => {
            const fetchImpl = fakeFetch(THEME_TEXT);
            use({ allowlist: fixtureAllowlist(), fetchImpl });

            const result = await install(body);

            expect(result.status).toBe(400);
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        test('never takes the URL, the hash or the destination from the request', async () => {
            const fetchImpl = fakeFetch(THEME_TEXT);
            use({ allowlist: fixtureAllowlist(), fetchImpl });

            const result = await install({
                id: 'midnight',
                url: 'http://169.254.169.254/latest/meta-data/',
                urls: ['http://127.0.0.1:1/'],
                sha256: 'f'.repeat(64),
                path: '../../escape',
                name: 'Escape',
            });

            expect(result.status).toBe(201);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(fetchImpl.calls[0].url).toBe(rawUrl('midnight.json'));
            expect(fetchImpl.calls[0].options).toMatchObject({ redirect: 'error' });
            expect(savedFiles()).toEqual(['Midnight Blue.json']);
        });

        test('answers only POST', async () => {
            use({ allowlist: fixtureAllowlist(), fetchImpl: fakeFetch(THEME_TEXT) });

            const response = await httpFetch(`${baseUrl}/api/sillybunny/themes/install-bundled`);

            expect(response.status).toBe(404);
        });
    });

    describe('the empty allowlist that ships', () => {
        test('holds no theme yet', () => {
            expect(Object.keys(BUNDLED_THEMES)).toEqual([]);
            expect(Object.isFrozen(BUNDLED_THEMES)).toBe(true);
        });

        test.each(['moonlit-echoes', 'midnight', 'anything', '__proto__'])('rejects the id %s and saves nothing', async (id) => {
            currentRouter = productionRouter;

            const result = await install({ id });

            expect(result.status).toBe(404);
            expect(savedFiles()).toEqual([]);
        });
    });

    describe('the fetched file', () => {
        test('is rejected when its hash differs, and nothing is saved', async () => {
            use({ allowlist: fixtureAllowlist({ midnight: { url: rawUrl('midnight.json'), sha256: sha256('another file') } }), fetchImpl: fakeFetch(THEME_TEXT) });

            const result = await install({ id: 'midnight' });

            expect(result.status).toBe(502);
            expect(result.body).toEqual({ error: 'hash_mismatch' });
            expect(savedFiles()).toEqual([]);
        });

        test('is checked against its hash before anything reads it as JSON', async () => {
            const notJson = '{ this is not json';
            use({ allowlist: fixtureAllowlist({ midnight: { url: rawUrl('midnight.json'), sha256: sha256('expected') } }), fetchImpl: fakeFetch(notJson) });
            const wrongHash = await install({ id: 'midnight' });

            use({ allowlist: fixtureAllowlist({ midnight: { url: rawUrl('midnight.json'), sha256: sha256(notJson) } }), fetchImpl: fakeFetch(notJson) });
            const rightHash = await install({ id: 'midnight' });

            expect(wrongHash.body).toEqual({ error: 'hash_mismatch' });
            expect(rightHash.body).toEqual({ error: 'invalid_theme' });
        });

        test('is rejected when it is larger than the cap, however it announces its size', async () => {
            const big = JSON.stringify({ name: 'Big', custom_css: 'x'.repeat(2000) });
            const allowlist = { big: { url: rawUrl('big.json'), sha256: sha256(big) } };

            use({ allowlist, fetchImpl: fakeFetch(big), maxBytes: 1000 });
            const streamed = await install({ id: 'big' });

            use({ allowlist, fetchImpl: fakeFetch(big, { headers: { 'content-length': '2000' } }), maxBytes: 1000 });
            const announced = await install({ id: 'big' });

            expect(streamed).toMatchObject({ status: 502, body: { error: 'too_large' } });
            expect(announced).toMatchObject({ status: 502, body: { error: 'too_large' } });
            expect(savedFiles()).toEqual([]);
        });

        test('aborts its request once it is turned away, because Bun leaves a request open when only its stream is cancelled', async () => {
            const big = JSON.stringify({ name: 'Big', custom_css: 'x'.repeat(2000) });
            const fetchImpl = fakeFetch(big);
            use({ allowlist: { big: { url: rawUrl('big.json'), sha256: sha256(big) } }, fetchImpl, maxBytes: 1000 });

            const result = await install({ id: 'big' });

            expect(result.body).toEqual({ error: 'too_large' });
            expect(fetchImpl.calls[0].options.signal.aborted).toBe(true);
        });

        test('is accepted when it is exactly as large as the cap', async () => {
            use({ allowlist: fixtureAllowlist(), fetchImpl: fakeFetch(THEME_TEXT), maxBytes: Buffer.byteLength(THEME_TEXT) });

            const result = await install({ id: 'midnight' });

            expect(result.status).toBe(201);
        });

        test('is rejected when the fetch does not answer in time, whether or not the fetch honours the abort signal', async () => {
            const honoursSignal = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')));
            }));
            const ignoresSignal = jest.fn(() => new Promise(() => {}));

            use({ allowlist: fixtureAllowlist(), fetchImpl: honoursSignal, timeoutMs: 30 });
            const first = await install({ id: 'midnight' });
            use({ allowlist: fixtureAllowlist(), fetchImpl: ignoresSignal, timeoutMs: 30 });
            const second = await install({ id: 'midnight' });

            expect(first).toMatchObject({ status: 504, body: { error: 'timeout' } });
            expect(second).toMatchObject({ status: 504, body: { error: 'timeout' } });
            expect(savedFiles()).toEqual([]);
        });

        test('is rejected when the body stalls after the headers arrived', async () => {
            const stalled = jest.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
            use({ allowlist: fixtureAllowlist(), fetchImpl: stalled, timeoutMs: 30 });

            const result = await install({ id: 'midnight' });

            expect(result).toMatchObject({ status: 504, body: { error: 'timeout' } });
        });

        test.each([
            ['a failing status', async () => new Response('gone', { status: 404 })],
            ['a network error', async () => { throw new Error('connect ECONNREFUSED'); }],
        ])('is rejected on %s', async (_label, fetchImpl) => {
            use({ allowlist: fixtureAllowlist(), fetchImpl });

            const result = await install({ id: 'midnight' });

            expect(result).toMatchObject({ status: 502, body: { error: 'upstream_failed' } });
            expect(savedFiles()).toEqual([]);
        });
    });

    describe('the theme', () => {
        test.each([
            ['not an object', '"a string"'],
            ['an array', '[{"name":"x"}]'],
            ['null', 'null'],
            ['without a name', JSON.stringify({ main_text_color: 'red' })],
            ['with an empty name', JSON.stringify({ name: '   ' })],
            ['with a name that is not text', JSON.stringify({ name: 5 })],
            ['with a name that has no file name left', JSON.stringify({ name: '///' })],
            ['with a name that is too long', JSON.stringify({ name: 'n'.repeat(201) })],
            ['with a nested value', JSON.stringify({ name: 'Nested', colors: { text: 'red' } })],
            ['with a list value', JSON.stringify({ name: 'Listed', colors: ['red'] })],
            ['with a prototype key', '{"name":"Proto","__proto__":"x"}'],
            ['that is not JSON', '{ not json'],
            ['that is not UTF-8', null],
        ])('is rejected when it is %s, and nothing is saved', async (_label, text) => {
            const bytes = text === null ? Buffer.from([0xff, 0xfe, 0x7b, 0x7d]) : Buffer.from(text);
            const digest = createHash('sha256').update(bytes).digest('hex');
            use({ allowlist: { bad: { url: rawUrl('bad.json'), sha256: digest } }, fetchImpl: fakeFetch(bytes) });

            const result = await install({ id: 'bad' });

            expect(result).toMatchObject({ status: 502, body: { error: 'invalid_theme' } });
            expect(savedFiles()).toEqual([]);
        });

        test('is saved for the user under its own name, and the name and the saved theme are returned', async () => {
            use({ allowlist: fixtureAllowlist(), fetchImpl: fakeFetch(THEME_TEXT) });

            const result = await install({ id: 'midnight' });

            expect(result).toEqual({ status: 201, body: { name: 'Midnight Blue', theme: THEME } });
            expect(savedFiles()).toEqual(['Midnight Blue.json']);
            expect(JSON.parse(fs.readFileSync(path.join(themesDirectory, 'Midnight Blue.json'), 'utf8'))).toEqual(THEME);
        });

        test('is saved under a sanitised file name that cannot leave the themes folder', async () => {
            const hostile = JSON.stringify({ name: '../../escape: "Blue"?', custom_css: '' });
            use({ allowlist: { hostile: { url: rawUrl('hostile.json'), sha256: sha256(hostile) } }, fetchImpl: fakeFetch(hostile) });

            const result = await install({ id: 'hostile' });

            expect(result.status).toBe(201);
            const files = savedFiles();
            expect(files).toHaveLength(1);
            expect(files[0]).toMatch(/^[^/\\:"?]+\.json$/);
            expect(path.dirname(path.resolve(themesDirectory, files[0]))).toBe(path.resolve(themesDirectory));
            expect(fs.readdirSync(tempRoot)).toEqual(['themes']);
        });

        test('leaves a theme of the same name as it is, and says so', async () => {
            fs.writeFileSync(path.join(themesDirectory, 'Midnight Blue.json'), '{"name":"Midnight Blue","custom_css":"mine"}');
            use({ allowlist: fixtureAllowlist(), fetchImpl: fakeFetch(THEME_TEXT) });

            const result = await install({ id: 'midnight' });

            // Only the name: the theme that is there is the user's, and the response does not describe it.
            expect(result).toEqual({ status: 409, body: { error: 'already_installed', name: 'Midnight Blue' } });
            expect(fs.readFileSync(path.join(themesDirectory, 'Midnight Blue.json'), 'utf8')).toContain('mine');
            expect(savedFiles()).toEqual(['Midnight Blue.json']);
        });
    });

    describe('the log', () => {
        let warn;
        beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
        afterEach(() => { warn.mockRestore(); });

        test.each([
            ['a redirect', 'redirect mode is set to error: https://example.invalid/'],
            ['a DNS error', 'getaddrinfo ENOTFOUND raw.githubusercontent.com'],
            ['a TLS error', 'certificate has expired'],
        ])('says what %s was, with the id, while the response stays generic', async (_label, message) => {
            use({ allowlist: fixtureAllowlist(), fetchImpl: jest.fn(async () => { throw new Error(message); }) });

            const result = await install({ id: 'midnight' });

            expect(result).toEqual({ status: 502, body: { error: 'upstream_failed' } });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0].join(' ')).toContain('midnight');
            expect(warn.mock.calls[0].join(' ')).toContain(message);
        });

        test('says which status the upstream answered', async () => {
            use({ allowlist: fixtureAllowlist(), fetchImpl: async () => new Response('gone', { status: 404 }) });

            await install({ id: 'midnight' });

            expect(warn.mock.calls[0].join(' ')).toContain('404');
        });

        test('says what failed when something other than the fetch did, and the response stays generic', async () => {
            fs.rmSync(themesDirectory, { recursive: true });
            fs.writeFileSync(themesDirectory, 'a file where the themes folder should be');
            use({ allowlist: fixtureAllowlist(), fetchImpl: fakeFetch(THEME_TEXT) });

            const result = await install({ id: 'midnight' });

            expect(result).toEqual({ status: 500, body: { error: 'install_failed' } });
            expect(warn.mock.calls.some(call => call.join(' ').includes('midnight') && call.join(' ').includes('not available'))).toBe(true);
        });

        test.each([
            ['a hash that differs', fixtureAllowlist({ midnight: { url: rawUrl('midnight.json'), sha256: sha256('another') } })],
            ['an unknown id', {}],
        ])('stays quiet for %s, which the client is told about by its code', async (_label, allowlist) => {
            use({ allowlist, fetchImpl: fakeFetch(THEME_TEXT) });

            await install({ id: 'midnight' });

            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('against a real HTTP server, through node-fetch', () => {
        let upstream;
        let upstreamPort;
        let targetHits;
        let endlessClosed;

        beforeAll(async () => {
            upstream = http.createServer((request, response) => {
                const redirects = { '/redirect-301.json': 301, '/redirect-302.json': 302, '/redirect-307.json': 307 };
                if (redirects[request.url]) {
                    response.writeHead(redirects[request.url], { Location: '/target.json' });
                    return response.end();
                }
                if (request.url === '/target.json' || request.url === '/theme.json') {
                    if (request.url === '/target.json') {
                        targetHits.push(request.url);
                    }
                    return response.end(THEME_TEXT);
                }
                if (request.url === '/endless.json') {
                    response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
                    const timer = setInterval(() => response.write(Buffer.alloc(16384, 97)), 1);
                    response.on('close', () => { clearInterval(timer); endlessClosed.resolve(); });
                    return undefined;
                }
                if (request.url === '/stalled-body.json') {
                    response.writeHead(200);
                    response.write('{');
                    return undefined;
                }
                // Anything else never answers: a stalled header.
                return undefined;
            });
            await new Promise((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
            upstreamPort = upstream.address().port;
        });

        beforeEach(() => {
            targetHits = [];
            let resolve;
            const promise = new Promise((done) => { resolve = done; });
            endlessClosed = { promise, resolve };
        });

        afterAll(async () => {
            upstream.closeAllConnections();
            await new Promise(resolve => upstream.close(resolve));
        });

        /** The real `node-fetch` with the options the route passes, aimed at the local server in place of GitHub. */
        const localFetch = (url, init) => nodeFetch(`http://127.0.0.1:${upstreamPort}/${new URL(url).pathname.split('/').pop()}`, init);
        const entry = file => ({ url: rawUrl(file), sha256: sha256(THEME_TEXT) });
        const useLocal = (files, options = {}) => use({ allowlist: Object.fromEntries(files.map(file => [file.replace('.json', ''), entry(file)])), fetchImpl: localFetch, ...options });

        test('serves a theme end to end, so the other cases fail for their own reason', async () => {
            useLocal(['theme.json']);

            const result = await install({ id: 'theme' });

            expect(result).toEqual({ status: 201, body: { name: 'Midnight Blue', theme: THEME } });
        });

        test.each(['redirect-301', 'redirect-302', 'redirect-307'])('refuses a real %s, and the target is not reached', async (id) => {
            useLocal([`${id}.json`]);
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                const result = await install({ id });

                expect(result).toEqual({ status: 502, body: { error: 'upstream_failed' } });
                expect(targetHits).toEqual([]);
                expect(savedFiles()).toEqual([]);
                expect(warn.mock.calls[0].join(' ')).toContain('redirect');
            } finally {
                warn.mockRestore();
            }
        });

        test('stops reading an endless chunked body at the cap, and closes the connection', async () => {
            useLocal(['endless.json'], { maxBytes: 64 * 1024, timeoutMs: 5000 });

            const startedAt = Date.now();
            const result = await install({ id: 'endless' });

            expect(result).toEqual({ status: 502, body: { error: 'too_large' } });
            expect(Date.now() - startedAt).toBeLessThan(2500);
            await expect(Promise.race([endlessClosed.promise.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('still open'), 2000))])).resolves.toBe('closed');
            expect(savedFiles()).toEqual([]);
        });

        test('ends a server that never answers its headers at the deadline', async () => {
            useLocal(['stalled-header.json'], { timeoutMs: 300 });

            const startedAt = Date.now();
            const result = await install({ id: 'stalled-header' });

            expect(result).toEqual({ status: 504, body: { error: 'timeout' } });
            expect(Date.now() - startedAt).toBeLessThan(2500);
        });

        test('ends a server that stalls its body after the headers at the deadline', async () => {
            useLocal(['stalled-body.json'], { timeoutMs: 300 });

            const startedAt = Date.now();
            const result = await install({ id: 'stalled-body' });

            expect(result).toEqual({ status: 504, body: { error: 'timeout' } });
            expect(Date.now() - startedAt).toBeLessThan(2500);
            expect(savedFiles()).toEqual([]);
        });
    });

    describe('the rate limit', () => {
        test('answers 429 once the user has installed too often', async () => {
            const fetchImpl = fakeFetch(THEME_TEXT);
            use({ allowlist: fixtureAllowlist(), fetchImpl, rateLimit: { points: 2, durationSeconds: 60 } });

            const statuses = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                statuses.push((await install({ id: 'midnight' })).status);
            }

            expect(statuses).toEqual([201, 409, 429]);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });
    });
});

describe('the allowlist check', () => {
    const entry = (overrides = {}) => ({ url: rawUrl('theme.json'), sha256: sha256('theme'), ...overrides });

    test('accepts no theme at all, and entries that pin a commit and a hash', () => {
        expect(() => assertValidAllowlist({})).not.toThrow();
        expect(() => assertValidAllowlist({ 'good-theme-1': entry() })).not.toThrow();
    });

    test.each([
        ['an id with capitals or spaces', { 'Bad Id': entry() }],
        ['a URL that is not https', { good: entry({ url: `http://raw.githubusercontent.com/a/b/${COMMIT}/t.json` }) }],
        ['a URL on another host', { good: entry({ url: `https://example.com/a/b/${COMMIT}/t.json` }) }],
        ['a URL on a branch, not a commit', { good: entry({ url: 'https://raw.githubusercontent.com/a/b/main/t.json' }) }],
        ['a URL on a short commit', { good: entry({ url: 'https://raw.githubusercontent.com/a/b/abc1234/t.json' }) }],
        ['a URL with a query', { good: entry({ url: `${rawUrl('t.json')}?token=1` }) }],
        ['a URL with credentials', { good: entry({ url: `https://user:pass@raw.githubusercontent.com/a/b/${COMMIT}/t.json` }) }],
        ['a hash that is not SHA-256', { good: entry({ sha256: 'abc' }) }],
        ['an upper-case hash', { good: entry({ sha256: sha256('theme').toUpperCase() }) }],
        ['a missing URL', { good: { sha256: sha256('theme') } }],
    ])('refuses %s', (_label, allowlist) => {
        expect(() => assertValidAllowlist(allowlist)).toThrow();
    });

    test('is checked when a router is made, so a bad list stops the server at start-up', () => {
        expect(() => createBundledThemesRouter({ allowlist: { 'Bad Id': entry() } })).toThrow();
    });
});
