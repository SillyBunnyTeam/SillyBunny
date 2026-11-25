/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest unit contracts for server caching, compression, whitelist, and boot markers. */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';

import {
    CONTENT_BOOT_ID,
    SERVER_BOOT_ID,
    bumpRestartCacheGeneration,
    computeContentBootId,
    getRestartCacheBootId,
    getServerBootId,
    resolveRestartCacheClearMode,
} from '../src/server-boot-marker.js';
import getResponseCompressionMiddleware, {
    ANDROID_STATIC_COMPRESSION_CACHE_BYTES,
    DESKTOP_STATIC_COMPRESSION_CACHE_BYTES,
    createCompressedStaticMiddleware,
    createStaticCompressionCache,
    getDefaultStaticCompressionCacheMaxBytes,
    isDirectLoopbackRequest,
    shouldBypassLoopbackCompression,
} from '../src/middleware/response-compression.js';
import {
    MANIFEST_FILE_NAME,
    RECONCILE_MARKER_FILE_NAME,
    buildManifest,
    fingerprintCard,
    reconcileManagedContentWithStatus,
} from '../src/sillybunny-managed-content.js';
import { setPublicAssetHeaders } from '../src/middleware/frontend-assets.js';
import { setConfigFilePath } from '../src/util.js';
import { createCard, createCardFile, createSpriteFile, createWorldFile } from './fixtures/managed-content/fixture-builder.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

jest.unstable_mockModule('../src/endpoints/thumbnails.js', () => ({
    invalidateThumbnail: jest.fn(),
}));

const swSource = fs.readFileSync(path.join(repoRoot, 'public', 'sw.js'), 'utf8');

let createRestartCacheClearMiddleware;
let compileIpPatterns;
let getForwardedIps;
let getTrustedProxies;
let isIpInPatterns;
let getWhitelistMiddleware;
let contentManager;
let groupsModule;

const tempDirs = [];

function makeTempDir(prefix = 'sb-perf-pr5-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function getRawHttp(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers });
        req.setTimeout(3000, () => req.destroy(new Error(`Timeout: ${url}`)));
        req.once('error', reject);
        req.once('response', async (res) => {
            const chunks = [];
            for await (const chunk of res) {
                chunks.push(chunk);
            }
            resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            });
        });
    });
}

function createSwHarness(origin = 'http://127.0.0.1:4444') {
    const listeners = new Map();
    const cacheStores = new Map();
    let pendingPutBarrier = null;
    const putCalls = [];
    const fetchCalls = [];

    const caches = {
        async open(name) {
            if (!cacheStores.has(name)) {
                cacheStores.set(name, new Map());
            }
            const store = cacheStores.get(name);
            return {
                async match(request) {
                    return store.get(request.url) ?? undefined;
                },
                async put(request, response) {
                    putCalls.push({ cacheName: name, url: request.url, body: response.bodyText });
                    if (pendingPutBarrier) {
                        await pendingPutBarrier;
                    }
                    store.set(request.url, response);
                },
            };
        },
        async keys() {
            return [...cacheStores.keys()];
        },
        async delete(name) {
            return cacheStores.delete(name);
        },
    };

    function makeResponse(url, bodyText = `body:${url}`) {
        return {
            ok: true,
            type: 'basic',
            bodyText,
            consumed: false,
            clone() {
                if (this.consumed) {
                    throw new Error('Cannot clone an already-consumed Response');
                }
                return makeResponse(url, bodyText);
            },
        };
    }

    const context = vm.createContext({
        URL,
        Object,
        Promise,
        caches,
        console: { debug: () => {}, error: () => {} },
        fetch: async (request) => {
            fetchCalls.push(request.url);
            return makeResponse(request.url);
        },
        self: {
            location: new URL(origin),
            skipWaiting: () => {},
            clients: { claim: async () => {} },
            addEventListener(type, handler) {
                listeners.set(type, handler);
            },
        },
    });

    vm.runInContext(swSource, context);

    return {
        putCalls,
        fetchCalls,
        setPutBarrier(promise) {
            pendingPutBarrier = promise;
        },
        dispatchFetch(pathname, method = 'GET') {
            const url = new URL(pathname, origin).toString();
            let respondedPromise = null;
            const waitUntilPromises = [];
            const event = {
                request: { url, method },
                respondWith(promise) {
                    respondedPromise = Promise.resolve(promise).then((res) => {
                        if (res) {
                            res.consumed = true;
                        }
                        return res;
                    });
                },
                waitUntil(promise) {
                    waitUntilPromises.push(Promise.resolve(promise));
                },
            };
            listeners.get('fetch')(event);
            return { respondedPromise, waitUntilPromises };
        },
    };
}

beforeAll(async () => {
    ({ createRestartCacheClearMiddleware } = await import('../src/middleware/restartCacheClear.js'));
    ({ compileIpPatterns, getForwardedIps, getTrustedProxies, isIpInPatterns } = await import('../src/express-common.js'));
    ({ default: getWhitelistMiddleware } = await import('../src/middleware/whitelist.js'));
    contentManager = await import('../src/endpoints/content-manager.js');
    groupsModule = await import('../src/endpoints/groups.js');
});

