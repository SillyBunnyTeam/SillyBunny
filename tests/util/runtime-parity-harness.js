import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_RUNTIMES = Object.freeze(['bun', 'node']);
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const LOG_LINES_KEPT = 80;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/;

// Valid 1x1 transparent PNG bytes, so image-metadata readers parse uploads without errors.
const MINIMAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Returns a valid 1x1 PNG image buffer for upload checks.
 * @returns {Buffer}
 */
export function createMinimalPngBuffer() {
    return Buffer.from(MINIMAL_PNG_BASE64, 'base64');
}

/**
 * Normalizes and validates the requested server runtime.
 * @param {string | undefined} runtime Explicit runtime name
 * @param {NodeJS.ProcessEnv} [env] Environment fallback
 * @returns {'bun' | 'node'}
 */
export function resolveParityRuntime(runtime, env = process.env) {
    const candidate = String(runtime || env.SILLYBUNNY_PARITY_RUNTIME || (process.versions?.bun ? 'bun' : 'node'))
        .trim()
        .toLowerCase();
    if (!SUPPORTED_RUNTIMES.includes(candidate)) {
        throw new Error(`Unsupported parity runtime "${candidate}". Expected one of: ${SUPPORTED_RUNTIMES.join(', ')}.`);
    }
    return /** @type {'bun' | 'node'} */ (candidate);
}

/**
 * Builds the executable and argv used to boot the real server with an isolated temp data root and config.
 * @param {'bun' | 'node'} runtime Target runtime
 * @param {{ port: number, dataRoot: string, configPath?: string, nodePath?: string, bunPath?: string }} options Boot options
 * @returns {{ command: string, args: string[], configPath: string }}
 */
export function buildServerLaunchSpec(runtime, {
    port,
    dataRoot,
    configPath = path.join(dataRoot, 'config.yaml'),
    nodePath = process.versions?.bun ? 'node' : process.execPath,
    bunPath = process.versions?.bun ? process.execPath : 'bun',
}) {
    const normalizedRuntime = resolveParityRuntime(runtime);
    const serverArgs = [
        'server.js',
        '--browserLaunchEnabled=false',
        '--port', String(port),
        '--dataRoot', dataRoot,
        '--configPath', configPath,
    ];

    if (normalizedRuntime === 'node') {
        return {
            command: nodePath,
            args: ['--no-warnings', ...serverArgs],
            configPath,
        };
    }

    return {
        command: bunPath,
        args: serverArgs,
        configPath,
    };
}

/**
 * Finds an available loopback TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
export function findFreePort() {
    return new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
            const address = listener.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            listener.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

/**
 * Extracts a request Cookie header value from a Fetch Response's Set-Cookie headers.
 * @param {Response} response Fetch response
 * @returns {string}
 */
export function extractCookieHeader(response) {
    const rawCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);

    return rawCookies
        .map(cookie => String(cookie).split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
}

/**
 * Encodes a single-file multipart/form-data payload without runtime-specific FormData quirks.
 * @param {{ fieldName: string, fileName: string, contentType: string, content: Buffer, boundary?: string }} options Multipart file entry
 * @returns {{ body: Buffer, contentType: string }}
 */
