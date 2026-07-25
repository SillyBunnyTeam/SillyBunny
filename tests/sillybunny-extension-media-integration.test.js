/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const capabilityRegistryKey = Symbol.for('sillybunny.extensionCapabilities');
const qigSource = readFileSync(fileURLToPath(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url)), 'utf8');
const bridgeSource = readFileSync(fileURLToPath(new URL('../public/scripts/extensions/expressions/expression-sprite-bridge.js', import.meta.url)), 'utf8');

function getFunctionSource(name) {
    const asyncStart = qigSource.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : qigSource.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const paramsStart = qigSource.indexOf('(', start);
    let parenDepth = 0;
    let bodyStart = -1;
    for (let index = paramsStart; index < qigSource.length; index++) {
        if (qigSource[index] === '(') parenDepth++;
        if (qigSource[index] === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                bodyStart = qigSource.indexOf('{', index);
                break;
            }
        }
    }
    let braceDepth = 0;
    for (let index = bodyStart; index < qigSource.length; index++) {
        if (qigSource[index] === '{') braceDepth++;
        if (qigSource[index] === '}' && --braceDepth === 0) return qigSource.slice(start, index + 1);
    }
    throw new Error(`Unable to extract ${name}`);
}

function createQigContext(values = {}) {
    const context = vm.createContext({
        AbortController,
        AbortSignal,
        Array,
        Boolean,
        DOMException,
        Error,
        Map,
        Number,
        Object,
        Promise,
        Set,
        String,
        Symbol,
        WeakSet,
        clearTimeout,
        setTimeout,
        ...values,
    });
    return context;
}

function evaluateInContext(name, context) {
    const fn = vm.runInContext(`(${getFunctionSource(name)})`, context);
    context[name] = fn;
    return fn;
}

function evaluateFunction(name, values = {}) {
    return evaluateInContext(name, createQigContext(values));
}

function installCapabilityRegistry(entries) {
    Object.defineProperty(globalThis, capabilityRegistryKey, {
        configurable: true,
        value: new Map(entries),
    });
}