afterEach(() => {
    jest.restoreAllMocks();
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('1. Content-fingerprint restartCacheClear & boot ID', () => {
    test('computes deterministic CONTENT_BOOT_ID quickly on warm stat cache and preserves SERVER_BOOT_ID', () => {
        computeContentBootId();
        const start = performance.now();
        const computed = computeContentBootId();
        const elapsedMs = performance.now() - start;

        expect(computed).toBe(CONTENT_BOOT_ID);
        expect(computed).toMatch(/^c-[0-9a-f]{24}$/);
        expect(elapsedMs).toBeLessThan(250);
        expect(getServerBootId()).toBe(SERVER_BOOT_ID);
        expect(SERVER_BOOT_ID).not.toBe(CONTENT_BOOT_ID);
    });

    test('changes CONTENT_BOOT_ID when package version, git ref, public subdirs, manifest, global or per-user extensions mutate', () => {
        const root = makeTempDir('sb-boot-fp-');
        const dataRoot = path.join(root, 'data');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
        fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
        fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
        fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'staging'), '1111111111111111111111111111111111111111\n');
        fs.mkdirSync(path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ext-a'), { recursive: true });
        fs.mkdirSync(path.join(root, 'public', 'css'), { recursive: true });
        fs.mkdirSync(path.join(root, 'public', 'locales'), { recursive: true });
        fs.mkdirSync(path.join(root, 'public', 'lib'), { recursive: true });
        fs.mkdirSync(path.join(dataRoot, 'default-user', 'extensions', 'user-ext'), { recursive: true });
        fs.writeFileSync(path.join(root, 'public', 'index.html'), '<html>v1</html>');
        fs.writeFileSync(path.join(root, 'public', 'scripts', 'openai.js'), 'export const v = 1;\n');
        fs.writeFileSync(path.join(root, 'public', 'css', 'sillybunny-theme.css'), 'body { color: red; }\n');
        fs.writeFileSync(path.join(root, 'public', 'locales', 'en.json'), '{"ok":"OK"}');
        fs.writeFileSync(path.join(root, 'public', 'lib', 'bundle.js'), 'export const b = 1;\n');
        fs.writeFileSync(
            path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ext-a', 'manifest.json'),
            '{"display_name":"A","version":"1.0.0"}',
        );
        fs.writeFileSync(
            path.join(dataRoot, 'default-user', 'extensions', 'user-ext', 'manifest.json'),
            '{"display_name":"UserExt","version":"1.0.0"}',
        );
        fs.writeFileSync(
            path.join(dataRoot, 'default-user', 'extensions', 'user-ext', 'index.js'),
            'export const ext = 1;\n',
        );

        const base = computeContentBootId({ rootDir: root, dataRoot });
        expect(computeContentBootId({ rootDir: root, dataRoot })).toBe(base);

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.0.1' }));
        const afterPkg = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterPkg).not.toBe(base);

        fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'staging'), '2222222222222222222222222222222222222222\n');
        const afterGit = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterGit).not.toBe(afterPkg);

        fs.writeFileSync(path.join(root, 'public', 'index.html'), '<html>v2-longer-payload</html>');
        const afterPublic = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterPublic).not.toBe(afterGit);

        fs.writeFileSync(path.join(root, 'public', 'scripts', 'openai.js'), 'export const v = 222222;\n');
        const afterScriptsSubdir = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterScriptsSubdir).not.toBe(afterPublic);

        fs.writeFileSync(path.join(root, 'public', 'css', 'sillybunny-theme.css'), 'body { color: blue; font-size: 16px; }\n');
        const afterCssSubdir = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterCssSubdir).not.toBe(afterScriptsSubdir);

        fs.writeFileSync(path.join(root, 'public', 'locales', 'en.json'), '{"ok":"Okay-Updated"}');
        const afterLocalesSubdir = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterLocalesSubdir).not.toBe(afterCssSubdir);

        fs.writeFileSync(path.join(root, 'public', 'lib', 'bundle.js'), 'export const b = 222222;\n');
        const afterLibSubdir = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterLibSubdir).not.toBe(afterLocalesSubdir);

        fs.mkdirSync(path.join(root, 'dist', 'frontend'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', 'frontend', 'asset-manifest.json'), '{"assets":{}}');
        const afterManifest = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterManifest).not.toBe(afterLibSubdir);

        fs.writeFileSync(
            path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ext-a', 'manifest.json'),
            '{"display_name":"A","version":"1.1.0-updated"}',
        );
        const afterGlobalExt = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterGlobalExt).not.toBe(afterManifest);

        fs.writeFileSync(
            path.join(dataRoot, 'default-user', 'extensions', 'user-ext', 'index.js'),
            'export const ext = 222222;\n',
        );
        const afterUserExtEdit = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterUserExtEdit).not.toBe(afterGlobalExt);

        fs.mkdirSync(path.join(dataRoot, 'default-user', 'extensions', 'user-ext-2'), { recursive: true });
        const afterUserExtInstall = computeContentBootId({ rootDir: root, dataRoot });
        expect(afterUserExtInstall).not.toBe(afterUserExtEdit);
    });

    test('detects public/ subdirectory edits even without .git (Docker layout) and wires bumpRestartCacheGeneration in extension routes', () => {
        const dockerRoot = makeTempDir('sb-docker-fp-');
        fs.writeFileSync(path.join(dockerRoot, 'package.json'), JSON.stringify({ version: '2.0.0-dev' }));
        fs.mkdirSync(path.join(dockerRoot, 'public', 'scripts', 'sillybunny-editor'), { recursive: true });
        fs.writeFileSync(path.join(dockerRoot, 'public', 'scripts', 'sillybunny-editor', 'dialog.js'), 'export const d = 1;\n');

        const before = computeContentBootId({ rootDir: dockerRoot });
        fs.writeFileSync(path.join(dockerRoot, 'public', 'scripts', 'sillybunny-editor', 'dialog.js'), 'export const d = 999999;\n');
        const after = computeContentBootId({ rootDir: dockerRoot });
        expect(after).not.toBe(before);

        const extensionsSource = fs.readFileSync(path.join(repoRoot, 'src', 'endpoints', 'extensions.js'), 'utf8');
        const usersPrivateSource = fs.readFileSync(path.join(repoRoot, 'src', 'endpoints', 'users-private.js'), 'utf8');
        expect(extensionsSource).toMatch(/import\s*\{[^}]*bumpRestartCacheGeneration[^}]*\}\s*from\s*'\.\.\/server-boot-marker\.js'/);
        expect((extensionsSource.match(/bumpRestartCacheGeneration\(\)/g) ?? []).length).toBeGreaterThanOrEqual(7);
        expect(usersPrivateSource).toMatch(/import\s*\{[^}]*bumpRestartCacheGeneration[^}]*\}\s*from\s*'\.\.\/server-boot-marker\.js'/);
        expect(usersPrivateSource).toMatch(/bumpRestartCacheGeneration\(\)/);
    });

    test('supports SB_DEV=1 always mode override and live bumpRestartCacheGeneration()', () => {
        expect(resolveRestartCacheClearMode('content', {})).toBe('content');
        expect(resolveRestartCacheClearMode('always', {})).toBe('always');
        expect(resolveRestartCacheClearMode('content', { SB_DEV: '1' })).toBe('always');

        const middleware = createRestartCacheClearMiddleware({ enabled: true, mode: 'content' });
        const beforeBootId = getRestartCacheBootId({ mode: 'content', env: {} });
        const cookieBefore = `sillybunny_cache_cleared=${encodeURIComponent(`${beforeBootId}.2`)}`;

        const headersUnchanged = new Map();
        middleware(
            { headers: { cookie: cookieBefore } },
            { headersSent: false, setHeader: (k, v) => headersUnchanged.set(k, v), cookie: () => {} },
            () => {},
        );
        expect(headersUnchanged.has('Clear-Site-Data')).toBe(false);

        const bumpedBootId = bumpRestartCacheGeneration();
        expect(bumpedBootId).not.toBe(beforeBootId);
        expect(getRestartCacheBootId({ mode: 'always', env: {} })).toContain(SERVER_BOOT_ID);

        const headersAfterBump = new Map();
        let issuedBootCookie = null;
        middleware(
            { headers: { cookie: cookieBefore } },
            {
                headersSent: false,
                setHeader: (k, v) => headersAfterBump.set(k, v),
                cookie: (_name, value) => {
                    issuedBootCookie = value;
                },
            },
            () => {},
        );
        expect(headersAfterBump.get('Clear-Site-Data')).toBe('"cache"');
        expect(issuedBootCookie).toBe(bumpedBootId);
    });
});

