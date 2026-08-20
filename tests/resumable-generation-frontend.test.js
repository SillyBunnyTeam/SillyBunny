/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const { fetchResumable, reconnectStaleGenerations } = await import('../public/scripts/resumable-generation.js');
const customRequestSource = readFileSync(new URL('../public/scripts/custom-request.js', import.meta.url), 'utf8');

const RESUME_URL = '/api/resumable-generations/resume';
const CANCEL_URL = '/api/resumable-generations/cancel';
const encoder = new TextEncoder();

/**
 * A body that hands out the given parts, then either closes, errors, or hangs until the signal aborts.
 */
function bodyFrom(parts, { errorAfter = Infinity, error = new TypeError('Load failed'), hang = false, signal = null } = {}) {
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index < parts.length && index < errorAfter) {
                controller.enqueue(encoder.encode(parts[index++]));
                return;
            }
            if (index >= errorAfter && index < parts.length) {
                controller.error(error);
                return;
            }
            if (!hang) {
                controller.close();
                return;
            }
            return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
            });
        },
    });
}

function resumeResponse(parts, { status = 200, statusText = '', contentType = null } = {}) {
    const headers = { 'X-Generation-Status': String(status) };
    if (statusText) {
        headers['X-Generation-Status-Text'] = statusText;
    }
    if (contentType) {
        headers['Content-Type'] = contentType;
    }
    return new Response(bodyFrom(parts), { status: 200, headers });
}

const originalFetch = globalThis.fetch;
let fetchMock;

beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function callsTo(url) {
    return fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url);
}

describe('fetchResumable', () => {
    test('passes an uninterrupted reply through and tags the request', async () => {
        fetchMock.mockResolvedValueOnce(new Response(bodyFrom(['data: a\n\n', 'data: [DONE]\n\n']), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        }));

        const response = await fetchResumable('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' },
            body: '{}',
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        await expect(response.text()).resolves.toBe('data: a\n\ndata: [DONE]\n\n');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/backends/chat-completions/generate');
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{}');
        expect(init.headers['X-CSRF-Token']).toBe('csrf');
        expect(init.headers['X-Generation-Id']).toMatch(/^[0-9a-f]{32}$/);
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    test('reattaches from the last byte when the stream breaks', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(bodyFrom(['data: a\n\n', 'data: b\n\n'], { errorAfter: 1 }), { status: 200 }))
            .mockResolvedValueOnce(resumeResponse(['data: b\n\n', 'data: [DONE]\n\n']));

        const response = await fetchResumable('/generate', { method: 'POST', headers: { 'X-CSRF-Token': 'csrf' }, body: '{}' });
        await expect(response.text()).resolves.toBe('data: a\n\ndata: b\n\ndata: [DONE]\n\n');

        const generationId = fetchMock.mock.calls[0][1].headers['X-Generation-Id'];
        const [resumeUrl, resumeInit] = fetchMock.mock.calls[1];
        expect(resumeUrl).toBe(RESUME_URL);
        expect(resumeInit.method).toBe('POST');
        expect(JSON.parse(resumeInit.body)).toEqual({ id: generationId, offset: 'data: a\n\n'.length });
        expect(resumeInit.headers['X-CSRF-Token']).toBe('csrf');
        expect(resumeInit.headers['X-Generation-Id']).toBeUndefined();
        expect(callsTo(CANCEL_URL)).toHaveLength(0);
    });

    test('asks the server for the reply when the first request dies before answering', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValueOnce(resumeResponse(['{"choices":[]}'], { status: 400, statusText: 'Bad Request', contentType: 'application/json' }));

        const response = await fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}' });

        expect(response.ok).toBe(false);
        expect(response.status).toBe(400);
        expect(response.statusText).toBe('Bad Request');
        expect(response.headers.get('content-type')).toBe('application/json');
        await expect(response.json()).resolves.toEqual({ choices: [] });
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).offset).toBe(0);
    });

    test('surfaces the original failure when the server has no such reply', async () => {
        const failure = new TypeError('Load failed');
        fetchMock
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(new Response(null, { status: 404 }));

        await expect(fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}' })).rejects.toBe(failure);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('aborting cancels the generation server-side instead of reattaching', async () => {
        const controller = new AbortController();
        fetchMock.mockImplementation(async (url, init) => {
            if (url === CANCEL_URL) {
                return new Response(null, { status: 204 });
            }
            return new Response(bodyFrom(['data: a\n\n'], { hang: true, signal: init.signal }), { status: 200 });
        });

        const response = await fetchResumable('/generate', { method: 'POST', headers: { 'X-CSRF-Token': 'csrf' }, body: '{}', signal: controller.signal });
        const text = response.text();
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.abort();

        await expect(text).rejects.toBeDefined();
        expect(callsTo(RESUME_URL)).toHaveLength(0);
        const cancelCalls = callsTo(CANCEL_URL);
        expect(cancelCalls).toHaveLength(1);
        const [, cancelInit] = cancelCalls[0];
        expect(cancelInit.method).toBe('POST');
        expect(cancelInit.keepalive).toBe(true);
        expect(cancelInit.headers['X-CSRF-Token']).toBe('csrf');
        expect(JSON.parse(cancelInit.body)).toEqual({ id: fetchMock.mock.calls[0][1].headers['X-Generation-Id'] });
    });

    test('reconnects a stalled stream when the page wakes up', async () => {
        fetchMock.mockImplementation(async (url, init) => {
            if (url === RESUME_URL) {
                return resumeResponse(['data: b\n\n', 'data: [DONE]\n\n']);
            }
            return new Response(bodyFrom(['data: a\n\n'], { hang: true, signal: init.signal }), { status: 200 });
        });

        const response = await fetchResumable('/generate', { method: 'POST', headers: {}, body: '{}' });
        const text = response.text();
        await new Promise(resolve => setTimeout(resolve, 10));

        reconnectStaleGenerations(Date.now() + 1000);
        expect(callsTo(RESUME_URL)).toHaveLength(0);

        reconnectStaleGenerations(Date.now() + 10000);
        await expect(text).resolves.toBe('data: a\n\ndata: b\n\ndata: [DONE]\n\n');
        expect(callsTo(RESUME_URL)).toHaveLength(1);
        expect(JSON.parse(callsTo(RESUME_URL)[0][1].body).offset).toBe('data: a\n\n'.length);
    });
});

test('routes all scoped-profile generation requests through fetchResumable', () => {
    expect(customRequestSource).toContain('import { fetchResumable } from \'./resumable-generation.js\';');
    expect(customRequestSource.match(/const response = await fetchResumable\(/g)).toHaveLength(3);
    expect(customRequestSource).toContain('await fetchResumable(getGenerateUrl(this.TYPE), {');
    expect(customRequestSource).toContain('await fetchResumable(\'/api/backends/text-completions/generate\', {');
    expect(customRequestSource).toContain('await fetchResumable(\'/api/backends/chat-completions/generate\', {');
});
