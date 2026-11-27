/* global globalThis */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { forwardAsyncRouteErrors, handleRouteError } from '../../src/route-errors.js';
import { setConfigFilePath } from '../../src/util.js';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../default/config.yaml', import.meta.url));

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
let configInitialized = false;

/**
 * Ensures the server config path is set before any config-reading module loads.
 */
export function ensureDefaultConfigLoaded() {
    if (!configInitialized) {
        setConfigFilePath(DEFAULT_CONFIG_PATH);
        configInitialized = true;
    }
}

/**
 * Returns a distinct deterministic secret value for each SECRET_KEYS entry.
 * @param {string} secretKey Entry from SECRET_KEYS
 * @returns {string} Secret value used in contract tests
 */
export function testSecretFor(secretKey) {
    return `contract-secret-${secretKey}`;
}

/**
 * Seeds every provider API key into an isolated user secrets file.
 * @param {{ root: string, backups: string }} directories User directories
 * @returns {Promise<Record<string, string>>} Map of SECRET_KEYS values to seeded secret strings
 */
export async function seedAllProviderSecrets(directories) {
    ensureDefaultConfigLoaded();
    const { SECRET_KEYS, SecretManager } = await import('../../src/endpoints/secrets.js');
    const manager = new SecretManager(directories);
    /** @type {Record<string, string>} */
    const seeded = {};
    for (const [name, key] of Object.entries(SECRET_KEYS)) {
        if (name === '_MIGRATED') {
            continue;
        }
        const value = testSecretFor(key);
        manager.writeSecret(key, value, `Contract ${name}`);
        seeded[key] = value;
    }
    return seeded;
}

/**
 * Clones fetch headers into a plain object without mutating the caller's map.
 * @param {any} headers Headers object, Headers instance, or entries array
 * @returns {Record<string, string>} Plain header dictionary
 */
function cloneHeaders(headers) {
    /** @type {Record<string, string>} */
    const result = {};
    if (!headers) {
        return result;
    }
    if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
            result[key] = String(value);
        });
        return result;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            result[key] = String(value);
        }
        return result;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
            result[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }
    }
    return result;
}

/**
 * Wraps node-fetch so external URLs route to the local fake HTTP server while loopback URLs pass untouched.
 * Never permits a real external network connection.
 * @param {typeof import('node-fetch').default} actualFetch Real node-fetch function
 * @param {() => number | null} getUpstreamPort Returns the listening port of the local fake upstream
 * @param {{ allowRedirect?: boolean }} [options] When allowRedirect is false, throws on any non-loopback host
 * @returns {typeof import('node-fetch').default} Wrapped fetch function
 */
export function createLoopbackFetch(actualFetch, getUpstreamPort, { allowRedirect = true } = {}) {
    const wrappedFetch = (url, options = {}) => {
        const href = typeof url === 'string'
            ? url
            : url instanceof URL
                ? url.toString()
                : url?.url ?? String(url);
        const parsed = new URL(href);

        if (LOOPBACK_HOSTS.has(parsed.hostname)) {
            return actualFetch(url, options);
        }

        if (!allowRedirect) {
            throw new Error(`Blocked external network request in loopback-only test: ${parsed.toString()}`);
        }

        const upstreamPort = getUpstreamPort();
        if (!upstreamPort) {
            throw new Error(`Blocked external network request with no fake upstream running: ${parsed.toString()}`);
        }

        const rewrittenUrl = `http://127.0.0.1:${upstreamPort}${parsed.pathname}${parsed.search}`;
        const headers = cloneHeaders(options?.headers);
        headers['x-test-original-origin'] = parsed.origin;
        headers['x-test-original-url'] = parsed.toString();

        return actualFetch(rewrittenUrl, {
            ...options,
            headers,
        });
    };
    return /** @type {typeof import('node-fetch').default} */ (wrappedFetch);
}

/**
 * Reads an incoming Node HTTP stream into a UTF-8 string.
 * @param {import('node:http').IncomingMessage} req Incoming request
 * @returns {Promise<string>} Raw request body
 */
function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.once('error', reject);
    });
}

/**
 * Starts a scriptable local fake upstream HTTP server on 127.0.0.1 with an ephemeral port.
 * Records every request, streams chunks on demand, and tracks premature client aborts.
 * @returns {Promise<object>} Running fake upstream controller
 */