export function buildMultipartFileBody({
    fieldName,
    fileName,
    contentType,
    content,
    boundary = `----SillyBunnyParity${Date.now().toString(16)}`,
}) {
    const header = Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`
        + `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return {
        body: Buffer.concat([header, content, footer]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

/**
 * Parses OpenAI-style SSE text into reconstructed assistant text and whether [DONE] arrived.
 * @param {string} rawText Raw SSE payload
 * @returns {{ text: string, done: boolean, chunks: string[] }}
 */
export function parseSseStreamText(rawText) {
    const chunks = [];
    let done = false;

    for (const rawLine of String(rawText).split(/\r?\n/)) {
        if (!rawLine.startsWith('data:')) {
            continue;
        }
        const payload = rawLine.slice(5).trim();
        if (!payload) {
            continue;
        }
        if (payload === '[DONE]') {
            done = true;
            continue;
        }
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') {
            chunks.push(delta);
        }
    }

    return {
        text: chunks.join(''),
        done,
        chunks,
    };
}

/**
 * Formats the trailing lines of a server log for diagnostic output.
 * @param {string[]} lines Captured output lines
 * @param {number} [maxLines] Maximum lines to return
 * @returns {string}
 */
export function formatLogTail(lines, maxLines = LOG_LINES_KEPT) {
    if (!Array.isArray(lines) || lines.length === 0) {
        return '(no server output captured)';
    }
    return lines.slice(-maxLines).join('\n');
}

/**
 * Checks that a target path is strictly contained within a parent directory.
 * @param {string} parentDir Expected parent directory
 * @param {string} targetPath Path to verify
 * @returns {boolean}
 */
export function isPathInsideDirectory(parentDir, targetPath) {
    const relative = path.relative(path.resolve(parentDir), path.resolve(targetPath));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Stops a spawned server process tree cleanly across Windows and POSIX platforms.
 * @param {import('node:child_process').ChildProcess | null} child Spawned process
 * @param {number} [graceTimeoutMs] Grace period before SIGKILL on POSIX
 * @returns {Promise<void>}
 */
async function stopServerProcessTree(child, graceTimeoutMs = 5_000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    const exitPromise = new Promise(resolve => {
        child.once('exit', () => resolve());
    });

    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 2_000))]);
        return;
    }

    // Detached POSIX spawns own their process group, so negative PID stops both supervisor and server child.
    const signalTarget = signal => {
        try {
            process.kill(-child.pid, signal);
        } catch {
            try {
                child.kill(signal);
            } catch {
                // Process already exited.
            }
        }
    };

    signalTarget('SIGTERM');
    const exitedGracefully = await Promise.race([
        exitPromise.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), graceTimeoutMs)),
    ]);

    if (!exitedGracefully && child.exitCode === null) {
        signalTarget('SIGKILL');
        await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
}

