import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { Response } from 'node-fetch';

import { REQUEST_CANCELLATION_ABORT_REASON, observeRequestCancellation } from '../src/request-cancellation.js';
import {
    ResumableGeneration,
    resumableGenerationMiddleware,
    router,
    testExports,
} from '../src/resumable-generations.js';
import { forwardFetchResponse } from '../src/util.js';

function createMockRequest(id = 'test-generation-1') {
    const headers = { 'x-generation-id': id };
    return {
        headers,
        socket: new EventEmitter(),
        user: { profile: { handle: 'tester' } },
        get(name) {
            return headers[String(name).toLowerCase()];
        },
    };
}

function createMockResponse() {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = '';
    response.socket = {};
    response.getHeader = () => undefined;
    return response;
}

/**
 * Runs the middleware and hands back the registered generation.
 */
function registerGeneration(id) {
    const request = createMockRequest(id);
    const response = createMockResponse();
    const next = jest.fn();
    resumableGenerationMiddleware(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    return { request, response, generation: request.resumableGeneration };
}

function collect(generation, offset = 0) {
    return new Promise(resolve => {
        const chunks = [];
        generation.subscribe(offset, {
            onChunk: chunk => chunks.push(chunk),
            onEnd: () => resolve(Buffer.concat(chunks).toString('utf8')),
        });
    });
}

afterEach(() => {
    jest.restoreAllMocks();
    testExports.generations.clear();
});

describe('resumable generation registry', () => {
    test('ignores requests without a usable generation id', () => {
        const request = createMockRequest('not valid!');
        const response = createMockResponse();
        const next = jest.fn();

        resumableGenerationMiddleware(request, response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(request.resumableGeneration).toBeUndefined();
        expect(testExports.generations.size).toBe(0);
    });

    test('mirrors everything the handler writes and replays it from an offset', async () => {
        const { response, generation } = registerGeneration('mirror-1');
        response.statusCode = 201;
        const headers = { 'content-type': 'text/plain' };
        response.getHeader = name => headers[String(name).toLowerCase()];

        response.write('hello ');
        response.end('world');

        expect(generation.done).toBe(true);
        expect(generation.statusCode).toBe(201);
        expect(generation.contentType).toBe('text/plain');
        expect(generation.size).toBe(11);
        await expect(collect(generation)).resolves.toBe('hello world');
        await expect(collect(generation, 6)).resolves.toBe('world');
        expect(testExports.generations.get('tester:mirror-1')).toBe(generation);
    });

    test('live subscribers get the bytes written after they attached', async () => {
        const { response, generation } = registerGeneration('live-stream-1');

        response.write('one,');
        const collected = collect(generation, 2);
        response.write('two,');
        response.end('three');

        await expect(collected).resolves.toBe('e,two,three');
    });

    test('discards an overflowing generation and releases its buffered bytes', () => {
        const { generation } = registerGeneration('overflow-1');
        const subscriber = {
            onChunk: jest.fn(),
            onEnd: jest.fn(),
            onFail: jest.fn(),
        };
        generation.subscribe(0, subscriber);
        const cancelHook = jest.fn();
        generation.onCancel(cancelHook);

        generation.write(Buffer.alloc(testExports.MAX_BUFFER_BYTES));
        generation.write('overflow');

        expect(subscriber.onChunk).toHaveBeenCalledTimes(1);
        expect(subscriber.onFail).toHaveBeenCalledTimes(1);
        expect(subscriber.onEnd).not.toHaveBeenCalled();
        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(generation.cancelled).toBe(true);
        expect(generation.done).toBe(true);
        expect(testExports.generations.has('tester:overflow-1')).toBe(false);
        expect(generation.chunks).toHaveLength(0);
        expect(generation.size).toBe(0);
    });

    test('does not double-end the attached response when overflow cancellation ends it', async () => {
        const { response, generation } = registerGeneration('overflow-response');
        const errors = [];
        response.on('error', error => errors.push(error));
        generation.onCancel(() => response.end());

        response.write(Buffer.alloc(testExports.MAX_BUFFER_BYTES));
        response.end('overflow');
        await new Promise(resolve => setImmediate(resolve));

        expect(errors).toHaveLength(0);
        expect(generation.done).toBe(true);
    });

    test('evicting an active generation cancels, finishes, and releases it', () => {
        const { response, generation } = registerGeneration('capacity-active');
        response.write('buffered');
        const subscriber = {
            onChunk: jest.fn(),
            onEnd: jest.fn(),
            onFail: jest.fn(),
        };
        generation.subscribe(0, subscriber);
        const cancelHook = jest.fn(() => response.end());
        generation.onCancel(cancelHook);

        for (let index = 0; index < testExports.MAX_GENERATIONS; index++) {
            registerGeneration(`capacity-${index}`);
        }

        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(subscriber.onFail).toHaveBeenCalledTimes(1);
        expect(subscriber.onEnd).not.toHaveBeenCalled();
        expect(generation.cancelled).toBe(true);
        expect(generation.done).toBe(true);
        expect(testExports.generations.has('tester:capacity-active')).toBe(false);
        expect(generation.chunks).toHaveLength(0);
        expect(generation.size).toBe(0);
    });

    test('evicting a finished generation does not cancel it', () => {
        const { response, generation } = registerGeneration('capacity-finished');
        const cancelHook = jest.fn();
        generation.onCancel(cancelHook);
        response.end('buffered');

        for (let index = 0; index < testExports.MAX_GENERATIONS; index++) {
            registerGeneration(`finished-${index}`);
        }

        expect(cancelHook).not.toHaveBeenCalled();
        expect(generation.cancelled).toBe(false);
        expect(generation.done).toBe(true);
        expect(testExports.generations.has('tester:capacity-finished')).toBe(false);
        expect(generation.chunks).toHaveLength(0);
        expect(generation.size).toBe(0);
    });

    test('re-registering an id cancels the superseded generation', () => {
        jest.spyOn(console, 'info').mockImplementation(() => undefined);
        const first = registerGeneration('replayed-1');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);

        const second = registerGeneration('replayed-1');

        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(first.generation.cancelled).toBe(true);
        expect(first.generation.done).toBe(true);
        expect(second.generation).not.toBe(first.generation);
        expect(testExports.generations.get('tester:replayed-1')).toBe(second.generation);
    });

    test('re-registering an id leaves a finished reply alone', () => {
        const first = registerGeneration('replayed-2');
        first.response.end('all done');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);

        registerGeneration('replayed-2');

        expect(cancelHook).not.toHaveBeenCalled();
        expect(first.generation.size).toBe('all done'.length);
    });

    test('cancel runs each hook once and does nothing once the reply finished', () => {
        const generation = new ResumableGeneration('tester:hooks');
        const hook = jest.fn();
        generation.onCancel(hook);

        expect(generation.cancel()).toBe(true);
        expect(generation.cancel()).toBe(false);
        expect(hook).toHaveBeenCalledTimes(1);

        const finished = new ResumableGeneration('tester:finished');
        const lateHook = jest.fn();
        finished.end();
        finished.onCancel(lateHook);

        expect(finished.cancel()).toBe(false);
        expect(lateHook).not.toHaveBeenCalled();
    });

    test('sweep drops finished replies after retention and cancels ones that ran too long', () => {
        const { response: finishedResponse, generation: finished } = registerGeneration('sweep-finished');
        finishedResponse.end('done');
        const { generation: running } = registerGeneration('sweep-running');
        const hook = jest.fn();
        running.onCancel(hook);

        const now = Date.now();
        testExports.sweepGenerations(now + testExports.FINISHED_RETENTION_MS - 1000);
        expect(testExports.generations.has('tester:sweep-finished')).toBe(true);
        expect(testExports.generations.has('tester:sweep-running')).toBe(true);

        testExports.sweepGenerations(now + testExports.FINISHED_RETENTION_MS + 1000);
        expect(testExports.generations.has('tester:sweep-finished')).toBe(false);
        expect(testExports.generations.has('tester:sweep-running')).toBe(true);
        expect(hook).not.toHaveBeenCalled();

        testExports.sweepGenerations(now + testExports.MAX_LIFETIME_MS + 1000);
        expect(testExports.generations.has('tester:sweep-running')).toBe(false);
        expect(hook).toHaveBeenCalledTimes(1);
        expect(running.done).toBe(true);
        expect(finished.done).toBe(true);
    });
});

