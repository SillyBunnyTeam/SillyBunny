/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { importScriptModule } from './util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
});

class MinimalHeaders {
    constructor(init = {}) {
        this._map = new Map();
        if (init instanceof MinimalHeaders) {
            for (const [k, v] of init._map.entries()) this._map.set(k, v);
        } else if (init && typeof init.forEach === 'function') {
            init.forEach((v, k) => this._map.set(String(k).toLowerCase(), String(v)));
        } else if (init && typeof init === 'object') {
            for (const [k, v] of Object.entries(init)) this._map.set(String(k).toLowerCase(), String(v));
        }
    }
    get(key) { return this._map.get(String(key).toLowerCase()) ?? null; }
    set(key, value) { this._map.set(String(key).toLowerCase(), String(value)); }
    has(key) { return this._map.has(String(key).toLowerCase()); }
    forEach(cb) { this._map.forEach((v, k) => cb(v, k, this)); }
    entries() { return this._map.entries(); }
    [Symbol.iterator]() { return this._map.entries(); }
}

class MinimalResponse {
    constructor(body = null, init = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.statusText = init.statusText ?? '';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = init.headers instanceof MinimalHeaders ? init.headers : new MinimalHeaders(init.headers);
        this._jsonData = init.jsonData ?? null;
        this._textData = init.textData ?? '';
    }
    async json() {
        return this._jsonData !== null ? this._jsonData : JSON.parse(this._textData || '{}');
    }
    async text() {
        return this._textData;
    }
}

function makeResponse({ status = 200, statusText = 'OK', headers = {}, body = null, jsonData = null, textData = '' } = {}) {
    return new MinimalResponse(body, { status, statusText, headers, jsonData, textData });
}

function createHangingStreamBody(signal) {
    const encoder = new TextEncoder();
    let sent = false;
    return new ReadableStream({
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n'));
                return;
            }
            return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
            });
        },
    });
}

describe('page unload wiring for resumable generations', () => {
    test('hands chat replies to the server on pagehide only, never on beforeunload or bfcache persisted pagehide', async () => {
        globalThis.ReadableStream = ReadableStream;
        globalThis.TextEncoder = TextEncoder;
        globalThis.Headers = MinimalHeaders;
        globalThis.Response = MinimalResponse;
        const fetchCalls = [];
        const fetchMock = jest.fn(async (url, init) => {
            fetchCalls.push({ url, init });
            if (url === '/api/backends/chat-completions/generate') {
                return makeResponse({
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                    body: createHangingStreamBody(init?.signal),
                });
            }
            if (url === '/api/resumable-generations/detach' || url === '/api/resumable-generations/cancel') {
                return makeResponse({ status: 204 });
            }
            if (url === '/api/chats/save') {
                return makeResponse({ status: 200, jsonData: { ok: true } });
            }
            return makeResponse({ status: 200, jsonData: {} });
        });

        let streamStartedResolve;
        const streamStarted = new Promise(resolve => { streamStartedResolve = resolve; });

        loaded = await importScriptModule({
            keepReal: ['scripts/resumable-generation.js', 'scripts/generation-commit-plan.js'],
            fetch: fetchMock,
            mocks: {
                'scripts/server-generations.js': {
                    createGenerationCommitPlan: () => ({
                        v: 1,
                        chat: { avatar: 'bunny.png' },
                        file: 'bunny-chat',
                        kind: 'append',
                        index: 0,
                        page: 'page-1',
                    }),
                },
                'scripts/openai.js': {
                    sendOpenAIRequest: async (_type, _messages, signal) => {
                        const { fetchResumable } = await import('../public/scripts/resumable-generation.js');
                        const response = await fetchResumable(
                            '/api/backends/chat-completions/generate',
                            { method: 'POST', headers: { 'X-CSRF-Token': 'csrf' }, body: '{}', signal },
                        );
                        const reader = response.body.getReader();
                        return async function* () {
                            const { value } = await reader.read();
                            streamStartedResolve();
                            yield { text: value ? 'Hi' : '', swipes: [], toolCalls: [], state: {} };
                            await reader.read();
                        };
                    },
                },
            },
        });

        await loaded.runReady();
        loaded.$('#main_api').val('openai').trigger('change');
        loaded.state.oai_settings.stream_openai = true;
        loaded.script.characters.push({ name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat', data: { extensions: {} } });
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Bunny');
        loaded.script.setOnlineStatus('connected');

        const generatePromise = loaded.script.Generate('normal');
        await streamStarted;
        await new Promise(resolve => setTimeout(resolve, 15));

        const processor = loaded.script.streamingProcessor;
        expect(processor).toBeTruthy();
        const stopSpy = jest.spyOn(processor, 'onStopStreaming');

        // 1. beforeunload must NOT stop streaming or detach/cancel the server generation.
        window.dispatchEvent(new Event('beforeunload'));
        expect(stopSpy).not.toHaveBeenCalled();
        expect(fetchCalls.filter(c => c.url === '/api/resumable-generations/detach')).toHaveLength(0);
        expect(fetchCalls.filter(c => c.url === '/api/resumable-generations/cancel')).toHaveLength(0);

        // 2. pagehide with persisted=true (bfcache) must NOT stop the chat UI's stream processor.
        const persistedHide = new Event('pagehide');
        Object.defineProperty(persistedHide, 'persisted', { value: true });
        window.dispatchEvent(persistedHide);
        expect(stopSpy).not.toHaveBeenCalled();

        // 3. pagehide with persisted=false hands the reply to the server via detach and stops the UI stream.
        const finalHide = new Event('pagehide');
        Object.defineProperty(finalHide, 'persisted', { value: false });
        window.dispatchEvent(finalHide);
        await generatePromise.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 15));

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(fetchCalls.some(c => c.url === '/api/resumable-generations/detach')).toBe(true);
        expect(fetchCalls.some(c => c.url === '/api/resumable-generations/cancel')).toBe(false);
    });
});