/**
 * Starts the real SillyBunny server on an ephemeral loopback port with a throwaway temp data root.
 * @param {{
 *   runtime: 'bun' | 'node',
 *   repositoryRoot?: string,
 *   readyTimeoutMs?: number,
 *   logFilePath?: string,
 *   nodePath?: string,
 *   bunPath?: string,
 * }} options Launch options
 * @returns {Promise<{
 *   runtime: 'bun' | 'node',
 *   port: number,
 *   baseUrl: string,
 *   dataRoot: string,
 *   configPath: string,
 *   bootDurationMs: number,
 *   getLogTail: () => string,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startParityServer({
    runtime,
    repositoryRoot = REPOSITORY_ROOT,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    logFilePath = '',
    nodePath = process.versions?.bun ? 'node' : process.execPath,
    bunPath = process.versions?.bun ? process.execPath : 'bun',
}) {
    const normalizedRuntime = resolveParityRuntime(runtime);
    const port = await findFreePort();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `sillybunny-parity-${normalizedRuntime}-`));
    const { command, args, configPath } = buildServerLaunchSpec(normalizedRuntime, {
        port,
        dataRoot,
        nodePath,
        bunPath,
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    let logStream = null;
    if (logFilePath) {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        logStream = fs.createWriteStream(logFilePath, { flags: 'w' });
    }

    const logLines = [];
    const appendOutput = chunk => {
        const text = chunk.toString();
        if (logStream) {
            logStream.write(text);
        }
        for (const line of text.split(/\r?\n/)) {
            if (line) {
                logLines.push(line);
            }
        }
        if (logLines.length > LOG_LINES_KEPT) {
            logLines.splice(0, logLines.length - LOG_LINES_KEPT);
        }
    };

    const startedAt = Date.now();
    const child = spawn(command, args, {
        cwd: repositoryRoot,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            SILLYBUNNY_LAUNCHER: '1',
            SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH: '1',
        },
    });

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    let spawnError = null;
    child.on('error', error => {
        spawnError = error;
    });

    let stopped = false;
    const stop = async () => {
        if (stopped) {
            return;
        }
        stopped = true;
        try {
            await stopServerProcessTree(child);
        } finally {
            if (logStream) {
                await new Promise(resolve => logStream.end(resolve));
            }
            try {
                // Windows releases SQLite and log file handles shortly after process exit.
                fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
            } catch (error) {
                console.warn(`Could not remove parity temp data root ${dataRoot}: ${error.message}`);
            }
        }
    };

    try {
        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
            if (spawnError) {
                throw new Error(`Failed to spawn ${normalizedRuntime} server (${command}): ${spawnError.message}`);
            }
            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(
                    `${normalizedRuntime} server exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode}).\n`
                    + `${formatLogTail(logLines)}`,
                );
            }
            const ready = await fetch(`${baseUrl}/csrf-token`, { signal: AbortSignal.timeout(2_000) })
                .then(response => response.ok, () => false);
            if (ready) {
                return {
                    runtime: normalizedRuntime,
                    port,
                    baseUrl,
                    dataRoot,
                    configPath,
                    bootDurationMs: Date.now() - startedAt,
                    getLogTail: () => formatLogTail(logLines),
                    stop,
                };
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        throw new Error(
            `${normalizedRuntime} server did not become ready within ${readyTimeoutMs / 1000}s.\n`
            + `${formatLogTail(logLines)}`,
        );
    } catch (error) {
        await stop();
        throw error;
    }
}

/**
 * Starts a local fake OpenAI-compatible upstream HTTP server on 127.0.0.1 for streamed and cancelled checks.
 * Never makes external network requests.
 * @returns {Promise<{
 *   port: number,
 *   baseUrl: string,
 *   requests: Array<{ method: string, url: string, body: any }>,
 *   waitForNextSilentClose: () => Promise<{ closed: boolean }>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeUpstreamServer() {
    const requests = [];
    const activeResponses = new Set();
    let pendingCloseResolvers = [];

    const resolveCloseWaiters = () => {
        for (const resolve of pendingCloseResolvers.splice(0)) {
            resolve({ closed: true });
        }
    };

    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let parsedBody = {};
            try {
                parsedBody = rawBody ? JSON.parse(rawBody) : {};
            } catch {
                response.writeHead(400, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
                return;
            }

            requests.push({
                method: request.method,
                url: request.url,
                body: parsedBody,
            });

            if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
                response.writeHead(404, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'Not found' } }));
                return;
            }

            if (parsedBody.model === 'parity-cancel-silent') {
                activeResponses.add(response);
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                });
                response.write('data: {"choices":[{"delta":{"content":"First chunk"}}]}\n\n');

                let closed = false;
                const handleClosed = () => {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    activeResponses.delete(response);
                    if (!response.writableEnded) {
                        response.end();
                    }
                    resolveCloseWaiters();
                };

                // Stay silent after the first chunk so disconnect detection cannot rely on a broken pipe from later writes.
                request.on('close', handleClosed);
                response.on('close', handleClosed);
                request.socket?.on('close', handleClosed);
                return;
            }

            if (parsedBody.model === 'parity-stream-model') {
                const deltas = ['Hello ', 'from ', 'parity!'];
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                });

                let index = 0;
                const writeNext = () => {
                    if (response.destroyed || response.writableEnded) {
                        return;
                    }
                    if (index < deltas.length) {
                        const content = deltas[index++];
                        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
                        const timer = setTimeout(writeNext, 20);
                        timer.unref?.();
                        return;
                    }
                    response.write('data: [DONE]\n\n');
                    response.end();
                };
                writeNext();
                return;
            }

            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'ok' } }],
            }));
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return {
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        waitForNextSilentClose: () => new Promise(resolve => {
            pendingCloseResolvers.push(resolve);
        }),
        close: async () => {
            for (const response of activeResponses) {
                if (!response.writableEnded) {
                    response.end();
                }
            }
            activeResponses.clear();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}

/**
 * Fetches a fresh CSRF token and session cookie header from a running parity server.
 * @param {string} baseUrl Server base URL
 * @returns {Promise<{ token: string, cookie: string, cacheControl: string }>}
 */
