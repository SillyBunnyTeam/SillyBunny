import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import express from 'express';

import { fetchWithCsrfRetry, isInvalidCsrfTokenResponse } from '../public/scripts/csrf-token-refresh.js';
import { answerWithErrorMessage, handleRouteError } from '../src/route-errors.js';

const REFUSAL_TEXT = 'Invalid CSRF token. Please refresh the page and try again.';
// chalk colors the message only when the console supports color, so this is the form that a launcher console gets.
const COLORED_REFUSAL_TEXT = `\u001b[31m${REFUSAL_TEXT}\u001b[39m`;

function createClient(baseUrl) {
    const cookies = new Map();

    return {
        cookies,
        async fetch(path, init = {}) {
            const headers = { ...init.headers };
            if (cookies.size > 0) {
                headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
            }

            const response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(5000) });
            for (const cookie of response.headers.getSetCookie()) {
                const [pair] = cookie.split(';');
                const separator = pair.indexOf('=');
                cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
            }
            return response;
        },
    };
}

async function getToken(client) {
    const response = await client.fetch('/csrf-token');
    return (await response.json()).token;
}

async function readAnswer(response) {
    return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: await response.text(),
    };
}

const CSRF_REFUSAL = { status: 403, type: 'text/plain; charset=utf-8', body: REFUSAL_TEXT };

describe('CSRF refusal answer and the client retry', () => {
    let baseUrl;
    let server;
    let consoleError;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use(cookieSession({ name: 'session', secret: 'csrf-refusal-test', sameSite: 'lax', httpOnly: true }));
        app.post('/api/other-csrf-error', (_request, _response, next) => {
            next(Object.assign(new Error('not the server refusal'), { status: 403, code: 'EBADCSRFTOKEN' }));
        });

        const protection = csrfSync({
            getTokenFromState: request => request.session.csrfToken,
            getTokenFromRequest: request => request.headers['x-csrf-token']?.toString(),
            storeTokenInState: (request, token) => {
                request.session.csrfToken = token;
            },
            size: 32,
        });
        protection.invalidCsrfTokenError.message = COLORED_REFUSAL_TEXT;
        protection.invalidCsrfTokenError.stack = undefined;
        answerWithErrorMessage(protection.invalidCsrfTokenError);

        app.get('/csrf-token', (request, response) => response.json({ token: protection.generateToken(request) }));
        app.use(protection.csrfSynchronisedProtection);
        app.post('/api/ping', (_request, response) => response.sendStatus(204));
        app.use((_request, response) => response.status(404).send('not found'));
        app.use(handleRouteError);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('answers a request without a CSRF token with 403 and the refusal text as plain text', async () => {
        const client = createClient(baseUrl);

        const answer = await readAnswer(await client.fetch('/api/ping', { method: 'POST' }));
        expect(answer).toEqual(CSRF_REFUSAL);
        expect(answer.body).toContain('Invalid CSRF token');
        expect(answer.body).not.toMatch(/\u001b/);
    });

    test('answers a token from a session that the server no longer has the same way', async () => {
        const client = createClient(baseUrl);
        const token = await getToken(client);
        client.cookies.clear();

        const answer = await readAnswer(await client.fetch('/api/ping', { method: 'POST', headers: { 'X-CSRF-Token': token } }));
        expect(answer).toEqual(CSRF_REFUSAL);
    });

    test('answers a token that does not match the session the same way', async () => {
        const client = createClient(baseUrl);
        await getToken(client);

        const answer = await readAnswer(await client.fetch('/api/ping', { method: 'POST', headers: { 'X-CSRF-Token': 'stale-token' } }));
        expect(answer).toEqual(CSRF_REFUSAL);
    });

    test('logs the refusal as before', async () => {
        const client = createClient(baseUrl);
        await client.fetch('/api/ping', { method: 'POST' });

        expect(consoleError).toHaveBeenCalledWith(`ForbiddenError: ${COLORED_REFUSAL_TEXT}`);
    });

    test('lets the client check recognize the real answer', async () => {
        const client = createClient(baseUrl);
        const response = await client.fetch('/api/ping', { method: 'POST' });

        await expect(isInvalidCsrfTokenResponse(response)).resolves.toBe(true);
    });

    test('lets the client retry helper refresh the token once and repeat the request', async () => {
        const client = createClient(baseUrl);
        let token = await getToken(client);
        client.cookies.clear();

        const statuses = [];
        const refreshCsrfToken = jest.fn(async () => {
            token = await getToken(client);
        });
        const fetchFn = async (path, init) => {
            const response = await client.fetch(path, init);
            statuses.push(response.status);
            return response;
        };

        const response = await fetchWithCsrfRetry('/api/ping', () => ({
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
        }), { refreshCsrfToken, fetchFn });

        expect(statuses).toEqual([403, 204]);
        expect(refreshCsrfToken).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(204);
    });

    test('accepts a request with the current token', async () => {
        const client = createClient(baseUrl);
        const token = await getToken(client);

        const response = await client.fetch('/api/ping', { method: 'POST', headers: { 'X-CSRF-Token': token } });
        expect(response.status).toBe(204);
    });

    test('keeps the status text for another error that carries the CSRF error code', async () => {
        const client = createClient(baseUrl);

        const response = await client.fetch('/api/other-csrf-error', { method: 'POST' });
        expect(response.status).toBe(403);
        await expect(response.text()).resolves.toBe('Forbidden');
    });
});
