import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createGitEnv } from './git.js';
import { closeHttpServer, guardRequestHandler, listenOnFixturePort, parseRequestTarget } from './ports.js';

/** One repository directory directly under the root, then one smart-HTTP endpoint. */
const ROUTE = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_PROTOCOL_HEADER = /^[A-Za-z0-9=:._-]{1,256}$/;
const CONTENT_ENCODING = /^(?:gzip|x-gzip|identity)$/i;
const MAX_CGI_HEADER_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * Server-wide policy, passed to http-backend as environment configuration so it reaches
 * upload-pack and pack-objects too. Pushes are refused, partial clones and lazy blob fetches
 * work like they do against GitHub, and fixture-internal refs stay hidden.
 */
export const GIT_SERVER_CONFIG = Object.freeze([
    ['http.receivepack', 'false'],
    ['http.uploadpack', 'true'],
    ['http.getanyfile', 'false'],
    ['uploadpack.allowFilter', 'true'],
    ['uploadpack.allowAnySHA1InWant', 'true'],
    ['uploadpack.hideRefs', 'refs/fixture/'],
]);

class RequestTooLarge extends Error {}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Stops a backend and everything it started. `git http-backend` runs git-http-backend, which runs
 * upload-pack and pack-objects; killing only the first process would leave the rest running.
 * @param {import('node:child_process').ChildProcess} child Backend process.
 * @returns {Promise<void>} Resolves once the kill is issued (on Windows, once taskkill has finished).
 */
function terminateTree(child) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        return Promise.resolve();
    }
    if (process.platform === 'win32') {
        return new Promise((resolve) => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            killer.on('error', () => {
                child.kill();
                resolve();
            });
            killer.on('close', () => resolve());
        });
    }
    try {
        // POSIX backends lead their own process group (spawned detached), so this reaches every descendant.
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
    return Promise.resolve();
}

/**
 * Waits until a POSIX process group is empty. Killed members can take a moment to exit and be reaped,
 * a busy pack-objects most of all, and close() promises that none of them is left.
 * @param {number} groupId Process group id.
 * @param {number} [timeoutMs] Upper bound for the wait.
 * @returns {Promise<void>}
 */
async function waitForGroupExit(groupId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(-groupId, 0);
        } catch {
            return;
        }
        await delay(20);
    }
}

/**
 * Terminates a backend tree and resolves once its processes have exited and its pipes are closed.
 * @param {import('node:child_process').ChildProcess} child Backend process.
 * @returns {Promise<void>}
 */
async function stopBackend(child) {
    const closed = new Promise((resolve) => {
        if ((child.exitCode !== null || child.signalCode !== null) && (!child.stdout || child.stdout.destroyed)) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            // A stray descendant can hold the pipes open; drop them so close still fires.
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
        }, 5000);
        child.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
    });
    const groupId = child.pid;
    await Promise.all([closed, terminateTree(child)]);
    if (process.platform !== 'win32' && groupId !== undefined) {
        await waitForGroupExit(groupId);
    }
}

/**
 * Reads a request body into memory, refusing anything over the limit.
 * @param {import('node:http').IncomingMessage} request Request.
 * @param {number} limit Byte limit.
 * @returns {Promise<Buffer>} Body.
 */
function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const declared = request.headers['content-length'];
        if (declared !== undefined && Number(declared) > limit) {
            reject(new RequestTooLarge());
            return;
        }
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                request.pause();
                reject(new RequestTooLarge());
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

/**
 * Finds the blank line that ends a CGI header block.
 * @param {Buffer} buffer Buffered output.
 * @returns {{index: number, length: number}|null} Terminator position.
 */
function findHeaderEnd(buffer) {
    const crlf = buffer.indexOf('\r\n\r\n');
    const lf = buffer.indexOf('\n\n');
    if (crlf === -1 && lf === -1) {
        return null;
    }
    if (lf === -1 || (crlf !== -1 && crlf < lf)) {
        return { index: crlf, length: 4 };
    }
    return { index: lf, length: 2 };
}

/**
 * Parses CGI response headers into an HTTP status and header map.
 * @param {string} text Header block.
 * @returns {{status: number, headers: Record<string, string|string[]>}} Parsed headers.
 */
