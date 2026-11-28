/** @jest-environment jsdom */
/* global globalThis */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { getExtensionCapability } from '../public/scripts/sillybunny-conversation/extension-capabilities.js';
import { MAX_IMAGE_BYTES } from '../public/scripts/extensions/quick-image-gen/lib/security.js';
import { loadSdModule } from './util/sd-module-harness.js';
import { createStreamResponse, loadQigModule } from './util/qig-module-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));
const capabilityRegistryKey = Symbol.for('sillybunny.extensionCapabilities');

let activeSdHarness = null;
let activeQigHarness = null;

async function drainAsync(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

function preparedReferenceImage() {
    const png = Buffer.alloc(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(1472, 16);
    png.writeUInt32BE(1472, 20);
    return png.toString('base64');
}

function tinyValidPngBytes() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    );
}

function installCapabilityRegistry(entries) {
    Object.defineProperty(globalThis, capabilityRegistryKey, {
        configurable: true,
        value: new Map(entries),
    });
}

async function importConversationMedia({ characters, currentAvatar, state, render, settings = {} } = {}) {
    jest.resetModules();
    await jest.unstable_mockModule(pub('script.js'), () => ({
        characters,
        default_user_avatar: 'user.png',
        getThumbnailUrl: jest.fn((_type, avatar) => avatar),
    }));
    await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({ extension_settings: settings, modules: [] }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/constants.js'), () => ({
        DEFAULT_SETTINGS: { image_gen_prompt_template: '{{char}} in {{scene}}: {{appearance}}' },
        MAX_STACKED_PARTICIPANT_AVATARS: 4,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
        getActiveConversationChat: jest.fn(() => null),
        getConversationGroupById: jest.fn(() => null),
        getConversationGroupIdForAvatar: jest.fn(() => null),
        getConversationPersonaId: jest.fn(() => 'persona-a'),
        getConversationRecord: jest.fn(() => null),
        getCharacterForAvatar: jest.fn((avatar = currentAvatar) => characters.find(character => character.avatar === avatar) || null),
        getCurrentCharAvatar: jest.fn(() => currentAvatar),
        getCurrentCharName: jest.fn(() => characters.find(character => character.avatar === currentAvatar)?.name || 'Character'),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/members.js'), () => ({
        parseAvatarList: jest.fn(() => []),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/shared-helpers.js'), () => ({
        formatPromptText: jest.fn(value => String(value)),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/render-scheduler.js'), () => ({
        scheduleTimelineRender: render,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/schedule.js'), () => ({
        getCharacterStatus: jest.fn(() => ({ status: 'online', activity: null, source: 'manual' })),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/settings-store.js'), () => ({
        getSettings: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/state.js'), () => ({
        conversationState: state,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store.js'), () => ({
        getConversationMessages: jest.fn(() => []),
    }));
    return import(pub('scripts/sillybunny-conversation/media.js'));
}

afterEach(() => {
    activeQigHarness?.cleanup();
    activeQigHarness = null;
    activeSdHarness?.cleanup();
    activeSdHarness = null;
    delete globalThis[capabilityRegistryKey];
    delete globalThis.toastr;
    jest.restoreAllMocks();
});

