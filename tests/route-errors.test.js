import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';

import { forwardAsyncRouteErrors, handleRouteError } from '../src/route-errors.js';

// Long enough for a loaded test machine, short enough that a request nobody answers fails the test quickly.
const REQUEST_TIMEOUT_MS = 5000;

async function waitFor(predicate) {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

describe('async route errors in a real Express app', () => {
    let baseUrl;
    let server;
    let consoleError;
    let consoleWarn;
    const escapedErrors = [];

    function request(path, init = {}) {
        return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }

    beforeAll(async () => {
        forwardAsyncRouteErrors();

        const app = express();
        app.use(express.json());
        app.use(async (request, _response, next) => {
            if (request.get('x-test-middleware') === 'reject') {
                throw new Error('middleware failed');
            }
            next();
        });

        const router = express.Router();
        router.get('/ok', (_request, response) => response.json({ ok: true }));
        router.get('/reject', async () => {
            throw new Error('route failed with a private detail');
        });
        router.get('/reject-without-reason', () => Promise.reject());
        router.get('/throw', () => {
            throw new Error('synchronous failure');
        });
        router.get('/client-error', async () => {
            throw Object.assign(new Error('not allowed here'), { status: 403 });
        });
        router.post('/echo', (request, response) => response.json(request.body));
        router.get('/answered-then-reject', async (_request, response) => {
            response.json({ answered: true });
            throw new Error('failed after the answer');
        });
        router.get('/started-then-reject', async (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.write('partial');
            await new Promise(resolve => setTimeout(resolve, 20));
            throw new Error('failed during the answer');
        });
        app.use('/api/test', router);

        const pluginRouter = express.Router();
        pluginRouter.post('/run', async () => {
            throw new Error('plugin route failed');
        });
        app.use('/api/plugins/example', pluginRouter);

        const errorHandlerRouter = express.Router();
        errorHandlerRouter.get('/', () => {
            throw new Error('first failure');
        });
        errorHandlerRouter.use(async (_error, _request, _response, _next) => {
            throw new Error('error handler failed');
        });
        app.use('/api/failing-error-handler', errorHandlerRouter);

        app.use((_request, response) => response.status(404).send('not found'));
        app.use(handleRouteError);
        // Records any error that the final handler lets through, such as a second answer that Express refuses.
        app.use((error, _request, _response, next) => {
            escapedErrors.push(error);
            next(error);
        });

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        escapedErrors.length = 0;
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('answers 500 to an async route that rejects and keeps answering', async () => {
        const failed = await request('/api/test/reject');
        expect(failed.status).toBe(500);

        const next = await request('/api/test/ok');
        expect(next.status).toBe(200);
        await expect(next.json()).resolves.toEqual({ ok: true });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('route failed with a private detail'));
    });

    test('answers 500 to an async middleware that rejects', async () => {
        const failed = await request('/api/test/ok', { headers: { 'x-test-middleware': 'reject' } });
        expect(failed.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('middleware failed'));
    });

    test('answers 500 to a rejected route in a router mounted the way server plugins are', async () => {
        const failed = await request('/api/plugins/example/run', { method: 'POST' });
        expect(failed.status).toBe(500);
    });

    test('answers 500 to a promise rejected without a reason instead of the not-found page', async () => {
        const failed = await request('/api/test/reject-without-reason');
        expect(failed.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Rejected promise'));
    });

    test('answers 500 when an async error handler rejects', async () => {
        const failed = await request('/api/failing-error-handler');
        expect(failed.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('error handler failed'));
    });

    test('answers with the status text and no error details', async () => {
        const failed = await request('/api/test/reject');
        expect(failed.status).toBe(500);
        const body = await failed.text();
        expect(body).toBe('Internal Server Error');
        expect(body).not.toContain('private detail');
        expect(body).not.toMatch(/\bat /);
    });

    test('does not answer again after the route answered', async () => {
        const response = await request('/api/test/answered-then-reject');
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ answered: true });

        await waitFor(() => consoleError.mock.calls.length > 0);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('failed after the answer'));
        expect(escapedErrors).toEqual([]);

        const next = await request('/api/test/ok');
        expect(next.status).toBe(200);
    });

    test('cuts off a response that fails after it started instead of leaving the client waiting', async () => {
        const response = await request('/api/test/started-then-reject');
        expect(response.status).toBe(200);

        const readError = await response.text().then(() => null, error => error);
        expect(readError).not.toBeNull();
        expect(readError.name).not.toBe('TimeoutError');
        expect(escapedErrors).toEqual([]);

        const next = await request('/api/test/ok');
        expect(next.status).toBe(200);
    });

    test('keeps the status of an error that carries one', async () => {
        const failed = await request('/api/test/client-error');
        expect(failed.status).toBe(403);
        await expect(failed.text()).resolves.toBe('Forbidden');
    });

    test('keeps the 400 for a body that is not valid JSON', async () => {
        const failed = await request('/api/test/echo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"unfinished":',
        });
        expect(failed.status).toBe(400);
    });

    test('answers 500 to a synchronous throw as Express always did', async () => {
        const failed = await request('/api/test/throw');
        expect(failed.status).toBe(500);
    });

    test('leaves requests that match no route to the not-found handler', async () => {
        const missing = await request('/api/test/missing');
        expect(missing.status).toBe(404);
        await expect(missing.text()).resolves.toBe('not found');
    });
});

describe('handleRouteError', () => {
    let consoleError;
    let consoleWarn;

    function fakeRequest() {
        return { socket: { destroy: jest.fn() } };
    }

    function fakeResponse({ headersSent = false, writableEnded = false } = {}) {
        return { headersSent, writableEnded, sendStatus: jest.fn() };
    }

    beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
    });

    test('answers a response that has not started with 500', () => {
        const response = fakeResponse();
        handleRouteError(new Error('failed'), fakeRequest(), response, jest.fn());

        expect(response.sendStatus).toHaveBeenCalledWith(500);
    });

    test('leaves a finished response as it is', () => {
        const request = fakeRequest();
        const response = fakeResponse({ headersSent: true, writableEnded: true });
        handleRouteError(new Error('failed late'), request, response, jest.fn());

        expect(response.sendStatus).not.toHaveBeenCalled();
        expect(request.socket.destroy).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('failed late'));
    });

    test('cuts off a started response instead of answering it again', () => {
        const request = fakeRequest();
        const response = fakeResponse({ headersSent: true });
        handleRouteError(new Error('failed midway'), request, response, jest.fn());

        expect(response.sendStatus).not.toHaveBeenCalled();
        expect(request.socket.destroy).toHaveBeenCalledTimes(1);
    });

    test('logs a client disconnect as a warning, as the process handlers do', () => {
        const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        handleRouteError(error, fakeRequest(), fakeResponse(), jest.fn());

        expect(consoleWarn).toHaveBeenCalledWith('Ignored streaming disconnect error:', 'socket hang up');
        expect(consoleError).not.toHaveBeenCalled();
    });

    test('ignores a status outside the error range', () => {
        const response = fakeResponse();
        handleRouteError(Object.assign(new Error('odd status'), { status: 302, statusCode: 200 }), fakeRequest(), response, jest.fn());

        expect(response.sendStatus).toHaveBeenCalledWith(500);
    });
});
