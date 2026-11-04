import { describe, expect, test } from '@jest/globals';
import vm from 'node:vm';
import { loadDeclarations } from './util/load-declarations.js';

const names = ['EventSourceStream'];
const context = vm.createContext({ TextDecoderStream, TransformStream, MessageEvent });
loadDeclarations(context, 'scripts/sse-stream.js', names);
const [EventSourceStream] = names.map(name => vm.runInContext(name, context));

const encoder = new TextEncoder();

function streamOf(chunks) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            }
            controller.close();
        },
    });
}

async function drain(readable) {
    const events = [];
    const reader = readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return events;
        events.push({ type: value.type, data: value.data, lastEventId: value.lastEventId });
    }
}

function readEvents(...chunks) {
    return drain(streamOf(chunks).pipeThrough(new EventSourceStream()));
}

function splitAt(text, ...offsets) {
    const bytes = encoder.encode(text);
    const cuts = [0, ...offsets, bytes.length];
    return cuts.slice(1).map((end, index) => bytes.slice(cuts[index], end));
}

function oneByteChunks(text) {
    return Array.from(encoder.encode(text), byte => Uint8Array.of(byte));
}

function seededRandom(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function randomChunks(text, random) {
    const bytes = encoder.encode(text);
    const chunks = [];
    for (let start = 0; start < bytes.length;) {
        const end = Math.min(bytes.length, start + 1 + Math.floor(random() * 9));
        chunks.push(bytes.slice(start, end));
        start = end;
    }
    return chunks;
}

const message = (data, lastEventId = '') => ({ type: 'message', data, lastEventId });

describe('EventSourceStream', () => {
    describe.each([
        ['LF', '\n'],
        ['CRLF', '\r\n'],
        ['CR', '\r'],
    ])('with %s line endings', (_name, eol) => {
        const block = (...lines) => lines.map(line => line + eol).join('') + eol;

        test('dispatches one message event per event block', async () => {
            expect(await readEvents(block('data: one') + block('data: two'))).toEqual([message('one'), message('two')]);
        });

        test('joins the data lines of one event with newlines', async () => {
            expect(await readEvents(block('data: a', 'data: b', 'data: c'))).toEqual([message('a\nb\nc')]);
            expect(await readEvents(block('data: a', 'data:', 'data: c'))).toEqual([message('a\n\nc')]);
        });

        test('skips comment lines and comment-only blocks', async () => {
            const chunk = block(': OPENROUTER PROCESSING') + block('data: a', ': ping', 'data: b') + block(':ok');
            expect(await readEvents(chunk)).toEqual([message('a\nb')]);
        });

        test('keeps the same events for every way of cutting the byte stream', async () => {
            const stream = block('id: 1', 'event: update', 'data: café 日本', ': note', 'data: \u{1F600}') + block('data: tail');
            const expected = [
                { type: 'update', data: 'café 日本\n\u{1F600}', lastEventId: '1' },
                message('tail', '1'),
            ];
            const length = encoder.encode(stream).length;
            for (let cut = 0; cut <= length; cut++) {
                expect(await readEvents(...splitAt(stream, cut))).toEqual(expected);
            }
            expect(await readEvents(...oneByteChunks(stream))).toEqual(expected);
            const random = seededRandom(2024);
            for (let round = 0; round < 60; round++) {
                expect(await readEvents(...randomChunks(stream, random))).toEqual(expected);
            }
        });
    });

    test('keeps a multibyte character that is split across chunks', async () => {
        const text = 'data: é日\u{1F600}\n\n';
        const expected = [message('é日\u{1F600}')];
        expect(await readEvents(...splitAt(text, 7))).toEqual(expected);
        expect(await readEvents(...splitAt(text, 9))).toEqual(expected);
        expect(await readEvents(...splitAt(text, 10))).toEqual(expected);
        expect(await readEvents(...splitAt(text, 12, 14))).toEqual(expected);
        expect(await readEvents(...splitAt(text, 13))).toEqual(expected);
    });

    test('reads a line ending that is cut between its carriage return and its line feed', async () => {
        expect(await readEvents('data: a\r', '\n', '\r', '\n', 'data: b\r\n\r', '\n')).toEqual([message('a'), message('b')]);
    });

    test('accepts different line endings in different events of one stream', async () => {
        expect(await readEvents('data: lf\n\ndata: crlf\r\n\r\ndata: cr\r\r')).toEqual([message('lf'), message('crlf'), message('cr')]);
    });

    test('strips one leading space from a field value and no other', async () => {
        expect(await readEvents('data:tight\n\ndata: one\n\ndata:  two\n\ndata:\ttab\n\n')).toEqual([
            message('tight'),
            message('one'),
            message(' two'),
            message('\ttab'),
        ]);
    });

    test('keeps colons inside a field value', async () => {
        const payload = '{"url":"http://host:80/a:b","t":"12:30"}';
        expect(await readEvents(`data: ${payload}\n\n`)).toEqual([message(payload)]);
    });

    test('names the event type from the event field and resets it for the next event', async () => {
        expect(await readEvents('event: update\ndata: 1\n\ndata: 2\n\nevent:\ndata: 3\n\n')).toEqual([
            { type: 'update', data: '1', lastEventId: '' },
            message('2'),
            message('3'),
        ]);
    });

    test('keeps the last event id for later events until an id field replaces it', async () => {
        expect(await readEvents('id: 7\ndata: a\n\ndata: b\n\nid: 8\ndata: c\n\nid:\ndata: d\n\n')).toEqual([
            message('a', '7'),
            message('b', '7'),
            message('c', '8'),
            message('d'),
        ]);
    });

    test('ignores an id field that contains a null character', async () => {
        expect(await readEvents('id: 5\ndata: a\n\nid: x\0y\ndata: b\n\n')).toEqual([message('a', '5'), message('b', '5')]);
    });

    test('does not dispatch a block without data but still records its id', async () => {
        expect(await readEvents('id: 9\n\nevent: ping\n\nretry: 3000\n\ndata: z\n\n')).toEqual([message('z', '9')]);
    });

    test('ignores the retry field and unknown fields', async () => {
        expect(await readEvents('retry: 3000\nfoo: bar\nDATA: loud\ndata: kept\n\n')).toEqual([message('kept')]);
    });

    test('drops a byte order mark at the start of the stream', async () => {
        expect(await readEvents(Uint8Array.of(0xEF, 0xBB, 0xBF), 'data: a\n\n')).toEqual([message('a')]);
        expect(await readEvents(Uint8Array.of(0xEF, 0xBB), Uint8Array.of(0xBF), 'data: a\n\n')).toEqual([message('a')]);
    });

    test('keeps delivering events after the DONE marker', async () => {
        expect(await readEvents('data: a\n\ndata: [DONE]\n\ndata: late\n\n')).toEqual([message('a'), message('[DONE]'), message('late')]);
    });

    test('delivers an error event with its type and payload', async () => {
        const payload = '{"error":{"message":"Rate limit reached","type":"rate_limit"}}';
        expect(await readEvents(`event: error\ndata: ${payload}\n\ndata: ${payload}\n\n`)).toEqual([
            { type: 'error', data: payload, lastEventId: '' },
            message(payload),
        ]);
    });

    test('delivers malformed JSON as text and keeps reading', async () => {
        const broken = '{"choices":[{"delta":{"content":"a';
        expect(await readEvents(`data: ${broken}\n\ndata: {"ok":true}\n\n`)).toEqual([message(broken), message('{"ok":true}')]);
        expect(await readEvents('data: {"choices":[{"delta":', '{"content":"a"}}]}\n', '\n')).toEqual([message('{"choices":[{"delta":{"content":"a"}}]}')]);
    });

    test('delivers reasoning deltas whole when a chunk ends inside a multibyte character', async () => {
        const payloads = [
            { choices: [{ index: 0, delta: { reasoning_content: 'Think é日', content: null } }] },
            { choices: [{ index: 0, delta: { reasoning: '\u{1F600}', content: 'Hi' } }] },
        ];
        const text = payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('');
        const cuts = [encoder.encode(text).indexOf(0xC3) + 1, encoder.encode(text).indexOf(0xF0) + 2];
        const events = await readEvents(...splitAt(text, ...cuts));
        expect(events.map(event => JSON.parse(event.data))).toEqual(payloads);
    });

    test('delivers tool call deltas whose arguments are split inside a token', async () => {
        const fragments = ['{"ci', 'ty": "Pa', 'ris", "un', 'it": "c"}'];
        const payloads = fragments.map((fragment, index) => ({
            choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call_1', type: 'function' } : {}), function: { ...(index === 0 ? { name: 'weather' } : {}), arguments: fragment } }] },
            }],
        }));
        const text = payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n';
        for (const size of [1, 3, 7, 16]) {
            const chunks = [];
            const bytes = encoder.encode(text);
            for (let start = 0; start < bytes.length; start += size) {
                chunks.push(bytes.slice(start, start + size));
            }
            const events = await readEvents(...chunks);
            expect(events.map(event => event.data)).toEqual([...payloads.map(payload => JSON.stringify(payload)), '[DONE]']);
            const argumentText = events.slice(0, -1).map(event => JSON.parse(event.data).choices[0].delta.tool_calls[0].function.arguments).join('');
            expect(JSON.parse(argumentText)).toEqual({ city: 'Paris', unit: 'c' });
        }
    });

    test('reads partial input split by empty chunks', async () => {
        expect(await readEvents('data: a', '', '\n', new Uint8Array(0), '\n')).toEqual([message('a')]);
    });

    test('emits nothing for a stream with no bytes or only empty chunks', async () => {
        expect(await readEvents()).toEqual([]);
        expect(await readEvents(new Uint8Array(0), '')).toEqual([]);
    });

    test('drops a final event that never received its blank line', async () => {
        expect(await readEvents('data: a\n\ndata: partial')).toEqual([message('a')]);
        expect(await readEvents('data: a\n')).toEqual([]);
    });

    test('delivers a 1 MiB single-chunk event unchanged', async () => {
        const payload = 'x'.repeat(1024 * 1024);
        const events = await readEvents(`data: ${payload}\n\n`);
        expect(events).toHaveLength(1);
        expect(events[0].data.length).toBe(payload.length);
        expect(events[0].data === payload).toBe(true);
    });

    test('delivers a 1 MiB multibyte event unchanged when chunk edges fall inside characters', async () => {
        const payload = 'é'.repeat(512 * 1024);
        const bytes = encoder.encode(`data: ${payload}\n\n`);
        const chunks = [];
        for (let start = 0; start < bytes.length; start += 65537) {
            chunks.push(bytes.slice(start, start + 65537));
        }
        const events = await readEvents(...chunks);
        expect(events).toHaveLength(1);
        expect(events[0].data.length).toBe(payload.length);
        expect(events[0].data === payload).toBe(true);
    });

    test('delivers many events from one chunk in order', async () => {
        const count = 20000;
        const text = Array.from({ length: count }, (_value, index) => `data: ${index}\n\n`).join('');
        const events = await readEvents(text);
        expect(events).toHaveLength(count);
        expect(events.every((event, index) => event.data === String(index))).toBe(true);
    });

    test('rejects reads with the error of a source that fails after some events', async () => {
        const failure = new Error('connection lost');
        let source;
        const readable = new ReadableStream({
            start(controller) {
                source = controller;
            },
        }).pipeThrough(new EventSourceStream());
        const reader = readable.getReader();
        source.enqueue(encoder.encode('data: first\n\n'));
        expect((await reader.read()).value.data).toBe('first');
        source.error(failure);
        await expect(reader.read()).rejects.toBe(failure);
    });
});