describe('Conversation extension media integration', () => {
    test('routes a configured NovelAI selfie through Image Generation, not QIG', async () => {
        const settings = { sd: { source: 'novel', model: 'nai-diffusion-4-5-full' } };
        const qig = { ensureReady: jest.fn(), generateScopedImage: jest.fn(async () => ({ url: 'pollinations.png' })) };
        const sd = { generateScopedImage: jest.fn(async () => ({ url: 'novelai.png' })) };
        installCapabilityRegistry([['quick-image-gen', qig], ['stable-diffusion', sd]]);
        const media = await importConversationMedia({
            characters: [{ name: 'Conversation', avatar: 'conversation.png' }],
            currentAvatar: 'roleplay.png',
            state: {},
            render: jest.fn(),
            settings,
        });

        await expect(media.generateConversationImage('selfie', '', { avatar: 'conversation.png' })).resolves.toBe('novelai.png');
        expect(qig.generateScopedImage).not.toHaveBeenCalled();

        sd.generateScopedImage.mockRejectedValue(new Error('NovelAI unavailable'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(media.generateConversationImage('selfie', '', { avatar: 'conversation.png' })).resolves.toBeNull();
        expect(qig.generateScopedImage).not.toHaveBeenCalled();

        installCapabilityRegistry([['quick-image-gen', qig]]);
        await expect(media.generateConversationImage('selfie', '', { avatar: 'conversation.png' })).resolves.toBeNull();
        expect(qig.generateScopedImage).not.toHaveBeenCalled();
    });

    test('uses NovelAI settings and the Conversation speaker without writing to the roleplay chat', async () => {
        const requests = [];
        let failRequest = false;
        let abortRequest = null;

        const save = jest.fn(async () => 'conversation-selfie.png');
        activeSdHarness = await loadSdModule({
            characters: [
                { name: 'Roleplay', avatar: 'roleplay.png' },
                { name: 'Conversation', avatar: 'conversation.png' },
            ],
            this_chid: 0,
            chatId: 'roleplay-chat',
            secretState: { api_key_novel: true },
            saveBase64AsFile: save,
            sdSettings: {
                source: 'novel',
                model: 'nai-diffusion-4-5-full',
                sampler: 'k_euler',
                scheduler: 'karras',
                steps: 23,
                scale: 6,
                width: 832,
                height: 1216,
                seed: 42,
                novel_anlas_guard: false,
                prompt_prefix: 'photo of {{char}}',
                negative_prompt: 'blur',
                character_prompts: { conversation: 'blue eyes', roleplay: 'wrong character' },
                character_negative_prompts: { conversation: 'hat' },
                novel_precise_reference: { enabled: false, references: [] },
            },
            fetch: async (url, options) => {
                if (String(url) === '/api/novelai/generate-image') {
                    requests.push({ url: String(url), body: JSON.parse(options.body) });
                    activeSdHarness.state.chatId = 'another-roleplay-chat';
                    abortRequest?.abort();
                    return {
                        ok: !failRequest,
                        text: async () => (failRequest ? 'Provider unavailable' : 'image-data'),
                    };
                }
                return { ok: true, json: async () => [], text: async () => '' };
            },
        });
        await activeSdHarness.sdModule.init();

        const sdCapability = getExtensionCapability('stable-diffusion');
        const qig = { generateScopedImage: jest.fn() };
        installCapabilityRegistry([['stable-diffusion', sdCapability], ['quick-image-gen', qig]]);
        const state = {};
        const media = await importConversationMedia({
            characters: [{ name: 'Conversation', avatar: 'conversation.png' }],
            currentAvatar: 'roleplay.png',
            state,
            render: jest.fn(),
            settings: activeSdHarness.extension_settings,
        });
        const generate = () => media.generateConversationImage('selfie at a desk', 'watermark', { avatar: 'conversation.png' });

        await expect(generate()).resolves.toBe('conversation-selfie.png');
        expect(requests).toEqual([{
            url: '/api/novelai/generate-image',
            body: expect.objectContaining({
                model: 'nai-diffusion-4-5-full',
                sampler: 'k_euler',
                scheduler: 'karras',
                steps: 23,
                scale: 6,
                width: 832,
                height: 1216,
                seed: 42,
                prompt: 'photo of Conversation, blue eyes, selfie at a desk',
                negative_prompt: 'watermark, blur, hat',
                precise_reference: [],
            }),
        }]);
        expect(save).toHaveBeenCalledWith('image-data', 'Conversation', 'Conversation_timestamp', 'png');
        expect(activeSdHarness.appendMediaToMessage).not.toHaveBeenCalled();

        save.mockClear();
        failRequest = true;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(generate()).resolves.toBeNull();
        expect(save).not.toHaveBeenCalled();

        failRequest = false;
        abortRequest = { abort: () => state.imageGenerationAbortController.abort() };
        await expect(generate()).resolves.toBeNull();
        expect(save).not.toHaveBeenCalled();

        activeSdHarness.secret_state[activeSdHarness.SECRET_KEYS.NOVEL] = false;
        await expect(generate()).resolves.toBeNull();
        expect(requests).toHaveLength(3);
        expect(qig.generateScopedImage).not.toHaveBeenCalled();
    });

    test('Image Generation sends no Precise References for a missing or malformed saved state', async () => {
        const requests = [];
        activeSdHarness = await loadSdModule({
            secretState: { api_key_novel: true },
            sdSettings: {
                source: 'novel',
                model: 'nai-diffusion-4-5-full',
                steps: 23,
                width: 832,
                height: 1216,
                novel_anlas_guard: false,
                prompt_prefix: '',
                negative_prompt: '',
            },
            fetch: async (url, options) => {
                if (String(url) === '/api/novelai/generate-image') {
                    requests.push(JSON.parse(options.body));
                    return { ok: true, text: async () => 'image-data' };
                }
                return { ok: true, json: async () => [], text: async () => '' };
            },
        });
        await activeSdHarness.sdModule.init();
        const sdCapability = getExtensionCapability('stable-diffusion');

        for (const state of [undefined, null, { enabled: true, references: {} }]) {
            activeSdHarness.extension_settings.sd.novel_precise_reference = state;
            await expect(sdCapability.generateScopedImage('prompt', 'negative', { character: { name: 'Seraphina' } }))
                .resolves.toEqual({ url: '/user/images/Seraphina/Seraphina_timestamp.png' });
        }
        expect(requests.map(body => body.precise_reference)).toEqual([[], [], []]);
    });

    test('Image Generation resolves user-file Precise References to base64 before calling the server route', async () => {
        const pngBytes = Buffer.from(preparedReferenceImage(), 'base64');
        const refPath = '/user/files/sb-nai-ref-0123456789abcdef.png';
        const requests = [];
        const fileFetchCalls = [];

        activeSdHarness = await loadSdModule({
            secretState: { api_key_novel: true },
            sdSettings: {
                source: 'novel',
                model: 'nai-diffusion-4-5-full',
                steps: 23,
                width: 832,
                height: 1216,
                novel_anlas_guard: false,
                prompt_prefix: '',
                negative_prompt: '',
                novel_precise_reference: {
                    enabled: true,
                    references: [{ path: refPath, bytes: pngBytes.byteLength, type: 'style', strength: 0.7, fidelity: 0.4 }],
                },
            },
            fetch: async (url, options) => {
                if (String(url) === refPath) {
                    fileFetchCalls.push([String(url), options]);
                    return { ok: true, arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength) };
                }
                if (String(url) === '/api/novelai/generate-image') {
                    requests.push(JSON.parse(options.body));
                    return { ok: true, text: async () => 'image-data' };
                }
                return { ok: true, json: async () => [], text: async () => '' };
            },
        });
        await activeSdHarness.sdModule.init();
        const sdCapability = getExtensionCapability('stable-diffusion');

        await expect(sdCapability.generateScopedImage('prompt', 'negative', { character: { name: 'Seraphina' } }))
            .resolves.toEqual({ url: '/user/images/Seraphina/Seraphina_timestamp.png' });
        expect(fileFetchCalls).toEqual([[refPath, { credentials: 'same-origin' }]]);
        expect(requests[0].precise_reference).toEqual([{ image: preparedReferenceImage(), type: 'style', strength: 0.7, fidelity: 0.4 }]);

        // A blocked Anlas guard rejects without fetching user files or hitting the server route.
        fileFetchCalls.length = 0;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        activeSdHarness.extension_settings.sd.novel_anlas_guard = true;
        await expect(sdCapability.generateScopedImage('prompt', 'negative', { character: { name: 'Seraphina' } }))
            .resolves.toBeNull();
        expect(fileFetchCalls).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(activeSdHarness.toastr.error).toHaveBeenCalledWith(
            expect.stringContaining('costs additional Anlas'),
            expect.anything(),
        );
    });

    test('uses the activated QIG capability with the explicit Conversation speaker only', async () => {
        const characters = [
            { name: 'Roleplay', avatar: 'roleplay.png', description: 'roleplay description' },
            { name: 'Conversation', avatar: 'conversation.png', description: 'conversation description' },
        ];
        const state = { imageGenerationActive: false, imageGenerationAbortController: null };
        const qig = {
            ensureReady: jest.fn(async () => {}),
            generateScopedImage: jest.fn(async () => ({ url: 'generated.png' })),
        };
        installCapabilityRegistry([['quick-image-gen', qig]]);
        const media = await importConversationMedia({
            characters,
            currentAvatar: 'roleplay.png',
            state,
            render: jest.fn(),
            settings: { sd: { source: 'extras' } },
        });

        const prompt = media.buildCharacterImagePrompt('{{char}} selfie', 'outside', 'conversation.png');
        await expect(media.generateConversationImage(prompt, '', { avatar: 'conversation.png' })).resolves.toBe('generated.png');

        expect(qig.generateScopedImage).toHaveBeenCalledWith(prompt, '', expect.objectContaining({
            avatar: 'conversation.png',
            character: characters[1],
            signal: expect.any(AbortSignal),
        }));
        expect(state).toEqual({ imageGenerationActive: false, imageGenerationAbortController: null });

        // No prompt-keyed side channel: without explicit options the request is refused
        // instead of falling back to the current roleplay character.
        await expect(media.generateConversationImage(prompt)).resolves.toBeNull();
        expect(qig.generateScopedImage).toHaveBeenCalledTimes(1);
    });

    test('returns cleanly when QIG is disabled and has no registered capability', async () => {
        const state = { imageGenerationActive: false, imageGenerationAbortController: null };
        globalThis.toastr = { warning: jest.fn() };
        const media = await importConversationMedia({
            characters: [{ name: 'Conversation', avatar: 'conversation.png' }],
            currentAvatar: 'conversation.png',
            state,
            render: jest.fn(),
        });

        await expect(media.generateConversationImage('portrait', '', { avatar: 'conversation.png', notify: true })).resolves.toBeNull();
        expect(state.imageGenerationActive).toBe(false);
        expect(state.imageGenerationAbortController).toBeNull();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    test('an aborted old run cannot clear a newer run controller or log a failure', async () => {
        let releaseOldReadiness;
        let releaseNewGeneration;
        const oldReadiness = new Promise(resolve => { releaseOldReadiness = resolve; });
        const newGeneration = new Promise(resolve => { releaseNewGeneration = resolve; });
        const qig = {
            ensureReady: jest.fn()
                .mockImplementationOnce(() => oldReadiness)
                .mockResolvedValue(undefined),
            generateScopedImage: jest.fn(() => newGeneration),
        };
        installCapabilityRegistry([['quick-image-gen', qig]]);
        const state = { imageGenerationActive: false, imageGenerationAbortController: null };
        const media = await importConversationMedia({
            characters: [{ name: 'Conversation', avatar: 'conversation.png' }],
            currentAvatar: 'conversation.png',
            state,
            render: jest.fn(),
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        globalThis.toastr = { warning: jest.fn() };

        const oldRun = media.generateConversationImage('old', '', { avatar: 'conversation.png', notify: true });
        const oldController = state.imageGenerationAbortController;
        oldController.abort();
        state.imageGenerationActive = false;
        state.imageGenerationAbortController = null;

        const newRun = media.generateConversationImage('new', '', { avatar: 'conversation.png' });
        const newController = state.imageGenerationAbortController;
        releaseOldReadiness();
        await oldRun;

        expect(state.imageGenerationActive).toBe(true);
        expect(state.imageGenerationAbortController).toBe(newController);
        expect(warn).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();

        releaseNewGeneration({ url: 'new.png' });
        await expect(newRun).resolves.toBe('new.png');
        expect(state.imageGenerationActive).toBe(false);
        expect(state.imageGenerationAbortController).toBeNull();
    });

    test('scoped character settings and generation stay isolated from roleplay globals and private references', async () => {
        const roleplay = { name: 'Roleplay', avatar: 'roleplay.png', data: { extensions: {} } };
        const target = {
            name: 'Target',
            avatar: 'target.png',
            data: { extensions: { sd_character_prompt: { positive: 'target tags' } } },
        };
        const requests = [];
        const pngB64 = tinyValidPngBytes().toString('base64');

        const roleplayRef = `data:image/png;base64,${tinyValidPngBytes().toString('base64')}`;
        const targetRef = `data:image/png;base64,${preparedReferenceImage()}`;

        activeQigHarness = await loadQigModule({
            characters: [roleplay, target],
            characterId: 0,
            groupId: 'roleplay-group',
            groups: [{ id: 'roleplay-group' }],
            chat: [{ mes: 'roleplay history' }],
            chatId: 'roleplay-chat',
            name1: 'Traveler',
            name2: 'Roleplay',
            persona: 'persona text',
            extensionSettings: {
                sd: {
                    character_prompts: { target: 'target tags' },
                    character_prompt_share: true,
                },
            },
            qigSettings: {
                provider: 'proxy',
                localType: 'a1111',
                localUrl: 'http://127.0.0.1:7860',
                saveToServer: true,
                style: 'global-style',
                width: 512,
                height: 512,
                proxyRefImages: [],
                _charSettingsBaseState: {
                    style: 'global-style',
                    width: 512,
                    height: 512,
                    proxyRefImages: [],
                },
                useSTStyle: true,
                starterPresetsSeeded: true,
                _backupCharSettings: {
                    'roleplay.png': { style: 'roleplay-style', width: 512 },
                    'target.png': { style: 'anime', width: 768 },
                },
                _backupCharRefImages: {
                    'roleplay.png': { proxyRefImages: [roleplayRef] },
                    'target.png': { proxyRefImages: [targetRef] },
                },
            },
            fetch: async (url, options) => {
                if (options?.method === 'POST' && String(url).includes('/sdapi/v1/txt2img')) {
                    requests.push(JSON.parse(options.body));
                    return createStreamResponse({ images: [pngB64] });
                }
                return undefined;
            },
        });

        const capability = getExtensionCapability('quick-image-gen');
        const scopedSnapshot = capability.getSettingsSnapshot({ avatar: 'target.png', character: target });
        expect(scopedSnapshot).toEqual(expect.objectContaining({
            style: 'anime',
            width: 768,
            proxyRefImages: [targetRef],
        }));
        expect(activeQigHarness.qigModule.getSettings().proxyRefImages).toEqual([roleplayRef]);

        // A character without reference overrides never inherits roleplay private reference images.
        const otherTarget = { name: 'Other', avatar: 'other.png', data: { extensions: {} } };
        const withoutTargetReference = capability.getSettingsSnapshot({ avatar: 'other.png', character: otherTarget });
        expect(withoutTargetReference.proxyRefImages).toEqual([]);

        // Generating scoped image uses target's prompt, character tags, and subfolder without mutating roleplay state.
        activeQigHarness.qigModule.getSettings().provider = 'local';
        const result = await capability.generateScopedImage('portrait', '', { avatar: 'target.png', character: target });
        expect(result).toEqual(expect.objectContaining({ url: expect.stringContaining('/user/images/Target/') }));
        expect(requests).toHaveLength(1);
        expect(requests[0].prompt).toContain('target tags');
        expect(requests[0].width).toBe(768);
        expect(activeQigHarness.state).toMatchObject({
            characterId: 0,
            groupId: 'roleplay-group',
            name2: 'Roleplay',
        });
    });

    const preciseReferences = image => ({
        enabled: true,
        references: [{ image, type: 'character', strength: 1, fidelity: 1 }],
    });

    test('QIG saves global Precise References during a character override and preserves them across config load', async () => {
        activeQigHarness = await loadQigModule({
            characters: [{ name: 'Seraphina', avatar: 'Seraphina.png', data: { extensions: {} } }],
            characterId: 0,
            qigSettings: {
                provider: 'novelai',
                prompt: 'global prompt',
                naiModel: 'nai-diffusion-4-5-full',
                naiPreciseReference: preciseReferences('GLOBAL'),
                _charSettingsBaseState: {
                    prompt: 'global prompt',
                    naiPreciseReference: preciseReferences('GLOBAL'),
                },
                starterPresetsSeeded: true,
                _backupCharSettings: {
                    'Seraphina.png': { prompt: 'character prompt' },
                },
                _backupCharRefImages: {
                    'Seraphina.png': { naiPreciseReference: preciseReferences('CHARACTER') },
                },
                _backupConfigurations: [
                    { id: 'pollinations', name: 'Pollinations', provider: 'pollinations', pollinationsModel: 'turbo' },
                ],
            },
        });

        // Active character override replaced the live settings with the character copy.
        expect(activeQigHarness.qigModule.getSettings().naiPreciseReference).toEqual(preciseReferences('CHARACTER'));

        // Saving a configuration captures the global base Precise References, not the character override.
        activeQigHarness.callGenericPopup.mockResolvedValueOnce('Global Snapshot');
        document.getElementById('qig-config-save').click();
        await drainAsync();

        const saved = activeQigHarness.extension_settings['quick-image-gen']._backupConfigurations
            .find(entry => entry.name === 'Global Snapshot');
        expect(saved).toMatchObject({
            prompt: 'global prompt',
            naiPreciseReference: preciseReferences('GLOBAL'),
        });

        // Loading a different provider configuration keeps the global Precise References as the persisted base.
        const select = document.getElementById('qig-config-select');
        select.value = 'pollinations';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await drainAsync();

        expect(activeQigHarness.qigModule.getSettings()._charSettingsBaseState.naiPreciseReference)
            .toEqual(preciseReferences('GLOBAL'));
    });

    test('QIG configurations take the live Precise References outside a character override', async () => {
        activeQigHarness = await loadQigModule({
            characters: [{ name: 'Seraphina', avatar: 'Seraphina.png', data: { extensions: {} } }],
            characterId: 0,
            qigSettings: {
                provider: 'novelai',
                naiModel: 'nai-diffusion-4-5-full',
                naiPreciseReference: preciseReferences('EDITED'),
                _charSettingsBaseState: { naiPreciseReference: preciseReferences('SAVED_BEFORE_EDIT') },
                starterPresetsSeeded: true,
                _backupCharSettings: {},
                _backupCharRefImages: {},
            },
        });

        activeQigHarness.callGenericPopup.mockResolvedValueOnce('Live Snapshot');
        document.getElementById('qig-config-save').click();
        await drainAsync();

        const saved = activeQigHarness.extension_settings['quick-image-gen']._backupConfigurations
            .find(entry => entry.name === 'Live Snapshot');
        expect(saved.naiPreciseReference).toEqual(preciseReferences('EDITED'));
    });

    test('QIG sends Precise References to official NovelAI API and native proxy, and rejects unsupported targets', async () => {
        const requests = [];
        const refImage = preparedReferenceImage();
        activeQigHarness = await loadQigModule({
            qigSettings: {
                provider: 'novelai',
                naiModel: 'nai-diffusion-4-5-full',
                naiKey: 'key',
                naiProxyUrl: '',
                sampler: 'euler_a',
                seed: 7,
                width: 832,
                height: 1216,
                steps: 23,
                cfgScale: 5,
                starterPresetsSeeded: true,
                naiPreciseReference: {
                    enabled: true,
                    references: [{ image: refImage, type: 'style', strength: 0.6, fidelity: 0.25 }],
                },
            },
            fetch: async (url, options) => {
                if (String(url).includes('novelai')) {
                    requests.push({ url: String(url), body: JSON.parse(options.body) });
                    throw new Error('request captured');
                }
                return undefined;
            },
        });

        const capability = getExtensionCapability('quick-image-gen');
        for (const naiProxyUrl of ['', 'https://proxy.example/novelai']) {
            activeQigHarness.qigModule.getSettings().naiProxyUrl = naiProxyUrl;
            await expect(capability.generateImage('prompt', 'negative')).rejects.toThrow('request captured');
        }
        expect(requests.map(request => request.url)).toEqual([
            'https://image.novelai.net/ai/generate-image',
            'https://proxy.example/novelai/generate',
        ]);
        for (const { body } of requests) {
            expect(body.parameters).toMatchObject({
                director_reference_images: [refImage],
                director_reference_descriptions: [{ caption: { base_caption: 'style', char_captions: [] }, legacy_uc: false }],
                director_reference_strength_values: [0.6],
                director_reference_secondary_strength_values: [0.75],
            });
        }

        // Unsupported model and OpenAI-compatible proxy reject before any provider request.
        requests.length = 0;
        activeQigHarness.qigModule.getSettings().naiProxyUrl = '';
        activeQigHarness.qigModule.getSettings().naiModel = 'nai-diffusion-4-full';
        await expect(capability.generateImage('prompt', 'negative')).rejects.toThrow('requires NovelAI V4.5');

        activeQigHarness.qigModule.getSettings().naiModel = 'nai-diffusion-4-5-full';
        activeQigHarness.qigModule.getSettings().naiProxyUrl = 'https://proxy.example/v1';
        await expect(capability.generateImage('prompt', 'negative')).rejects.toThrow('OpenAI-compatible proxies are not supported');
        expect(requests).toEqual([]);

        // Disabled Precise References omit director fields even for earlier models.
        activeQigHarness.qigModule.getSettings().naiProxyUrl = '';
        activeQigHarness.qigModule.getSettings().naiModel = 'nai-diffusion-3';
        activeQigHarness.qigModule.getSettings().naiPreciseReference.enabled = false;
        await expect(capability.generateImage('prompt', 'negative')).rejects.toThrow('request captured');
        expect(requests).toHaveLength(1);
        expect(requests[0].body.parameters).not.toHaveProperty('director_reference_images');
    });

    test('QIG resolves user-file Precise References and refuses invalid paths before any provider request', async () => {
        const pngBytes = Buffer.from(preparedReferenceImage(), 'base64');
        const refPath = '/user/files/sb-nai-ref-fedcba9876543210.png';
        const requests = [];
        const fileFetchCalls = [];

        activeQigHarness = await loadQigModule({
            qigSettings: {
                provider: 'novelai',
                naiModel: 'nai-diffusion-4-5-full',
                naiKey: 'key',
                naiProxyUrl: '',
                sampler: 'euler_a',
                seed: 7,
                width: 832,
                height: 1216,
                steps: 23,
                cfgScale: 5,
                starterPresetsSeeded: true,
                naiPreciseReference: {
                    enabled: true,
                    references: [{ path: refPath, bytes: pngBytes.byteLength, type: 'character&style', strength: 0.8, fidelity: 0.25 }],
                },
            },
            fetch: async (url, options) => {
                if (String(url) === refPath) {
                    fileFetchCalls.push([String(url), options]);
                    return createStreamResponse(new Uint8Array(pngBytes), { contentType: 'image/png' });
                }
                if (String(url).includes('novelai')) {
                    requests.push({ url: String(url), body: JSON.parse(options.body) });
                    throw new Error('request captured');
                }
                return undefined;
            },
        });

        const capability = getExtensionCapability('quick-image-gen');
        await expect(capability.generateImage('prompt', 'negative')).rejects.toThrow('request captured');
        expect(fileFetchCalls).toEqual([[refPath, { credentials: 'same-origin' }]]);
        expect(requests[0].body.parameters).toMatchObject({
            director_reference_images: [preparedReferenceImage()],
            director_reference_descriptions: [{ caption: { base_caption: 'character&style', char_captions: [] }, legacy_uc: false }],
            director_reference_strength_values: [0.8],
            director_reference_secondary_strength_values: [0.75],
        });

        fileFetchCalls.length = 0;
        activeQigHarness.qigModule.getSettings().naiPreciseReference = {
            enabled: true,
            references: [{ path: '/etc/passwd', type: 'character', strength: 1, fidelity: 1 }],
        };
        await expect(capability.generateImage('prompt', 'negative')).rejects.toThrow('path is invalid');
        expect(fileFetchCalls).toEqual([]);
    });

    test('QIG keeps a removed Precise Reference user file while any config or character override references it', async () => {
        const pathA = '/user/files/sb-nai-ref-1111111111111111.png';
        const pathB = '/user/files/sb-nai-ref-2222222222222222.png';
        const unusedPath = '/user/files/sb-nai-ref-3333333333333333.png';
        const stateWith = path => ({ enabled: true, references: [{ path, type: 'character', strength: 1, fidelity: 1 }] });

        activeQigHarness = await loadQigModule({
            qigSettings: {
                provider: 'novelai',
                naiModel: 'nai-diffusion-4-5-full',
                naiPreciseReference: { enabled: true, references: [] },
                starterPresetsSeeded: true,
                _backupConfigurations: [{ id: 'cfg-1', name: 'Cfg 1', provider: 'novelai', naiPreciseReference: stateWith(pathA) }],
                _backupCharRefImages: { 'other.png': { naiPreciseReference: stateWith(pathB) } },
            },
        });

        const editor = activeQigHarness.mountedPreciseRefEditors.at(-1);
        expect(editor).toBeDefined();

        await editor.options.onRemoveFile(pathA);
        await editor.options.onRemoveFile(pathB);
        expect(activeQigHarness.deleteNovelAIPreciseReferenceFile).not.toHaveBeenCalled();

        await editor.options.onRemoveFile(unusedPath);
        expect(activeQigHarness.deleteNovelAIPreciseReferenceFile).toHaveBeenCalledWith(
            unusedPath,
            expect.objectContaining({ getRequestHeaders: expect.any(Function) }),
        );
    });

    test('QIG readiness follows complete initialization and propagates failure', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        activeQigHarness = await loadQigModule({
            deferReady: true,
            failExtensionsImport: 'initialization failed',
        });

        let settled = false;
        const readiness = activeQigHarness.qigModule.ensureQuickImageGenReady(0).finally(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        activeQigHarness.runReady();
        await expect(readiness).rejects.toThrow('initialization failed');
    });

    test('scoped run snapshots preserve queued review revisions and transient overrides without mutating live settings', async () => {
        activeQigHarness = await loadQigModule({
            qigSettings: {
                provider: 'pollinations',
                reviewBeforeGenerate: true,
                style: 'global',
                starterPresetsSeeded: true,
                _backupContextualFilters: [
                    { id: 'f1', name: 'scoped filter', enabled: true, matchMode: 'keyword', keywords: ['dragon'], promptAdditions: 'scales' },
                ],
            },
        });

        const queued = activeQigHarness.qigModule.getGenerationSettingsForRun();
        expect(queued).toMatchObject({
            style: 'global',
            reviewBeforeGenerate: true,
        });
        expect(Array.isArray(queued.__qigActiveContextualFilters)).toBe(true);

        // Transient settings override applies only within the scoped task callback.
        const customSnapshot = { ...queued, style: 'transient-style' };
        let insideSnapshot = null;
        await activeQigHarness.qigModule.withTransientGenerationSettings(customSnapshot, async () => {
            insideSnapshot = activeQigHarness.qigModule.getGenerationSettingsForRun();
        });
        expect(insideSnapshot.style).toBe('transient-style');
        expect(activeQigHarness.qigModule.getSettings().style).toBe('global');
    });

    test('Text AI override preserves the explicit scoped context, profile ID, and signal during contextual LLM filtering', async () => {
        const sendRequest = jest.fn(async () => ({ content: '1' }));
        const pngB64 = tinyValidPngBytes().toString('base64');
        const target = { name: 'Target', avatar: 'target.png', data: { extensions: {} } };

        activeQigHarness = await loadQigModule({
            characters: [{ name: 'Roleplay', avatar: 'roleplay.png', data: { extensions: {} } }, target],
            characterId: 0,
            chat: [{ mes: 'roleplay message should stay isolated' }],
            ConnectionManagerRequestService: { sendRequest },
            qigSettings: {
                provider: 'local',
                localType: 'a1111',
                localUrl: 'http://127.0.0.1:7860',
                llmOverrideEnabled: true,
                llmOverrideProfileId: 'scoped-profile',
                llmOverrideMaxTokens: 100,
                llmRequestRole: 'system',
                starterPresetsSeeded: true,
                _backupContextualFilters: [
                    {
                        id: 'llm-filter',
                        name: 'Mood Filter',
                        enabled: true,
                        matchMode: 'LLM',
                        description: 'It is raining outside',
                        tags: 'raindrops',
                    },
                ],
            },
            fetch: async (url) => {
                if (String(url).includes('/sdapi/v1/txt2img')) {
                    return createStreamResponse({ images: [pngB64] });
                }
                return undefined;
            },
        });

        const capability = getExtensionCapability('quick-image-gen');
        await capability.generateScopedImage('standing outside', '', { avatar: 'target.png', character: target });

        expect(sendRequest).toHaveBeenCalled();
        const [profileId, messages] = sendRequest.mock.calls[0];
        expect(profileId).toBe('scoped-profile');
        expect(JSON.stringify(messages)).not.toContain('roleplay message should stay isolated');
    });

    test('multi-result finalization handles {images} payloads, picks the first success, and releases extras', async () => {
        const pngBytes = tinyValidPngBytes();
        let saveAttempt = 0;
        activeQigHarness = await loadQigModule({
            saveBase64AsFile: jest.fn(async (_b64, subfolder, name, ext) => {
                saveAttempt += 1;
                return `/user/images/${subfolder}/${name}_${saveAttempt}.${ext}`;
            }),
            qigSettings: {
                provider: 'local',
                localType: 'comfyui',
                localUrl: 'http://127.0.0.1:8188',
                comfyModel: 'checkpoint.safetensors',
                saveToServer: true,
                starterPresetsSeeded: true,
            },
            fetch: async (url, options) => {
                const targetUrl = String(url);
                if (options?.method === 'POST' && targetUrl.endsWith('/prompt')) {
                    return createStreamResponse({ prompt_id: 'multi-1' });
                }
                if (targetUrl.includes('/history/multi-1')) {
                    return createStreamResponse({
                        'multi-1': {
                            status: { completed: true, status_str: 'success' },
                            outputs: {
                                9: {
                                    images: [
                                        { filename: 'broken.png', subfolder: '', type: 'output' },
                                        { filename: 'good.png', subfolder: '', type: 'output' },
                                        { filename: 'extra.png', subfolder: '', type: 'output' },
                                    ],
                                },
                            },
                        },
                    });
                }
                if (targetUrl.includes('filename=broken.png')) {
                    return createStreamResponse('missing', { status: 404, ok: false, contentType: 'text/plain' });
                }
                if (targetUrl.includes('/view?')) {
                    return createStreamResponse(pngBytes, { contentType: 'image/png' });
                }
                return createStreamResponse({});
            },
        });

        const capability = getExtensionCapability('quick-image-gen');
        const result = await capability.generateImage('portrait', '');

        expect(result).toEqual(expect.objectContaining({
            url: expect.stringMatching(/_1\.png$/),
        }));
        expect(saveAttempt).toBe(2);
    });

    test('external runs are serialized, cancellation-safe, and deduplicate Comfy prompt cancellation', async () => {
        const order = [];
        const cancelCalls = [];
        let releaseFirstHistory;
        const firstHistoryGate = new Promise(resolve => { releaseFirstHistory = resolve; });
        let promptSeq = 0;
        const pngBytes = tinyValidPngBytes();

        activeQigHarness = await loadQigModule({
            qigSettings: {
                provider: 'local',
                localType: 'comfyui',
                localUrl: 'http://127.0.0.1:8188',
                comfyModel: 'checkpoint.safetensors',
                starterPresetsSeeded: true,
            },
            fetch: async (url, options) => {
                const targetUrl = String(url);
                if (options?.method === 'POST' && targetUrl.endsWith('/prompt')) {
                    promptSeq += 1;
                    const id = `prompt-${promptSeq}`;
                    order.push(`submit:${id}`);
                    return createStreamResponse({ prompt_id: id });
                }
                if (targetUrl.includes('/history/prompt-1')) {
                    await new Promise((resolve, reject) => {
                        if (options?.signal?.aborted) {
                            reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
                            return;
                        }
                        options?.signal?.addEventListener('abort', () => {
                            reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                        firstHistoryGate.then(resolve, reject);
                    });
                    return createStreamResponse({});
                }
                if (targetUrl.includes('/history/prompt-2')) {
                    return createStreamResponse({
                        'prompt-2': {
                            status: { completed: true, status_str: 'success' },
                            outputs: {
                                9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
                            },
                        },
                    });
                }
                if (targetUrl.includes('/view?')) {
                    return createStreamResponse(pngBytes, { contentType: 'image/png' });
                }
                if (targetUrl.endsWith('/queue') && (!options?.method || options.method === 'GET')) {
                    return createStreamResponse({
                        queue_running: [],
                        queue_pending: [[0, 'prompt-1']],
                    });
                }
                if (options?.method === 'POST' && (targetUrl.includes('/interrupt') || targetUrl.includes('/queue') || targetUrl.includes('/cancel'))) {
                    cancelCalls.push({ url: targetUrl, body: options?.body });
                    return createStreamResponse({});
                }
                return createStreamResponse({});
            },
        });

        const capability = getExtensionCapability('quick-image-gen');
        const firstController = new AbortController();
        const first = capability.generateImage('first prompt', '', { signal: firstController.signal });
        // Yield until run 1 finishes its readiness check and enters the serialized external queue.
        await drainAsync(2);
        const second = capability.generateImage('second prompt', '');

        await drainAsync(4);
        expect(order).toEqual(['submit:prompt-1']);

        // Aborting run 1 cancels prompt-1 and allows queued run 2 to start and finish cleanly.
        firstController.abort(new DOMException('Cancelled', 'AbortError'));
        releaseFirstHistory();

        await expect(first).rejects.toThrow();
        await expect(second).resolves.toEqual(expect.objectContaining({ url: expect.any(String) }));
        expect(order).toEqual(['submit:prompt-1', 'submit:prompt-2']);
        expect(cancelCalls).toHaveLength(1);
    });

    test('direct provider submissions enforce active owners and output size budgets', async () => {
        activeQigHarness = await loadQigModule({
            qigSettings: {
                provider: 'local',
                localType: 'a1111',
                localUrl: 'http://127.0.0.1:7860',
                starterPresetsSeeded: true,
            },
            fetch: async (url) => {
                if (String(url).includes('/sdapi/v1/txt2img')) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers({
                            'content-type': 'application/json',
                            'content-length': String(MAX_IMAGE_BYTES * 2),
                        }),
                        body: { cancel: jest.fn(async () => {}), getReader: jest.fn() },
                    };
                }
                return undefined;
            },
        });

        // Calling generateForProvider without an active external or interactive run owner is rejected.
        const controller = new AbortController();
        await expect(activeQigHarness.qigModule.generateForProvider(
            'portrait',
            '',
            activeQigHarness.qigModule.getSettings(),
            controller.signal,
        )).rejects.toMatchObject({ name: 'AbortError' });

        // Oversized provider output is rejected by the external output budget guard.
        const capability = getExtensionCapability('quick-image-gen');
        await expect(capability.generateImage('portrait', '')).rejects.toThrow(/limit/i);
    });

    test('the sprite bridge uses only the activated QIG capability', async () => {
        jest.resetModules();
        const bridge = await import(pub('scripts/extensions/expressions/expression-sprite-bridge.js'));

        // Without an activated capability the bridge declines instead of importing QIG.
        await expect(bridge.generateExpressionSprite('joy', { characterName: 'Mona' })).resolves.toBeNull();

        const qig = {
            ensureReady: jest.fn(async () => {}),
            getSettingsSnapshot: jest.fn(() => ({ negativePrompt: 'blurry' })),
            generateImage: jest.fn(async () => ({ url: 'sprite.png' })),
        };
        installCapabilityRegistry([['quick-image-gen', qig]]);

        await expect(bridge.generateExpressionSprite('joy', { characterName: 'Mona' })).resolves.toBe('sprite.png');
        expect(qig.generateImage).toHaveBeenCalledWith(
            expect.stringContaining('Mona'),
            expect.stringContaining('blurry'),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        const sheet = await bridge.generateExpressionSpriteSheet(['joy', 'anger'], { characterName: 'Mona' });
        expect(sheet).toEqual({ imageUrl: 'sprite.png', grid: { columns: 2, rows: 1 } });

        // Stop aborts the in-flight capability signal.
        let capturedSignal = null;
        qig.generateImage.mockImplementationOnce(async (_prompt, _negative, { signal }) => {
            capturedSignal = signal;
            await new Promise(resolve => setTimeout(resolve, 5));
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return { url: 'late.png' };
        });
        const pending = bridge.generateExpressionSprite('sad', { characterName: 'Mona' });
        await Promise.resolve();
        expect(bridge.stopExpressionSpriteGeneration()).toBe(true);
        await expect(pending).rejects.toThrow('Aborted');
        expect(capturedSignal?.aborted).toBe(true);
    });

    test('no module imports the QIG entrypoint directly and lifecycle hooks register and unregister cleanly', async () => {
        // Static import-boundary and manifest contracts stay explicit text/JSON checks.
        const bridgeSource = readFileSync(pub('scripts/extensions/expressions/expression-sprite-bridge.js'), 'utf8');
        expect(bridgeSource).not.toContain('quick-image-gen/index.js');
        expect(bridgeSource).toContain('extension-capabilities.js');

        const qigManifest = JSON.parse(readFileSync(pub('scripts/extensions/quick-image-gen/manifest.json'), 'utf8'));
        expect(qigManifest.hooks?.disable).toBe('deactivate');
        const ttsManifest = JSON.parse(readFileSync(pub('scripts/extensions/tts/manifest.json'), 'utf8'));
        expect(ttsManifest.hooks?.activate).toBe('init');
        expect(ttsManifest.hooks?.disable).toBe('deactivate');

        // Behavioural verification: loading QIG registers its capability and deactivate() unregisters it.
        activeQigHarness = await loadQigModule();
        expect(getExtensionCapability('quick-image-gen')).toEqual(expect.objectContaining({
            ensureReady: expect.any(Function),
            generateImage: expect.any(Function),
            generateScopedImage: expect.any(Function),
            getSettingsSnapshot: expect.any(Function),
        }));

        activeQigHarness.qigModule[qigManifest.hooks.disable]();
        expect(getExtensionCapability('quick-image-gen')).toBeNull();
    });

    test('shared capability registry unregisters only its own registration', async () => {
        jest.resetModules();
        const registry = await import(pub('scripts/sillybunny-conversation/extension-capabilities.js'));

        const first = { id: 1 };
        const second = { id: 2 };
        const unregisterFirst = registry.registerExtensionCapability('demo', first);
        expect(registry.getExtensionCapability('demo')).toBe(first);

        registry.registerExtensionCapability('demo', second);
        // The stale unregister is a no-op once a newer registration replaced it.
        unregisterFirst();
        expect(registry.getExtensionCapability('demo')).toBe(second);
    });
});