describe('resumable generations and the disconnect guards', () => {
    test('forwardFetchResponse keeps draining upstream after the client response closes', async () => {
        const { request, response, generation } = registerGeneration('forward-1');
        const upstreamBody = new PassThrough();
        const destroySpy = jest.spyOn(upstreamBody, 'destroy');
        const onDisconnect = jest.fn();
        const collected = collect(generation);

        await forwardFetchResponse(new Response(upstreamBody), response, request, onDisconnect);
        upstreamBody.write('data: first\n\n');
        response.emit('close');
        expect(destroySpy).not.toHaveBeenCalled();
        expect(onDisconnect).not.toHaveBeenCalled();

        // Everything upstream sends after the client left still lands in the generation.
        upstreamBody.write('data: second\n\n');
        upstreamBody.end('data: [DONE]\n\n');

        await expect(collected).resolves.toBe('data: first\n\ndata: second\n\ndata: [DONE]\n\n');
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(generation.done).toBe(true);
    });

    test('cancelling a forwarded generation runs the provider hook and destroys upstream', async () => {
        const { request, response, generation } = registerGeneration('forward-cancel');
        const upstreamBody = new PassThrough();
        const destroySpy = jest.spyOn(upstreamBody, 'destroy');
        const onDisconnect = jest.fn();

        await forwardFetchResponse(new Response(upstreamBody), response, request, onDisconnect);
        upstreamBody.write('data: first\n\n');
        expect(generation.cancel()).toBe(true);

        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(generation.done).toBe(true);
        expect(response.writableEnded).toBe(true);
    });

    test('observeRequestCancellation ignores client disconnects and aborts on an explicit cancel', () => {
        const { request, response, generation } = registerGeneration('observe-1');
        const controller = new AbortController();

        observeRequestCancellation(request, response, { controller });
        response.emit('close');
        request.socket.emit('close');
        expect(controller.signal.aborted).toBe(false);

        generation.cancel();
        expect(controller.signal.aborted).toBe(true);
        expect(controller.signal.reason).toBe(REQUEST_CANCELLATION_ABORT_REASON);
    });

    test('observeRequestCancellation still aborts on disconnect for ordinary requests', () => {
        const request = { socket: new EventEmitter() };
        const response = createMockResponse();
        const controller = new AbortController();

        observeRequestCancellation(request, response, { controller });
        response.emit('close');

        expect(controller.signal.aborted).toBe(true);
    });
});