function parseCgiHeaders(text) {
    let status = 200;
    /** @type {Record<string, string|string[]>} */
    const headers = {};
    for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator <= 0) {
            continue;
        }
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === 'status') {
            const code = Number.parseInt(value, 10);
            if (code >= 100 && code <= 599) {
                status = code;
            }
            continue;
        }
        const existing = headers[name];
        headers[name] = existing === undefined ? value : [existing, value].flat();
    }
    return { status, headers };
}

/**
 * Resolves the repository directory for a route name, accepting `name` or `name.git`.
 * @param {string} projectRoot Root directory.
 * @param {string} name Name from the URL.
 * @returns {string|null} Directory name relative to the root.
 */
function resolveRepository(projectRoot, name) {
    for (const candidate of [name, `${name}.git`]) {
        try {
            if (fs.statSync(path.join(projectRoot, candidate, 'objects')).isDirectory()) {
                return candidate;
            }
        } catch {
            // Try the next spelling.
        }
    }
    return null;
}

/**
 * Starts a read-only git smart-HTTP server for every bare repository directly under `projectRoot`.
 * Only `upload-pack` is served; `receive-pack` and the dumb protocol are refused.
 * @param {object} options Options.
 * @param {string} options.projectRoot Directory holding bare repositories.
 * @param {string} [options.host] Bind host (default loopback).
 * @param {number} [options.port] Explicit fixture port (default random).
 * @param {number} [options.maxPort] Highest random port (default the top of the fixture range).
 * @param {number} [options.maxRequestBytes] Request body limit.
 * @param {string} [options.logFile] JSON Lines file that receives one entry per request.
 * @param {string} [options.home] HOME for git processes.
 * @returns {Promise<{host: string, port: number, url: string, projectRoot: string, requests: object[], urlFor: (name: string) => string, activePids: () => number[], close: () => Promise<void>}>}
 */
