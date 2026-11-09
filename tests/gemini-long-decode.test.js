import { Buffer } from 'node:buffer';
import { PassThrough, Readable } from 'node:stream';

import { describe, expect, jest, test } from '@jest/globals';

import { continueGenerateContentStream, continueInteractionStream } from '../src/gemini-long-decode.js';

const okResponse = body => ({ ok: true, status: 200, statusText: 'OK', body });
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const chunk = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

async function readAll(stream) {
    const chunks = [];
    for await (const part of stream) {
        chunks.push(Buffer.from(part));
    }
    return Buffer.concat(chunks).toString('utf8');
}

describe('continueGenerateContentStream', () => {
    test('returns a failed response unchanged', () => {
        const response = { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'nope' };

        expect(continueGenerateContentStream(response, jest.fn(), new AbortController().signal)).toBe(response);
    });

    test('keeps an event and a multi-byte character intact across network chunks', async () => {
        const bytes = Buffer.from(event(chunk('héllo wörld ✓')) + event(chunk('', { finishReason: 'STOP' })), 'utf8');
        const middleOfCharacter = bytes.indexOf(Buffer.from('✓', 'utf8')) + 1;
        const body = Readable.from([bytes.subarray(0, 10), bytes.subarray(10, middleOfCharacter), bytes.subarray(middleOfCharacter)], { objectMode: true });

        const response = continueGenerateContentStream(okResponse(body), jest.fn(), new AbortController().signal);

        expect(await readAll(response.body)).toBe(bytes.toString('utf8'));
    });

    test('finds a separator wherever a network chunk splits it', async () => {
        const first = event(chunk('before', { continuationToken: 'checkpoint' }));
        const text = first + event(chunk('', { finishReason: 'STOP' }));

        for (let split = first.length - 5; split <= first.length + 1; split++) {
            const body = Readable.from([text.slice(0, split), text.slice(split)], { objectMode: true });
            const response = continueGenerateContentStream(okResponse(body), jest.fn(), new AbortController().signal);

            const output = await readAll(response.body);

            expect(output).not.toContain('checkpoint');
            expect(output).toContain('"before"');
            expect(output).toContain('"finishReason":"STOP"');
        }
    });

    test('finds every event when the stream sends one character at a time', async () => {
        const text = event(chunk('one', { continuationToken: 'checkpoint' })) + event(chunk('two', { finishReason: 'STOP' }));
        const body = Readable.from([...text], { objectMode: true });

        const response = continueGenerateContentStream(okResponse(body), jest.fn(), new AbortController().signal);
        const output = await readAll(response.body);

        expect(output).not.toContain('checkpoint');
        expect(output).toContain('"one"');
        expect(output).toContain('"two"');
        expect(output).toContain('"finishReason":"STOP"');
    });

    test('reads an event that the stream ends without a blank line after', async () => {
        const body = Readable.from([`data: ${JSON.stringify(chunk('tail', { finishReason: 'STOP' }))}`], { objectMode: true });

        const response = continueGenerateContentStream(okResponse(body), jest.fn(), new AbortController().signal);

        expect(await readAll(response.body)).toContain('tail');
    });

    test('forwards lines it cannot parse', async () => {
        const body = Readable.from([': keep-alive\n\n', 'data: not json\n\n', event(chunk('ok', { finishReason: 'STOP' }))], { objectMode: true });

        const response = continueGenerateContentStream(okResponse(body), jest.fn(), new AbortController().signal);
        const output = await readAll(response.body);

        expect(output).toContain(': keep-alive');
        expect(output).toContain('data: not json');
        expect(output).toContain('"ok"');
    });

    test('ends without a cut-off finish when the abort signal stops the next request', async () => {
        const controller = new AbortController();
        const sendHop = jest.fn(async () => {
            throw new Error('aborted');
        });
        const body = new PassThrough();
        body.write(event(chunk('one', { finishReason: 'CONTINUATION', continuationToken: 'token-1' })));

        const response = continueGenerateContentStream(okResponse(body), sendHop, controller.signal);
        controller.abort();
        body.end();

        const output = await readAll(response.body);

        expect(sendHop).toHaveBeenCalledWith('token-1');
        expect(output).toContain('"one"');
        expect(output).not.toContain('CONTINUATION');
    });

    test('ends without a cut-off finish when the abort signal stops a request', async () => {
        const controller = new AbortController();
        const body = new PassThrough();
        body.write(event(chunk('one')));

        const response = continueGenerateContentStream(okResponse(body), jest.fn(), controller.signal);
        const reading = readAll(response.body);
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.abort();
        body.destroy(new Error('aborted'));

        const output = await reading;

        expect(output).toContain('"one"');
        expect(output).not.toContain('CONTINUATION');
    });

    test('sends no further request and closes the upstream body at its next event once the client stream is destroyed', async () => {
        const body = new PassThrough();
        const sendHop = jest.fn();
        body.write(event(chunk('one')));

        const response = continueGenerateContentStream(okResponse(body), sendHop, new AbortController().signal);
        await new Promise(resolve => response.body.once('data', resolve));
        response.body.destroy();
        body.write(event(chunk('two', { finishReason: 'CONTINUATION', continuationToken: 'token-1' })));
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(sendHop).not.toHaveBeenCalled();
        expect(body.destroyed).toBe(true);
    });

    test('closes when the client leaves during a silent request and the abort fails the body read', async () => {
        const controller = new AbortController();
        const body = new PassThrough();
        const sendHop = jest.fn();
        controller.signal.addEventListener('abort', () => body.destroy(new Error('aborted')));
        body.write(event(chunk('one', { continuationToken: 'token-1' })));

        const response = continueGenerateContentStream(okResponse(body), sendHop, controller.signal);
        await new Promise(resolve => response.body.once('data', resolve));
        const closed = new Promise(resolve => response.body.once('close', resolve));
        response.body.destroy();
        controller.abort();
        await closed;

        expect(sendHop).not.toHaveBeenCalled();
    });
});

describe('continueInteractionStream', () => {
    test('returns a failed response unchanged', () => {
        const response = { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'nope' };

        expect(continueInteractionStream(response, jest.fn(), new AbortController().signal)).toBe(response);
    });

    test('drops the final event of a request it continues and keeps the last one', async () => {
        const first = Readable.from([event({ event_type: 'interaction.completed', interaction: { status: 'requires_continuation', continuation_token: 'token-1' } })], { objectMode: true });
        const second = Readable.from([event({ event_type: 'interaction.completed', interaction: { status: 'completed' } })], { objectMode: true });
        const sendHop = jest.fn(async () => okResponse(second));

        const response = continueInteractionStream(okResponse(first), sendHop, new AbortController().signal);
        const output = await readAll(response.body);

        expect(sendHop).toHaveBeenCalledWith('token-1');
        expect(output).not.toContain('requires_continuation');
        expect(output.match(/interaction\.completed/g)).toHaveLength(1);
    });
});
