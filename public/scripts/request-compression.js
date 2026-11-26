import { gzip } from '/lib.js';

/**
 * @type {RequestCompressionConfig}
 *
 * @typedef {Object} RequestCompressionConfig
 * @property {boolean} enabled Whether request compression is enabled.
 * @property {number} minPayloadSize Minimum payload size in bytes to trigger compression.
 * @property {number} maxPayloadSize Hard upper payload size limit for compression.
 * @property {number} timeout Timeout for request compression in milliseconds.
 */
const requestCompressionConfig = {
    enabled: false,
    minPayloadSize: 0,
    maxPayloadSize: 0,
    timeout: 0,
};

/**
 * Sets the configuration for request compression from the server.
 * @param {RequestCompressionConfig} config Configuration object for request compression
 */
export function setRequestCompressionConfig(config) {
    Object.assign(requestCompressionConfig, (config ?? {}));
}

/**
 * Checks whether native off-main-thread CompressionStream('gzip') is available.
 * @returns {boolean}
 */
// SillyBunny: prefer native CompressionStream('gzip') off the main thread when available, falling back to fflate.
function canUseNativeCompressionStream() {
    return typeof globalThis.CompressionStream === 'function'
        && typeof globalThis.Response === 'function';
}

/**
 * Compresses a Uint8Array using native off-main-thread CompressionStream('gzip').
 * @param {Uint8Array<ArrayBuffer>} input Uint8Array to compress
 * @returns {{ promise: Promise<Uint8Array<ArrayBuffer>>, terminate: () => void }}
 */
function gzipBufferNative(input) {
    let aborted = false;
    const stream = new globalThis.CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const promise = (async () => {
        const readPromise = new globalThis.Response(stream.readable).arrayBuffer();
        await writer.write(input);
        await writer.close();
        const arrayBuffer = await readPromise;
        if (aborted) {
            throw new Error('compress_native_gzip_aborted');
        }
        return new Uint8Array(arrayBuffer);
    })();
    const terminate = () => {
        aborted = true;
        writer.abort().catch(() => {});
    };
    return { promise, terminate };
}

/**
 * Compresses a Uint8Array using fflate gzip fallback.
 * @param {Uint8Array<ArrayBuffer>} input Uint8Array to compress
 * @returns {{ promise: Promise<Uint8Array<ArrayBuffer>>, terminate: () => void }} Gzip-compressed Uint8Array promise and a terminate function.
 */
function gzipBuffer(input) {
    let terminate = () => {};
    const promise = new Promise((resolve, reject) => {
        try {
            terminate = gzip(input, (error, compressed) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(new Uint8Array(compressed));
            });
        } catch (error) {
            reject(error);
        }
    });
    return { promise, terminate };
}

/**
 * Wraps a promise with a timeout, rejecting if the promise does not settle within the specified time.
 * Note: timeout does not cancel the underlying compression task; it only stops waiting for it.
 * @param {Promise<T>} promise Promise to wrap with a timeout
 * @param {number} timeoutMs Timeout in milliseconds
 * @param {string} label Used for error message if timeout occurs
 * @returns {Promise<T>} Resolves with the original promise's value if it settles in time, otherwise rejects with a timeout error
 * @template T Type of the promise's resolved value
 */
async function withTimeout(promise, timeoutMs, label) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Compresses a fetch request using gzip when supported and worthwhile.
 * Compression is skipped when feature-toggle is disabled, body is too small,
 * body is not a string, or compression fails/timeouts.
 *
 * @param {RequestInit} request fetch request parameters
 * @returns {Promise<RequestInit>} A request init object that may include gzip-compressed body
 */
export async function compressRequest(request) {
    const plainRequest = { ...request };
    const requestBody = plainRequest?.body;

    if (!requestCompressionConfig.enabled) {
        return plainRequest;
    }

    if (!requestBody || typeof requestBody !== 'string') {
        return plainRequest;
    }

    const textEncoder = new TextEncoder();
    const encodedBody = textEncoder.encode(requestBody);
    const bodySize = encodedBody.byteLength;
    const minBytes = Number(requestCompressionConfig.minPayloadSize) || 0;
    const maxBytes = Number(requestCompressionConfig.maxPayloadSize) || 0;

    if (bodySize < minBytes || (maxBytes > 0 && bodySize > maxBytes)) {
        return plainRequest;
    }

    // SillyBunny: use native CompressionStream('gzip') off the main thread when supported, falling back to fflate automatically.
    let compressedBody = null;
    if (canUseNativeCompressionStream()) {
        let nativeTerminate = () => {};
        try {
            const nativeTask = gzipBufferNative(encodedBody);
            nativeTerminate = nativeTask.terminate;
            compressedBody = await withTimeout(
                nativeTask.promise,
                requestCompressionConfig.timeout,
                'compress_native_gzip',
            );
        } catch (nativeError) {
            nativeTerminate();
            if (nativeError?.message === 'compress_native_gzip_timeout') {
                console.warn('Failed to compress request body, using plain request.', nativeError);
                return plainRequest;
            }
            // Fall through to fflate fallback when native CompressionStream fails or rejects gzip.
        }
    }

    if (compressedBody === null) {
        const { promise, terminate } = gzipBuffer(encodedBody);
        try {
            compressedBody = await withTimeout(
                promise,
                requestCompressionConfig.timeout,
                'compress_fflate_gzip',
            );
        } catch (error) {
            terminate();
            console.warn('Failed to compress request body, using plain request.', error);
            return plainRequest;
        }
    }

    if (!compressedBody || compressedBody.byteLength >= bodySize) {
        return plainRequest;
    }

    const headers = new Headers(plainRequest.headers ?? {});
    headers.set('Content-Encoding', 'gzip');

    return {
        ...plainRequest,
        headers,
        body: compressedBody,
    };
}
