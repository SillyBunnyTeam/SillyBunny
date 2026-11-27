import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';
import express from 'express';
import multer from 'multer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultConfigPath = path.join(repoRoot, 'default', 'config.yaml');

const originalGlobalFetch = global.fetch;
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;

export const SAMPLE_PNG_BUFFER = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

export const SAMPLE_AUDIO_BUFFER = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00contract-audio-bytes', 'binary');

/**
 * Builds a minimal valid ZIP buffer containing one file.
 * @param {string} fileName Entry name inside the archive
 * @param {Buffer} fileBuffer Entry bytes
 * @returns {Promise<Buffer>}
 */
export function createZipWithFile(fileName, fileBuffer) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip');
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.append(fileBuffer, { name: fileName });
        void archive.finalize();
    });
}

export function jsonReply(data, status = 200, headers = {}) {
    return {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(data),
    };
}

export function binaryReply(buffer, contentType = 'application/octet-stream', status = 200, headers = {}) {
    return {
        status,
        headers: { 'Content-Type': contentType, ...headers },
        body: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    };
}

export function textReply(text, status = 200, contentType = 'text/plain; charset=utf-8', headers = {}) {
    return {
        status,
        headers: { 'Content-Type': contentType, ...headers },
        body: String(text),
    };
}

export function htmlErrorReply(status = 502, html = '<html><body>Bad Gateway</body></html>', headers = {}) {
    return {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
        body: html,
    };
}

export function streamChunksReply(chunks, contentType = 'text/plain; charset=utf-8', status = 200, headers = {}) {
    return {
        status,
        headers: { 'Content-Type': contentType, ...headers },
        chunks,
    };
}

export const STANDARD_UPSTREAM_ERRORS = [
    ['401 Unauthorized', jsonReply({ error: { message: 'Invalid API key' } }, 401)],
    ['429 Too Many Requests', jsonReply({ error: { message: 'Rate limit exceeded' } }, 429)],
    ['500 Internal Server Error', jsonReply({ error: { message: 'Upstream failure' } }, 500)],
    ['502 non-JSON HTML', htmlErrorReply(502, '<html><body>502 Bad Gateway</body></html>')],
];

function readStreamBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

function parseQuery(searchParams) {
    const query = {};
    for (const [key, value] of searchParams.entries()) {
        if (Object.hasOwn(query, key)) {
            query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
        } else {
            query[key] = value;
        }
    }
    return query;
}

/**
 * Starts a local loopback HTTP server that records requests and replays scripted replies.
 */