async function importConversationMedia({ characters, currentAvatar, state, render } = {}) {
    jest.resetModules();
    await jest.unstable_mockModule('../public/script.js', () => ({
        characters,
        default_user_avatar: 'user.png',
        getThumbnailUrl: jest.fn((_type, avatar) => avatar),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({
        DEFAULT_SETTINGS: { image_gen_prompt_template: '{{char}} in {{scene}}: {{appearance}}' },
        MAX_STACKED_PARTICIPANT_AVATARS: 4,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
        getActiveConversationBranch: jest.fn(() => null),
        getConversationGroupById: jest.fn(() => null),
        getConversationGroupIdForAvatar: jest.fn(() => null),
        getConversationPersonaId: jest.fn(() => 'persona-a'),
        getCurrentCharacter: jest.fn(() => characters.find(character => character.avatar === currentAvatar) || null),
        getCurrentCharAvatar: jest.fn(() => currentAvatar),
        getCurrentCharName: jest.fn(() => characters.find(character => character.avatar === currentAvatar)?.name || 'Character'),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/partners.js', () => ({
        parseAvatarList: jest.fn(() => []),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({
        formatPromptText: jest.fn(value => String(value)),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
        scheduleTimelineRender: render,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
        getCurrentActivityFromSchedule: jest.fn(() => ({ status: 'online' })),
        getStoredSchedule: jest.fn(() => null),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
        getSettings: jest.fn(() => ({})),
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
        conversationState: state,
    }));
    await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
        getConversationThread: jest.fn(() => []),
    }));
    return import('../public/scripts/sillybunny-conversation/media.js');
}

afterEach(() => {
    delete globalThis[capabilityRegistryKey];
    delete globalThis.toastr;
    delete globalThis.document;
    jest.restoreAllMocks();
});

describe('Conversation extension media integration', () => {
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

    test('scoped context is immutable, explicit, and never exposes roleplay chat/group globals', () => {
        const roleplay = { name: 'Roleplay', avatar: 'roleplay.png' };
        const target = { name: 'Target', avatar: 'target.png', data: { extensions: { sd_character_prompt: { positive: 'target tags' } } } };
        const baseContext = {
            characterId: 0,
            characters: [roleplay, target],
            chat: [{ mes: 'roleplay history' }],
            chatId: 'roleplay-chat',
            group: { id: 'roleplay-group' },
            groupId: 'roleplay-group',
            groups: [{ id: 'roleplay-group' }],
            name1: 'Traveler',
            name2: 'Roleplay',
            persona: 'persona text',
        };
        const context = createQigContext({
            getContext: () => baseContext,
            normalizeContextLookupValue: value => String(value || '').toLowerCase(),
            snapshotGenerationSettings: value => JSON.parse(JSON.stringify(value)),
        });
        evaluateInContext('getContextCharactersList', context);
        evaluateInContext('freezeContextSnapshot', context);
        const createContext = evaluateInContext('createScopedCharacterGenerationContext', context);

        const scopedContext = createContext({ avatar: target.avatar, character: target });
        expect(scopedContext).toMatchObject({
            characterId: '1',
            chatId: '',
            group: null,
            groupId: null,
            name1: 'Traveler',
            name2: 'Target',
            persona: 'persona text',
            __qigScopedCharacter: true,
            __qigCharacterAvatar: 'target.png',
        });
        expect(scopedContext.chat).toEqual([]);
        expect(Object.isFrozen(scopedContext)).toBe(true);
        expect(Object.isFrozen(scopedContext.characters)).toBe(true);
        expect(Object.isFrozen(scopedContext.characters['1'])).toBe(true);
        // The scoped character is a snapshot: mutating the live roleplay object later
        // cannot leak into an in-flight scoped run.
        expect(scopedContext.characters['1']).not.toBe(target);
        expect(baseContext).toMatchObject({ characterId: 0, groupId: 'roleplay-group', name2: 'Roleplay' });
    });

    test('scoped character settings use explicit target records without touching roleplay settings', () => {
        const charSettings = { target: { style: 'target-style', width: 768 } };
        const charRefImages = { target: { proxyRefImages: ['target-private.png'] } };
        const buildSettings = evaluateFunction('getScopedCharacterGenerationSettings', {
            applyCharScopedStateToGenerationSettings(settings, state) {
                if (!state) return;
                for (const key of ['style', 'width', 'height', 'proxyRefImages']) {
                    if (Object.hasOwn(state, key)) settings[key] = Array.isArray(state[key]) ? [...state[key]] : state[key];
                }
            },
            charRefImages,
            charSettings,
            charSettingsBaseState: { style: 'global-style', proxyRefImages: ['global.png'] },
            charSettingsOverrideApplied: true,
            clearCharacterReferenceSettings(settings) {
                settings.proxyRefImages = [];
                settings.customApiRefImages = [];
                settings.nanobananaRefImages = [];
                settings.nanogptRefImages = [];
                settings.localRefImage = '';
            },
            cloneCharScopedState: jest.fn(() => ({})),
            defaultSettings: {},
            getCharacterProviderReferences: (record, provider) => record?.[`${provider}RefImages`] || [],
            getScopedCharacterStoreValue: store => store.target,
            hasCharacterReferenceOverrides: record => Object.keys(record || {}).length > 0,
            normalizeCharacterReferenceRecord: record => record || {},
        });
        const roleplaySettings = {
            provider: 'proxy',
            style: 'roleplay-style',
            width: 512,
            proxyRefImages: ['roleplay-private.png'],
        };

        const scoped = buildSettings(roleplaySettings, { __qigScopedCharacter: true });
        expect(scoped).toEqual(expect.objectContaining({
            style: 'target-style',
            width: 768,
            proxyRefImages: ['target-private.png'],
        }));
        expect(roleplaySettings.proxyRefImages).toEqual(['roleplay-private.png']);

        delete charRefImages.target;
        const withoutTargetReference = buildSettings(roleplaySettings, { __qigScopedCharacter: true });
        expect(withoutTargetReference.proxyRefImages).toEqual([]);
    });

    test('QIG readiness follows complete initialization and propagates failure', async () => {
        let rejectInitialization;
        const initialization = new Promise((_resolve, reject) => { rejectInitialization = reject; });
        const ensureReady = evaluateFunction('ensureQuickImageGenReady', {
            quickImageGenInitializationPromise: initialization,
        });
        let settled = false;
        const readiness = ensureReady(0).finally(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        rejectInitialization(new Error('initialization failed'));
        await expect(readiness).rejects.toThrow('initialization failed');
    });

    test('multi-result finalization handles {images} payloads, picks the first success, and releases extras', async () => {
        const released = [];
        const context = createQigContext({
            attachResultFailures: (results, failures) => {
                results.failures = failures;
                return results;
            },
            collectSequentialResults: async (items, task) => {
                const results = [];
                const errors = [];
                for (const [index, item] of items.entries()) {
                    try {
                        const value = await task(item, index);
                        if (value != null) results.push(value);
                    } catch (error) {
                        errors.push({ index, error });
                    }
                }
                return { results, errors };
            },
            finalizeGeneratedEntry: jest.fn(async result => {
                if (result.url === 'broken.png') throw new Error('finalization failed');
                return { url: `final-${result.url}` };
            }),
            getProviderModelId: () => 'model-1',
            getResultFailures: () => [],
            normalizeProviderResult: result => (Array.isArray(result?.images)
                ? result.images.map(image => ({ url: image.url }))
                : [{ url: result.url }]),
            releaseTransientProviderResult: value => released.push(value),
        });
        evaluateInContext('finalizeGeneratedResults', context);
        const finalizeFirst = evaluateInContext('finalizeFirstExternalResult', context);

        const providerResult = { images: [{ url: 'broken.png' }, { url: 'good.png' }, { url: 'extra.png' }] };
        const options = { commitGuard: jest.fn() };
        await expect(finalizeFirst(providerResult, 'prompt', 'negative', { provider: 'proxy' }, options))
            .resolves.toEqual({ url: 'final-good.png' });
        // The unused successful sibling was released; the winner was retained.
        expect(released).toContainEqual({ url: 'final-extra.png' });
        expect(released).not.toContainEqual({ url: 'final-good.png' });
    });

    test('external runs are serialized, cancellation-safe, and cancel the matching Comfy prompt', async () => {
        const context = createQigContext({
            activeExternalGenerationRun: null,
            externalGenerationTail: Promise.resolve(),
            nextExternalGenerationRunId: 1,
            log: jest.fn(),
        });
        const cancelledPrompts = [];
        context.cancelTrackedComfyPromptOnce = jest.fn(tracked => {
            cancelledPrompts.push(tracked.promptId);
            return Promise.resolve({ cancelled: true });
        });
        evaluateInContext('getAbortError', context);
        evaluateInContext('abortExternalGenerationRun', context);
        evaluateInContext('assertExternalGenerationRun', context);
        const enqueue = evaluateInContext('enqueueExternalGeneration', context);

        const order = [];
        let releaseFirst;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        let firstRun;
        let secondRun;

        const first = enqueue(async run => {
            firstRun = run;
            order.push('first:start');
            run.comfyPrompt = { promptId: 'prompt-1' };
            await firstGate;
            if (run.signal.aborted) throw context.getAbortError(run.signal);
            return 'first';
        });
        const second = enqueue(async run => {
            secondRun = run;
            order.push('second:start');
            return 'second';
        });

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(order).toEqual(['first:start']);
        expect(context.activeExternalGenerationRun).toBe(firstRun);

        // Aborting the first run cancels its exact Comfy prompt and cannot clear
        // the second run's active state.
        context.abortExternalGenerationRun(firstRun);
        releaseFirst();
        await expect(first).rejects.toThrow();
        await expect(second).resolves.toBe('second');
        expect(order).toEqual(['first:start', 'second:start']);
        expect(cancelledPrompts).toEqual(['prompt-1']);
        expect(secondRun.id).toBeGreaterThan(firstRun.id);
        expect(context.activeExternalGenerationRun).toBeNull();

        // Late completion of the stale run cannot clear a newer active run either.
        context.activeExternalGenerationRun = { id: 99 };
        expect(() => context.assertExternalGenerationRun(firstRun)).toThrow();
        expect(context.activeExternalGenerationRun).toEqual({ id: 99 });
    });

    test('tracked Comfy prompt cancellation is deduplicated per prompt', async () => {
        const cancelTrackedComfyPrompt = jest.fn(async () => ({ cancelled: true }));
        const cancelOnce = evaluateFunction('cancelTrackedComfyPromptOnce', { cancelTrackedComfyPrompt });
        const tracked = { promptId: 'prompt-9' };

        const first = cancelOnce(tracked);
        const second = cancelOnce(tracked);
        expect(second).toBe(first);
        await first;
        expect(cancelTrackedComfyPrompt).toHaveBeenCalledTimes(1);
        await expect(cancelOnce({ promptId: '' })).resolves.toEqual(expect.objectContaining({ cancelled: false }));
    });

    test('the sprite bridge uses only the activated QIG capability', async () => {
        jest.resetModules();
        globalThis.document = { getElementById: jest.fn(() => null) };
        const bridge = await import('../public/scripts/extensions/expressions/expression-sprite-bridge.js');

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

    test('no module imports the QIG entrypoint directly and lifecycle hooks are wired', async () => {
        expect(bridgeSource).not.toContain('quick-image-gen/index.js');
        expect(bridgeSource).toContain('extension-capabilities.js');

        // Canonical capability is registered at module scope with a clean unregister on disable.
        expect(qigSource).toContain('registerExtensionCapability(extensionName, quickImageGenCapability)');
        expect(qigSource).toContain('export function deactivate()');
        expect(qigSource).toContain('unregisterQuickImageGenCapability?.();');

        const qigManifest = JSON.parse(readFileSync(fileURLToPath(new URL('../public/scripts/extensions/quick-image-gen/manifest.json', import.meta.url)), 'utf8'));
        expect(qigManifest.hooks?.disable).toBe('deactivate');
        const ttsManifest = JSON.parse(readFileSync(fileURLToPath(new URL('../public/scripts/extensions/tts/manifest.json', import.meta.url)), 'utf8'));
        expect(ttsManifest.hooks?.activate).toBe('init');
        expect(ttsManifest.hooks?.disable).toBe('deactivate');
    });

    test('shared capability registry unregisters only its own registration', async () => {
        jest.resetModules();
        const registry = await import('../public/scripts/sillybunny-conversation/extension-capabilities.js');

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
