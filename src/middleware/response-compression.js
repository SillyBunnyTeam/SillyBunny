import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import compression from 'compression';
import mime from 'mime-types';

import { isBunRuntime, isNativeTermuxEnvironment } from '../runtime.js';
import { getConfigValue } from '../util.js';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

const LOOPBACK_REMOTE_ADDRESSES = new Set([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
]);

const PROXY_FORWARDING_HEADERS = Object.freeze([
    'x-forwarded-for',
    'forwarded',
    'via',
    'x-real-ip',
    'cf-connecting-ip',
]);

const LOOPBACK_BYPASS_ENV_KEY = 'SILLYTAVERN_PERFORMANCE_COMPRESSION_LOOPBACKBYPASS';
const TEST_COMPRESSION_ENV_KEY = 'SILLYBUNNY_TEST_COMPRESSION';

export const ANDROID_STATIC_COMPRESSION_CACHE_BYTES = 32 * 1024 * 1024;
export const DESKTOP_STATIC_COMPRESSION_CACHE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 2048;

const STATIC_COMPRESSIBLE_EXTENSIONS = new Set([
    '.css',
    '.htm',
    '.html',
    '.js',
    '.json',
    '.map',
    '.mjs',
    '.svg',
    '.txt',
    '.webmanifest',
    '.xml',
]);

function getHeaderValue(response, headerName) {
    const value = response?.getHeader?.(headerName);
    if (Array.isArray(value)) {
        return value.join(',');
    }

    return value === undefined || value === null ? '' : String(value);
}

function hasCacheDirective(response, directive) {
    const cacheControl = getHeaderValue(response, 'Cache-Control').toLowerCase();
    return cacheControl.split(',').map(part => part.trim()).includes(directive);
}

function appendVaryAcceptEncoding(response) {
    const existing = getHeaderValue(response, 'Vary');
    if (!existing) {
        response.setHeader('Vary', 'Accept-Encoding');
        return;
    }

    const tokens = existing.split(',').map(part => part.trim().toLowerCase());
    if (!tokens.includes('accept-encoding')) {
        response.setHeader('Vary', `${existing}, Accept-Encoding`);
    }
}

function hasProxyHeaders(request) {
    const headers = request?.headers;
    if (!headers) {
        return false;
    }

    for (const headerName of PROXY_FORWARDING_HEADERS) {
        const value = headers[headerName];
        if (Array.isArray(value) ? value.some(Boolean) : Boolean(value && String(value).trim())) {
            return true;
        }
    }

    return false;
}

/**
 * True only when the TCP peer is loopback and no reverse-proxy header is present.
 * A local reverse proxy (nginx/Caddy/Cloudflare Tunnel) connects over loopback on behalf
 * of remote clients, so any proxy header disqualifies the loopback bypass.
 * @param {import('express').Request} request Express request
 * @returns {boolean}
 */
export function isDirectLoopbackRequest(request) {
    const remoteAddress = request?.socket?.remoteAddress;
    if (!remoteAddress || !LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress)) {
        return false;
    }

    return !hasProxyHeaders(request);
}

function readLoopbackBypassSetting(explicitSetting, env = process.env) {
    if (explicitSetting !== undefined) {
        return explicitSetting;
    }
    if (env && LOOPBACK_BYPASS_ENV_KEY in env) {
        return env[LOOPBACK_BYPASS_ENV_KEY];
    }
    // Avoid calling getConfigValue when standalone unit tests have not initialized config.yaml.
    if (globalThis.COMMAND_LINE_ARGS) {
        return getConfigValue('performance.compression.loopbackBypass', 'auto');
    }
    return 'auto';
}

/**
 * Determines whether dynamic compression should be skipped for a loopback request.
 * @param {import('express').Request} request Express request
 * @param {object} [options]
 * @param {unknown} [options.loopbackBypass] Explicit bypass setting (`auto`, `true`, `false`)
 * @param {NodeJS.ProcessEnv} [options.env] Environment variables
 * @returns {boolean}
 */
export function shouldBypassLoopbackCompression(request, { loopbackBypass, env = process.env } = {}) {
    if (env?.[TEST_COMPRESSION_ENV_KEY] === '1') {
        return false;
    }

    const setting = readLoopbackBypassSetting(loopbackBypass, env);
    if (setting === false) {
        return false;
    }

    const normalized = String(setting ?? 'auto').trim().toLowerCase();
    if (normalized === 'false' || normalized === 'off' || normalized === '0' || normalized === 'never') {
        return false;
    }

    return isDirectLoopbackRequest(request);
}