describe('2. Service Worker disk-thrash & loopback SWR fixes (public/sw.js)', () => {
    test('does not intercept unhashed .js/.mjs modules or loopback SWR assets', async () => {
        const loopbackSw = createSwHarness('http://127.0.0.1:4444');

        expect(loopbackSw.dispatchFetch('/script.js').respondedPromise).toBeNull();
        expect(loopbackSw.dispatchFetch('/scripts/sillybunny-tabs.js').respondedPromise).toBeNull();
        expect(loopbackSw.dispatchFetch('/scripts/module.mjs').respondedPromise).toBeNull();
        expect(loopbackSw.dispatchFetch('/css/sillybunny-theme.css').respondedPromise).toBeNull();
        expect(loopbackSw.dispatchFetch('/lib/jquery.min.js').respondedPromise).toBeNull();
        expect(loopbackSw.dispatchFetch('/img/ai4.png').respondedPromise).toBeNull();
        expect(loopbackSw.dispatchFetch('/webfonts/fa-solid-900.woff2').respondedPromise).toBeNull();
        expect(loopbackSw.putCalls).toHaveLength(0);

        const remoteSw = createSwHarness('https://sillybunny.example.com');
        const remoteCss = remoteSw.dispatchFetch('/css/sillybunny-theme.css');
        expect(remoteCss.respondedPromise).not.toBeNull();
        await remoteCss.respondedPromise;
        await Promise.all(remoteCss.waitUntilPromises);
        expect(remoteSw.putCalls).toHaveLength(1);
    });

    test('returns immutable /frontend-assets/ responses without awaiting cache.put on the critical path', async () => {
        const sw = createSwHarness('https://sillybunny.example.com');
        let releasePut;
        sw.setPutBarrier(new Promise((resolve) => {
            releasePut = resolve;
        }));

        const { respondedPromise, waitUntilPromises } = sw.dispatchFetch('/frontend-assets/style-89abcdef.css');
        expect(respondedPromise).not.toBeNull();

        const response = await respondedPromise;
        expect(response.ok).toBe(true);
        expect(waitUntilPromises.length).toBeGreaterThan(0);

        releasePut();
        await Promise.all(waitUntilPromises);
        expect(sw.putCalls).toHaveLength(1);
    });
});

