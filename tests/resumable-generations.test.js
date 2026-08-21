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
    testExports.setTotalBufferedBytes(0);
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
        expect(testExports.totalBufferedBytes).toBe(11);
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

    test('re-registering an id drops the finished reply\'s buffered copy', () => {
        const first = registerGeneration('replayed-2');
        first.response.end('all done');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);

        registerGeneration('replayed-2');

        expect(cancelHook).not.toHaveBeenCalled();
        expect(first.generation.done).toBe(true);
        expect(first.generation.size).toBe(0);
        expect(testExports.totalBufferedBytes).toBe(0);
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

    test('waiting for headers can be cancelled when the waiting client disappears', async () => {
        const { generation } = registerGeneration('waiter-1');
        const wait = generation.waitForHeaders();
        expect(generation.headerWaiters).toHaveLength(1);

        wait.cancel();
        await expect(wait.promise).resolves.toBeUndefined();
        expect(generation.headerWaiters).toHaveLength(0);

        const late = generation.waitForHeaders();
        generation.captureHeaders({ statusCode: 201, statusMessage: '', getHeader: () => undefined });
        await expect(late.promise).resolves.toBeUndefined();
        expect(generation.headerWaiters).toHaveLength(0);
    });
});

describe('registry capacity', () => {
    /**
     * Registers a generation for a synthetic profile, bypassing the tester helper.
     */
    function registerFor(handle, id) {
        const request = createMockRequest(id);
        request.user = { profile: { handle } };
        const response = createMockResponse();
        const next = jest.fn();
        resumableGenerationMiddleware(request, response, next);
        expect(next).toHaveBeenCalledTimes(1);
        return { request, response, generation: request.resumableGeneration };
    }

    let fillerCount = 0;

    /**
     * Adds a live filler registration spread over synthetic profiles.
     */
    function addLiveFiller() {
        const bucket = Math.floor(fillerCount / testExports.MAX_GENERATIONS_PER_PROFILE);
        fillerCount++;
        return registerFor(`filler-${bucket}`, `filler${String(fillerCount).padStart(6, '0')}`);
    }

    afterEach(() => {
        fillerCount = 0;
    });

    test('a full registry never discards another profile\'s live generation', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const victim = registerGeneration('victim-1');
        victim.response.write('live');
        const cancelHook = jest.fn();
        victim.generation.onCancel(cancelHook);

        while (testExports.generations.size < testExports.MAX_GENERATIONS) {
            addLiveFiller();
        }
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS);

        const latecomer = registerFor('filler-late', 'latecomer-00001');

        expect(latecomer.generation).toBeUndefined();
        expect(cancelHook).not.toHaveBeenCalled();
        expect(victim.generation.cancelled).toBe(false);
        expect(testExports.generations.has('tester:victim-1')).toBe(true);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS);
    });

    test('an over-cap profile gives up its own oldest live generation', () => {
        const first = registerGeneration('own-000000');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);
        for (let index = 1; index < testExports.MAX_GENERATIONS_PER_PROFILE; index++) {
            registerGeneration(`own-${String(index).padStart(6, '0')}`);
        }
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS_PER_PROFILE);

        registerGeneration('own-newest');

        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(first.generation.cancelled).toBe(true);
        expect(first.generation.done).toBe(true);
        expect(testExports.generations.has('tester:own-000000')).toBe(false);
        expect(testExports.generations.has('tester:own-newest')).toBe(true);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS_PER_PROFILE);
    });

    test('global pressure drops finished replies before touching live ones', () => {
        const finished = registerGeneration('finished-spare');
        finished.response.end('cached');
        const live = registerGeneration('live-keep');
        live.response.write('running');

        while (testExports.generations.size < testExports.MAX_GENERATIONS) {
            addLiveFiller();
        }
        addLiveFiller();

        expect(testExports.generations.has('tester:finished-spare')).toBe(false);
        expect(finished.generation.cancelled).toBe(false);
        expect(testExports.generations.has('tester:live-keep')).toBe(true);
        expect(live.generation.cancelled).toBe(false);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS);
    });

    test('the global byte budget frees finished replies before overflowing a live one', () => {
        const spare = registerGeneration('budget-spare');
        spare.response.write(Buffer.alloc(1000));
        spare.response.end();

        const live = registerGeneration('budget-live');
        testExports.setTotalBufferedBytes(testExports.MAX_TOTAL_BUFFER_BYTES - 500);

        live.response.write(Buffer.alloc(800));

        expect(testExports.generations.has('tester:budget-spare')).toBe(false);
        expect(live.generation.overflowed).toBe(false);
        expect(live.generation.size).toBe(800);
        expect(testExports.totalBufferedBytes).toBe(testExports.MAX_TOTAL_BUFFER_BYTES - 700);
    });

    test('a live reply overflows instead of breaking the global byte budget', () => {
        const live = registerGeneration('budget-overflow');
        const subscriber = { onChunk: jest.fn(), onEnd: jest.fn(), onFail: jest.fn() };
        live.generation.subscribe(0, subscriber);
        testExports.setTotalBufferedBytes(testExports.MAX_TOTAL_BUFFER_BYTES);

        live.generation.write('too much');

        expect(live.generation.overflowed).toBe(true);
        expect(subscriber.onFail).toHaveBeenCalledTimes(1);
        expect(live.generation.size).toBe(0);
        // Only the simulated outside pressure remains; the discarded reply gave its bytes back.
        expect(testExports.totalBufferedBytes).toBe(testExports.MAX_TOTAL_BUFFER_BYTES);
        expect(testExports.generations.has('tester:budget-overflow')).toBe(false);
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
    /** @type {Map<string, () => void>} */
    const heldReleases = new Map();
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
            const release = () => {
                response.write('first-');
                pendingHandlers.set(id, () => {
                    response.write('second-');
                    response.end('done');
                });
            };
            if (new URL(request.url, 'http://localhost').searchParams.has('hold')) {
                heldReleases.set(id, release);
            } else {
                release();
            }
        });

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    function postJson(path, body, init = {}) {
        return fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...init,
        });
    }

    async function startGeneration(id, query = '') {
        const promise = fetch(`${baseUrl}/generate${query}`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        if (query) {
            // A held handler writes nothing, so the response headers only arrive on release.
            return promise;
        }
        const original = await promise;
        await original.body.getReader().read();
        return original;
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

    test('a reply serves at most MAX_RESUME_CLIENTS concurrent resumes', async () => {
        const id = 'route-subscriber-limit';
        await startGeneration(id);

        const openReaders = Array.from({ length: testExports.MAX_RESUME_CLIENTS }, () =>
            postJson('/api/resumable-generations/resume', { id, offset: 0 }));
        await new Promise(resolve => setTimeout(resolve, 50));

        const rejected = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        expect(rejected.status).toBe(429);

        pendingHandlers.get(id)();
        for (const reader of await Promise.all(openReaders)) {
            expect(reader.status).toBe(200);
            await expect(reader.text()).resolves.toBe('first-second-done');
        }
    });

    test('at most MAX_RESUME_CLIENTS resumes may queue for a slow handler', async () => {
        const id = 'route-waiter-limit';
        const original = startGeneration(id, '?hold=1');

        const waiting = Array.from({ length: testExports.MAX_RESUME_CLIENTS }, () =>
            postJson('/api/resumable-generations/resume', { id, offset: 0 }));
        await new Promise(resolve => setTimeout(resolve, 50));

        const rejected = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        expect(rejected.status).toBe(503);

        heldReleases.get(id)();
        pendingHandlers.get(id)();
        await (await original).text();
        for (const reader of await Promise.all(waiting)) {
            expect(reader.status).toBe(200);
            await expect(reader.text()).resolves.toBe('first-second-done');
        }
    });

    test('a resume whose connection dies while waiting frees its waiter slot', async () => {
        const id = 'route-waiter-gone';
        const original = startGeneration(id, '?hold=1');

        const waiting = Array.from({ length: testExports.MAX_RESUME_CLIENTS - 1 }, () =>
            postJson('/api/resumable-generations/resume', { id, offset: 0 }));
        const aborter = new AbortController();
        const doomed = postJson('/api/resumable-generations/resume', { id, offset: 0 }, { signal: aborter.signal });
        await new Promise(resolve => setTimeout(resolve, 50));

        aborter.abort();
        await expect(doomed).rejects.toThrow();
        await new Promise(resolve => setTimeout(resolve, 50));

        // The freed slot must admit a fresh waiter instead of answering 503.
        const accepted = postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await new Promise(resolve => setTimeout(resolve, 50));
        heldReleases.get(id)();
        pendingHandlers.get(id)();
        await (await original).text();

        for (const reader of await Promise.all([...waiting, accepted])) {
            expect(reader.status).toBe(200);
            await expect(reader.text()).resolves.toBe('first-second-done');
        }
    });
});