export async function startGitServer({
    projectRoot,
    host = '127.0.0.1',
    port,
    maxPort,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    logFile,
    home,
}) {
    const root = path.resolve(projectRoot);
    if (!fs.statSync(root).isDirectory()) {
        throw new Error(`Not a directory: ${root}`);
    }
    if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    }

    const configEnv = { GIT_CONFIG_COUNT: String(GIT_SERVER_CONFIG.length) };
    GIT_SERVER_CONFIG.forEach(([key, value], index) => {
        configEnv[`GIT_CONFIG_KEY_${index}`] = key;
        configEnv[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    const baseEnv = createGitEnv({ home, extra: configEnv });

    /** @type {object[]} */
    const requests = [];
    /** @type {Set<import('node:child_process').ChildProcess>} */
    const children = new Set();

    const record = (entry) => {
        requests.push(entry);
        if (logFile) {
            fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
        }
    };

    const server = http.createServer(guardRequestHandler(async (request, response) => {
        const started = Date.now();
        const url = parseRequestTarget(request);
        const match = url ? ROUTE.exec(url.pathname) : null;
        const protocolHeader = request.headers['git-protocol'];
        const entry = {
            time: new Date(started).toISOString(),
            method: request.method,
            // A target that URL rejects is logged as it was sent.
            path: url ? url.pathname : String(request.url ?? ''),
            query: url ? url.search.slice(1) : '',
            repo: match?.[1] ?? null,
            service: null,
            gitProtocol: typeof protocolHeader === 'string' ? protocolHeader : null,
            status: 0,
            refused: false,
            requestBytes: 0,
            responseBytes: 0,
            durationMs: 0,
        };
        let logged = false;
        const finish = (status, extra = {}) => {
            if (logged) {
                return;
            }
            logged = true;
            Object.assign(entry, { status, durationMs: Date.now() - started }, extra);
            record(entry);
        };
        const refuse = (status) => {
            entry.refused = true;
            response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'close' });
            response.end('TODO(copy)\n');
            finish(status);
        };

        if (!url) {
            refuse(400);
            return;
        }
        if (!match) {
            refuse(404);
            return;
        }

        const endpoint = match[2];
        let service = null;
        if (endpoint === 'info/refs') {
            service = url.searchParams.get('service');
        } else {
            service = endpoint;
        }
        entry.service = service;

        if (service === 'git-receive-pack') {
            refuse(403);
            return;
        }
        if (service !== 'git-upload-pack') {
            // Dumb-protocol discovery: only smart HTTP is served.
            refuse(403);
            return;
        }
        const expectedMethod = endpoint === 'info/refs' ? 'GET' : 'POST';
        if (request.method !== expectedMethod) {
            refuse(405);
            return;
        }
        const repository = resolveRepository(root, match[1]);
        if (!repository) {
            refuse(404);
            return;
        }

        let body = Buffer.alloc(0);
        if (request.method === 'POST') {
            try {
                body = await readBody(request, maxRequestBytes);
            } catch (error) {
                refuse(error instanceof RequestTooLarge ? 413 : 400);
                return;
            }
        }
        entry.requestBytes = body.length;

        const env = {
            ...baseEnv,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            GIT_HTTP_MAX_REQUEST_BUFFER: String(maxRequestBytes),
            GATEWAY_INTERFACE: 'CGI/1.1',
            SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
            SERVER_SOFTWARE: 'sillybunny-smoke-git',
            REQUEST_METHOD: request.method,
            PATH_INFO: `/${repository}/${endpoint}`,
            QUERY_STRING: endpoint === 'info/refs' ? `service=${service}` : '',
            REMOTE_ADDR: request.socket.remoteAddress ?? '127.0.0.1',
            CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
            CONTENT_LENGTH: String(body.length),
        };
        const encoding = request.headers['content-encoding'];
        if (encoding !== undefined) {
            if (typeof encoding !== 'string' || !CONTENT_ENCODING.test(encoding)) {
                refuse(415);
                return;
            }
            // http-backend inflates gzip request bodies itself.
            env.HTTP_CONTENT_ENCODING = encoding;
        }
        if (entry.gitProtocol && GIT_PROTOCOL_HEADER.test(entry.gitProtocol)) {
            // http-backend reads HTTP_GIT_PROTOCOL; older versions only read GIT_PROTOCOL.
            env.HTTP_GIT_PROTOCOL = entry.gitProtocol;
            env.GIT_PROTOCOL = entry.gitProtocol;
        }

        const child = spawn('git', ['http-backend'], {
            // Never the caller's directory: a checkout there (or a broken .git file) must not matter.
            cwd: root,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        children.add(child);
        let stderr = '';
        let headerBuffer = Buffer.alloc(0);
        let headersSent = false;
        let responseBytes = 0;
        let status = 0;

        const fail = () => {
            if (!response.headersSent) {
                response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' });
                response.end('TODO(copy)\n');
                status = 502;
            } else {
                response.destroy();
            }
            terminateTree(child);
        };

        child.on('error', (error) => {
            fail();
            if (child.pid === undefined) {
                // The process never started, so no close event will log the request.
                children.delete(child);
                finish(502, { error: error.message });
            }
        });
        child.stdin.on('error', () => {});
        child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_STDERR_BYTES) {
                stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length);
            }
        });
        child.stdout.on('data', (chunk) => {
            if (headersSent) {
                responseBytes += chunk.length;
                if (!response.write(chunk)) {
                    child.stdout.pause();
                    response.once('drain', () => child.stdout.resume());
                }
                return;
            }
            headerBuffer = Buffer.concat([headerBuffer, chunk]);
            const end = findHeaderEnd(headerBuffer);
            if (!end) {
                if (headerBuffer.length > MAX_CGI_HEADER_BYTES) {
                    fail();
                }
                return;
            }
            const parsed = parseCgiHeaders(headerBuffer.subarray(0, end.index).toString('latin1'));
            const rest = headerBuffer.subarray(end.index + end.length);
            headerBuffer = Buffer.alloc(0);
            status = parsed.status;
            response.writeHead(parsed.status, parsed.headers);
            headersSent = true;
            if (rest.length > 0) {
                responseBytes += rest.length;
                response.write(rest);
            }
        });
        child.stdout.on('end', () => {
            if (!headersSent) {
                fail();
                return;
            }
            response.end();
        });
        child.on('close', (code) => {
            children.delete(child);
            finish(status, {
                responseBytes,
                exitCode: code,
                ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
            });
        });
        response.on('close', () => {
            if (!response.writableFinished) {
                // The client went away; stop computing a pack nobody reads.
                terminateTree(child);
            }
        });
        child.stdin.end(body);
    }, record));

    const boundPort = await listenOnFixturePort(server, { host, port, maxPort });
    const url = `http://${host}:${boundPort}`;

    return {
        host,
        port: boundPort,
        url,
        projectRoot: root,
        requests,
        urlFor: (name) => `${url}/${name}`,
        activePids: () => [...children].map(child => child.pid).filter(pid => pid !== undefined),
        close: async () => {
            await Promise.all([closeHttpServer(server), ...[...children].map(stopBackend)]);
        },
    };
}