function stripBrotliWhenGzipAccepted(acceptEncoding) {
    const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(', ') : String(acceptEncoding || '');
    if (!raw || !/\bgzip\b/i.test(raw) || !/\bbr\b/i.test(raw)) {
        return null;
    }

    const filtered = raw
        .split(',')
        .map(part => part.trim())
        .filter((part) => {
            if (!part) {
                return false;
            }
            const token = part.split(';', 1)[0].trim().toLowerCase();
            if (token !== 'br') {
                return true;
            }
            return /;\s*q\s*=\s*0(?:\.0+)?\s*$/i.test(part);
        });

    return filtered.length > 0 ? filtered.join(', ') : null;
}

function parseEncodingQuality(rawHeader, encodingName) {
    const parts = String(rawHeader || '').split(',');
    let wildcardQuality = null;

    for (const rawPart of parts) {
        const part = rawPart.trim();
        if (!part) {
            continue;
        }
        const [rawName, ...params] = part.split(';');
        const name = rawName.trim().toLowerCase();
        let quality = 1;
        for (const param of params) {
            const match = /^\s*q\s*=\s*(\d+(?:\.\d+)?)\s*$/i.exec(param);
            if (match) {
                quality = Number(match[1]);
            }
        }
        if (name === encodingName) {
            return quality;
        }
        if (name === '*') {
            wildcardQuality = quality;
        }
    }

    return wildcardQuality ?? 0;
}

/**
 * Selects the preferred static encoding (`br` on Node, `gzip` on Bun) from `Accept-Encoding`.
 * @param {string | string[] | undefined} acceptEncoding Raw header
 * @param {object} [options]
 * @param {boolean} [options.preferGzip] Prefer gzip over brotli
 * @returns {'br' | 'gzip' | null}
 */
