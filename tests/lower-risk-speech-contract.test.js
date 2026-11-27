import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    SAMPLE_AUDIO_BUFFER,
    STANDARD_UPSTREAM_ERRORS,
    binaryReply,
    createFakeUpstreamServer,
    createLoopbackNetworkGuard,
    htmlErrorReply,
    initContractConfig,
    jsonReply,
    startContractApp,
    streamChunksReply,
    textReply,
} from './util/lower-risk-contract-harness.js';

const { default: actualNodeFetch } = await import('node-fetch');

let fakeServer = null;
let app = null;

const networkGuard = createLoopbackNetworkGuard({
    getFakeServer: () => fakeServer,
    getAllowedPorts: () => [app?.port],
    actualNodeFetch,
});

await jest.unstable_mockModule('node-fetch', () => ({
    default: networkGuard.guardedNodeFetch,
}));

const contractConfig = await initContractConfig('sillybunny-speech-cfg-');

const { router: speechRouter } = await import('../src/endpoints/speech.js');
const { router: openAiRouter } = await import('../src/endpoints/openai.js');
const { router: googleRouter } = await import('../src/endpoints/google.js');
const { router: azureRouter } = await import('../src/endpoints/azure.js');
const { router: minimaxRouter } = await import('../src/endpoints/minimax.js');
const { router: volcengineRouter } = await import('../src/endpoints/volcengine.js');
const { router: novelAiRouter } = await import('../src/endpoints/novelai.js');
const { SECRET_KEYS } = await import('../src/endpoints/secrets.js');

const ALL_SPEECH_SECRETS = {
    [SECRET_KEYS.POLLINATIONS]: 'test-pollinations-key',
    [SECRET_KEYS.ELEVENLABS]: 'test-elevenlabs-key',
    [SECRET_KEYS.OPENAI]: 'test-openai-key',
    [SECRET_KEYS.ELECTRONHUB]: 'test-electronhub-key',
    [SECRET_KEYS.CHUTES]: 'test-chutes-key',
    [SECRET_KEYS.CUSTOM_OPENAI_TTS]: 'test-custom-tts-key',
    [SECRET_KEYS.GROQ]: 'test-groq-key',
    [SECRET_KEYS.MISTRALAI]: 'test-mistral-key',
    [SECRET_KEYS.ZAI]: 'test-zai-key',
    [SECRET_KEYS.MAKERSUITE]: 'test-makersuite-key',
    [SECRET_KEYS.VERTEXAI]: 'test-vertex-key',
    [SECRET_KEYS.AZURE_TTS]: 'test-azure-key',
    [SECRET_KEYS.MINIMAX]: 'test-minimax-key',
    [SECRET_KEYS.VOLCENGINE_APP_ID]: 'test-volc-app-id',
    [SECRET_KEYS.VOLCENGINE_ACCESS_KEY]: 'test-volc-access-key',
    [SECRET_KEYS.NOVEL]: 'test-novelai-key',
};

function googleSpeakBatchReply(base64Audio) {
    const inner = JSON.stringify([base64Audio]);
    const outer = JSON.stringify([['wrb.fr', 'jQ1olc', inner, null, null, null, '0']]);
    return textReply(`)]}'\n\n${outer}`, 200, 'application/json; charset=utf-8');
}

