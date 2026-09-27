import { afterEach, describe, test, expect, jest } from '@jest/globals';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Response } from 'node-fetch';
import { CHAT_COMPLETION_SOURCES } from '../src/constants';
import { REQUEST_CANCELLATION_ABORT_REASON } from '../src/request-cancellation';
import { abortOnRequestClose, flattenSchema, forwardFetchResponse } from '../src/util';

function createMockExpressResponse() {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = '';

    return response;
}

function createMockExpressRequest() {
    return { socket: new EventEmitter() };
}

async function collectResponseBody(response) {
    const chunks = [];

    response.on('data', chunk => chunks.push(Buffer.from(chunk)));

    await once(response, 'finish');

    return Buffer.concat(chunks).toString('utf8');
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('flattenSchema', () => {
    test('should return the schema if it is not an object', () => {
        const schema = 'it is not an object';
        expect(flattenSchema(schema, CHAT_COMPLETION_SOURCES.MAKERSUITE)).toBe(schema);
    });

    test('should handle schema with $defs and $ref', () => {
        const schema = {
            $schema: 'http://json-schema.org/draft-07/schema#',
            $defs: {
                a: { type: 'string' },
                b: {
                    type: 'object',
                    properties: {
                        c: { $ref: '#/$defs/a' },
                    },
                },
            },
            properties: {
                d: { $ref: '#/$defs/b' },
            },
        };
        const expected = {
            properties: {
                d: {
                    type: 'object',
                    properties: {
                        c: { type: 'string' },
                    },
                },
            },
        };
        expect(flattenSchema(schema, CHAT_COMPLETION_SOURCES.MAKERSUITE)).toEqual(expected);
    });

    test('should filter unsupported properties for Google API schema', () => {
        const schema = {
            $defs: {
                a: {
                    type: 'string',
                    default: 'test',
                },
            },
            type: 'object',
            properties: {
                b: { $ref: '#/$defs/a' },
                c: { type: 'number' },
            },
            additionalProperties: false,
            exclusiveMinimum: 0,
            propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            },
        };
        const expected = {
            type: 'object',
            properties: {
                b: {
                    type: 'string',
                },
                c: { type: 'number' },
            },
        };
        expect(flattenSchema(schema, CHAT_COMPLETION_SOURCES.MAKERSUITE)).toEqual(expected);
    });

    test('should not filter properties for non-Google API schema', () => {
        const schema = {
            $defs: {
                a: {
                    type: 'string',
                    default: 'test',
                },
            },
            type: 'object',
            properties: {
                b: { $ref: '#/$defs/a' },
                c: { type: 'number' },
            },
            additionalProperties: false,
            exclusiveMinimum: 0,
            propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            },
        };
        const expected = {
            type: 'object',
            properties: {
                b: {
                    type: 'string',
                    default: 'test',
                },
                c: { type: 'number' },
            },
            additionalProperties: false,
            exclusiveMinimum: 0,
            propertyNames: {
                pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            },
        };
        expect(flattenSchema(schema, 'some-other-api')).toEqual(expected);
    });
});

describe('forwardFetchResponse', () => {
    test('should destroy upstream streaming bodies when the client response closes early', async () => {
        const upstreamBody = new PassThrough();
        const destroySpy = jest.spyOn(upstreamBody, 'destroy');
        const response = createMockExpressResponse();
        response.socket = {};

        await forwardFetchResponse(new Response(upstreamBody), response);
        response.emit('close');

        expect(destroySpy).toHaveBeenCalled();
    });

    test('should destroy upstream streaming bodies that are not Node Readable instances', async () => {
        const upstreamBody = Object.assign(new EventEmitter(), {
            pipe: jest.fn(),
            destroy: jest.fn(),
        });
        const response = createMockExpressResponse();
        response.socket = {};

        await forwardFetchResponse({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: upstreamBody,
        }, response);
        response.emit('close');

        expect(upstreamBody.destroy).toHaveBeenCalled();
    });

    test('should finish the client response when upstream streaming emits a request cancellation error', async () => {
        const upstreamBody = new PassThrough();
        const response = createMockExpressResponse();
        response.socket = {};
        const bodyPromise = collectResponseBody(response);

        await forwardFetchResponse(new Response(upstreamBody), response);
        upstreamBody.emit('error', REQUEST_CANCELLATION_ABORT_REASON);

        await expect(bodyPromise).resolves.toBe('');
        expect(response.writableEnded).toBe(true);
    });

    test('should finish the client response when upstream streaming fails', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const upstreamBody = new PassThrough();
        const response = createMockExpressResponse();
        response.socket = {};
        const bodyPromise = collectResponseBody(response);

        await forwardFetchResponse(new Response(upstreamBody), response);
        upstreamBody.emit('error', new Error('The operation timed out.'));

        await expect(bodyPromise).resolves.toBe('');
        expect(response.writableEnded).toBe(true);
    });

    test('should log JSON error bodies and return the original body for non-2xx streaming responses', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const body = JSON.stringify({ error: { message: 'Forbidden by upstream policy' }, detail: 'policy_denied' });
        const response = createMockExpressResponse();
        const bodyPromise = collectResponseBody(response);

        await forwardFetchResponse(new Response(body, {
            status: 403,
            statusText: 'Forbidden',
        }), response);

        expect(await bodyPromise).toBe(body);
        expect(response.statusCode).toBe(403);
        expect(warnSpy).toHaveBeenCalledWith(`Streaming request failed with status 403 Forbidden: ${body}`);
    });

    test('should log plain text error bodies and return the original body for non-2xx streaming responses', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const body = 'Plain text upstream failure';
        const response = createMockExpressResponse();
        const bodyPromise = collectResponseBody(response);

        await forwardFetchResponse(new Response(body, {
            status: 502,
            statusText: 'Bad Gateway',
        }), response);

        expect(await bodyPromise).toBe(body);
        expect(response.statusCode).toBe(502);
        expect(warnSpy).toHaveBeenCalledWith(`Streaming request failed with status 502 Bad Gateway: ${body}`);
    });
});

describe('abortOnRequestClose', () => {
    test('should abort the upstream controller when the client request socket closes', () => {
        const request = createMockExpressRequest();
        const controller = new AbortController();

        abortOnRequestClose(request, controller);
        request.socket.emit('close');

        expect(controller.signal.aborted).toBe(true);
    });

    test('should preserve existing socket close listeners when registering the abort handler', () => {
        const request = createMockExpressRequest();
        const existingListener = jest.fn();

        request.socket.on('close', existingListener);
        abortOnRequestClose(request, new AbortController());
        request.socket.emit('close');

        expect(existingListener).toHaveBeenCalledTimes(1);
    });

    test('should abort the upstream controller when the client response closes', () => {
        const request = new EventEmitter();
        request.socket = new EventEmitter();
        const response = new EventEmitter();
        const controller = new AbortController();

        abortOnRequestClose(request, controller, response);
        response.emit('close');

        expect(controller.signal.aborted).toBe(true);
    });
});