export async function startFakeUpstream() {
    /** @type {Array<object>} */
    const requests = [];
    /** @type {Set<import('node:net').Socket>} */
    const activeSockets = new Set();
    /** @type {Set<() => void>} */
    const pendingReleases = new Set();

    /** @type {((record: any, res: import('node:http').ServerResponse, req: import('node:http').IncomingMessage) => void | Promise<void>) | null} */
    let handler = null;

    const server = http.createServer(async (req, res) => {
        // Closing each upstream socket after its response prevents keep-alive handles from lingering in Jest.
        res.setHeader('Connection', 'close');

        let abortedResolve;
        const abortedPromise = new Promise((resolve) => {
            abortedResolve = resolve;
        });

        let rawBody = '';
        try {
            rawBody = await readRequestBody(req);
        } catch {
            // Client disconnected before sending the full body.
        }

        let jsonBody = null;
        if (rawBody) {
            try {
                jsonBody = JSON.parse(rawBody);
            } catch {
                jsonBody = null;
            }
        }

        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        const record = {
            method: req.method,
            url: req.url || '/',
            pathname: parsed.pathname,
            search: parsed.search,
            searchParams: parsed.searchParams,
            headers: { ...req.headers },
            originalOrigin: typeof req.headers['x-test-original-origin'] === 'string'
                ? req.headers['x-test-original-origin']
                : null,
            originalUrl: typeof req.headers['x-test-original-url'] === 'string'
                ? req.headers['x-test-original-url']
                : null,
            rawBody,
            jsonBody,
            aborted: false,
            finished: false,
            abortedPromise,
        };

        const markAborted = () => {
            if (!res.writableEnded && !record.aborted) {
                record.aborted = true;
                abortedResolve();
            }
        };

        res.once('close', markAborted);
        req.once('aborted', markAborted);
        req.socket?.once('close', markAborted);
        res.on('error', () => {
            markAborted();
        });
        res.once('finish', () => {
            record.finished = true;
        });

        requests.push(record);

        try {
            if (handler) {
                await handler(record, res, req);
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No fake upstream handler configured' } }));
            }
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            if (!res.writableEnded) {
                res.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
            }
        }
    });

    server.on('connection', (socket) => {
        activeSockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => activeSockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

    function releasePendingStreams() {
        for (const release of pendingReleases) {
            release();
        }
        pendingReleases.clear();
    }

    return {
        port,
        url: `http://127.0.0.1:${port}`,
        get requests() {
            return requests;
        },
        /**
         * Installs a custom handler for subsequent upstream requests.
         * @param {(record: any, res: import('node:http').ServerResponse, req: import('node:http').IncomingMessage) => void | Promise<void>} nextHandler
         */
        setHandler(nextHandler) {
            handler = nextHandler;
        },
        /**
         * Configures a static JSON response for every incoming request.
         * @param {number} status HTTP status code
         * @param {any} payload JSON payload
         * @param {Record<string, string>} [extraHeaders] Extra response headers
         */
        replyJson(status, payload, extraHeaders = {}) {
            this.setHandler((_record, res) => {
                res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
                res.end(JSON.stringify(payload));
            });
        },
        /**
         * Configures a static raw text response (useful for non-JSON error bodies).
         * @param {number} status HTTP status code
         * @param {string} text Response body text
         * @param {Record<string, string>} [extraHeaders] Extra response headers
         */
        replyText(status, text, extraHeaders = {}) {
            this.setHandler((_record, res) => {
                res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders });
                res.end(text);
            });
        },
        /**
         * Configures a chunked streaming response that flushes each chunk separately.
         * @param {string[]} chunks Ordered stream chunks
         * @param {{ status?: number, contentType?: string, extraHeaders?: Record<string, string>, chunkDelayMs?: number }} [options]
         */
        replyStream(chunks, { status = 200, contentType = 'text/event-stream', extraHeaders = {}, chunkDelayMs = 5 } = {}) {
            this.setHandler(async (_record, res) => {
                res.writeHead(status, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache',
                    ...extraHeaders,
                });
                for (const chunk of chunks) {
                    if (res.destroyed || res.writableEnded) {
                        return;
                    }
                    res.write(chunk);
                    await new Promise((resolve) => {
                        const timer = setTimeout(resolve, chunkDelayMs);
                        timer.unref?.();
                    });
                }
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
            });
        },
        /**
         * Configures a streaming response that writes an initial chunk then stays open until client abort or cleanup.
         * Auxiliary abort endpoints (such as KoboldCpp /api/extra/abort) are answered 200 immediately.
         * @param {string} initialChunk First chunk flushed to prove the stream is active
         * @param {{ contentType?: string, extraHeaders?: Record<string, string> }} [options]
         */
        replyHangingStream(initialChunk, { contentType = 'text/event-stream', extraHeaders = {} } = {}) {
            this.setHandler((record, res) => {
                if (record.pathname === '/api/extra/abort' || record.pathname === '/extra/abort') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: 'true', done: 'true' }));
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache',
                    ...extraHeaders,
                });
                res.write(initialChunk);

                const release = () => {
                    pendingReleases.delete(release);
                    if (!res.destroyed && !res.writableEnded) {
                        res.end();
                    }
                };
                pendingReleases.add(release);
                res.once('close', () => pendingReleases.delete(release));
            });
        },
        /**
         * Holds the upstream request open before sending response headers until client abort or cleanup.
         * @returns {{ waitUntilReceived: (timeoutMs?: number) => Promise<any> }} Helper that resolves with the recorded request once received
         */
        replyHangingBeforeHeaders() {
            let receivedResolve;
            let receivedRecord = null;
            const receivedPromise = new Promise((resolve) => {
                receivedResolve = resolve;
            });

            this.setHandler((record, res) => {
                if (record.pathname === '/api/extra/abort' || record.pathname === '/extra/abort') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: 'true', done: 'true' }));
                    return;
                }

                receivedRecord = record;
                receivedResolve(record);

                const release = () => {
                    pendingReleases.delete(release);
                    if (!res.destroyed && !res.writableEnded) {
                        if (!res.headersSent) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                        }
                        res.end('{}');
                    }
                };
                pendingReleases.add(release);
                res.once('close', () => pendingReleases.delete(release));
            });

            return {
                async waitUntilReceived(timeoutMs = 3000) {
                    if (receivedRecord) {
                        return receivedRecord;
                    }
                    return await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error(`Upstream did not receive request within ${timeoutMs}ms`)), timeoutMs);
                        timer.unref?.();
                        receivedPromise.then((record) => {
                            clearTimeout(timer);
                            resolve(record);
                        });
                    });
                },
            };
        },
        /**
         * Clears recorded requests and closes any open hanging streams.
         */
        reset() {
            releasePendingStreams();
            requests.length = 0;
            handler = null;
        },
        /**
         * Waits until the recorded upstream request detects a premature client disconnect.
         * @param {any} record Recorded request entry
         * @param {number} [timeoutMs] Maximum wait duration in milliseconds
         * @returns {Promise<boolean>} True if upstream observed abort before timeout
         */
        async waitForAbort(record, timeoutMs = 3000) {
            if (record.aborted) {
                return true;
            }
            return await new Promise((resolve) => {
                const timer = setTimeout(() => resolve(record.aborted), timeoutMs);
                timer.unref?.();
                record.abortedPromise.then(() => {
                    clearTimeout(timer);
                    resolve(true);
                });
            });
        },
        /**
         * Waits until a predicate matches a recorded upstream request.
         * @param {(requests: any[]) => boolean} predicate Condition to wait for
         * @param {number} [timeoutMs] Maximum wait duration in milliseconds
         * @returns {Promise<boolean>} True if condition matched before timeout
         */
        async waitForRequests(predicate, timeoutMs = 3000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (predicate(requests)) {
                    return true;
                }
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 10);
                    timer.unref?.();
                });
            }
            return predicate(requests);
        },
        releasePendingStreams,
        async close() {
            releasePendingStreams();
            for (const socket of activeSockets) {
                socket.destroy();
            }
            activeSockets.clear();
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    };
}

