/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('generateQuietPrompt external abort signal (#385)', () => {
    test('forwards an external AbortSignal to the quiet request, aborts on cancel, and cleans up listeners (#385)', async () => {
        let capturedSignal = null;
        let resolveRequest;

        loaded = await importScriptModule({
            mocks: {
                'scripts/openai.js': base => ({
                    ...base,
                    prepareOpenAIMessages: jest.fn(async () => [[{ role: 'user', content: 'Transform this.' }], false]),
                    sendOpenAIRequest: jest.fn((_type, _messages, signal) => {
                        capturedSignal = signal;
                        return new Promise(resolve => {
                            resolveRequest = resolve;
                        });
                    }),
                }),
            },
        });
        await loaded.script.changeMainAPI('openai');
        loaded.script.setOnlineStatus('Connected');
        loaded.script.characters.push({ name: 'Alice', avatar: 'alice.png', chat: 'chat-1' });
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Alice');

        // 1. Aborted in-flight quiet request propagates reason and cleans up the external abort listener.
        const externalController = new AbortController();
        const removeSpy = jest.spyOn(externalController.signal, 'removeEventListener');

        const pending = loaded.script.generateQuietPrompt({
            quietPrompt: 'Transform this.',
            signal: externalController.signal,
        });

        for (let i = 0; i < 20 && !capturedSignal; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        expect(capturedSignal.aborted).toBe(false);

        const cancelReason = new Error('User pressed stop');
        externalController.abort(cancelReason);

        expect(capturedSignal.aborted).toBe(true);
        expect(capturedSignal.reason).toBe(cancelReason);

        resolveRequest({ choices: [{ message: { content: 'late reply' } }] });
        await expect(pending).resolves.toBeUndefined();
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

        // 2. Non-aborted quiet request resolves with the response text and still detaches the listener.
        capturedSignal = null;
        const okController = new AbortController();
        const okRemoveSpy = jest.spyOn(okController.signal, 'removeEventListener');

        const okPending = loaded.script.generateQuietPrompt({
            quietPrompt: 'Transform this.',
            signal: okController.signal,
        });

        for (let i = 0; i < 20 && !capturedSignal; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        expect(capturedSignal.aborted).toBe(false);

        resolveRequest({ choices: [{ message: { content: 'done' } }] });
        await expect(okPending).resolves.toBe('done');
        expect(okRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    test('short-circuits immediately without issuing a request when generateQuietPrompt receives an already-aborted signal (#385)', async () => {
        const sendOpenAIRequest = jest.fn(async () => ({ choices: [{ message: { content: 'should not run' } }] }));

        loaded = await importScriptModule({
            mocks: {
                'scripts/openai.js': base => ({
                    ...base,
                    prepareOpenAIMessages: jest.fn(async () => [[{ role: 'user', content: 'Transform this.' }], false]),
                    sendOpenAIRequest,
                }),
            },
        });
        await loaded.script.changeMainAPI('openai');
        loaded.script.setOnlineStatus('Connected');
        loaded.script.characters.push({ name: 'Alice', avatar: 'alice.png', chat: 'chat-1' });
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Alice');

        const generationStarted = jest.fn();
        loaded.eventSource.on(loaded.script.event_types.GENERATION_STARTED, generationStarted);

        const externalController = new AbortController();
        externalController.abort(new Error('Already cancelled'));

        const result = await loaded.script.generateQuietPrompt({
            quietPrompt: 'Transform this.',
            signal: externalController.signal,
        });

        expect(result).toBeUndefined();
        expect(sendOpenAIRequest).not.toHaveBeenCalled();
        expect(generationStarted).not.toHaveBeenCalled();
    });
});
