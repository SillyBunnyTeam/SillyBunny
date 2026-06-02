import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';

import {
    REQUEST_CANCELLATION_ABORT_REASON,
    isRequestCancellationError,
    observeRequestCancellation,
} from '../src/request-cancellation.js';

function createHttpExchange() {
    const request = new EventEmitter();
    request.socket = new EventEmitter();

    const response = new EventEmitter();
    response.writableEnded = false;
    response.destroyed = false;

    return { request, response };
}

describe('observeRequestCancellation', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('aborts the upstream controller on socket close without replacing existing listeners', () => {
        const { request, response } = createHttpExchange();
        const existingCloseListener = jest.fn();
        const controller = new AbortController();

        request.socket.on('close', existingCloseListener);
        observeRequestCancellation(request, response, { controller });
        request.socket.emit('close');

        expect(controller.signal.aborted).toBe(true);
        expect(existingCloseListener).toHaveBeenCalledTimes(1);
    });

    test('runs the abort hook once across duplicate disconnect signals', () => {
        const { request, response } = createHttpExchange();
        const controller = new AbortController();
        const onAbort = jest.fn();

        observeRequestCancellation(request, response, { controller, onAbort });
        request.emit('aborted');
        response.emit('close');
        response.emit('close');
        request.socket.emit('close');

        expect(controller.signal.aborted).toBe(true);
        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(onAbort).toHaveBeenCalledWith(expect.objectContaining({
            request,
            response,
            signal: controller.signal,
            source: 'request-aborted',
        }));
    });

    test('warns when an async abort hook exceeds its timeout without delaying abort', () => {
        jest.useFakeTimers();
        const { request, response } = createHttpExchange();
        const controller = new AbortController();
        const onAbort = jest.fn(() => new Promise(() => undefined));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        observeRequestCancellation(request, response, {
            controller,
            onAbort,
            abortHookTimeoutMs: 25,
        });
        response.emit('close');

        expect(controller.signal.aborted).toBe(true);

        jest.advanceTimersByTime(25);

        expect(warnSpy).toHaveBeenCalledWith('Request cancellation hook timed out after 25ms from response-close');
    });

    test('can abort through a socket polling fallback and stop polling during cleanup', () => {
        const { request, response } = createHttpExchange();
        const controller = new AbortController();
        const stopPolling = jest.fn();
        let pollDisconnect = null;
        const startConnectionPolling = jest.fn((socket, intervalMs, onDisconnect) => {
            pollDisconnect = onDisconnect;
            return stopPolling;
        });

        observeRequestCancellation(request, response, {
            controller,
            pollConnection: true,
            pollIntervalMs: 25,
            startConnectionPolling,
        });

        expect(startConnectionPolling).toHaveBeenCalledWith(request.socket, 25, expect.any(Function));

        pollDisconnect();

        expect(controller.signal.aborted).toBe(true);
        expect(stopPolling).toHaveBeenCalledTimes(1);
    });

    test('does not abort after the response finishes normally', () => {
        const { request, response } = createHttpExchange();
        const controller = new AbortController();

        observeRequestCancellation(request, response, { controller });
        response.writableEnded = true;
        response.emit('finish');
        request.socket.emit('close');

        expect(controller.signal.aborted).toBe(false);
    });

    test('only treats request close as cancellation when the request is marked aborted', () => {
        const { request, response } = createHttpExchange();
        const completedController = new AbortController();
        const abortedController = new AbortController();

        request.complete = true;
        observeRequestCancellation(request, response, { controller: completedController });
        request.emit('close');

        expect(completedController.signal.aborted).toBe(false);

        const abortedRequest = new EventEmitter();
        abortedRequest.socket = new EventEmitter();
        abortedRequest.aborted = true;

        observeRequestCancellation(abortedRequest, response, { controller: abortedController });
        abortedRequest.emit('close');

        expect(abortedController.signal.aborted).toBe(true);
    });
});

describe('isRequestCancellationError', () => {
    test('recognizes expected request cancellation errors', () => {
        const errors = [
            REQUEST_CANCELLATION_ABORT_REASON,
            new Error(REQUEST_CANCELLATION_ABORT_REASON),
            new DOMException(REQUEST_CANCELLATION_ABORT_REASON, 'AbortError'),
            Object.assign(new Error('operation was aborted'), { code: 'ABORT_ERR' }),
        ];

        for (const error of errors) {
            expect(isRequestCancellationError(error)).toBe(true);
        }
    });

    test('does not classify unrelated failures as request cancellation', () => {
        expect(isRequestCancellationError(new Error('upstream exploded'))).toBe(false);
    });
});
