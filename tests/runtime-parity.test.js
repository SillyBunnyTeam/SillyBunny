import { afterEach, describe, expect, test } from '@jest/globals';
import path from 'node:path';

import { parseParityCliArgs } from './runtime-parity.js';
import {
    buildMultipartFileBody,
    buildServerLaunchSpec,
    createMinimalPngBuffer,
    extractCookieHeader,
    formatLogTail,
    isPathInsideDirectory,
    parseSseStreamText,
    resolveParityRuntime,
    startFakeUpstreamServer,
} from './util/runtime-parity-harness.js';

describe('runtime parity harness helpers', () => {
    test('resolves explicit and environment runtimes and rejects unknown values', () => {
        expect(resolveParityRuntime('bun', {})).toBe('bun');
        expect(resolveParityRuntime('NODE', {})).toBe('node');
        expect(resolveParityRuntime(undefined, { SILLYBUNNY_PARITY_RUNTIME: 'bun' })).toBe('bun');
        expect(resolveParityRuntime(undefined, { SILLYBUNNY_PARITY_RUNTIME: 'node' })).toBe('node');
        expect(() => resolveParityRuntime('deno', {})).toThrow('Unsupported parity runtime "deno"');
    });

    test('builds isolated server launch specs for both runtimes without touching repo config', () => {
        const dataRoot = path.join('/tmp', 'parity-root');
        const nodeSpec = buildServerLaunchSpec('node', { port: 45123, dataRoot, nodePath: '/usr/bin/node' });
        expect(nodeSpec).toEqual({
            command: '/usr/bin/node',
            args: [
                '--no-warnings',
                'server.js',
                '--browserLaunchEnabled=false',
                '--port', '45123',
                '--dataRoot', dataRoot,
                '--configPath', path.join(dataRoot, 'config.yaml'),
            ],
            configPath: path.join(dataRoot, 'config.yaml'),
        });

        const bunSpec = buildServerLaunchSpec('bun', { port: 45124, dataRoot, bunPath: '/usr/bin/bun' });
        expect(bunSpec).toEqual({
            command: '/usr/bin/bun',
            args: [
                'server.js',
                '--browserLaunchEnabled=false',
                '--port', '45124',
                '--dataRoot', dataRoot,
                '--configPath', path.join(dataRoot, 'config.yaml'),
            ],
            configPath: path.join(dataRoot, 'config.yaml'),
        });
    });

    test('parses CLI runtime and log-file flags and rejects unknown flags', () => {
        expect(parseParityCliArgs(['--runtime', 'bun', '--log-file', '/tmp/bun.log'], {})).toEqual({
            runtime: 'bun',
            logFilePath: '/tmp/bun.log',
        });
        expect(parseParityCliArgs(['--runtime=node', '--log-file=/tmp/node.log'], {})).toEqual({
            runtime: 'node',
            logFilePath: '/tmp/node.log',
        });
        expect(parseParityCliArgs([], { SILLYBUNNY_PARITY_RUNTIME: 'bun', SILLYBUNNY_PARITY_SERVER_LOG: '/tmp/env.log' })).toEqual({
            runtime: 'bun',
            logFilePath: '/tmp/env.log',
        });
        expect(() => parseParityCliArgs(['--unknown'], {})).toThrow('Unknown argument "--unknown"');
    });

    test('extracts session Cookie pairs from Set-Cookie headers', () => {
        const response = {
            headers: {
                getSetCookie: () => [
                    'session-abc=payload123; path=/; httponly; samesite=lax',
                    'session-abc.sig=sig456; path=/; httponly',
                ],
                get: () => null,
            },
        };
        expect(extractCookieHeader(/** @type {any} */ (response))).toBe('session-abc=payload123; session-abc.sig=sig456');
    });

    test('builds multipart payloads containing a valid PNG signature', () => {
        const png = createMinimalPngBuffer();
        expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

        const multipart = buildMultipartFileBody({
            fieldName: 'avatar',
            fileName: 'sample.png',
            contentType: 'image/png',
            content: png,
            boundary: '----TestBoundary',
        });
        expect(multipart.contentType).toBe('multipart/form-data; boundary=----TestBoundary');
        expect(multipart.body.includes(png)).toBe(true);
        expect(multipart.body.toString('latin1')).toContain('name="avatar"; filename="sample.png"');
        expect(multipart.body.toString('latin1')).toContain('------TestBoundary--');
    });

    test('parses streamed SSE deltas and completion sentinel', () => {
        const sse = [
            'data: {"choices":[{"delta":{"content":"Hello "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"world"}}]}',
            '',
            'data: [DONE]',
            '',
        ].join('\n');

        expect(parseSseStreamText(sse)).toEqual({
            text: 'Hello world',
            done: true,
            chunks: ['Hello ', 'world'],
        });
    });

    test('checks directory containment and formats log tails', () => {
        const parent = path.resolve('/tmp/parity-root');
        expect(isPathInsideDirectory(parent, path.join(parent, 'default-user', 'chats', 'a.jsonl'))).toBe(true);
        expect(isPathInsideDirectory(parent, path.resolve('/tmp/parity-root-sibling/a.jsonl'))).toBe(false);
        expect(isPathInsideDirectory(parent, parent)).toBe(false);

        expect(formatLogTail([])).toBe('(no server output captured)');
        expect(formatLogTail(['a', 'b', 'c'], 2)).toBe('b\nc');
    });
});

describe('local fake upstream server', () => {
    /** @type {Awaited<ReturnType<typeof startFakeUpstreamServer>> | null} */
    let upstream = null;

    afterEach(async () => {
        if (upstream) {
            await upstream.close();
            upstream = null;
        }
    });

    test('streams SSE deltas and records incoming requests on loopback', async () => {
        upstream = await startFakeUpstreamServer();
        expect(upstream.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

        const response = await fetch(`${upstream.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'parity-stream-model',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            }),
        });
        expect(response.status).toBe(200);
        const parsed = parseSseStreamText(await response.text());
        expect(parsed).toEqual({
            text: 'Hello from parity!',
            done: true,
            chunks: ['Hello ', 'from ', 'parity!'],
        });
        expect(upstream.requests).toHaveLength(1);
        expect(upstream.requests[0].body.model).toBe('parity-stream-model');
    });

    test('detects client aborts on silent open streams', async () => {
        upstream = await startFakeUpstreamServer();
        const closedPromise = upstream.waitForNextSilentClose();
        const controller = new AbortController();

        const response = await fetch(`${upstream.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'parity-cancel-silent',
                messages: [{ role: 'user', content: 'abort me' }],
                stream: true,
            }),
            signal: controller.signal,
        });
        expect(response.status).toBe(200);

        const reader = response.body.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain('First chunk');

        controller.abort();
        await reader.cancel().catch(() => undefined);

        const outcome = await Promise.race([
            closedPromise,
            new Promise(resolve => setTimeout(() => resolve({ closed: false }), 2_000)),
        ]);
        expect(outcome).toEqual({ closed: true });
    });
});
