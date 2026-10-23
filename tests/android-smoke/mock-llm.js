import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { closeHttpServer, guardRequestHandler, listenOnFixturePort, parseRequestTarget } from './ports.js';

export const MOCK_MODEL_ID = 'sillybunny-smoke';
export const MOCK_REPLY = 'mock reply';
export const MOCK_CREATED = 1767225600;
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Splits the canned reply into deterministic stream deltas (each word keeps its leading space).
 * @param {string} reply Reply text.
 * @returns {string[]} Deltas.
 */
export function replyChunks(reply) {
    return reply.match(/\s*\S+\s*$|\s*\S+/g) ?? [reply];
}

function sendJson(response, status, body, headers = {}) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        ...headers,
    });
    response.end(text);
}

function sendError(response, status, type, headers = {}) {
    sendJson(response, status, { error: { message: 'TODO(copy)', type, code: null } }, headers);
}

function readJson(request, limit) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let overflow = false;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                overflow = true;
                request.pause();
                resolve({ overflow });
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (overflow) {
                return;
            }
            try {
                resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            } catch {
                resolve({ invalid: true });
            }
        });
        request.on('error', () => resolve({ invalid: true }));
    });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Starts a mock OpenAI-compatible endpoint with `/v1/models` and `/v1/chat/completions`
 * (plain JSON and SSE streaming). SillyBunny's Custom source calls `<url>/models` for its status
 * check and `<url>/chat/completions` for generation, so set the custom URL to `<url>/v1`.
 * @param {object} [options] Options.
 * @param {string} [options.host] Bind host (default loopback).
 * @param {number} [options.port] Explicit fixture port (default random).
 * @param {number} [options.maxPort] Highest random port (default the top of the fixture range).
 * @param {string} [options.reply] Canned assistant reply.
 * @param {string[]} [options.models] Model ids listed by `/v1/models`.
 * @param {number} [options.chunkDelayMs] Delay between stream chunks.
 * @param {number} [options.maxRequestBytes] Request body limit.
 * @param {string} [options.logFile] JSON Lines file that receives one entry per request.
 * @returns {Promise<{host: string, port: number, url: string, baseUrl: string, model: string, reply: string, requests: object[], close: () => Promise<void>}>}
 */
export async function startMockLlm({
    host = '127.0.0.1',
    port,
    maxPort,
    reply = MOCK_REPLY,
    models = [MOCK_MODEL_ID],
    chunkDelayMs = 0,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    logFile,
} = {}) {
    if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    }
    /** @type {object[]} */
    const requests = [];
    let completions = 0;

    const record = (entry) => {
        requests.push(entry);
        if (logFile) {
            fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
        }
    };

    const server = http.createServer(guardRequestHandler(async (request, response) => {
        const url = parseRequestTarget(request);
        // A target that URL rejects is logged as it was sent.
        const entry = { time: new Date().toISOString(), method: request.method, path: url ? url.pathname : String(request.url ?? '') };
        if (!url) {
            record({ ...entry, status: 400 });
            sendError(response, 400, 'invalid_request_error');
            return;
        }
        // SillyBunny appends `/chat/completions` to the base URL as text, so a base URL with a trailing slash yields `//`.
        const pathname = url.pathname.replace(/\/{2,}/g, '/');

        if (pathname === '/v1/models') {
            if (request.method !== 'GET') {
                record({ ...entry, status: 405 });
                sendError(response, 405, 'invalid_request_error');
                return;
            }
            record({ ...entry, status: 200 });
            sendJson(response, 200, {
                object: 'list',
                data: models.map(id => ({ id, object: 'model', created: MOCK_CREATED, owned_by: MOCK_MODEL_ID })),
            });
            return;
        }

        if (pathname !== '/v1/chat/completions') {
            record({ ...entry, status: 404 });
            sendError(response, 404, 'not_found_error');
            return;
        }
        if (request.method !== 'POST') {
            record({ ...entry, status: 405 });
            sendError(response, 405, 'invalid_request_error');
            return;
        }

        const parsed = await readJson(request, maxRequestBytes);
        const body = parsed.body;
        if (parsed.overflow || !body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
            const status = parsed.overflow ? 413 : 400;
            record({ ...entry, status });
            // An oversized body is left unread, so the connection cannot be reused.
            sendError(response, status, 'invalid_request_error', parsed.overflow ? { 'Connection': 'close' } : {});
            return;
        }

        completions += 1;
        const id = `chatcmpl-smoke-${completions}`;
        const model = typeof body.model === 'string' && body.model ? body.model : models[0];
        const stream = body.stream === true;
        const chunks = replyChunks(reply);
        record({ ...entry, status: 200, id, model, stream, messages: body.messages });

        if (!stream) {
            sendJson(response, 200, {
                id,
                object: 'chat.completion',
                created: MOCK_CREATED,
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: body.messages.length,
                    completion_tokens: chunks.length,
                    total_tokens: body.messages.length + chunks.length,
                },
            });
            return;
        }

        response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        const event = (delta, finishReason = null) => `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: MOCK_CREATED,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
        const frames = [
            event({ role: 'assistant', content: '' }),
            ...chunks.map(content => event({ content })),
            event({}, 'stop'),
            'data: [DONE]\n\n',
        ];
        for (const frame of frames) {
            if (response.destroyed) {
                return;
            }
            response.write(frame);
            if (chunkDelayMs > 0) {
                await delay(chunkDelayMs);
            }
        }
        response.end();
    }, record));

    const boundPort = await listenOnFixturePort(server, { host, port, maxPort });
    const url = `http://${host}:${boundPort}`;
    return {
        host,
        port: boundPort,
        url,
        baseUrl: `${url}/v1`,
        model: models[0],
        reply,
        requests,
        close: () => closeHttpServer(server),
    };
}
