import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

import compression from 'compression';

const DEFAULT_COMPRESSION_THRESHOLD = 1024;
const DEFAULT_ZSTD_LEVEL = 1;

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
    if (typeof response.vary === 'function') {
        response.vary('Accept-Encoding');
        return;
    }

    const current = getHeaderValue(response, 'Vary');
    const tokens = current
        ? current.split(',').map(part => part.trim()).filter(Boolean)
        : [];
    if (!tokens.some(token => token.toLowerCase() === 'accept-encoding')) {
        tokens.push('Accept-Encoding');
        response.setHeader('Vary', tokens.join(', '));
    }
}

/**
 * Feature-detects native zstd compression support on Bun 1.4+ or Node 22.15+/24+.
 * @returns {boolean}
 */
export function isZstdSupported() {
    return typeof globalThis.Bun?.zstdCompress === 'function'
        || typeof zlib.zstdCompress === 'function'
        || typeof zlib.createZstdCompress === 'function';
}

/**
 * Parses an HTTP Accept-Encoding header into a coding -> quality map.
 * @param {string | string[] | undefined} headerValue
 * @returns {Map<string, number>}
 */
export function parseAcceptEncoding(headerValue) {
    const qualities = new Map();
    const raw = Array.isArray(headerValue) ? headerValue.join(',') : String(headerValue ?? '');
    if (!raw.trim()) {
        return qualities;
    }

    for (const part of raw.split(',')) {
        const segments = part.split(';').map(segment => segment.trim()).filter(Boolean);
        if (segments.length === 0) {
            continue;
        }
        const coding = segments[0].toLowerCase();
        let quality = 1;
        for (let i = 1; i < segments.length; i++) {
            const match = /^q\s*=\s*([0-9]*\.?[0-9]+)$/i.exec(segments[i]);
            if (match) {
                const parsed = Number(match[1]);
                if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
                    quality = parsed;
                }
            }
        }
        const existing = qualities.get(coding);
        if (existing === undefined || quality > existing) {
            qualities.set(coding, quality);
        }
    }

    return qualities;
}

/**
 * Negotiates the preferred response encoding for a client's Accept-Encoding header.
 * Native zstd is chosen only when the client ranks it strictly above both brotli and gzip.
 * At equal quality zstd at the speed-oriented level used here sends more bytes than either of
 * them, so every other case is left to the `compression` package (brotli, gzip or deflate).
 * @param {string | string[] | undefined} acceptEncodingHeader
 * @param {{ zstdSupported?: boolean }} [options]
 * @returns {'zstd' | 'br' | 'gzip' | null}
 */
export function negotiateCompressionEncoding(acceptEncodingHeader, { zstdSupported = isZstdSupported() } = {}) {
    const qualities = parseAcceptEncoding(acceptEncodingHeader);
    if (qualities.size === 0) {
        return null;
    }

    const wildcardQ = qualities.get('*') ?? 0;
    const zstdQ = qualities.has('zstd') ? qualities.get('zstd') : 0;
    const brQ = qualities.has('br') ? qualities.get('br') : wildcardQ;
    const gzipQ = qualities.has('gzip') ? qualities.get('gzip') : wildcardQ;

    if (zstdSupported && zstdQ > 0 && zstdQ > brQ && zstdQ > gzipQ) {
        return 'zstd';
    }
    if (brQ > 0 && brQ >= gzipQ) {
        return 'br';
    }
    if (gzipQ > 0) {
        return 'gzip';
    }

    return null;
}

/**
 * Compresses a Buffer with native zstd using Bun.zstdCompress or node:zlib.zstdCompress.
 * @param {Buffer} buffer
 * @param {number} [level=1]
 * @returns {Promise<Buffer>}
 */
export async function compressZstdBuffer(buffer, level = DEFAULT_ZSTD_LEVEL) {
    if (typeof globalThis.Bun?.zstdCompress === 'function') {
        const compressed = await globalThis.Bun.zstdCompress(buffer, { level });
        return Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed);
    }

    if (typeof zlib.zstdCompress === 'function') {
        const zstdOptions = zlib.constants?.ZSTD_c_compressionLevel !== undefined
            ? { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }
            : {};
        return await new Promise((resolve, reject) => {
            zlib.zstdCompress(buffer, zstdOptions, (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            });
        });
    }

    if (typeof zlib.createZstdCompress === 'function') {
        return await new Promise((resolve, reject) => {
            const stream = createZstdStream(level);
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
            stream.end(buffer);
        });
    }

    throw new Error('Native zstd compression is not available in this runtime.');
}