export async function createFakeUpstreamServer() {
    /** @type {Array<object>} */
    const requests = [];
    /** @type {Array<object | Function>} */
    const queue = [];
    /** @type {((req: object, rawReq: http.IncomingMessage, rawRes: http.ServerResponse) => any) | null} */
    let handler = null;

    const server = http.createServer(async (req, res) => {
        try {
            const rawBody = await readStreamBuffer(req);
            const text = rawBody.toString('utf8');
            const headers = { ...req.headers };
            const originalUrlHeader = headers['x-contract-original-url'];
            const originalHostHeader = headers['x-contract-original-host'];
            const originalProtocolHeader = headers['x-contract-original-protocol'];
            delete headers['x-contract-original-url'];
            delete headers['x-contract-original-host'];
            delete headers['x-contract-original-protocol'];

            const localUrl = new URL(req.url || '/', `http://127.0.0.1:${server.address().port}`);
            const originalUrl = typeof originalUrlHeader === 'string' && originalUrlHeader
                ? originalUrlHeader
                : localUrl.toString();
            const parsedOriginal = new URL(originalUrl);

            let json = null;
            if (text.length > 0) {
                try {
                    json = JSON.parse(text);
                } catch {
                    json = null;
                }
            }

            let form = null;
            const contentType = String(headers['content-type'] || '').toLowerCase();
            if (contentType.includes('application/x-www-form-urlencoded')) {
                form = parseQuery(new URLSearchParams(text));
            }

            const recorded = {
                method: req.method,
                url: req.url,
                pathname: parsedOriginal.pathname,
                search: parsedOriginal.search,
                searchParams: parsedOriginal.searchParams,
                query: parseQuery(parsedOriginal.searchParams),
                originalUrl,
                originalHost: typeof originalHostHeader === 'string' ? originalHostHeader : parsedOriginal.host,
                originalProtocol: typeof originalProtocolHeader === 'string' ? originalProtocolHeader : parsedOriginal.protocol,
                headers,
                rawBody,
                text,
                json,
                form,
            };
            requests.push(recorded);

            const nextResponder = queue.length > 0 ? queue.shift() : handler;
            if (!nextResponder) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No fake upstream responder queued for ${req.method} ${originalUrl}` }));
                return;
            }

            const reply = typeof nextResponder === 'function'
                ? await nextResponder(recorded, req, res)
                : nextResponder;

            if (res.writableEnded || reply === undefined) {
                return;
            }

            if (reply.delayMs) {
                await new Promise(resolve => setTimeout(resolve, reply.delayMs));
            }

            const status = reply.status ?? 200;
            const responseHeaders = { ...(reply.headers || {}) };
            if (Array.isArray(reply.chunks)) {
                res.writeHead(status, responseHeaders);
                for (const chunk of reply.chunks) {
                    res.write(chunk);
                }
                res.end();
                return;
            }

            const payload = reply.json !== undefined
                ? JSON.stringify(reply.json)
                : (reply.body ?? '');
            if (reply.json !== undefined && !responseHeaders['Content-Type'] && !responseHeaders['content-type']) {
                responseHeaders['Content-Type'] = 'application/json';
            }
            res.writeHead(status, reply.statusText, responseHeaders);
            res.end(payload);
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: error.message }));
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

    return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        enqueue(...responders) {
            queue.push(...responders);
        },
        setHandler(fn) {
            handler = fn;
        },
        clearRequests() {
            requests.length = 0;
        },
        reset() {
            requests.length = 0;
            queue.length = 0;
            handler = null;
        },
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => {
                server.close(error => (error && error.code !== 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve());
            });
        },
    };
}

function normalizeHeadersObject(headersInput) {
    if (!headersInput) {
        return {};
    }
    if (typeof headersInput.entries === 'function') {
        return Object.fromEntries(headersInput.entries());
    }
    if (Array.isArray(headersInput)) {
        return Object.fromEntries(headersInput);
    }
    return { ...headersInput };
}

function extractUrlString(input) {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.toString();
    }
    if (input && typeof input.url === 'string') {
        return input.url;
    }
    return String(input);
}

function isAllowedDirectLoopback(parsedUrl, allowedPorts) {
    const isLoopbackHost = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';
    if (!isLoopbackHost || parsedUrl.protocol !== 'http:') {
        return false;
    }
    const port = Number(parsedUrl.port || 80);
    return allowedPorts.has(port);
}

/**
 * Creates a fail-closed loopback network guard for `node-fetch`, global `fetch`, and `node:https`.
 * Any request targeting a host/port outside the active test servers is rewritten to the local fake upstream server
 * (or rejected when `blockExternal` is true) so zero traffic ever leaves loopback.
 * @param {object} options
 * @param {() => { port: number } | null} options.getFakeServer
 * @param {() => number[]} [options.getAllowedPorts]
 * @param {Function} options.actualNodeFetch
 */
export function createLoopbackNetworkGuard({ getFakeServer, getAllowedPorts = () => [], actualNodeFetch }) {
    const state = {
        blockExternal: false,
    };

    function getAllowedPortSet() {
        const ports = new Set(getAllowedPorts().filter(Boolean));
        const fake = getFakeServer();
        if (fake?.port) {
            ports.add(fake.port);
        }
        return ports;
    }

    function rewriteForFetch(input, init) {
        const rawUrl = extractUrlString(input);
        const parsed = new URL(rawUrl);
        const allowedPorts = getAllowedPortSet();
        if (isAllowedDirectLoopback(parsed, allowedPorts)) {
            return { target: input, options: init };
        }

        const fake = getFakeServer();
        if (state.blockExternal || !fake) {
            throw new Error(`Blocked outbound network request in contract test: ${rawUrl}`);
        }

        const rewrittenUrl = `http://127.0.0.1:${fake.port}${parsed.pathname}${parsed.search}`;
        const baseHeaders = input && typeof input === 'object' && !(input instanceof URL) && input.headers
            ? normalizeHeadersObject(input.headers)
            : {};
        const initHeaders = normalizeHeadersObject(init?.headers);
        const headers = {
            ...baseHeaders,
            ...initHeaders,
            'x-contract-original-url': parsed.toString(),
            'x-contract-original-host': parsed.host,
            'x-contract-original-protocol': parsed.protocol,
        };
        delete headers.host;
        delete headers.Host;

        const options = init ? { ...init, headers } : { headers };
        if (input && typeof input === 'object' && !(input instanceof URL) && !options.method && input.method) {
            options.method = input.method;
        }
        return { target: rewrittenUrl, options };
    }

    function guardedNodeFetch(input, init) {
        const { target, options } = rewriteForFetch(input, init);
        return actualNodeFetch(target, options);
    }

    function guardedGlobalFetch(input, init) {
        const { target, options } = rewriteForFetch(input, init);
        return originalGlobalFetch(target, options);
    }

    function normalizeNodeRequestArgs(defaultProtocol, arg0, arg1, arg2) {
        let parsedUrl = null;
        let options = {};
        let callback = undefined;

        if (typeof arg0 === 'string' || arg0 instanceof URL) {
            parsedUrl = new URL(arg0.toString());
            if (typeof arg1 === 'function') {
                callback = arg1;
            } else {
                options = { ...(arg1 || {}) };
                callback = arg2;
            }
        } else {
            options = { ...(arg0 || {}) };
            callback = typeof arg1 === 'function' ? arg1 : arg2;
            const host = options.hostname || options.host || 'localhost';
            const portPart = options.port && !String(host).includes(':') ? `:${options.port}` : '';
            const reqPath = options.path || '/';
            const protocol = options.protocol || defaultProtocol;
            parsedUrl = new URL(`${protocol}//${host}${portPart}${reqPath}`);
        }

        return { parsedUrl, options, callback };
    }

    function rewriteNodeRequest(defaultProtocol, arg0, arg1, arg2) {
        const { parsedUrl, options, callback } = normalizeNodeRequestArgs(defaultProtocol, arg0, arg1, arg2);
        if (defaultProtocol === 'http:' && isAllowedDirectLoopback(parsedUrl, getAllowedPortSet())) {
            return originalHttpRequest(arg0, arg1, arg2);
        }

        const fake = getFakeServer();
        if (state.blockExternal || !fake) {
            throw new Error(`Blocked outbound ${defaultProtocol.toUpperCase()} request in contract test: ${parsedUrl.toString()}`);
        }

        const headers = normalizeHeadersObject(options.headers);
        delete headers.host;
        delete headers.Host;
        headers['x-contract-original-url'] = parsedUrl.toString();
        headers['x-contract-original-host'] = parsedUrl.host;
        headers['x-contract-original-protocol'] = parsedUrl.protocol;

        const rewrittenOptions = {
            ...options,
            protocol: 'http:',
            host: '127.0.0.1',
            hostname: '127.0.0.1',
            port: fake.port,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            headers,
            agent: false,
        };
        delete rewrittenOptions.servername;
        delete rewrittenOptions.rejectUnauthorized;
        delete rewrittenOptions.ca;
        delete rewrittenOptions.cert;
        delete rewrittenOptions.key;
        delete rewrittenOptions.pfx;
        delete rewrittenOptions.passphrase;
        delete rewrittenOptions.createConnection;

        return originalHttpRequest(rewrittenOptions, callback);
    }

    function guardedHttpRequest(arg0, arg1, arg2) {
        return rewriteNodeRequest('http:', arg0, arg1, arg2);
    }

    function guardedHttpGet(arg0, arg1, arg2) {
        const req = guardedHttpRequest(arg0, arg1, arg2);
        req.end();
        return req;
    }

    function guardedHttpsRequest(arg0, arg1, arg2) {
        return rewriteNodeRequest('https:', arg0, arg1, arg2);
    }

    function guardedHttpsGet(arg0, arg1, arg2) {
        const req = guardedHttpsRequest(arg0, arg1, arg2);
        req.end();
        return req;
    }

    global.fetch = guardedGlobalFetch;
    http.request = /** @type {any} */ (guardedHttpRequest);
    http.get = /** @type {any} */ (guardedHttpGet);
    https.request = /** @type {any} */ (guardedHttpsRequest);
    https.get = /** @type {any} */ (guardedHttpsGet);

    return {
        guardedNodeFetch,
        setBlockExternal(blocked) {
            state.blockExternal = Boolean(blocked);
        },
        restore() {
            global.fetch = originalGlobalFetch;
            http.request = originalHttpRequest;
            http.get = originalHttpGet;
            https.request = originalHttpsRequest;
            https.get = originalHttpsGet;
        },
    };
}

/**
 * Creates a fresh ephemeral user directory layout under the OS temp directory.
 * @param {string} prefix Temp directory prefix
 */
export function createEphemeralUserDirs(prefix = 'sillybunny-lower-risk-') {
    const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
    const userRoot = path.join(tempRoot, 'user');
    const directories = {
        root: userRoot,
        backups: path.join(userRoot, 'backups'),
        characters: path.join(userRoot, 'characters'),
        chats: path.join(userRoot, 'chats'),
        groupChats: path.join(userRoot, 'group chats'),
        groups: path.join(userRoot, 'groups'),
        vectors: path.join(userRoot, 'vectors'),
        comfyWorkflows: path.join(userRoot, 'user', 'workflows'),
        userImages: path.join(userRoot, 'user', 'images'),
        files: path.join(userRoot, 'user', 'files'),
        worlds: path.join(userRoot, 'worlds'),
        uploads: path.join(tempRoot, '_uploads'),
    };
    for (const dir of Object.values(directories)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return { tempRoot, directories };
}

async function decodeFetchResponse(response) {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const text = buffer.toString('utf8');
    let json = null;
    if (text.length > 0) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    return {
        status: response.status,
        headers: response.headers,
        buffer,
        text,
        json,
    };
}

/**
 * Copies `default/config.yaml` into a temp directory and registers it via `setConfigFilePath`.
 * Call before importing any endpoint router whose module init reads config values (e.g. `secrets.js`).
 * @param {string} [prefix] Temp directory prefix
 * @returns {Promise<{ configPath: string, cleanup: () => void }>}
 */
export async function initContractConfig(prefix = 'sillybunny-lower-risk-cfg-') {
    const { setConfigFilePath } = await import('../../src/util.js');
    const configRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
    const configPath = path.join(configRoot, 'config.yaml');
    fs.copyFileSync(defaultConfigPath, configPath);
    setConfigFilePath(configPath);
    return {
        configPath,
        cleanup() {
            fs.rmSync(configRoot, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}

/**
 * Starts an isolated Express server mounting real SillyBunny routers with ephemeral temp storage and seeded secrets.
 * Call after any `jest.unstable_mockModule` declarations.
 * @param {object} options
 * @param {Array<[string, import('express').Router]>} options.routes Array of `[mountPath, router]`
 * @param {boolean} [options.withUpload] Mount multer upload middleware (`avatar` field)
 * @param {string} [options.handle] Initial user handle
 * @param {string} [options.tempPrefix] Temp directory prefix
 * @param {Record<string, string>} [options.secrets] Initial secrets to seed
 * @param {boolean} [options.skipConfigInit] Skip creating a temp config when `initContractConfig` was already called
 */
export async function startContractApp({
    routes,
    withUpload = false,
    handle = 'contract-test-user',
    tempPrefix = 'sillybunny-lower-risk-',
    secrets = {},
    skipConfigInit = false,
}) {
    const { SecretManager } = await import('../../src/endpoints/secrets.js');
    const { createUploadStorage } = await import('../../src/middleware/uploadStorage.js');
    const { default: multerMonkeyPatch } = await import('../../src/middleware/multerMonkeyPatch.js');

    const tempRoots = [];
    let ownedConfig = null;
    if (!skipConfigInit) {
        ownedConfig = await initContractConfig(`${tempPrefix}cfg-`);
    }

    let currentHandle = handle;
    let currentDirs;
    let uploadMiddleware = null;

    function resetUser(newSecrets = {}, newHandle = handle) {
        const created = createEphemeralUserDirs(tempPrefix);
        tempRoots.push(created.tempRoot);
        currentDirs = created.directories;
        currentHandle = newHandle;
        if (withUpload) {
            uploadMiddleware = multer({ storage: createUploadStorage(currentDirs.uploads) }).single('avatar');
        }
        seedSecrets(newSecrets);
        return currentDirs;
    }

    function seedSecrets(secretMap = {}) {
        const manager = new SecretManager(currentDirs);
        for (const [key, value] of Object.entries(secretMap)) {
            if (value !== undefined && value !== null) {
                manager.writeSecret(key, String(value));
            }
        }
    }

    function clearSecrets() {
        const secretsFile = path.join(currentDirs.root, 'secrets.json');
        if (fs.existsSync(secretsFile)) {
            fs.unlinkSync(secretsFile);
        }
    }

    resetUser(secrets, handle);

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: currentHandle },
            directories: currentDirs,
        };
        next();
    });
    if (withUpload) {
        app.use((req, res, next) => uploadMiddleware(req, res, next));
        app.use(multerMonkeyPatch);
    }
    for (const [mountPath, router] of routes) {
        app.use(mountPath, router);
    }

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
        port,
        baseUrl,
        get directories() {
            return currentDirs;
        },
        get handle() {
            return currentHandle;
        },
        setHandle(nextHandle) {
            currentHandle = nextHandle;
        },
        seedSecrets,
        clearSecrets,
        resetUser,
        async postJson(route, body = {}) {
            const response = await originalGlobalFetch(`${baseUrl}${route}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return decodeFetchResponse(response);
        },
        async postUpload(route, { bytes = SAMPLE_AUDIO_BUFFER, fileName = 'audio.wav', contentType = 'audio/wav', fields = {} } = {}) {
            const form = new FormData();
            form.append('avatar', new Blob([bytes], { type: contentType }), fileName);
            for (const [key, value] of Object.entries(fields)) {
                form.append(key, String(value));
            }
            const response = await originalGlobalFetch(`${baseUrl}${route}`, {
                method: 'POST',
                body: form,
            });
            return decodeFetchResponse(response);
        },
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => {
                server.close(error => (error && error.code !== 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve());
            });
            for (const root of tempRoots.splice(0)) {
                fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
            }
            ownedConfig?.cleanup();
        },
    };
}