async function fetchCsrfSession(baseUrl) {
    const response = await fetch(`${baseUrl}/csrf-token`);
    assert.equal(response.status, 200, `GET /csrf-token returned ${response.status}`);
    const cookie = extractCookieHeader(response);
    const cacheControl = response.headers.get('cache-control') || '';
    const payload = await response.json();
    const token = String(payload?.token ?? '');
    assert.ok(token.length >= 32 && token !== 'disabled', `Expected real CSRF token, got "${token}"`);
    assert.ok(cookie.length > 0, 'Expected GET /csrf-token to set session cookies');
    assert.ok(cacheControl.includes('no-store'), `Expected no-store Cache-Control header, got "${cacheControl}"`);
    return { token, cookie, cacheControl };
}

/**
 * Reads from a ReadableStream until the accumulated text satisfies a predicate.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader Stream reader
 * @param {(text: string) => boolean} predicate Stop condition
 * @param {number} [timeoutMs] Read timeout
 * @returns {Promise<string>}
 */
async function readUntil(reader, predicate, timeoutMs = 5_000) {
    const decoder = new TextDecoder();
    let collected = '';
    const deadline = Date.now() + timeoutMs;

    while (!predicate(collected)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(`Timed out waiting for streamed chunk. Received so far: ${JSON.stringify(collected)}`);
        }
        const next = await Promise.race([
            reader.read(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Stream read timed out')), remaining)),
        ]);
        if (next.done) {
            break;
        }
        collected += decoder.decode(next.value, { stream: true });
    }

    return collected;
}

/**
 * Runs the 6 runtime parity checks against a booted server and local fake upstream.
 * @param {{ baseUrl: string, dataRoot: string }} server Running parity server
 * @param {{ baseUrl: string, requests: Array<{ method: string, url: string, body: any }>, waitForNextSilentClose: () => Promise<{ closed: boolean }> }} upstream Local fake upstream
 * @returns {Promise<Array<{ id: string, title: string, durationMs: number }>>}
 */
