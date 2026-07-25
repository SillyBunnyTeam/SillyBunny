import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

import getResponseCompressionMiddleware, { shouldCompressResponse } from '../src/middleware/response-compression.js';

const LARGE_JSON = Object.freeze({
    message: 'compressible response payload '.repeat(256),
});
const FIRST_EVENT = 'data: first\n\n';
const SECOND_EVENT = 'data: second\n\n';
const REQUEST_TIMEOUT_MS = 2_000;

function createResponse(headers = {}) {
    const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        getHeader(name) {
            return normalizedHeaders.get(String(name).toLowerCase());
        },
    };
}

function openHttpResponse(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { headers });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`Request timed out: ${url}`)));
        request.once('response', resolve);
        request.once('error', reject);
    });
}

async function getRawResponse(url, headers = {}) {
    const response = await openHttpResponse(url, headers);
    const chunks = [];

    for await (const chunk of response) {
        chunks.push(chunk);
    }

    return {
        body: Buffer.concat(chunks),
        headers: response.headers,
        statusCode: response.statusCode,
    };
}

async function readDelayedEventStream(response, releaseSecondEvent) {
    let body = '';
    let firstEventObservedBeforeCompletion = false;

    for await (const chunk of response) {
        body += chunk;
        if (!firstEventObservedBeforeCompletion && body.includes(FIRST_EVENT)) {
            firstEventObservedBeforeCompletion = !response.complete;
            releaseSecondEvent();
        }
    }

    return { body, firstEventObservedBeforeCompletion };
}

describe('response compression middleware', () => {
    test('skips server-sent event streams', () => {
        expect(shouldCompressResponse({}, createResponse({
            'Content-Type': 'text/event-stream; charset=utf-8',
        }))).toBe(false);
    });

    test('honors no-transform cache directives', () => {
        expect(shouldCompressResponse({}, createResponse({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-transform',
        }))).toBe(false);
    });

    test('keeps default compression behavior for regular JSON responses', () => {
        expect(shouldCompressResponse({}, createResponse({
            'Content-Type': 'application/json',
        }))).toBe(true);
    });

    describe('HTTP integration', () => {
        let baseUrl;
        let releaseSecondEvent;
        let server;

        beforeAll(async () => {
            const app = express();
            const secondEventDelay = new Promise(resolve => {
                releaseSecondEvent = resolve;
            });

            app.use(getResponseCompressionMiddleware());
            app.get('/json', (_request, response) => response.json(LARGE_JSON));
            app.get('/no-transform', (_request, response) => {
                response.set('Cache-Control', 'public, no-transform');
                response.json(LARGE_JSON);
            });
            app.get('/events', (_request, response) => {
                response.set({
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'text/event-stream; charset=utf-8',
                });
                response.flushHeaders();
                response.write(FIRST_EVENT);
                secondEventDelay.then(() => {
                    if (!response.destroyed) {
                        response.end(SECOND_EVENT);
                    }
                });
            });

            await new Promise(resolve => {
                server = app.listen(0, '127.0.0.1', resolve);
            });
            baseUrl = `http://127.0.0.1:${server.address().port}`;
        });

        afterAll(async () => {
            releaseSecondEvent?.();
            if (server) {
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
        });

        test('compresses large JSON with gzip and updates representation headers', async () => {
            const response = await getRawResponse(`${baseUrl}/json`, {
                'Accept-Encoding': 'gzip',
            });
            const decodedBody = gunzipSync(response.body);

            expect(response.statusCode).toBe(200);
            expect(response.headers['content-encoding']).toBe('gzip');
            expect(response.headers.vary?.split(',').map(value => value.trim().toLowerCase())).toContain('accept-encoding');
            expect(response.headers['content-length']).toBeUndefined();
            expect(response.body.length).toBeLessThan(decodedBody.length);
            expect(JSON.parse(decodedBody.toString('utf8'))).toEqual(LARGE_JSON);
        });

        test('keeps no-transform responses uncompressed', async () => {
            const response = await getRawResponse(`${baseUrl}/no-transform`, {
                'Accept-Encoding': 'gzip',
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers['content-encoding']).toBeUndefined();
            expect(response.body.toString('utf8')).toBe(JSON.stringify(LARGE_JSON));
        });

        test('streams the first SSE event before the delayed response completes', async () => {
            const response = await openHttpResponse(`${baseUrl}/events`, {
                'Accept-Encoding': 'gzip',
            });
            let stream;

            try {
                expect(response.headers['content-encoding']).toBeUndefined();
                response.setEncoding('utf8');
                stream = await readDelayedEventStream(response, releaseSecondEvent);
            } finally {
                releaseSecondEvent();
                response.destroy();
            }

            expect(stream.firstEventObservedBeforeCompletion).toBe(true);
            expect(stream.body).toBe(FIRST_EVENT + SECOND_EVENT);
        });
    });
});