/**
 * Starts an isolated Express server mounting the real SillyBunny backend routers with ephemeral temp directories.
 * @param {Record<string, import('express').Router>} routers Map of mount paths to Express routers
 * @param {{ seedSecrets?: boolean, userHandle?: string }} [options]
 * @returns {Promise<object>} Running Express harness
 */
export async function startBackendApp(routers, { seedSecrets = true, userHandle = 'contract-user' } = {}) {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousPollingEnv = process.env.SILLYTAVERN_PERFORMANCE_STREAMING_ENABLECONNECTIONPOLLING;

    const tempDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-provider-contract-'));
    const dataRoot = path.join(tempDir, 'data');
    const userRoot = path.join(tempDir, 'user');
    const backupsRoot = path.join(userRoot, 'backups');
    const keylessRoot = path.join(tempDir, 'keyless');
    const keylessBackups = path.join(keylessRoot, 'backups');

    for (const directory of [dataRoot, userRoot, backupsRoot, keylessRoot, keylessBackups]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    globalThis.DATA_ROOT = dataRoot;
    // OS connection polling spawns netstat on Windows/macOS; native socket close events cover abort propagation here.
    process.env.SILLYTAVERN_PERFORMANCE_STREAMING_ENABLECONNECTIONPOLLING = 'false';
    ensureDefaultConfigLoaded();

    const userDirectories = { root: userRoot, backups: backupsRoot };
    const keylessDirectories = { root: keylessRoot, backups: keylessBackups };
    const secrets = seedSecrets ? await seedAllProviderSecrets(userDirectories) : {};

    forwardAsyncRouteErrors();
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
        const useKeyless = req.get('x-test-keyless') === 'true';
        req.user = {
            profile: { handle: userHandle, name: 'Contract User', admin: true },
            directories: useKeyless ? keylessDirectories : userDirectories,
        };
        next();
    });

    for (const [mountPath, router] of Object.entries(routers)) {
        app.use(mountPath, router);
    }
    app.use(handleRouteError);

    /** @type {Set<import('node:net').Socket>} */
    const activeSockets = new Set();
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        listening.once('error', reject);
    });
    server.on('connection', (socket) => {
        activeSockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => activeSockets.delete(socket));
    });

    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

    return {
        port,
        url: `http://127.0.0.1:${port}`,
        tempDir,
        dataRoot,
        userDirectories,
        keylessDirectories,
        secrets,
        /**
         * Sends a JSON POST request using a non-pooled HTTP socket and buffers the full response.
         * @param {string} routePath Request path on the Express app
         * @param {object} payload Request JSON body
         * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [options]
         * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string, json: any }>}
         */
        postJson(routePath, payload, { headers = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            return new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: routePath,
                    agent: false,
                    timeout: timeoutMs,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': String(body.length),
                        'Connection': 'close',
                        ...headers,
                    },
                }, (res) => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.once('error', reject);
                    res.once('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json = null;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            json = null;
                        }
                        resolve({
                            status: res.statusCode ?? 0,
                            headers: res.headers,
                            text,
                            json,
                        });
                    });
                });
                req.once('timeout', () => req.destroy(new Error(`POST ${routePath} timed out after ${timeoutMs}ms`)));
                req.once('error', reject);
                req.end(body);
            });
        },
        /**
         * Opens a streaming POST request, waits for the first response chunk, then destroys the client socket.
         * @param {string} routePath Request path on the Express app
         * @param {object} payload Request JSON body
         * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [options]
         * @returns {Promise<{ status: number, firstChunk: string }>}
         */
        streamAndAbortAfterFirstChunk(routePath, payload, { headers = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (fn, value) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    fn(value);
                };

                const req = http.request({
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: routePath,
                    agent: false,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': String(body.length),
                        'Connection': 'close',
                        ...headers,
                    },
                }, (res) => {
                    res.once('data', (chunk) => {
                        const firstChunk = chunk.toString('utf8');
                        const status = res.statusCode ?? 0;
                        res.destroy();
                        req.destroy();
                        finish(resolve, { status, firstChunk });
                    });
                    res.once('end', () => {
                        finish(reject, new Error(`Stream ${routePath} ended before delivering the first chunk (status ${res.statusCode})`));
                    });
                    res.once('error', (error) => {
                        if (!settled) {
                            finish(reject, error);
                        }
                    });
                });

                const timer = setTimeout(() => {
                    req.destroy();
                    finish(reject, new Error(`Stream ${routePath} timed out waiting for first chunk after ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref?.();

                req.on('error', (error) => {
                    if (!settled) {
                        finish(reject, error);
                    }
                });
                req.end(body);
            });
        },
        /**
         * Sends a POST request and returns a handle that lets the test destroy the socket mid-flight before headers arrive.
         * @param {string} routePath Request path on the Express app
         * @param {object} payload Request JSON body
         * @param {{ headers?: Record<string, string> }} [options]
         * @returns {{ abort: () => void }} Active client request handle
         */
        startAbortablePost(routePath, payload, { headers = {} } = {}) {
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            const req = http.request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: routePath,
                agent: false,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(body.length),
                    'Connection': 'close',
                    ...headers,
                },
            }, (res) => {
                res.resume();
                res.on('error', () => {});
            });
            req.on('error', () => {});
            req.end(body);
            return {
                abort() {
                    req.destroy();
                },
            };
        },
        async close() {
            for (const socket of activeSockets) {
                socket.destroy();
            }
            activeSockets.clear();
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
            globalThis.DATA_ROOT = previousDataRoot;
            if (previousPollingEnv === undefined) {
                delete process.env.SILLYTAVERN_PERFORMANCE_STREAMING_ENABLECONNECTIONPOLLING;
            } else {
                process.env.SILLYTAVERN_PERFORMANCE_STREAMING_ENABLECONNECTIONPOLLING = previousPollingEnv;
            }
            fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}