export async function runParityChecks(server, upstream, { onCheckPass = null } = {}) {
    /** @type {{ token: string, cookie: string } | null} */
    let session = null;

    const authHeaders = (extra = {}) => ({
        Cookie: session.cookie,
        'X-CSRF-Token': session.token,
        ...extra,
    });

    const checks = [
        {
            id: 'security-tokens',
            title: 'Security tokens (CSRF)',
            run: async () => {
                const indexResponse = await fetch(`${server.baseUrl}/`);
                assert.equal(indexResponse.status, 200, `GET / returned ${indexResponse.status}`);
                const indexHtml = await indexResponse.text();
                assert.ok(indexHtml.includes('<html') || indexHtml.includes('<!DOCTYPE html'), 'GET / did not serve HTML');

                session = await fetchCsrfSession(server.baseUrl);

                const missingToken = await fetch(`${server.baseUrl}/api/ping`, { method: 'POST' });
                assert.equal(missingToken.status, 403, `POST without CSRF token returned ${missingToken.status}`);
                const missingBody = await missingToken.text();
                assert.ok(missingBody.includes('Invalid CSRF token'), `Unexpected missing-CSRF body: ${JSON.stringify(missingBody)}`);
                assert.equal(ANSI_ESCAPE_PATTERN.test(missingBody), false, 'CSRF error response leaked ANSI control codes');

                const cookieOnly = await fetch(`${server.baseUrl}/api/ping`, {
                    method: 'POST',
                    headers: { Cookie: session.cookie },
                });
                assert.equal(cookieOnly.status, 403, `POST with session cookie but no CSRF header returned ${cookieOnly.status}`);

                const wrongToken = await fetch(`${server.baseUrl}/api/ping`, {
                    method: 'POST',
                    headers: {
                        Cookie: session.cookie,
                        'X-CSRF-Token': '0'.repeat(session.token.length),
                    },
                });
                assert.equal(wrongToken.status, 403, `POST with wrong CSRF token returned ${wrongToken.status}`);
                const wrongBody = await wrongToken.text();
                assert.ok(wrongBody.includes('Invalid CSRF token'), `Unexpected wrong-CSRF body: ${JSON.stringify(wrongBody)}`);

                const validToken = await fetch(`${server.baseUrl}/api/ping`, {
                    method: 'POST',
                    headers: authHeaders(),
                });
                assert.equal(validToken.status, 204, `POST /api/ping with valid CSRF token returned ${validToken.status}`);
            },
        },
        {
            id: 'request-bodies',
            title: 'Request bodies',
            run: async () => {
                const unicodeName = 'parity-café-テスト.txt';
                const parsedResponse = await fetch(`${server.baseUrl}/api/files/sanitize-filename`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ fileName: unicodeName }),
                });
                assert.equal(parsedResponse.status, 200, `POST /api/files/sanitize-filename returned ${parsedResponse.status}`);
                assert.deepEqual(await parsedResponse.json(), { fileName: unicodeName });

                const formBodyResponse = await fetch(`${server.baseUrl}/api/files/sanitize-filename`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
                    body: new URLSearchParams({ fileName: 'parity-urlencoded.txt' }).toString(),
                });
                assert.equal(formBodyResponse.status, 200, `URL-encoded POST returned ${formBodyResponse.status}`);
                assert.deepEqual(await formBodyResponse.json(), { fileName: 'parity-urlencoded.txt' });

                // Exceed Express's default 100 KB JSON limit to verify SillyBunny's raised JSON limit on both runtimes.
                const largePayloadText = `${'SillyBunny-parity-body-テスト-'.repeat(8_000)}END`;
                const largeBuffer = Buffer.from(largePayloadText, 'utf8');
                assert.ok(largeBuffer.length > 200_000, 'Large JSON test payload must exceed 200 KB');

                const largeUploadResponse = await fetch(`${server.baseUrl}/api/files/upload`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        name: 'parity-large-body.txt',
                        data: largeBuffer.toString('base64'),
                    }),
                });
                assert.equal(largeUploadResponse.status, 200, `Large JSON upload returned ${largeUploadResponse.status}`);
                const largeUploadJson = await largeUploadResponse.json();
                assert.equal(largeUploadJson.path, '/user/files/parity-large-body.txt');

                const servedLarge = await fetch(`${server.baseUrl}${largeUploadJson.path}`, {
                    headers: { Cookie: session.cookie },
                });
                assert.equal(servedLarge.status, 200, `GET ${largeUploadJson.path} returned ${servedLarge.status}`);
                const servedBytes = Buffer.from(await servedLarge.arrayBuffer());
                assert.ok(servedBytes.equals(largeBuffer), 'Large JSON-uploaded file bytes did not round-trip intact');

                const malformedResponse = await fetch(`${server.baseUrl}/api/files/sanitize-filename`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: '{"fileName": "broken',
                });
                assert.equal(malformedResponse.status, 400, `Malformed JSON returned ${malformedResponse.status}`);
                const malformedText = await malformedResponse.text();
                assert.equal(malformedText.includes('SyntaxError'), false, 'Malformed JSON response leaked internal error details');

                const healthAfterBadJson = await fetch(`${server.baseUrl}/api/ping`, {
                    method: 'POST',
                    headers: authHeaders(),
                });
                assert.equal(healthAfterBadJson.status, 204, 'Server did not stay healthy after invalid JSON body');
            },
        },
        {
            id: 'file-uploads',
            title: 'File uploads',
            run: async () => {
                const pngBytes = createMinimalPngBuffer();
                const fileName = 'parity-upload.png';
                const multipart = buildMultipartFileBody({
                    fieldName: 'avatar',
                    fileName,
                    contentType: 'image/png',
                    content: pngBytes,
                });

                const uploadResponse = await fetch(`${server.baseUrl}/api/backgrounds/upload`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': multipart.contentType }),
                    body: multipart.body,
                });
                assert.equal(uploadResponse.status, 200, `POST /api/backgrounds/upload returned ${uploadResponse.status}`);
                assert.equal(await uploadResponse.text(), fileName);

                const storedPath = path.join(server.dataRoot, 'default-user', 'backgrounds', fileName);
                assert.ok(isPathInsideDirectory(server.dataRoot, storedPath), 'Uploaded file escaped temp dataRoot');
                assert.ok(fs.existsSync(storedPath), `Expected uploaded file at ${storedPath}`);
                assert.ok(fs.readFileSync(storedPath).equals(pngBytes), 'Stored background file bytes differ from upload');

                const uploadsTempDir = path.join(server.dataRoot, '_uploads');
                if (fs.existsSync(uploadsTempDir)) {
                    const leftovers = fs.readdirSync(uploadsTempDir);
                    assert.deepEqual(leftovers, [], `Multer temp upload was not cleaned up: ${leftovers.join(', ')}`);
                }

                const served = await fetch(`${server.baseUrl}/backgrounds/${fileName}`, {
                    headers: { Cookie: session.cookie },
                });
                assert.equal(served.status, 200, `GET /backgrounds/${fileName} returned ${served.status}`);
                assert.ok(String(served.headers.get('content-type') || '').includes('image/png'));
                const servedBytes = Buffer.from(await served.arrayBuffer());
                assert.ok(servedBytes.equals(pngBytes), 'Served background bytes did not match uploaded PNG');
            },
        },
        {
            id: 'chat-save-reload',
            title: 'Saving and reloading a chat',
            run: async () => {
                const characterName = 'ParityChar';
                const avatarUrl = `${characterName}.png`;
                const fileName = 'parity-roundtrip-chat';
                const initialChat = [
                    {
                        user_name: 'ParityUser',
                        character_name: characterName,
                        create_date: '2026-11-27@00h00m00s',
                        chat_metadata: {
                            parity_marker: 'ws9-chat-save',
                            note: 'café-テスト',
                        },
                    },
                    {
                        name: characterName,
                        is_user: false,
                        is_system: false,
                        send_date: '2026-11-27T00:00:01.000Z',
                        mes: 'Greetings from the parity check.',
                        extra: { api: 'custom', model: 'parity-stream-model' },
                    },
                    {
                        name: 'ParityUser',
                        is_user: true,
                        is_system: false,
                        send_date: '2026-11-27T00:00:02.000Z',
                        mes: 'Line 1\nLine 2 — "quoted" & テスト',
                        extra: {},
                    },
                ];

                const saveResponse = await fetch(`${server.baseUrl}/api/chats/save`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        ch_name: characterName,
                        file_name: fileName,
                        avatar_url: avatarUrl,
                        chat: initialChat,
                    }),
                });
                assert.equal(saveResponse.status, 200, `POST /api/chats/save returned ${saveResponse.status}`);
                const saveResult = await saveResponse.json();
                assert.equal(saveResult.ok, true);
                assert.ok(typeof saveResult.integrity === 'string' && saveResult.integrity.length > 0, 'Missing integrity token on chat save');

                const chatFilePath = path.join(server.dataRoot, 'default-user', 'chats', characterName, `${fileName}.jsonl`);
                assert.ok(isPathInsideDirectory(server.dataRoot, chatFilePath), 'Saved chat escaped temp dataRoot');
                assert.ok(fs.existsSync(chatFilePath), `Expected saved chat file at ${chatFilePath}`);

                const reloadResponse = await fetch(`${server.baseUrl}/api/chats/get`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        ch_name: characterName,
                        file_name: fileName,
                        avatar_url: avatarUrl,
                    }),
                });
                assert.equal(reloadResponse.status, 200, `POST /api/chats/get returned ${reloadResponse.status}`);
                const reloaded = await reloadResponse.json();
                assert.equal(Array.isArray(reloaded), true);
                assert.equal(reloaded.length, initialChat.length);
                assert.equal(reloaded[0].user_name, 'ParityUser');
                assert.equal(reloaded[0].character_name, characterName);
                assert.equal(reloaded[0].chat_metadata.parity_marker, 'ws9-chat-save');
                assert.equal(reloaded[0].chat_metadata.note, 'café-テスト');
                assert.equal(reloaded[0].chat_metadata.integrity, saveResult.integrity);
                assert.equal(reloaded[1].mes, initialChat[1].mes);
                assert.equal(reloaded[2].mes, initialChat[2].mes);

                const appendedMessage = {
                    name: characterName,
                    is_user: false,
                    is_system: false,
                    send_date: '2026-11-27T00:00:03.000Z',
                    mes: 'Follow-up saved with integrity.',
                    extra: { api: 'custom' },
                };
                const secondSave = await fetch(`${server.baseUrl}/api/chats/save`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        ch_name: characterName,
                        file_name: fileName,
                        avatar_url: avatarUrl,
                        chat: [...reloaded, appendedMessage],
                    }),
                });
                assert.equal(secondSave.status, 200, `Second POST /api/chats/save returned ${secondSave.status}`);
                const secondSaveResult = await secondSave.json();
                assert.equal(secondSaveResult.ok, true);
                assert.notEqual(secondSaveResult.integrity, saveResult.integrity);

                const secondReload = await fetch(`${server.baseUrl}/api/chats/get`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        ch_name: characterName,
                        file_name: fileName,
                        avatar_url: avatarUrl,
                    }),
                });
                assert.equal(secondReload.status, 200);
                const reloadedAgain = await secondReload.json();
                assert.equal(reloadedAgain.length, 4);
                assert.equal(reloadedAgain[3].mes, appendedMessage.mes);
                assert.equal(reloadedAgain[0].chat_metadata.integrity, secondSaveResult.integrity);
            },
        },
        {
            id: 'streamed-generation',
            title: 'Streamed generation',
            run: async () => {
                const requestCountBefore = upstream.requests.length;
                const response = await fetch(`${server.baseUrl}/api/backends/chat-completions/generate`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        chat_completion_source: 'custom',
                        custom_url: upstream.baseUrl,
                        model: 'parity-stream-model',
                        messages: [{ role: 'user', content: 'Stream a greeting' }],
                        stream: true,
                    }),
                });
                assert.equal(response.status, 200, `Streamed generation returned ${response.status}`);
                assert.ok(response.body, 'Streamed generation response had no body stream');

                const rawSse = await response.text();
                const parsed = parseSseStreamText(rawSse);
                assert.equal(parsed.text, 'Hello from parity!');
                assert.equal(parsed.done, true, 'Streamed generation did not emit [DONE]');
                assert.deepEqual(parsed.chunks, ['Hello ', 'from ', 'parity!']);

                const upstreamRequest = upstream.requests[requestCountBefore];
                assert.ok(upstreamRequest, 'Fake upstream did not receive streamed generation request');
                assert.equal(upstreamRequest.body.model, 'parity-stream-model');
                assert.equal(upstreamRequest.body.stream, true);
                assert.deepEqual(upstreamRequest.body.messages, [{ role: 'user', content: 'Stream a greeting' }]);
            },
        },
        {
            id: 'cancelled-generation',
            title: 'Cancelled generation',
            run: async () => {
                // 1. Plain streamed generation cancelled by dropping the client connection mid-stream.
                const directClosedPromise = upstream.waitForNextSilentClose();
                const abortController = new AbortController();
                const directResponse = await fetch(`${server.baseUrl}/api/backends/chat-completions/generate`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        chat_completion_source: 'custom',
                        custom_url: upstream.baseUrl,
                        model: 'parity-cancel-silent',
                        messages: [{ role: 'user', content: 'Abort direct stream' }],
                        stream: true,
                    }),
                    signal: abortController.signal,
                });
                assert.equal(directResponse.status, 200, `Direct cancel stream returned ${directResponse.status}`);
                const directReader = directResponse.body.getReader();
                const firstDirectChunk = await readUntil(directReader, text => text.includes('First chunk'));
                assert.ok(firstDirectChunk.includes('First chunk'));

                abortController.abort();
                await directReader.cancel().catch(() => undefined);
                const directCloseOutcome = await Promise.race([
                    directClosedPromise,
                    new Promise(resolve => setTimeout(() => resolve({ closed: false }), DEFAULT_CANCEL_TIMEOUT_MS)),
                ]);
                assert.equal(directCloseOutcome.closed, true, 'Client disconnect did not propagate abort to upstream within 5s');

                // 2. Resumable streamed generation cancelled explicitly through /api/resumable-generations/cancel.
                const resumableClosedPromise = upstream.waitForNextSilentClose();
                const generationId = 'parity_cancel_resumable_001';
                const resumableResponse = await fetch(`${server.baseUrl}/api/backends/chat-completions/generate`, {
                    method: 'POST',
                    headers: authHeaders({
                        'Content-Type': 'application/json',
                        'X-Generation-Id': generationId,
                    }),
                    body: JSON.stringify({
                        chat_completion_source: 'custom',
                        custom_url: upstream.baseUrl,
                        model: 'parity-cancel-silent',
                        messages: [{ role: 'user', content: 'Cancel resumable stream' }],
                        stream: true,
                    }),
                });
                assert.equal(resumableResponse.status, 200, `Resumable cancel stream returned ${resumableResponse.status}`);
                const resumableReader = resumableResponse.body.getReader();
                const firstResumableChunk = await readUntil(resumableReader, text => text.includes('First chunk'));
                assert.ok(firstResumableChunk.includes('First chunk'));

                const cancelResponse = await fetch(`${server.baseUrl}/api/resumable-generations/cancel`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ id: generationId }),
                });
                assert.equal(cancelResponse.status, 204, `POST /api/resumable-generations/cancel returned ${cancelResponse.status}`);

                const resumableCloseOutcome = await Promise.race([
                    resumableClosedPromise,
                    new Promise(resolve => setTimeout(() => resolve({ closed: false }), DEFAULT_CANCEL_TIMEOUT_MS)),
                ]);
                assert.equal(resumableCloseOutcome.closed, true, 'Resumable cancel did not propagate abort to upstream within 5s');

                // Confirm the server finished the cancelled client response stream cleanly.
                const tailRead = await Promise.race([
                    resumableReader.read().then(result => result.done),
                    new Promise(resolve => setTimeout(() => resolve(false), DEFAULT_CANCEL_TIMEOUT_MS)),
                ]);
                await resumableReader.cancel().catch(() => undefined);
                assert.equal(tailRead, true, 'Cancelled resumable response stream did not close on the client side');

                const healthAfterCancel = await fetch(`${server.baseUrl}/api/ping`, {
                    method: 'POST',
                    headers: authHeaders(),
                });
                assert.equal(healthAfterCancel.status, 204, 'Server did not remain healthy after cancelled generations');
            },
        },
    ];

    const results = [];
    for (const check of checks) {
        const startedAt = Date.now();
        await check.run();
        const result = {
            id: check.id,
            title: check.title,
            durationMs: Date.now() - startedAt,
        };
        results.push(result);
        onCheckPass?.(result);
    }
    return results;
}