function createZstdStream(level = DEFAULT_ZSTD_LEVEL) {
    const zstdOptions = zlib.constants?.ZSTD_c_compressionLevel !== undefined
        ? { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }
        : {};
    return zlib.createZstdCompress(zstdOptions);
}

function toBuffer(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    }
    return Buffer.alloc(0);
}

function parseContentLength(response) {
    const raw = getHeaderValue(response, 'Content-Length').trim();
    if (!raw) {
        return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Keeps generic response compression away from live streams.
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

function createZstdResponseMiddleware(fallbackMiddleware, { threshold = DEFAULT_COMPRESSION_THRESHOLD, level = DEFAULT_ZSTD_LEVEL } = {}) {
    return function responseCompressionMiddleware(request, response, next) {
        if (request.method === 'HEAD' || negotiateCompressionEncoding(request.headers?.['accept-encoding']) !== 'zstd') {
            return fallbackMiddleware(request, response, next);
        }

        const origWrite = response.write;
        const origEnd = response.end;
        const origWriteHead = response.writeHead;
        const origFlush = response.flush;

        let decided = false;
        let passthrough = false;
        let zstdStream = null;
        let bufferedChunks = null;
        let streamEnded = false;
        let upstreamWaitingForDrain = false;
        let downstreamPaused = false;
        let emittingUpstreamDrain = false;

        const canCompress = (sizeHint, isFinalSingleShot) => {
            if (response.statusCode < 200 || response.statusCode === 204 || response.statusCode === 304) {
                return false;
            }
            if (getHeaderValue(response, 'Content-Encoding')) {
                return false;
            }
            if (!shouldCompressResponse(request, response)) {
                return false;
            }
            const declaredLength = parseContentLength(response);
            if (isFinalSingleShot) {
                const effectiveSize = sizeHint ?? declaredLength ?? 0;
                if (effectiveSize < threshold) {
                    return false;
                }
            } else if (declaredLength !== null && declaredLength < threshold) {
                return false;
            }
            return true;
        };

        const cleanupStream = () => {
            if (zstdStream && !streamEnded) {
                streamEnded = true;
                zstdStream.destroy();
            }
        };

        const initStreamingZstd = () => {
            appendVaryAcceptEncoding(response);
            response.removeHeader('Content-Length');
            response.setHeader('Content-Encoding', 'zstd');

            if (typeof zlib.createZstdCompress === 'function') {
                zstdStream = createZstdStream(level);
                zstdStream.on('data', compressedChunk => {
                    if (origWrite.call(response, compressedChunk) === false) {
                        downstreamPaused = true;
                        zstdStream.pause();
                    }
                });
                zstdStream.on('drain', () => {
                    if (!upstreamWaitingForDrain) {
                        return;
                    }
                    upstreamWaitingForDrain = false;
                    emittingUpstreamDrain = true;
                    try {
                        response.emit('drain');
                    } finally {
                        emittingUpstreamDrain = false;
                    }
                });
                zstdStream.on('end', () => {
                    streamEnded = true;
                    origEnd.call(response);
                });
                zstdStream.on('error', () => {
                    streamEnded = true;
                    if (!response.writableEnded) {
                        origEnd.call(response);
                    }
                });
                response.on('drain', () => {
                    if (emittingUpstreamDrain || !downstreamPaused) {
                        return;
                    }
                    downstreamPaused = false;
                    zstdStream?.resume();
                });
                response.on('close', cleanupStream);
            } else {
                bufferedChunks = [];
            }
        };

        response.writeHead = function zstdWriteHead(statusCode, reasonPhrase, headers) {
            let headerArg = headers;
            let reasonArg = reasonPhrase;
            if (reasonPhrase && typeof reasonPhrase === 'object') {
                headerArg = reasonPhrase;
                reasonArg = undefined;
            }

            if (headerArg && typeof headerArg === 'object') {
                if (Array.isArray(headerArg)) {
                    for (let i = 0; i + 1 < headerArg.length; i += 2) {
                        response.setHeader(headerArg[i], headerArg[i + 1]);
                    }
                } else {
                    for (const [key, value] of Object.entries(headerArg)) {
                        if (value !== undefined) {
                            response.setHeader(key, value);
                        }
                    }
                }
            }

            response.statusCode = statusCode;

            if (!decided) {
                decided = true;
                if (canCompress(null, false)) {
                    initStreamingZstd();
                } else {
                    passthrough = true;
                }
            }

            if (!passthrough) {
                response.removeHeader('Content-Length');
            }

            if (reasonArg !== undefined) {
                return origWriteHead.call(this, statusCode, reasonArg);
            }
            return origWriteHead.call(this, statusCode);
        };

        response.write = function zstdWrite(chunk, encoding, callback) {
            if (!decided) {
                decided = true;
                const chunkLen = chunk ? toBuffer(chunk, encoding).length : 0;
                if (canCompress(chunkLen, false)) {
                    initStreamingZstd();
                } else {
                    passthrough = true;
                }
            }

            if (passthrough) {
                return origWrite.call(this, chunk, encoding, callback);
            }

            if (zstdStream) {
                const canContinue = zstdStream.write(chunk, encoding, callback);
                if (!canContinue) {
                    upstreamWaitingForDrain = true;
                }
                return canContinue;
            }

            if (chunk) {
                bufferedChunks.push(toBuffer(chunk, encoding));
            }
            if (typeof encoding === 'function') {
                encoding();
            } else if (typeof callback === 'function') {
                callback();
            }
            return true;
        };

        response.end = function zstdEnd(chunk, encoding, callback) {
            let actualChunk = chunk;
            let actualEncoding = encoding;
            let actualCallback = callback;
            if (typeof actualChunk === 'function') {
                actualCallback = actualChunk;
                actualChunk = undefined;
                actualEncoding = undefined;
            } else if (typeof actualEncoding === 'function') {
                actualCallback = actualEncoding;
                actualEncoding = undefined;
            }

            // Single-shot fast path (res.json / res.send) using native async zstdCompress.
            if (!decided) {
                decided = true;
                const payload = actualChunk !== undefined && actualChunk !== null
                    ? toBuffer(actualChunk, actualEncoding)
                    : Buffer.alloc(0);

                if (payload.length === 0 || !canCompress(payload.length, true)) {
                    passthrough = true;
                    return origEnd.call(this, chunk, encoding, callback);
                }

                appendVaryAcceptEncoding(response);
                response.removeHeader('Content-Length');
                response.setHeader('Content-Encoding', 'zstd');

                compressZstdBuffer(payload, level)
                    .then(compressed => {
                        if (response.destroyed) {
                            actualCallback?.();
                            return;
                        }
                        origWrite.call(this, compressed);
                        origEnd.call(this, actualCallback);
                    })
                    .catch(() => {
                        if (response.destroyed) {
                            actualCallback?.();
                            return;
                        }
                        if (!response.headersSent) {
                            response.removeHeader('Content-Encoding');
                        }
                        origEnd.call(this, payload, actualCallback);
                    });
                return this;
            }

            if (passthrough) {
                return origEnd.call(this, chunk, encoding, callback);
            }

            if (zstdStream) {
                if (actualCallback) {
                    response.once('finish', actualCallback);
                }
                if (actualChunk !== undefined && actualChunk !== null) {
                    zstdStream.end(actualChunk, actualEncoding);
                } else {
                    zstdStream.end();
                }
                return this;
            }

            if (actualChunk !== undefined && actualChunk !== null) {
                bufferedChunks.push(toBuffer(actualChunk, actualEncoding));
            }
            const combined = Buffer.concat(bufferedChunks);
            compressZstdBuffer(combined, level)
                .then(compressed => {
                    if (response.destroyed) {
                        actualCallback?.();
                        return;
                    }
                    origWrite.call(this, compressed);
                    origEnd.call(this, actualCallback);
                })
                .catch(() => {
                    if (!response.destroyed) {
                        origEnd.call(this, actualCallback);
                    }
                });
            return this;
        };

        response.flush = function zstdFlush() {
            if (zstdStream && typeof zstdStream.flush === 'function') {
                zstdStream.flush();
                return;
            }
            if (typeof origFlush === 'function') {
                origFlush.call(this);
            }
        };

        return next();
    };
}

export default function getResponseCompressionMiddleware(options = {}) {
    const fallbackMiddleware = compression({ filter: shouldCompressResponse });
    return createZstdResponseMiddleware(fallbackMiddleware, options);
}