describe('3. Loopback compression bypass, Q1/L1 dynamic tuning, and bounded static LRU', () => {
    test('bypasses loopback ONLY when no proxy headers are present', () => {
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe(true);
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '127.0.0.2' }, headers: {} })).toBe(true);
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: {} })).toBe(true);
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} })).toBe(true);
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '::FFFF:127.0.0.1' }, headers: {} })).toBe(true);
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.2' }, headers: {} })).toBe(true);
        expect(isDirectLoopbackRequest({ socket: { remoteAddress: '192.168.1.25' }, headers: {} })).toBe(false);

        for (const proxyHeader of ['x-forwarded-for', 'forwarded', 'via', 'x-real-ip', 'cf-connecting-ip']) {
            const req = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: { [proxyHeader]: '203.0.113.5' },
            };
            expect(isDirectLoopbackRequest(req)).toBe(false);
            expect(shouldBypassLoopbackCompression(req, { loopbackBypass: 'auto', env: {} })).toBe(false);
        }

        const directLoopback = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
        expect(shouldBypassLoopbackCompression(directLoopback, { loopbackBypass: 'auto', env: {} })).toBe(true);
        expect(shouldBypassLoopbackCompression(directLoopback, { loopbackBypass: false, env: {} })).toBe(false);
        expect(shouldBypassLoopbackCompression(directLoopback, { loopbackBypass: 'auto', env: { SILLYBUNNY_TEST_COMPRESSION: '1' } })).toBe(false);
    });

    test('uses Brotli Q1 on Node, Gzip L1 on Bun without mutating req.headers, and 2048-byte threshold', async () => {
        const largePayload = { text: 'sillybunny-perf-payload-'.repeat(200) };
        const smallPayload = { text: 'tiny' };
        let observedAcceptEncoding = null;

        const createTestServer = async (options) => {
            const app = express();
            app.use(getResponseCompressionMiddleware(options));
            app.get('/large', (req, res) => {
                observedAcceptEncoding = req.headers['accept-encoding'];
                res.json(largePayload);
            });
            app.get('/small', (_req, res) => res.json(smallPayload));
            const server = await new Promise(resolve => {
                const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
            });
            return server;
        };

        const nodeServer = await createTestServer({ preferGzip: false, env: {} });
        const bunServer = await createTestServer({ preferGzip: true, env: {} });

        try {
            const nodeUrl = `http://127.0.0.1:${nodeServer.address().port}`;
            const bunUrl = `http://127.0.0.1:${bunServer.address().port}`;

            const directRes = await getRawHttp(`${nodeUrl}/large`, { 'Accept-Encoding': 'gzip, deflate, br' });
            expect(directRes.headers['content-encoding']).toBeUndefined();

            const proxiedNodeRes = await getRawHttp(`${nodeUrl}/large`, {
                'Accept-Encoding': 'gzip, deflate, br',
                'X-Real-IP': '198.51.100.42',
            });
            expect(proxiedNodeRes.headers['content-encoding']).toBe('br');
            expect(JSON.parse(brotliDecompressSync(proxiedNodeRes.body).toString('utf8'))).toEqual(largePayload);

            const proxiedSmallRes = await getRawHttp(`${nodeUrl}/small`, {
                'Accept-Encoding': 'gzip, deflate, br',
                'X-Real-IP': '198.51.100.42',
            });
            expect(proxiedSmallRes.headers['content-encoding']).toBeUndefined();

            const proxiedBunRes = await getRawHttp(`${bunUrl}/large`, {
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Forwarded': 'for=198.51.100.42',
            });
            expect(proxiedBunRes.headers['content-encoding']).toBe('gzip');
            expect(observedAcceptEncoding).toBe('gzip, deflate, br, zstd');
            expect(JSON.parse(gunzipSync(proxiedBunRes.body).toString('utf8'))).toEqual(largePayload);

            // When gzip is explicitly rejected (`gzip;q=0`), Bun preferGzip must preserve `br` instead of dropping compression.
            const proxiedBunBrOnly = await getRawHttp(`${bunUrl}/large`, {
                'Accept-Encoding': 'br, gzip;q=0',
                'Via': '1.1 reverse-proxy',
            });
            expect(proxiedBunBrOnly.headers['content-encoding']).toBe('br');
            expect(JSON.parse(brotliDecompressSync(proxiedBunBrOnly.body).toString('utf8'))).toEqual(largePayload);
        } finally {
            await new Promise(resolve => nodeServer.close(resolve));
            await new Promise(resolve => bunServer.close(resolve));
        }
    });

    test('caps static compressed LRU at 32 MB Android / 128 MB desktop, evicts old bytes, and invalidates on mtime/size change', async () => {
        expect(getDefaultStaticCompressionCacheMaxBytes({ platform: 'android', env: {} })).toBe(ANDROID_STATIC_COMPRESSION_CACHE_BYTES);
        expect(getDefaultStaticCompressionCacheMaxBytes({ platform: 'linux', env: { SILLYBUNNY_ANDROID_APP: '1' } })).toBe(ANDROID_STATIC_COMPRESSION_CACHE_BYTES);
        expect(getDefaultStaticCompressionCacheMaxBytes({ platform: 'win32', env: {} })).toBe(DESKTOP_STATIC_COMPRESSION_CACHE_BYTES);

        const staticRoot = makeTempDir('sb-static-lru-');
        const assetAPath = path.join(staticRoot, 'a.js');
        const assetBPath = path.join(staticRoot, 'b.js');
        fs.writeFileSync(assetAPath, `export const a = "${'alpha-'.repeat(800)}";\n`);
        fs.writeFileSync(assetBPath, `export const b = "${'bravo-'.repeat(800)}";\n`);

        const statA = fs.statSync(assetAPath);
        const entryAProbeCache = createStaticCompressionCache({ maxBytes: 1024 * 1024 });
        const warmedProbe = await entryAProbeCache.warm(assetAPath, statA, 'gzip');
        expect(warmedProbe).not.toBeNull();

        const boundedCache = createStaticCompressionCache({ maxBytes: warmedProbe.buffer.byteLength + 16 });
        await boundedCache.warm(assetAPath, statA, 'gzip');
        expect(boundedCache.get(assetAPath, statA, 'gzip')).not.toBeNull();

        const statB = fs.statSync(assetBPath);
        await boundedCache.warm(assetBPath, statB, 'gzip');
        expect(boundedCache.stats().bytesUsed).toBeLessThanOrEqual(warmedProbe.buffer.byteLength + 16);
        expect(boundedCache.get(assetAPath, statA, 'gzip')).toBeNull();
        expect(boundedCache.get(assetBPath, statB, 'gzip')).not.toBeNull();

        const middlewareCache = createStaticCompressionCache({ maxBytes: 1024 * 1024 });
        const app = express();
        app.use(createCompressedStaticMiddleware(staticRoot, { cache: middlewareCache, preferGzip: true, loopbackBypass: false }));
        app.use(express.static(staticRoot));
        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });

        try {
            const url = `http://127.0.0.1:${server.address().port}/a.js`;
            const firstMiss = await getRawHttp(url, { 'Accept-Encoding': 'gzip' });
            expect(firstMiss.statusCode).toBe(200);
            expect(firstMiss.headers.vary).toContain('Accept-Encoding');

            await middlewareCache.warm(assetAPath, statA, 'gzip');
            const secondHit = await getRawHttp(url, { 'Accept-Encoding': 'gzip' });
            expect(secondHit.headers['content-encoding']).toBe('gzip');
            expect(secondHit.headers.vary).toContain('Accept-Encoding');
            expect(gunzipSync(secondHit.body).toString('utf8')).toContain('export const a =');

            const notModified = await getRawHttp(url, {
                'Accept-Encoding': 'gzip',
                'If-None-Match': secondHit.headers.etag,
            });
            expect(notModified.statusCode).toBe(304);

            const weakNotModified = await getRawHttp(url, {
                'Accept-Encoding': 'gzip',
                'If-None-Match': `W/${secondHit.headers.etag}`,
            });
            expect(weakNotModified.statusCode).toBe(304);

            const wildcardNotModified = await getRawHttp(url, {
                'Accept-Encoding': 'gzip',
                'If-None-Match': '*',
            });
            expect(wildcardNotModified.statusCode).toBe(304);

            const updatedSource = `export const a = "${'updated-delta-'.repeat(900)}";\n`;
            fs.writeFileSync(assetAPath, updatedSource);
            const future = new Date(Date.now() + 10_000);
            fs.utimesSync(assetAPath, future, future);

            const afterMutate = await getRawHttp(url, { 'Accept-Encoding': 'gzip' });
            expect(afterMutate.body.toString('utf8')).toBe(updatedSource);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('mounts static compressed LRU in server-main.js, honors no-transform, and rejects mid-warm file mutations', async () => {
        const serverMainSource = fs.readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');
        const staticLruPos = serverMainSource.indexOf('createCompressedStaticMiddleware(publicDirectory');
        const expressStaticPos = serverMainSource.indexOf('express.static(publicDirectory');
        expect(staticLruPos).toBeGreaterThan(-1);
        expect(expressStaticPos).toBeGreaterThan(staticLruPos);

        const staticRoot = makeTempDir('sb-static-live-');
        const scriptPath = path.join(staticRoot, 'app.js');
        const noTransformPath = path.join(staticRoot, 'raw.js');
        const payloadText = `export const msg = "${'live-lru-'.repeat(600)}";\n`;
        fs.writeFileSync(scriptPath, payloadText);
        fs.writeFileSync(noTransformPath, payloadText);

        const staleCache = createStaticCompressionCache({ maxBytes: 1024 * 1024 });
        const initialStat = fs.statSync(scriptPath);
        const mismatchedWarm = await staleCache.warm(scriptPath, {
            size: initialStat.size + 10,
            mtimeMs: initialStat.mtimeMs,
        }, 'gzip');
        expect(mismatchedWarm).toBeNull();
        expect(staleCache.stats().entries).toBe(0);

        const liveCache = createStaticCompressionCache({ maxBytes: 1024 * 1024 });
        const customSetHeaders = (res, filePath) => {
            if (filePath.endsWith('raw.js')) {
                res.setHeader('Cache-Control', 'public, no-transform');
                return;
            }
            setPublicAssetHeaders(res, filePath);
        };

        const app = express();
        app.use(getResponseCompressionMiddleware({ preferGzip: true, env: {} }));
        app.use(createCompressedStaticMiddleware(staticRoot, {
            cache: liveCache,
            preferGzip: true,
            env: {},
            setHeaders: customSetHeaders,
        }));
        app.use(express.static(staticRoot, { setHeaders: customSetHeaders }));

        const server = await new Promise(resolve => {
            const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
        });

        try {
            const baseUrl = `http://127.0.0.1:${server.address().port}`;

            const directLoopback = await getRawHttp(`${baseUrl}/app.js`, { 'Accept-Encoding': 'gzip, br' });
            expect(directLoopback.headers['content-encoding']).toBeUndefined();
            expect(liveCache.stats().entries).toBe(0);

            const proxiedMiss = await getRawHttp(`${baseUrl}/app.js`, {
                'Accept-Encoding': 'gzip, br',
                'Via': '1.1 edge',
            });
            expect(proxiedMiss.headers['content-encoding']).toBe('gzip');
            expect(gunzipSync(proxiedMiss.body).toString('utf8')).toBe(payloadText);

            await liveCache.warm(scriptPath, fs.statSync(scriptPath), 'gzip');
            const proxiedHit = await getRawHttp(`${baseUrl}/app.js`, {
                'Accept-Encoding': 'gzip, br',
                'Via': '1.1 edge',
            });
            expect(proxiedHit.headers['content-encoding']).toBe('gzip');
            expect(proxiedHit.headers['cache-control']).toBe('no-cache');
            expect(proxiedHit.headers.etag).toMatch(/-gzip"$/);
            expect(proxiedHit.headers.vary).toContain('Accept-Encoding');
            expect(liveCache.stats().hits).toBeGreaterThanOrEqual(1);
            expect(gunzipSync(proxiedHit.body).toString('utf8')).toBe(payloadText);

            const noTransformRes = await getRawHttp(`${baseUrl}/raw.js`, {
                'Accept-Encoding': 'gzip, br',
                'Via': '1.1 edge',
            });
            expect(noTransformRes.headers['content-encoding']).toBeUndefined();
            expect(noTransformRes.headers.vary).toBeUndefined();
            expect(noTransformRes.body.toString('utf8')).toBe(payloadText);
            expect(liveCache.get(noTransformPath, fs.statSync(noTransformPath), 'gzip')).toBeNull();
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe('4. Precompiled CIDR whitelist, getForwardedIps fast-path, and Handlebars-free 403', () => {
    test('precompiles CIDR entries once per whitelist snapshot and re-compiles on array or push mutation', () => {
        const patterns = ['127.0.0.1', '192.168.0.0/16', '10.0.0.0/8'];
        const initialCompiled = compileIpPatterns(patterns);

        expect(isIpInPatterns('127.0.0.1', patterns)).toBe(true);
        expect(isIpInPatterns('::ffff:127.0.0.1', patterns)).toBe(true);
        expect(isIpInPatterns('::1', patterns)).toBe(false);

        for (let i = 0; i < 100; i++) {
            expect(isIpInPatterns('127.0.0.1', patterns)).toBe(true);
            expect(isIpInPatterns('192.168.1.50', patterns)).toBe(true);
            expect(isIpInPatterns('203.0.113.9', patterns)).toBe(false);
        }
        expect(compileIpPatterns(patterns)).toBe(initialCompiled);

        patterns.push('203.0.113.9');
        expect(isIpInPatterns('203.0.113.9', patterns)).toBe(true);
        expect(compileIpPatterns(patterns)).not.toBe(initialCompiled);

        const freshCompiled = compileIpPatterns(['::1']);
        expect(freshCompiled.allowsIpv6Loopback).toBe(true);
        expect(freshCompiled.allowsIpv4Loopback).toBe(false);
    });

    test('keeps getTrustedProxies cached by value when SILLYTAVERN_WHITELIST env var returns a fresh array per lookup', () => {
        const previousEnv = process.env.SILLYTAVERN_WHITELIST;
        try {
            process.env.SILLYTAVERN_WHITELIST = JSON.stringify(['127.0.0.1', '::1', '192.168.0.0/16']);
            const first = getTrustedProxies();
            const second = getTrustedProxies();
            expect(second).toBe(first);
            expect(first).toEqual(['127.0.0.1', '::1', '192.168.0.0/16']);

            process.env.SILLYTAVERN_WHITELIST = JSON.stringify(['127.0.0.1', '10.0.0.0/8']);
            const updated = getTrustedProxies();
            expect(updated).not.toBe(first);
            expect(updated).toEqual(['127.0.0.1', '10.0.0.0/8']);
            expect(getTrustedProxies()).toBe(updated);
        } finally {
            if (previousEnv === undefined) {
                delete process.env.SILLYTAVERN_WHITELIST;
            } else {
                process.env.SILLYTAVERN_WHITELIST = previousEnv;
            }
            getTrustedProxies();
        }
    });

    test('short-circuits getForwardedIps with zero config lookups when no forwarded headers exist', () => {
        const readConfig = jest.fn((_key, defaultValue) => defaultValue);
        const ips = getForwardedIps(
            { headers: { host: '127.0.0.1:4444', 'user-agent': 'Mozilla/5.0' } },
            ['127.0.0.1'],
            { readConfig },
        );
        expect(ips).toEqual([]);
        expect(readConfig).not.toHaveBeenCalled();

        const withHeader = getForwardedIps(
            { headers: { 'x-real-ip': '198.51.100.8' } },
            ['127.0.0.1'],
            { readConfig },
        );
        expect(withHeader).toEqual(['198.51.100.8']);
        expect(readConfig).toHaveBeenCalledTimes(1);
    });

    test('renders escaped 403 whitelist page without importing handlebars', async () => {
        const whitelistSource = fs.readFileSync(path.join(repoRoot, 'src', 'middleware', 'whitelist.js'), 'utf8');
        expect(whitelistSource).not.toMatch(/from\s+['"]handlebars['"]/);

        const dataRoot = makeTempDir('sb-wl-403-');
        fs.mkdirSync(path.join(dataRoot, '_errors'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_errors', 'forbidden-by-whitelist.html'), '<p>Blocked: {{ipDetails}}</p>');
        const previousDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = dataRoot;

        try {
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            const middleware = await getWhitelistMiddleware();
            let status = 200;
            let body = '';
            middleware(
                {
                    socket: { remoteAddress: '203.0.113.99' },
                    headers: { 'user-agent': 'test' },
                    path: '/test',
                },
                {
                    status(code) {
                        status = code;
                        return this;
                    },
                    send(payload) {
                        body = payload;
                        return this;
                    },
                },
                () => {},
            );
            expect(status).toBe(403);
            expect(body).toBe('<p>Blocked: 203.0.113.99</p>');
        } finally {
            globalThis.DATA_ROOT = previousDataRoot;
        }
    });
});

describe('5. Cold-boot content & group reconciliation markers', () => {
    test('skips managed PNG/theme hashing and content.log writes on unchanged boots, and re-triggers on mutation or version bump', async () => {
        const bundledDir = makeTempDir('sb-bundled-');
        const userRoot = makeTempDir('sb-user-');

        const cardV1 = createCardFile({ card: createCard({ character_version: '1', first_mes: 'Hello v1' }) });
        const cardV2 = createCardFile({ card: createCard({ character_version: '2', first_mes: 'Hello v2' }) });
        const worldV1 = createWorldFile([{ key: ['lore'], content: 'v1' }]);
        const spriteV1 = createSpriteFile(1);

        const entries = [
            { filename: 'default_AssistantReisen.png', type: 'character' },
            { filename: 'Assistant Reisen', type: 'sprites' },
            { filename: 'SillyBunny Lexicon.json', type: 'world' },
        ];

        const writeBundledVersion = (cardBuf, previousManifest = null) => {
            fs.mkdirSync(path.join(bundledDir, 'Assistant Reisen'), { recursive: true });
            fs.writeFileSync(path.join(bundledDir, 'default_AssistantReisen.png'), cardBuf);
            fs.writeFileSync(path.join(bundledDir, 'Assistant Reisen', 'joy.webp'), spriteV1);
            fs.writeFileSync(path.join(bundledDir, 'SillyBunny Lexicon.json'), worldV1);
            const manifest = buildManifest({ bundledDirectory: bundledDir, entries, previous: previousManifest });
            fs.writeFileSync(path.join(bundledDir, MANIFEST_FILE_NAME), JSON.stringify(manifest));
            return manifest;
        };

        const manifestV1 = writeBundledVersion(cardV1);
        const manifestV2 = writeBundledVersion(cardV2, manifestV1);

        const presetDir = path.join(bundledDir, 'presets', 'openai');
        fs.mkdirSync(presetDir, { recursive: true });
        fs.writeFileSync(path.join(presetDir, 'PresetA.json'), '{}');
        fs.writeFileSync(path.join(presetDir, 'PresetB.json'), '{}');
        fs.writeFileSync(path.join(presetDir, 'PresetC.json'), '{}');

        const contentIndex = [
            ...entries.map(entry => ({ ...entry, folder: bundledDir })),
            { filename: 'presets/openai/PresetA.json', type: 'openai_preset', folder: bundledDir },
            { filename: 'presets/openai/PresetB.json', type: 'openai_preset', folder: bundledDir },
            { filename: 'presets/openai/PresetC.json', type: 'openai_preset', folder: bundledDir },
        ];

        const directories = {
            root: userRoot,
            characters: path.join(userRoot, 'characters'),
            worlds: path.join(userRoot, 'worlds'),
            backups: path.join(userRoot, 'backups'),
            themes: path.join(userRoot, 'themes'),
            quickreplies: path.join(userRoot, 'QuickReplies'),
            openAI_Settings: path.join(userRoot, 'OpenAI Settings'),
        };
        Object.values(directories).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
        fs.writeFileSync(
            path.join(userRoot, 'default-preset-deletions.json'),
            JSON.stringify({ version: 1, deleted: { 'openai_preset::presets/openai/PresetB.json': true } }),
        );

        await contentManager.seedContentForUser(contentIndex, directories, [], {
            managedDirectory: bundledDir,
            appVersion: '2.0.0-test',
        });

        expect(fs.existsSync(path.join(userRoot, RECONCILE_MARKER_FILE_NAME))).toBe(true);
        expect(fs.existsSync(path.join(directories.openAI_Settings, 'PresetB.json'))).toBe(false);

        const contentLogPath = path.join(userRoot, 'content.log');
        const logStatBefore = fs.statSync(contentLogPath);
        const readFileSpy = jest.spyOn(fs, 'readFileSync');

        await contentManager.seedContentForUser(contentIndex, directories, [], {
            managedDirectory: bundledDir,
            appVersion: '2.0.0-test',
        });

        const readPaths = readFileSpy.mock.calls.map(([target]) => path.resolve(String(target)));
        expect(readPaths).not.toContain(path.resolve(path.join(directories.characters, 'default_AssistantReisen.png')));
        expect(readPaths.filter(p => p.endsWith('default-preset-deletions.json'))).toHaveLength(1);
        expect(fs.statSync(contentLogPath).mtimeMs).toBe(logStatBefore.mtimeMs);
        readFileSpy.mockRestore();

        const cardPath = path.join(directories.characters, 'default_AssistantReisen.png');
        fs.writeFileSync(cardPath, cardV1);
        const bumpedTime = new Date(Date.now() + 15_000);
        fs.utimesSync(cardPath, bumpedTime, bumpedTime);

        await contentManager.seedContentForUser(contentIndex, directories, [], {
            managedDirectory: bundledDir,
            appVersion: '2.0.0-test',
        });

        expect(fingerprintCard(fs.readFileSync(cardPath))).toBe(manifestV2.items[0].fingerprint);

        const readSpyOnVersionBump = jest.spyOn(fs, 'readFileSync');
        await contentManager.seedContentForUser(contentIndex, directories, [], {
            managedDirectory: bundledDir,
            appVersion: '2.1.0-test',
        });
        const versionBumpReads = readSpyOnVersionBump.mock.calls.map(([target]) => path.resolve(String(target)));
        expect(versionBumpReads).toContain(path.resolve(cardPath));
        readSpyOnVersionBump.mockRestore();
    });

    test('does not persist managed reconciliation marker when a per-item update fails, allowing next boot to retry', () => {
        const bundledDir = makeTempDir('sb-bundled-retry-');
        const userRoot = makeTempDir('sb-user-retry-');
        const directories = {
            root: userRoot,
            characters: path.join(userRoot, 'characters'),
            worlds: path.join(userRoot, 'worlds'),
            backups: path.join(userRoot, 'backups'),
        };
        Object.values(directories).forEach(dir => fs.mkdirSync(dir, { recursive: true }));

        const cardV1 = createCardFile({ card: createCard({ character_version: '1', first_mes: 'v1' }) });
        const cardV2 = createCardFile({ card: createCard({ character_version: '2', first_mes: 'v2' }) });
        const entries = [{ filename: 'default_AssistantReisen.png', type: 'character' }];

        fs.writeFileSync(path.join(bundledDir, 'default_AssistantReisen.png'), cardV1);
        const manifestV1 = buildManifest({ bundledDirectory: bundledDir, entries });
        fs.writeFileSync(path.join(bundledDir, 'default_AssistantReisen.png'), cardV2);
        const manifestV2 = buildManifest({ bundledDirectory: bundledDir, entries, previous: manifestV1 });
        fs.writeFileSync(path.join(bundledDir, MANIFEST_FILE_NAME), JSON.stringify(manifestV2));

        // User starts with v1, while bundled v2 file is temporarily missing to induce a caught per-item failure.
        const userCardPath = path.join(directories.characters, 'default_AssistantReisen.png');
        fs.writeFileSync(userCardPath, cardV1);
        fs.rmSync(path.join(bundledDir, 'default_AssistantReisen.png'));

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const failedPass = reconcileManagedContentWithStatus({
            bundledDirectory: bundledDir,
            directories,
            appVersion: '2.0.0-retry',
        });
        expect(failedPass).toEqual({ updated: [], clean: false });
        expect(fs.existsSync(path.join(userRoot, RECONCILE_MARKER_FILE_NAME))).toBe(false);
        warnSpy.mockRestore();

        // Once the bundled file is available again, the next boot retries and updates the card + writes the marker.
        fs.writeFileSync(path.join(bundledDir, 'default_AssistantReisen.png'), cardV2);
        const retryPass = reconcileManagedContentWithStatus({
            bundledDirectory: bundledDir,
            directories,
            appVersion: '2.0.0-retry',
        });
        expect(retryPass).toEqual({ updated: ['default_AssistantReisen.png'], clean: true });
        expect(fingerprintCard(fs.readFileSync(userCardPath))).toBe(manifestV2.items[0].fingerprint);
        expect(fs.existsSync(path.join(userRoot, RECONCILE_MARKER_FILE_NAME))).toBe(true);
    });

    test('writes .migrated-v1 signature marker after migrateGroupChatsMetadataFormat, skips reads when unchanged, and re-migrates newly copied legacy groups', async () => {
        const userRoot = makeTempDir('sb-groups-marker-');
        const userDirs = {
            root: userRoot,
            groups: path.join(userRoot, 'groups'),
            groupChats: path.join(userRoot, 'group chats'),
            backups: path.join(userRoot, 'backups'),
        };
        Object.values(userDirs).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
        fs.writeFileSync(path.join(userDirs.groups, 'g1.json'), JSON.stringify({
            id: 'g1',
            name: 'Group 1',
            members: [],
            chats: ['c1'],
            chat_id: 'c1',
        }));
        fs.writeFileSync(path.join(userDirs.groupChats, 'c1.jsonl'), '{"name":"Alice","mes":"Hi"}\n');

        await groupsModule.migrateGroupChatsMetadataFormat([userDirs]);

        const markerPath = groupsModule.getGroupsMigrationMarkerPath(userDirs);
        expect(path.basename(markerPath)).toBe('.migrated-v1');
        expect(fs.existsSync(markerPath)).toBe(true);
        expect(fs.readFileSync(markerPath, 'utf8').trim()).toMatch(/^v1:g1\.json:/);
        expect(fs.readdirSync(userDirs.groups)).toEqual(['g1.json']);

        const readFileSpy = jest.spyOn(fs.promises, 'readFile');
        const readdirSpy = jest.spyOn(fs.promises, 'readdir');
        await groupsModule.migrateGroupChatsMetadataFormat([userDirs]);
        expect(readFileSpy).not.toHaveBeenCalled();
        expect(readdirSpy).toHaveBeenCalledTimes(1);
        expect(readdirSpy).toHaveBeenCalledWith(userDirs.groups, { withFileTypes: true });
        readFileSpy.mockRestore();
        readdirSpy.mockRestore();

        // Copying a legacy group file later invalidates the signature and triggers migration.
        fs.writeFileSync(path.join(userDirs.groups, 'g2.json'), JSON.stringify({
            id: 'g2',
            name: 'Legacy Imported Group',
            members: [],
            chats: ['c2'],
            chat_id: 'c2',
            chat_metadata: { note: 'imported-legacy-note' },
        }));
        fs.writeFileSync(path.join(userDirs.groupChats, 'c2.jsonl'), '{"name":"Bob","mes":"Old chat"}\n');

        await groupsModule.migrateGroupChatsMetadataFormat([userDirs]);

        const migratedGroup = JSON.parse(fs.readFileSync(path.join(userDirs.groups, 'g2.json'), 'utf8'));
        expect(migratedGroup.chat_metadata).toBeUndefined();
        const migratedChatLines = fs.readFileSync(path.join(userDirs.groupChats, 'c2.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(migratedChatLines[0].chat_metadata).toEqual({ note: 'imported-legacy-note' });
        expect(fs.readFileSync(markerPath, 'utf8').trim()).toContain('g2.json:');
    });
});