/**
 * Boots the real server under the target runtime, runs every parity check, and cleans up all resources.
 * @param {{
 *   runtime?: string,
 *   logFilePath?: string,
 *   readyTimeoutMs?: number,
 *   onCheckPass?: (result: { id: string, title: string, durationMs: number }) => void,
 * }} [options] Suite options
 * @returns {Promise<{
 *   runtime: 'bun' | 'node',
 *   bootDurationMs: number,
 *   totalDurationMs: number,
 *   checks: Array<{ id: string, title: string, durationMs: number }>,
 * }>}
 */
export async function runRuntimeParitySuite({
    runtime,
    logFilePath = process.env.SILLYBUNNY_PARITY_SERVER_LOG || '',
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    onCheckPass = null,
} = {}) {
    const targetRuntime = resolveParityRuntime(runtime);
    const totalStart = Date.now();
    const upstream = await startFakeUpstreamServer();
    let server = null;

    try {
        server = await startParityServer({
            runtime: targetRuntime,
            readyTimeoutMs,
            logFilePath,
        });
        const checks = await runParityChecks(server, upstream, { onCheckPass });
        return {
            runtime: targetRuntime,
            bootDurationMs: server.bootDurationMs,
            totalDurationMs: Date.now() - totalStart,
            checks,
        };
    } catch (error) {
        if (server) {
            error.serverLogTail = server.getLogTail();
        }
        throw error;
    } finally {
        await server?.stop();
        await upstream.close();
    }
}