export function negotiateStaticEncoding(acceptEncoding, { preferGzip = isBunRuntime() } = {}) {
    const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(', ') : String(acceptEncoding || '');
    if (!raw) {
        return null;
    }

    const brQuality = parseEncodingQuality(raw, 'br');
    const gzipQuality = parseEncodingQuality(raw, 'gzip');
    const order = preferGzip ? ['gzip', 'br'] : ['br', 'gzip'];

    for (const candidate of order) {
        const quality = candidate === 'br' ? brQuality : gzipQuality;
        if (quality > 0) {
            return /** @type {'br' | 'gzip'} */ (candidate);
        }
    }

    return null;
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @returns {number}
 */
export function getDefaultStaticCompressionCacheMaxBytes({ env = process.env, platform = process.platform } = {}) {
    const isAndroid = platform === 'android'
        || env?.SILLYBUNNY_ANDROID_APP === '1'
        || isNativeTermuxEnvironment();
    return isAndroid ? ANDROID_STATIC_COMPRESSION_CACHE_BYTES : DESKTOP_STATIC_COMPRESSION_CACHE_BYTES;
}

/**
 * Builds the lookup key for a static compressed asset.
 * @param {string} filePath Absolute or normalized path
 * @param {number} size Byte length of uncompressed file
 * @param {number} mtimeMs Modification timestamp in ms
 * @param {'br' | 'gzip'} encoding Compression encoding
 * @returns {string}
 */
export function buildStaticCompressionCacheKey(filePath, size, mtimeMs, encoding) {
    return `${path.resolve(filePath)}|${size}|${Math.trunc(mtimeMs)}|${encoding}`;
}

/**
 * Bounded in-memory LRU cache for pre-compressed static asset buffers.
 * Entries are keyed by `(path, size, mtimeMs, encoding)` and computed asynchronously
 * off the critical request path so cache misses never stall response delivery.
 * @param {object} [options]
 * @param {number} [options.maxBytes] Maximum total compressed bytes retained in memory
 * @param {number} [options.minBytes] Minimum uncompressed file size eligible for caching
 * @param {number} [options.brotliQuality] Brotli quality for background static compression
 * @param {number} [options.gzipLevel] Gzip level for background static compression
 */
export function createStaticCompressionCache({
    maxBytes = getDefaultStaticCompressionCacheMaxBytes(),
    minBytes = DEFAULT_COMPRESSION_THRESHOLD_BYTES,
    brotliQuality = 5,
    gzipLevel = 6,
} = {}) {
    /** @type {Map<string, { buffer: Buffer, encoding: 'br' | 'gzip', etag: string, size: number, mtimeMs: number, pathSlotKey: string }>} */
    const entries = new Map();
    /** @type {Map<string, string>} Maps `${resolvedPath}|${encoding}` -> active cache key so stale mtimes evict immediately */
    const activeKeyByPathEncoding = new Map();
    /** @type {Map<string, Promise<{ buffer: Buffer, encoding: 'br' | 'gzip', etag: string, size: number, mtimeMs: number } | null>>} */
    const inFlight = new Map();

    let bytesUsed = 0;
    let hits = 0;
    let misses = 0;

    function deleteKey(key) {
        const existing = entries.get(key);
        if (!existing) {
            return;
        }
        entries.delete(key);
        bytesUsed = Math.max(0, bytesUsed - existing.buffer.byteLength);
        if (activeKeyByPathEncoding.get(existing.pathSlotKey) === key) {
            activeKeyByPathEncoding.delete(existing.pathSlotKey);
        }
    }

    function get(filePath, { size, mtimeMs }, encoding) {
        const key = buildStaticCompressionCacheKey(filePath, size, mtimeMs, encoding);
        const entry = entries.get(key);
        if (!entry) {
            misses += 1;
            return null;
        }

        // Refresh Map insertion order for O(1) LRU promotion.
        entries.delete(key);
        entries.set(key, entry);
        hits += 1;
        return entry;
    }

    function set(filePath, { size, mtimeMs }, encoding, compressedBuffer) {
        if (!Buffer.isBuffer(compressedBuffer) || size < minBytes) {
            return null;
        }
        if (compressedBuffer.byteLength >= size || compressedBuffer.byteLength > maxBytes) {
            return null;
        }

        const resolvedPath = path.resolve(filePath);
        const pathSlotKey = `${resolvedPath}|${encoding}`;
        const previousKey = activeKeyByPathEncoding.get(pathSlotKey);
        const key = buildStaticCompressionCacheKey(resolvedPath, size, mtimeMs, encoding);

        if (previousKey && previousKey !== key) {
            deleteKey(previousKey);
        }
        if (entries.has(key)) {
            deleteKey(key);
        }

        while (bytesUsed + compressedBuffer.byteLength > maxBytes && entries.size > 0) {
            const oldestKey = entries.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            deleteKey(oldestKey);
        }

        if (bytesUsed + compressedBuffer.byteLength > maxBytes) {
            return null;
        }

        const truncatedMtime = Math.trunc(mtimeMs);
        const entry = {
            buffer: compressedBuffer,
            encoding,
            etag: `"${size.toString(16)}-${truncatedMtime.toString(16)}-${encoding}"`,
            size,
            mtimeMs: truncatedMtime,
            pathSlotKey,
        };
        entries.set(key, entry);
        activeKeyByPathEncoding.set(pathSlotKey, key);
        bytesUsed += compressedBuffer.byteLength;
        return entry;
    }

    function warm(filePath, { size, mtimeMs }, encoding, rawBuffer) {
        if (size < minBytes || maxBytes <= 0) {
            return Promise.resolve(null);
        }

        const key = buildStaticCompressionCacheKey(filePath, size, mtimeMs, encoding);
        const existing = entries.get(key);
        if (existing) {
            return Promise.resolve(existing);
        }

        const pending = inFlight.get(key);
        if (pending) {
            return pending;
        }

        const job = (async () => {
            try {
                const sourceBuffer = rawBuffer ?? await fs.promises.readFile(filePath);
                if (sourceBuffer.byteLength < minBytes) {
                    return null;
                }
                const compressed = encoding === 'br'
                    ? await brotliCompressAsync(sourceBuffer, {
                        params: {
                            [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: sourceBuffer.byteLength,
                        },
                    })
                    : await gzipAsync(sourceBuffer, { level: gzipLevel });

                return set(filePath, { size: sourceBuffer.byteLength, mtimeMs }, encoding, compressed);
            } catch {
                return null;
            } finally {
                inFlight.delete(key);
            }
        })();

        inFlight.set(key, job);
        return job;
    }

    function clear() {
        entries.clear();
        activeKeyByPathEncoding.clear();
        inFlight.clear();
        bytesUsed = 0;
    }

    function stats() {
        return {
            bytesUsed,
            maxBytes,
            entries: entries.size,
            inFlight: inFlight.size,
            hits,
            misses,
        };
    }

    return {
        get,
        set,
        warm,
        clear,
        stats,
    };
}

let defaultStaticCompressionCache = null;

export function getDefaultStaticCompressionCache() {
    defaultStaticCompressionCache ??= createStaticCompressionCache();
    return defaultStaticCompressionCache;
}

function resolveStaticTargetPath(rootDir, requestPath) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(String(requestPath || '/'));
    } catch {
        return null;
    }

    if (decodedPath.includes('\0')) {
        return null;
    }

    const resolvedRoot = path.resolve(rootDir);
    const candidate = path.resolve(resolvedRoot, `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`);
    const relative = path.relative(resolvedRoot, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
    }

    return candidate;
}

/**
 * Express middleware that serves pre-compressed static files from a bounded LRU cache
 * and warms misses asynchronously in the background without blocking the first response.
 * @param {string} rootDir Static root directory
 * @param {object} [options]
 * @param {ReturnType<typeof createStaticCompressionCache>} [options.cache]
 * @param {unknown} [options.loopbackBypass]
 * @param {boolean} [options.preferGzip]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(res: import('express').Response, filePath: string, stat: fs.Stats) => void} [options.setHeaders]
 * @returns {import('express').RequestHandler}
 */