describe('Speech and TTS endpoint contract matrix', () => {
    beforeAll(async () => {
        fakeServer = await createFakeUpstreamServer();
        app = await startContractApp({
            routes: [
                ['/api/speech', speechRouter],
                ['/api/openai', openAiRouter],
                ['/api/google', googleRouter],
                ['/api/azure', azureRouter],
                ['/api/minimax', minimaxRouter],
                ['/api/volcengine', volcengineRouter],
                ['/api/novelai', novelAiRouter],
            ],
            withUpload: true,
            tempPrefix: 'sillybunny-speech-contract-',
            secrets: ALL_SPEECH_SECRETS,
            skipConfigInit: true,
        });
    });

    beforeEach(() => {
        fakeServer.reset();
        networkGuard.setBlockExternal(false);
        app.resetUser(ALL_SPEECH_SECRETS);
    });

    afterAll(async () => {
        networkGuard.restore();
        await app?.close();
        await fakeServer?.close();
        contractConfig.cleanup();
    });

    describe('Pollinations TTS (/api/speech/pollinations/*)', () => {
        test('lists voices by model name or alias', async () => {
            fakeServer.enqueue(jsonReply([
                { name: 'openai-audio', aliases: ['audio-alias'], voices: ['alloy', 'nova'] },
            ]));

            const res = await app.postJson('/api/speech/pollinations/voices', { model: 'audio-alias' });

            expect(res.status).toBe(200);
            expect(res.json).toEqual(['alloy', 'nova']);
            expect(fakeServer.requests[0].method).toBe('GET');
            expect(fakeServer.requests[0].originalUrl).toBe('https://gen.pollinations.ai/text/models');
        });

        test('synthesizes audio, maps openai-audio to tts-1, and preserves Content-Type', async () => {
            fakeServer.enqueue(binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/mpeg'));

            const res = await app.postJson('/api/speech/pollinations/generate', {
                text: 'Speak this line',
                model: 'openai-audio',
                voice: 'nova',
            });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('audio/mpeg');
            expect(res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            const [req] = fakeServer.requests;
            expect(req.originalUrl).toBe('https://gen.pollinations.ai/v1/audio/speech');
            expect(req.headers.authorization).toBe('Bearer test-pollinations-key');
            expect(req.json).toEqual({ model: 'tts-1', input: 'Speak this line', voice: 'nova' });
        });

        test('returns 400 when Pollinations key is missing', async () => {
            app.clearSecrets();
            const res = await app.postJson('/api/speech/pollinations/generate', { text: 'Hi' });
            expect(res.status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s for voices and generate', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply, errorReply);
            expect((await app.postJson('/api/speech/pollinations/voices', {})).status).toBe(500);
            expect((await app.postJson('/api/speech/pollinations/generate', { text: 'Hi' })).status).toBe(500);
        });
    });

    describe('ElevenLabs (/api/speech/elevenlabs/*)', () => {
        test('lists voices, default voice settings, and history with xi-api-key', async () => {
            fakeServer.enqueue(
                jsonReply({ voices: [{ voice_id: 'v1', name: 'Rachel' }] }),
                jsonReply({ stability: 0.5, similarity_boost: 0.75 }),
                jsonReply({ history: [{ history_item_id: 'h1' }] }),
            );

            const voicesRes = await app.postJson('/api/speech/elevenlabs/voices', {});
            const settingsRes = await app.postJson('/api/speech/elevenlabs/voice-settings', {});
            const historyRes = await app.postJson('/api/speech/elevenlabs/history', {});

            expect(voicesRes.status).toBe(200);
            expect(voicesRes.json.voices[0].voice_id).toBe('v1');
            expect(settingsRes.status).toBe(200);
            expect(settingsRes.json.stability).toBe(0.5);
            expect(historyRes.status).toBe(200);
            expect(historyRes.json.history[0].history_item_id).toBe('h1');

            expect(fakeServer.requests.map(r => r.originalUrl)).toEqual([
                'https://api.elevenlabs.io/v1/voices',
                'https://api.elevenlabs.io/v1/voices/settings/default',
                'https://api.elevenlabs.io/v1/history',
            ]);
            for (const req of fakeServer.requests) {
                expect(req.headers['xi-api-key']).toBe('test-elevenlabs-key');
            }
        });

        test('synthesizes audio and streams history audio', async () => {
            fakeServer.enqueue(
                binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/mpeg'),
                binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/mpeg'),
            );

            const synthRes = await app.postJson('/api/speech/elevenlabs/synthesize', {
                voiceId: 'voice-abc',
                request: { text: 'Hello ElevenLabs', model_id: 'eleven_monolingual_v1' },
            });
            const histAudioRes = await app.postJson('/api/speech/elevenlabs/history-audio', {
                historyItemId: 'hist-123',
            });

            expect(synthRes.status).toBe(200);
            expect(synthRes.headers.get('content-type')).toContain('audio/mpeg');
            expect(synthRes.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            expect(histAudioRes.status).toBe(200);
            expect(histAudioRes.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);

            expect(fakeServer.requests[0].originalUrl).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-abc');
            expect(fakeServer.requests[0].json).toEqual({ text: 'Hello ElevenLabs', model_id: 'eleven_monolingual_v1' });
            expect(fakeServer.requests[1].originalUrl).toBe('https://api.elevenlabs.io/v1/history/hist-123/audio');
        });

        test('uploads custom voice multipart payload and recognizes uploaded audio', async () => {
            fakeServer.enqueue(
                jsonReply({ voice_id: 'custom-voice-1' }),
                jsonReply({ text: 'recognized words' }),
            );

            const dataUri = `data:audio/wav;base64,${SAMPLE_AUDIO_BUFFER.toString('base64')}`;
            const addRes = await app.postJson('/api/speech/elevenlabs/voices/add', {
                name: 'My Voice',
                description: 'Sample',
                labels: '{"accent":"neutral"}',
                files: [dataUri, 'invalid-entry-skipped'],
            });
            expect(addRes.status).toBe(200);
            expect(addRes.json).toEqual({ voice_id: 'custom-voice-1' });
            expect(fakeServer.requests[0].originalUrl).toBe('https://api.elevenlabs.io/v1/voices/add');
            expect(fakeServer.requests[0].headers['content-type']).toContain('multipart/form-data');
            expect(fakeServer.requests[0].text).toContain('My Voice');

            const recRes = await app.postUpload('/api/speech/elevenlabs/recognize', {
                bytes: SAMPLE_AUDIO_BUFFER,
                fileName: 'sample.wav',
                fields: { model: 'scribe_v1' },
            });
            expect(recRes.status).toBe(200);
            expect(recRes.json).toEqual({ text: 'recognized words' });
            expect(fakeServer.requests[1].originalUrl).toBe('https://api.elevenlabs.io/v1/speech-to-text');
            expect(fakeServer.requests[1].headers['xi-api-key']).toBe('test-elevenlabs-key');
            expect(fs.readdirSync(app.directories.uploads)).toHaveLength(0);
        });

        test('returns 400 when key or required fields are missing', async () => {
            expect((await app.postJson('/api/speech/elevenlabs/synthesize', { voiceId: 'v1' })).status).toBe(400);
            expect((await app.postJson('/api/speech/elevenlabs/history-audio', {})).status).toBe(400);
            expect((await app.postJson('/api/speech/elevenlabs/recognize', { model: 'scribe_v1' })).status).toBe(400);

            app.clearSecrets();
            for (const route of [
                '/api/speech/elevenlabs/voices',
                '/api/speech/elevenlabs/voice-settings',
                '/api/speech/elevenlabs/synthesize',
                '/api/speech/elevenlabs/history',
                '/api/speech/elevenlabs/history-audio',
                '/api/speech/elevenlabs/voices/add',
                '/api/speech/elevenlabs/recognize',
            ]) {
                expect((await app.postJson(route, {})).status).toBe(400);
            }
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s for synthesize and voices', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply, errorReply);
            expect((await app.postJson('/api/speech/elevenlabs/voices', {})).status).toBe(500);
            expect((await app.postJson('/api/speech/elevenlabs/synthesize', { voiceId: 'v1', request: { text: 'Hi' } })).status).toBe(500);
        });
    });

    describe('OpenAI, ElectronHub, Chutes, and Custom OpenAI-compatible TTS (/api/openai/*)', () => {
        test.each([
            ['mp3', 'mp3', 'audio/mpeg'],
            ['opus', 'opus', 'audio/opus'],
            ['aac', 'aac', 'audio/aac'],
            ['flac', 'flac', 'audio/flac'],
            ['wav', 'wav', 'audio/wav'],
            ['ogg', 'wav', 'audio/wav'],
        ])('OpenAI /generate-voice normalizes %s -> %s and sets Content-Type', async (inputFormat, expectedFormat, expectedMime) => {
            fakeServer.enqueue(binaryReply(SAMPLE_AUDIO_BUFFER, expectedMime));

            const res = await app.postJson('/api/openai/generate-voice', {
                text: 'Read aloud',
                voice: 'shimmer',
                speed: 1.2,
                model: 'gpt-4o-mini-tts',
                response_format: inputFormat,
                instructions: 'Cheerful tone',
            });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain(expectedMime);
            expect(res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            const [req] = fakeServer.requests;
            expect(req.originalUrl).toBe('https://api.openai.com/v1/audio/speech');
            expect(req.headers.authorization).toBe('Bearer test-openai-key');
            expect(req.json).toEqual({
                input: 'Read aloud',
                response_format: expectedFormat,
                voice: 'shimmer',
                speed: 1.2,
                model: 'gpt-4o-mini-tts',
                instructions: 'Cheerful tone',
            });
        });

        test('ElectronHub /electronhub/generate-voice forwards provider and dynamic parameters, and /models lists models', async () => {
            fakeServer.enqueue(
                binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/mpeg'),
                jsonReply({ data: [{ id: 'tts-hd' }] }),
            );

            const voiceRes = await app.postJson('/api/openai/electronhub/generate-voice', {
                input: 'Hello ElectronHub',
                voice: 'echo',
                model: 'tts-hd',
                cfg_scale: 2.5,
                emotional_style: 'calm',
                custom_flag: true,
            });
            const modelsRes = await app.postJson('/api/openai/electronhub/models', {});

            expect(voiceRes.status).toBe(200);
            expect(voiceRes.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            expect(fakeServer.requests[0].originalUrl).toBe('https://api.electronhub.ai/v1/audio/speech');
            expect(fakeServer.requests[0].json).toMatchObject({
                input: 'Hello ElectronHub',
                voice: 'echo',
                model: 'tts-hd',
                response_format: 'mp3',
                cfg_scale: 2.5,
                emotional_style: 'calm',
                custom_flag: true,
            });

            expect(modelsRes.status).toBe(200);
            expect(modelsRes.json).toEqual([{ id: 'tts-hd' }]);
            expect(fakeServer.requests[1].originalUrl).toBe('https://api.electronhub.ai/v1/models');
        });

        test('Chutes /chutes/generate-voice posts to chutes-kokoro.chutes.ai/speak', async () => {
            fakeServer.enqueue(binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/mpeg'));

            const res = await app.postJson('/api/openai/chutes/generate-voice', {
                input: 'Hello Chutes',
                voice: 'af_bella',
                speed: 1.1,
            });

            expect(res.status).toBe(200);
            expect(res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            expect(fakeServer.requests[0].originalUrl).toBe('https://chutes-kokoro.chutes.ai/speak');
            expect(fakeServer.requests[0].headers.authorization).toBe('Bearer test-chutes-key');
            expect(fakeServer.requests[0].json).toEqual({
                text: 'Hello Chutes',
                voice: 'af_bella',
                speed: 1.1,
            });
        });

        test('Custom OpenAI TTS /custom/generate-voice posts to provider_endpoint and rejects missing endpoint', async () => {
            expect((await app.postJson('/api/openai/custom/generate-voice', { input: 'Hi' })).status).toBe(400);

            fakeServer.enqueue(binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/wav'));
            const res = await app.postJson('/api/openai/custom/generate-voice', {
                input: 'Custom hello',
                provider_endpoint: 'https://custom-tts.example/v1/audio/speech',
                voice: 'custom-v1',
                response_format: 'wav',
            });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('audio/wav');
            expect(res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            expect(fakeServer.requests[0].originalUrl).toBe('https://custom-tts.example/v1/audio/speech');
            expect(fakeServer.requests[0].headers.authorization).toBe('Bearer test-custom-tts-key');
        });

        test.each([
            ['openai', '/api/openai/generate-voice', { text: 'Hi' }],
            ['electronhub', '/api/openai/electronhub/generate-voice', { input: 'Hi' }],
            ['electronhub-models', '/api/openai/electronhub/models', {}],
            ['chutes', '/api/openai/chutes/generate-voice', { input: 'Hi' }],
        ])('%s returns 400 when API key is missing and 500 on upstream errors', async (_name, route, body) => {
            app.clearSecrets();
            expect((await app.postJson(route, body)).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);

            app.seedSecrets(ALL_SPEECH_SECRETS);
            for (const [, errorReply] of STANDARD_UPSTREAM_ERRORS) {
                fakeServer.reset();
                fakeServer.enqueue(errorReply);
                expect((await app.postJson(route, body)).status).toBe(500);
            }
        });

        test.each([
            ['openai', '/api/openai/transcribe-audio', 'https://api.openai.com/v1/audio/transcriptions', 'Bearer test-openai-key'],
            ['groq', '/api/openai/groq/transcribe-audio', 'https://api.groq.com/openai/v1/audio/transcriptions', 'Bearer test-groq-key'],
            ['mistral', '/api/openai/mistral/transcribe-audio', 'https://api.mistral.ai/v1/audio/transcriptions', 'Bearer test-mistral-key'],
            ['zai', '/api/openai/zai/transcribe-audio', 'https://api.z.ai/api/paas/v4/audio/transcriptions', 'Bearer test-zai-key'],
        ])('%s transcription uploads multipart audio and cleans temp file', async (_name, route, expectedUrl, expectedAuth) => {
            fakeServer.enqueue(jsonReply({ text: 'transcribed line' }));

            const res = await app.postUpload(route, {
                bytes: SAMPLE_AUDIO_BUFFER,
                fileName: 'clip.wav',
                fields: { model: 'whisper-1', language: 'en' },
            });

            expect(res.status).toBe(200);
            expect(res.json).toEqual({ text: 'transcribed line' });
            expect(fakeServer.requests[0].originalUrl).toBe(expectedUrl);
            expect(fakeServer.requests[0].headers.authorization).toBe(expectedAuth);
            expect(fakeServer.requests[0].headers['content-type']).toContain('multipart/form-data');
            expect(fs.readdirSync(app.directories.uploads)).toHaveLength(0);
        });

        test('Chutes /chutes/transcribe-audio sends base64 JSON and joins transcript chunks', async () => {
            fakeServer.enqueue(jsonReply([{ text: 'Hello ' }, { text: 'world ' }]));

            const res = await app.postUpload('/api/openai/chutes/transcribe-audio', {
                bytes: SAMPLE_AUDIO_BUFFER,
                fileName: 'clip.wav',
                fields: { model: 'chutes-whisper-large-v3' },
            });

            expect(res.status).toBe(200);
            expect(res.json).toEqual({ text: 'Hello world' });
            expect(fakeServer.requests[0].originalUrl).toBe('https://chutes-whisper-large-v3.chutes.ai/transcribe');
            expect(fakeServer.requests[0].json).toEqual({ audio_b64: SAMPLE_AUDIO_BUFFER.toString('base64') });
            expect(fs.readdirSync(app.directories.uploads)).toHaveLength(0);
        });
    });

    describe('Google Translate TTS and Gemini Native TTS (/api/google/*)', () => {
        test('lists Translate languages and Gemini native voices without outbound calls', async () => {
            networkGuard.setBlockExternal(true);

            const translateVoices = await app.postJson('/api/google/list-voices', {});
            expect(translateVoices.status).toBe(200);
            expect(translateVoices.json.en).toBe('English');

            const nativeVoices = await app.postJson('/api/google/list-native-voices', {});
            expect(nativeVoices.status).toBe(200);
            expect(Array.isArray(nativeVoices.json.voices)).toBe(true);
            expect(nativeVoices.json.voices.some(v => v.voice_id === 'Zephyr')).toBe(true);
        });

        test('Google Translate /generate-voice decodes batchexecute base64 audio via loopback global fetch', async () => {
            fakeServer.enqueue(googleSpeakBatchReply(SAMPLE_AUDIO_BUFFER.toString('base64')));

            const res = await app.postJson('/api/google/generate-voice', { text: 'Hello Google', voice: 'en' });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('audio/mpeg');
            expect(res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            expect(fakeServer.requests[0].originalHost).toBe('translate.google.com');
            expect(fakeServer.requests[0].query.rpcids).toBe('jQ1olc');
        });

        test('Gemini /generate-native-tts wraps L16 PCM in a 44-byte RIFF/WAVE header and preserves non-PCM audio', async () => {
            const rawPcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
            fakeServer.enqueue(
                jsonReply({
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: {
                                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                                    data: rawPcm.toString('base64'),
                                },
                            }],
                        },
                    }],
                }),
                jsonReply({
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: {
                                    mimeType: 'audio/mpeg',
                                    data: SAMPLE_AUDIO_BUFFER.toString('base64'),
                                },
                            }],
                        },
                    }],
                }),
            );

            const pcmRes = await app.postJson('/api/google/generate-native-tts', {
                text: 'Say hello',
                voice: 'Zephyr',
                model: 'gemini-2.5-flash-preview-tts',
            });
            expect(pcmRes.status).toBe(200);
            expect(pcmRes.headers.get('content-type')).toContain('audio/wav');
            expect(pcmRes.buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
            expect(pcmRes.buffer.subarray(8, 12).toString('ascii')).toBe('WAVE');
            expect(pcmRes.buffer.readUInt32LE(24)).toBe(24000);
            expect(pcmRes.buffer.subarray(44).equals(rawPcm)).toBe(true);
            expect(fakeServer.requests[0].originalUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent');
            expect(fakeServer.requests[0].headers['x-goog-api-key']).toBe('test-makersuite-key');
            expect(fakeServer.requests[0].json.generationConfig).toEqual({
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
            });

            const mp3Res = await app.postJson('/api/google/generate-native-tts', {
                text: 'Say hello mp3',
                voice: 'Puck',
                model: 'gemini-2.5-flash-preview-tts',
            });
            expect(mp3Res.status).toBe(200);
            expect(mp3Res.headers.get('content-type')).toContain('audio/mpeg');
            expect(mp3Res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
        });

        test('Gemini /generate-native-tts forwards JSON upstream error status and returns 500 on non-JSON HTML error', async () => {
            fakeServer.enqueue(
                jsonReply({ error: { message: 'Quota exceeded' } }, 429),
                jsonReply({ error: { message: 'Bad key' } }, 401),
                htmlErrorReply(502, '<html>502</html>'),
            );

            const rateRes = await app.postJson('/api/google/generate-native-tts', { text: 'Hi', voice: 'Zephyr', model: 'gemini-2.5-flash-preview-tts' });
            expect(rateRes.status).toBe(429);
            expect(rateRes.json).toEqual({ error: 'Quota exceeded' });

            const authRes = await app.postJson('/api/google/generate-native-tts', { text: 'Hi', voice: 'Zephyr', model: 'gemini-2.5-flash-preview-tts' });
            expect(authRes.status).toBe(401);
            expect(authRes.json).toEqual({ error: 'Bad key' });

            // Non-JSON error triggers JSON.parse SyntaxError in catch block and yields 500.
            const htmlRes = await app.postJson('/api/google/generate-native-tts', { text: 'Hi', voice: 'Zephyr', model: 'gemini-2.5-flash-preview-tts' });
            expect(htmlRes.status).toBe(500);
            expect(htmlRes.json.error).toContain('Internal server error');
        });
    });

    describe('Azure Cognitive Services TTS (/api/azure/*)', () => {
        test('lists voices and synthesizes escaped SSML audio', async () => {
            fakeServer.enqueue(
                jsonReply([{ ShortName: 'en-US-AriaNeural' }]),
                binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/webm'),
            );

            const listRes = await app.postJson('/api/azure/list', { region: 'eastus' });
            expect(listRes.status).toBe(200);
            expect(listRes.json).toEqual([{ ShortName: 'en-US-AriaNeural' }]);
            expect(fakeServer.requests[0].originalUrl).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
            expect(fakeServer.requests[0].headers['ocp-apim-subscription-key']).toBe('test-azure-key');

            const genRes = await app.postJson('/api/azure/generate', {
                region: 'eastus',
                voice: 'en-US-AriaNeural',
                text: 'A & B < C > D',
            });
            expect(genRes.status).toBe(200);
            expect(genRes.headers.get('content-type')).toContain('audio/ogg');
            expect(genRes.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            const genReq = fakeServer.requests[1];
            expect(genReq.originalUrl).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
            expect(genReq.headers['content-type']).toBe('application/ssml+xml');
            expect(genReq.headers['x-microsoft-outputformat']).toBe('webm-24khz-16bit-mono-opus');
            expect(genReq.text).toContain('A &amp; B &lt; C &gt; D');
            expect(genReq.text).toContain('xml:lang=\'en-US\'');
        });

        test('returns 403 when key is missing and 400 when required params are missing', async () => {
            expect((await app.postJson('/api/azure/list', {})).status).toBe(400);
            expect((await app.postJson('/api/azure/generate', { region: 'eastus', text: 'Hi' })).status).toBe(400);

            app.clearSecrets();
            expect((await app.postJson('/api/azure/list', { region: 'eastus' })).status).toBe(403);
            expect((await app.postJson('/api/azure/generate', { region: 'eastus', voice: 'en-US-AriaNeural', text: 'Hi' })).status).toBe(403);
            expect(fakeServer.requests).toHaveLength(0);
        });

        test.each(STANDARD_UPSTREAM_ERRORS)('returns 500 on upstream %s', async (_label, errorReply) => {
            fakeServer.enqueue(errorReply, errorReply);
            expect((await app.postJson('/api/azure/list', { region: 'eastus' })).status).toBe(500);
            expect((await app.postJson('/api/azure/generate', { region: 'eastus', voice: 'en-US-AriaNeural', text: 'Hi' })).status).toBe(500);
        });
    });

    describe('MiniMax TTS (/api/minimax/generate-voice)', () => {
        test('decodes hex audio payload and supports URL-based audio fallback', async () => {
            const expectedBytes = Buffer.from([0x49, 0x44, 0x33, 0x01, 0x02]);
            fakeServer.enqueue(
                jsonReply({ base_resp: { status_code: 0 }, data: { audio: `0x${expectedBytes.toString('hex')}` } }),
                jsonReply({ base_resp: { status_code: 0 }, data: { url: 'https://cdn.minimax.example/clip.wav' } }),
                binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/wav'),
            );

            const hexRes = await app.postJson('/api/minimax/generate-voice', {
                text: 'Hex voice test',
                voiceId: 'male-qn-qingse',
                format: 'mp3',
                language: 'English',
            });
            expect(hexRes.status).toBe(200);
            expect(hexRes.headers.get('content-type')).toContain('audio/mpeg');
            expect(hexRes.buffer.equals(expectedBytes)).toBe(true);
            expect(fakeServer.requests[0].originalUrl).toBe('https://api.minimax.io/v1/t2a_v2');
            expect(fakeServer.requests[0].headers['mm-api-source']).toBe('SillyTavern-TTS');
            expect(fakeServer.requests[0].json).toMatchObject({
                text: 'Hex voice test',
                lang: 'English',
                voice_setting: { voice_id: 'male-qn-qingse' },
            });

            const urlRes = await app.postJson('/api/minimax/generate-voice', {
                text: 'URL voice test',
                voiceId: 'male-qn-qingse',
                format: 'wav',
            });
            expect(urlRes.status).toBe(200);
            expect(urlRes.headers.get('content-type')).toContain('audio/wav');
            expect(urlRes.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            expect(fakeServer.requests[2].originalUrl).toBe('https://cdn.minimax.example/clip.wav');
        });

        test('returns 400 when parameters or API key are missing and 500 on MiniMax status codes or HTTP errors', async () => {
            expect((await app.postJson('/api/minimax/generate-voice', { text: 'Hi' })).status).toBe(400);
            app.clearSecrets();
            expect((await app.postJson('/api/minimax/generate-voice', { text: 'Hi', voiceId: 'v1' })).status).toBe(400);

            app.seedSecrets(ALL_SPEECH_SECRETS);
            fakeServer.enqueue(jsonReply({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }));
            const authCodeRes = await app.postJson('/api/minimax/generate-voice', { text: 'Hi', voiceId: 'v1' });
            expect(authCodeRes.status).toBe(500);
            expect(authCodeRes.json.error).toContain('Authentication failed');

            for (const [, errorReply] of STANDARD_UPSTREAM_ERRORS) {
                fakeServer.reset();
                fakeServer.enqueue(errorReply);
                const errRes = await app.postJson('/api/minimax/generate-voice', { text: 'Hi', voiceId: 'v1' });
                expect(errRes.status).toBe(500);
                expect(errRes.json).toHaveProperty('error');
            }
        });
    });

    describe('Volcengine TTS (/api/volcengine/generate-voice)', () => {
        test('concatenates base64 audio chunks from NDJSON stream and sends expected headers', async () => {
            const chunk1 = Buffer.from('chunk-one-');
            const chunk2 = Buffer.from('chunk-two');
            fakeServer.enqueue(streamChunksReply([
                `${JSON.stringify({ code: 0, data: chunk1.toString('base64') })}\n`,
                `${JSON.stringify({ code: 0, data: chunk2.toString('base64') })}\n`,
                `${JSON.stringify({ code: 20000000 })}\n`,
            ], 'application/x-ndjson'));

            const res = await app.postJson('/api/volcengine/generate-voice', {
                resource_id: 'volc.service_type.10029',
                text: 'Speak Volcengine',
                voice_speaker: 'zh_female_shuangkuaisisi',
                speed: '10',
            });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('audio/mpeg');
            expect(res.buffer.equals(Buffer.concat([chunk1, chunk2]))).toBe(true);
            const [req] = fakeServer.requests;
            expect(req.originalUrl).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
            expect(req.headers['x-api-app-id']).toBe('test-volc-app-id');
            expect(req.headers['x-api-access-key']).toBe('test-volc-access-key');
            expect(req.headers['x-api-resource-id']).toBe('volc.service_type.10029');
            expect(req.json.req_params).toMatchObject({
                text: 'Speak Volcengine',
                speaker: 'zh_female_shuangkuaisisi',
                audio_params: { format: 'mp3', speech_rate: 10 },
            });
        });

        test('returns 403 without credentials, 400 without params, and 500 on stream error code or HTTP error with X-Tt-Logid', async () => {
            expect((await app.postJson('/api/volcengine/generate-voice', { text: 'Hi' })).status).toBe(400);
            app.clearSecrets();
            expect((await app.postJson('/api/volcengine/generate-voice', { resource_id: 'r', text: 'Hi', voice_speaker: 's' })).status).toBe(403);

            app.seedSecrets(ALL_SPEECH_SECRETS);
            fakeServer.enqueue(
                streamChunksReply([`${JSON.stringify({ code: 3001, message: 'bad speaker' })}\n`]),
                { status: 429, headers: { 'Content-Type': 'application/json', 'X-Tt-Logid': 'log-987' }, body: '{"error":"rate"}' },
            );

            const streamErr = await app.postJson('/api/volcengine/generate-voice', { resource_id: 'r', text: 'Hi', voice_speaker: 's' });
            expect(streamErr.status).toBe(500);

            const httpErr = await app.postJson('/api/volcengine/generate-voice', { resource_id: 'r', text: 'Hi', voice_speaker: 's' });
            expect(httpErr.status).toBe(500);
            expect(httpErr.headers.get('x-tt-logid')).toBe('log-987');
        });
    });

    describe('NovelAI TTS (/api/novelai/generate-voice)', () => {
        test('requests GET /ai/generate-voice with query params and returns audio/mpeg', async () => {
            fakeServer.enqueue(binaryReply(SAMPLE_AUDIO_BUFFER, 'audio/mpeg'));

            const res = await app.postJson('/api/novelai/generate-voice', {
                text: 'Hello NovelAI!',
                voice: 'Aini',
            });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('audio/mpeg');
            expect(res.buffer.equals(SAMPLE_AUDIO_BUFFER)).toBe(true);
            const [req] = fakeServer.requests;
            expect(req.method).toBe('GET');
            expect(req.originalHost).toBe('api.novelai.net');
            expect(req.pathname).toBe('/ai/generate-voice');
            expect(req.query).toEqual({
                text: 'Hello NovelAI!',
                voice: '-1',
                seed: 'Aini',
                opus: 'false',
                version: 'v2',
            });
            expect(req.headers.authorization).toBe('Bearer test-novelai-key');
        });

        test('returns 400 when token, text, or voice is missing and 500 on upstream errors', async () => {
            expect((await app.postJson('/api/novelai/generate-voice', { text: 'Hi' })).status).toBe(400);
            app.clearSecrets();
            expect((await app.postJson('/api/novelai/generate-voice', { text: 'Hi', voice: 'Aini' })).status).toBe(400);
            expect(fakeServer.requests).toHaveLength(0);

            app.seedSecrets(ALL_SPEECH_SECRETS);
            for (const [, errorReply] of STANDARD_UPSTREAM_ERRORS) {
                fakeServer.reset();
                fakeServer.enqueue(errorReply);
                expect((await app.postJson('/api/novelai/generate-voice', { text: 'Hi', voice: 'Aini' })).status).toBe(500);
            }
        });
    });
});