describe('resumable generation routes', () => {
    let server;
    let baseUrl;
    /** @type {Map<string, () => void>} */
    const pendingHandlers = new Map();
    const cancelled = new Set();

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'route-tester' } };
            next();
        });
        app.use('/api/resumable-generations', router);
        app.use(resumableGenerationMiddleware);
        app.post('/generate', (request, response) => {
            const id = request.get('x-generation-id');
            request.resumableGeneration.onCancel(() => {
                cancelled.add(id);
                response.end();
            });
            response.status(201);
            response.setHeader('Content-Type', 'text/plain');
            response.write('first-');
            pendingHandlers.set(id, () => {
                response.write('second-');
                response.end('done');
            });
        });

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    function postJson(path, body) {
        return fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    test('resume is a 404 for a reply the server does not have', async () => {
        const response = await postJson('/api/resumable-generations/resume', { id: 'never-registered', offset: 0 });
        expect(response.status).toBe(404);
    });

    test('replays the rest of a reply whose client went away, with the original status', async () => {
        const id = 'route-resume-1';
        const original = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        const reader = original.body.getReader();
        const first = await reader.read();
        expect(original.status).toBe(201);
        expect(new TextDecoder().decode(first.value)).toBe('first-');

        // The client drops off mid-reply; the handler only finishes afterwards.
        await reader.cancel();
        pendingHandlers.get(id)();

        const resumed = await postJson('/api/resumable-generations/resume', { id, offset: 6 });
        expect(resumed.status).toBe(200);
        expect(resumed.headers.get('x-generation-status')).toBe('201');
        expect(resumed.headers.get('content-type')).toContain('text/plain');
        expect(resumed.headers.get('cache-control')).toContain('no-store');
        await expect(resumed.text()).resolves.toBe('second-done');

        const fromStart = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await expect(fromStart.text()).resolves.toBe('first-second-done');

        const beyond = await postJson('/api/resumable-generations/resume', { id, offset: 999 });
        expect(beyond.status).toBe(416);
    });

    test('a resume that attaches before the reply finishes streams the live tail', async () => {
        const id = 'route-resume-live';
        const original = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        await original.body.getReader().read();

        const resumedPromise = postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await new Promise(resolve => setTimeout(resolve, 50));
        pendingHandlers.get(id)();

        const resumed = await resumedPromise;
        await expect(resumed.text()).resolves.toBe('first-second-done');
    });

    test('cancel stops a running reply and reports 404 afterwards for unknown ids', async () => {
        const id = 'route-cancel-1';
        const original = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        await original.body.getReader().read();

        const cancel = await postJson('/api/resumable-generations/cancel', { id });
        expect(cancel.status).toBe(204);
        expect(cancelled.has(id)).toBe(true);

        const unknown = await postJson('/api/resumable-generations/cancel', { id: 'nobody-home' });
        expect(unknown.status).toBe(404);
    });
});