export function createCompressedStaticMiddleware(rootDir, {
    cache = getDefaultStaticCompressionCache(),
    loopbackBypass,
    preferGzip = isBunRuntime(),
    env = process.env,
    setHeaders,
} = {}) {
    return function compressedStaticMiddleware(request, response, next) {
        if ((request.method !== 'GET' && request.method !== 'HEAD') || request.headers?.range) {
            return next();
        }

        if (shouldBypassLoopbackCompression(request, { loopbackBypass, env })) {
            return next();
        }

        const targetPath = resolveStaticTargetPath(rootDir, request.path);
        if (!targetPath) {
            return next();
        }

        const ext = path.extname(targetPath).toLowerCase();
        if (!STATIC_COMPRESSIBLE_EXTENSIONS.has(ext)) {
            return next();
        }

        let fileStat;
        try {
            fileStat = fs.statSync(targetPath);
        } catch {
            return next();
        }

        if (!fileStat.isFile()) {
            return next();
        }

        appendVaryAcceptEncoding(response);

        const encoding = negotiateStaticEncoding(request.headers?.['accept-encoding'], { preferGzip });
        if (!encoding) {
            return next();
        }

        const cached = cache.get(targetPath, fileStat, encoding);
        if (!cached) {
            void cache.warm(targetPath, fileStat, encoding);
            return next();
        }

        if (typeof setHeaders === 'function') {
            setHeaders(response, targetPath, fileStat);
        }
        if (hasCacheDirective(response, 'no-transform')) {
            return next();
        }

        const contentType = mime.contentType(ext);
        if (contentType && !response.getHeader('Content-Type')) {
            response.setHeader('Content-Type', contentType);
        }
        response.setHeader('ETag', cached.etag);
        response.setHeader('Last-Modified', fileStat.mtime.toUTCString());

        const ifNoneMatch = request.headers?.['if-none-match'];
        if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').map(tag => tag.trim()).includes(cached.etag)) {
            response.status(304);
            return response.end();
        }

        response.setHeader('Content-Encoding', cached.encoding);
        response.setHeader('Content-Length', String(cached.buffer.byteLength));
        if (request.method === 'HEAD') {
            return response.end();
        }

        return response.end(cached.buffer);
    };
}

/**
 * Keeps generic response compression away from live streams and no-transform responses.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @returns {boolean}
 */
export function shouldCompressResponse(request, response) {
    const contentType = getHeaderValue(response, 'Content-Type').toLowerCase();
    if (contentType.split(';', 1)[0].trim() === 'text/event-stream') {
        return false;
    }

    if (hasCacheDirective(response, 'no-transform')) {
        return false;
    }

    return compression.filter(request, response);
}

/**
 * Creates dynamic response compression middleware with direct-loopback bypass,
 * 2048-byte threshold, Brotli Q1 on Node.js, and Gzip L1 on Bun.
 * @param {object} [options]
 * @param {unknown} [options.loopbackBypass] Override `performance.compression.loopbackBypass`
 * @param {number} [options.threshold] Minimum payload byte length to compress
 * @param {boolean} [options.preferGzip] Prefer Gzip L1 over Brotli (defaults to true on Bun)
 * @param {NodeJS.ProcessEnv} [options.env] Environment variables
 * @returns {import('express').RequestHandler}
 */
export default function getResponseCompressionMiddleware({
    loopbackBypass,
    threshold = DEFAULT_COMPRESSION_THRESHOLD_BYTES,
    preferGzip = isBunRuntime(),
    env = process.env,
} = {}) {
    const dynamicCompression = compression({
        filter: shouldCompressResponse,
        threshold,
        level: zlib.constants.Z_BEST_SPEED,
        brotli: {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 1,
            },
        },
    });

    return function responseCompressionMiddleware(request, response, next) {
        if (shouldBypassLoopbackCompression(request, { loopbackBypass, env })) {
            return next();
        }

        if (preferGzip) {
            const strippedAcceptEncoding = stripBrotliWhenGzipAccepted(request.headers?.['accept-encoding']);
            if (strippedAcceptEncoding) {
                // Present a view without `br` to `compression` without mutating `request.headers`
                // for downstream routes such as `/proxy/*`.
                const negotiatorRequest = Object.create(request, {
                    headers: {
                        value: {
                            ...request.headers,
                            'accept-encoding': strippedAcceptEncoding,
                        },
                    },
                });
                return dynamicCompression(negotiatorRequest, response, () => next());
            }
        }

        return dynamicCompression(request, response, next);
    };
}
