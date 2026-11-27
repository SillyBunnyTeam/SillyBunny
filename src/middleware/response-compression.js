import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import compression from 'compression';
import mime from 'mime-types';

import { hasForwardingHeaders, isLoopbackAddress } from '../loopback-request.js';
import { isBunRuntime, isNativeTermuxEnvironment } from '../runtime.js';
import { getConfigValue } from '../util.js';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

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

/**
 * True only when the TCP peer is loopback and no reverse-proxy header is present.
 * A local reverse proxy (nginx/Caddy/Cloudflare Tunnel) connects over loopback on behalf
 * of remote clients, so any forwarding header disqualifies the loopback bypass. The
 * address and header tests are the ones `requireHttps` uses for its local exemption.
 * The address is read from the socket instead of `request.ip` because `request.ip`
 * follows `X-Forwarded-For` once `trust proxy` is enabled, and a client must never be
 * able to name itself loopback to switch compression off.
 * @param {import('express').Request} request Express request
 * @returns {boolean}
 */
export function isDirectLoopbackRequest(request) {
    return isLoopbackAddress(request?.socket?.remoteAddress) && !hasForwardingHeaders(request);
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
                let effectiveSize = sourceBuffer.byteLength;
                let effectiveMtimeMs = mtimeMs;
                if (!rawBuffer) {
                    if (sourceBuffer.byteLength !== size) {
                        return null;
                    }
                    const currentStat = await fs.promises.stat(filePath);
                    if (currentStat.size !== size || Math.trunc(currentStat.mtimeMs) !== Math.trunc(mtimeMs)) {
                        return null;
                    }
                    effectiveSize = currentStat.size;
                    effectiveMtimeMs = currentStat.mtimeMs;
                }
                const compressed = encoding === 'br'
                    ? await brotliCompressAsync(sourceBuffer, {
                        params: {
                            [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: sourceBuffer.byteLength,
                        },
                    })
                    : await gzipAsync(sourceBuffer, { level: gzipLevel });

                return set(filePath, { size: effectiveSize, mtimeMs: effectiveMtimeMs }, encoding, compressed);
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

// Same pattern that `send` (behind `express.static`) uses to refuse a path that climbs out of the root.
const PARENT_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Maps a request path to a file under `rootDir`, or returns `null` for any path that
 * `express.static` with default options would not serve as that file. The cache must not
 * answer where the static handler refuses, or the answer would depend on whether the
 * cache is warm.
 * @param {string} rootDir Static root directory
 * @param {string} requestPath Request path relative to the mount point
 * @returns {string | null}
 */
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

    // A trailing slash asks `send` for `<path>/index.html`, never for the file itself.
    if (decodedPath.endsWith('/') || decodedPath.endsWith(path.sep)) {
        return null;
    }

    // Normalize first and refuse what is left of `..`, as `send` does. Resolving against the
    // root and then checking containment would accept `/x/../../<root name>/file`.
    const relativePath = path.normalize(`.${path.sep}${decodedPath}`);
    if (PARENT_SEGMENT_RE.test(relativePath)) {
        return null;
    }

    // `send` hides a file whose last segment starts with a dot (the legacy dotfile rule); a
    // dot in a directory name is allowed.
    if (path.basename(relativePath).startsWith('.')) {
        return null;
    }

    const resolvedRoot = path.resolve(rootDir);
    const candidate = path.normalize(path.join(resolvedRoot, relativePath));
    const relative = path.relative(resolvedRoot, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
    }

    return candidate;
}

function probeStaticHeaders(response, setHeaders, targetPath, fileStat) {
    if (typeof setHeaders !== 'function') {
        return { noTransform: hasCacheDirective(response, 'no-transform'), apply: () => {} };
    }

    const ops = [];
    const staged = new Map();
    const recorder = {
        setHeader(name, value) {
            staged.set(String(name).toLowerCase(), value);
            ops.push(['setHeader', name, value]);
            return this;
        },
        getHeader(name) {
            const key = String(name).toLowerCase();
            return staged.has(key) ? staged.get(key) : response.getHeader?.(name);
        },
        removeHeader(name) {
            staged.delete(String(name).toLowerCase());
            ops.push(['removeHeader', name]);
            return this;
        },
        set(field, value) {
            if (typeof field === 'string') {
                return this.setHeader(field, value);
            }
            if (field && typeof field === 'object') {
                for (const [key, val] of Object.entries(field)) {
                    this.setHeader(key, val);
                }
            }
            return this;
        },
    };

    setHeaders(recorder, targetPath, fileStat);
    const noTransform = hasCacheDirective(recorder, 'no-transform');

    return {
        noTransform,
        apply() {
            for (const [op, name, value] of ops) {
                if (op === 'setHeader') {
                    response.setHeader(name, value);
                } else {
                    response.removeHeader?.(name);
                }
            }
        },
    };
}

function matchesIfNoneMatch(ifNoneMatchHeader, etag) {
    if (typeof ifNoneMatchHeader !== 'string' || !ifNoneMatchHeader.trim()) {
        return false;
    }

    const stripWeak = tag => tag.trim().replace(/^W\//, '');
    const target = stripWeak(etag);
    for (const rawTag of ifNoneMatchHeader.split(',')) {
        const trimmed = rawTag.trim();
        if (trimmed === '*' || stripWeak(trimmed) === target) {
            return true;
        }
    }

    return false;
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
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return next();
        }

        // Range and the two preconditions that can answer 206 or 412 are decided by `send`;
        // the cache would answer 200 for them.
        const requestHeaders = request.headers ?? {};
        if (requestHeaders.range || requestHeaders['if-match'] || requestHeaders['if-unmodified-since']) {
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

        const encoding = negotiateStaticEncoding(request.headers?.['accept-encoding'], { preferGzip });
        if (!encoding) {
            return next();
        }

        const headerProbe = probeStaticHeaders(response, setHeaders, targetPath, fileStat);
        if (headerProbe.noTransform) {
            return next();
        }

        const cached = cache.get(targetPath, fileStat, encoding);
        if (!cached) {
            appendVaryAcceptEncoding(response);
            void cache.warm(targetPath, fileStat, encoding);
            return next();
        }

        headerProbe.apply();
        appendVaryAcceptEncoding(response);

        const contentType = mime.contentType(ext);
        if (contentType && !response.getHeader('Content-Type')) {
            response.setHeader('Content-Type', contentType);
        }
        response.setHeader('ETag', cached.etag);
        response.setHeader('Last-Modified', fileStat.mtime.toUTCString());

        if (matchesIfNoneMatch(request.headers?.['if-none-match'], cached.etag)) {
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
 * Creates dynamic response compression middleware with a direct-loopback bypass and a
 * 2048-byte threshold. Gzip level and Brotli quality stay at the `compression` package
 * defaults on every runtime, so remote clients receive the same bytes as before.
 * @param {object} [options]
 * @param {unknown} [options.loopbackBypass] Override `performance.compression.loopbackBypass`
 * @param {number} [options.threshold] Minimum payload byte length to compress
 * @param {NodeJS.ProcessEnv} [options.env] Environment variables
 * @returns {import('express').RequestHandler}
 */
export default function getResponseCompressionMiddleware({
    loopbackBypass,
    threshold = DEFAULT_COMPRESSION_THRESHOLD_BYTES,
    env = process.env,
} = {}) {
    const dynamicCompression = compression({
        filter: shouldCompressResponse,
        threshold,
    });

    return function responseCompressionMiddleware(request, response, next) {
        if (shouldBypassLoopbackCompression(request, { loopbackBypass, env })) {
            return next();
        }

        return dynamicCompression(request, response, next);
    };
}
