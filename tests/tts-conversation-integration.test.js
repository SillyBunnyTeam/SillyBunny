/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { getExtensionCapability } from '../public/scripts/sillybunny-conversation/extension-capabilities.js';
import { SimpleMutex } from '../public/scripts/util/SimpleMutex.js';
import { loadTtsModule } from './util/tts-module-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));
const capabilityRegistryKey = Symbol.for('sillybunny.extensionCapabilities');

let activeHarness = null;

async function drainMacrotasks(rounds = 5) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

function installCapabilityRegistry(entries) {
    Object.defineProperty(globalThis, capabilityRegistryKey, {
        configurable: true,
        value: new Map(entries),
    });
}

async function importConversationTts() {
    jest.resetModules();
    await jest.unstable_mockModule(pub('script.js'), () => ({ name1: 'User' }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store-utils.js'), () => ({
        getConversationAttachmentSummary: jest.fn(() => '[Attachment]'),
    }));
    return import(pub('scripts/sillybunny-conversation/tts.js'));
}

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
    delete globalThis[capabilityRegistryKey];
    delete globalThis.toastr;
    jest.restoreAllMocks();
});

describe('TTS Conversation integration', () => {
    test('uses only the activated TTS capability while preserving manual narration', async () => {
        const conversationTts = await importConversationTts();
        await expect(conversationTts.narrateConversationMessage({ role: 'character', name: 'Mona', mes: 'Hello' })).resolves.toBe(false);

        const narrateTtsMessage = jest.fn(async () => true);
        installCapabilityRegistry([['tts', { narrateTtsMessage }]]);
        const message = { role: 'member', name: 'Mona', mes: 'Hello', extra: { member_avatar: 'mona.png' } };

        await expect(conversationTts.narrateConversationMessage(message)).resolves.toBe(true);
        expect(narrateTtsMessage).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Mona',
            mes: 'Hello',
            is_user: false,
        }), expect.objectContaining({
            manual: false,
            force: false,
            isStillVisible: null,
            propagateErrors: true,
            unrestrictedVoiceMap: true,
        }));

        await expect(conversationTts.narrateConversationMessage(message, { manual: true, force: true })).resolves.toBe(true);
        expect(narrateTtsMessage).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({
            manual: true,
            force: true,
            unrestrictedVoiceMap: true,
        }));
    });

    test('Conversation reports capability failures instead of silently succeeding', async () => {
        const conversationTts = await importConversationTts();
        const narrateTtsMessage = jest.fn(async () => { throw new Error('provider offline'); });
        installCapabilityRegistry([['tts', { narrateTtsMessage }]]);
        globalThis.toastr = { warning: jest.fn(), info: jest.fn() };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(conversationTts.narrateConversationMessage(
            { role: 'character', name: 'Mona', mes: 'Hello' },
            { manual: true },
        )).resolves.toBe(false);
        expect(warn).toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalled();
        expect(narrateTtsMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ propagateErrors: true }));
    });

    test('auto narration only runs for the exact visible persona, group, and branch', async () => {
        jest.resetModules();
        const chats = new Map();
        const narrateConversationMessage = jest.fn(async () => true);
        const scheduleTimelineRender = jest.fn();
        const isConversationActive = jest.fn((avatar, groupId, { chatId, personaId }) => (
            avatar === 'speaker.png'
            && groupId === 'group-a'
            && chatId === 'branch-a'
            && personaId === 'persona-a'
        ));
        // The conversation is named by its persona and group, and each chat holds the messages written to it.
        const getConversationAddress = jest.fn((_avatar, { chatId = '', groupId = '', personaId = '' } = {}) => ({ conversationId: `${personaId}|${groupId}`, chatId: chatId || 'main' }));
        const commitChat = jest.fn((address, edit) => {
            const key = `${address.conversationId}|${address.chatId}`;
            if (!chats.has(key)) {
                chats.set(key, { messages: [] });
            }
            edit(chats.get(key));
        });

        await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
            getMessageTimeStamp: jest.fn(() => 'now'),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/constants.js'), () => ({
            SAFE_TOAST_OPTIONS: {},
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
            getActiveConversationChat: jest.fn(() => null),
            getConversationAddress,
            getConversationGroupIdForAvatar: jest.fn(() => 'group-a'),
            getConversationPersonaId: jest.fn(() => 'persona-a'),
            getCurrentCharAvatar: jest.fn(() => 'speaker.png'),
            getCurrentCharName: jest.fn(() => 'Speaker'),
            parsePositiveInt: jest.fn(value => Number(value) || 0),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-data-browser.js'), () => ({
            conversationData: { commitChat, chat: jest.fn(() => null) },
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/notifications.js'), () => ({
            isConversationActive,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/render-scheduler.js'), () => ({
            scheduleTimelineRender,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/settings-store.js'), () => ({
            getConversationSessionMarker: jest.fn(() => 0),
            resetFollowupCount: jest.fn(),
            setConversationSessionMarker: jest.fn(),
            setLastUserActivity: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/typing.js'), () => ({
            stripPreviewText: jest.fn(value => String(value || '').trim()),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store-utils.js'), () => ({
            getConversationAttachmentLabels: jest.fn(() => []),
            getConversationAttachmentSummary: jest.fn(() => ''),
            getConversationFileAttachments: jest.fn(() => []),
            getConversationMediaAttachments: jest.fn(() => []),
            getConversationMediaDisplay: jest.fn(() => ''),
            getConversationMediaIndex: jest.fn(() => 0),
            getConversationPromptMediaAttachments: jest.fn(() => []),
            hasConversationMessageContent: jest.fn(() => true),
            normalizeConversationStoredMessage: jest.fn(message => message),
            resolveConversationReminderChatId: jest.fn(() => 'branch-a'),
            safeParseMessages: jest.fn(messages => messages),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/tts.js'), () => ({
            narrateConversationMessage,
        }));

        const { appendConversationChatMessage } = await import(pub('scripts/sillybunny-conversation/conversation-store.js'));
        appendConversationChatMessage('speaker.png', { mes: 'other persona', role: 'character' }, {
            chatId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-b',
        });
        appendConversationChatMessage('speaker.png', { mes: 'other group', role: 'character' }, {
            chatId: 'branch-a',
            groupId: 'group-b',
            personaId: 'persona-a',
        });
        appendConversationChatMessage('speaker.png', { mes: 'other branch', role: 'character' }, {
            chatId: 'branch-b',
            groupId: 'group-a',
            personaId: 'persona-a',
        });

        const visibleMessage = appendConversationChatMessage('speaker.png', { mes: 'visible', role: 'character' }, {
            chatId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-a',
        });
        expect([...chats.keys()].sort()).toEqual(['persona-a|group-a|branch-a', 'persona-a|group-a|branch-b', 'persona-a|group-b|branch-a', 'persona-b|group-a|branch-a']);
        expect(chats.get('persona-a|group-a|branch-a').messages).toEqual([visibleMessage]);
        expect(narrateConversationMessage).toHaveBeenCalledTimes(1);
        expect(narrateConversationMessage).toHaveBeenCalledWith(visibleMessage, { isStillVisible: expect.any(Function) });
        expect(scheduleTimelineRender).toHaveBeenCalledTimes(1);

        const { isStillVisible } = narrateConversationMessage.mock.calls[0][1];
        expect(isStillVisible()).toBe(true);
        isConversationActive.mockReturnValue(false);
        expect(isStillVisible()).toBe(false);
    });

    test('narrate revalidates visibility immediately before enqueue; manual Speak is unaffected', async () => {
        let visible = true;
        let flipVisibilityOnFetch = false;
        let loadAttempts = 0;
        const generateTts = jest.fn(async () => 'data:audio/wav;base64,');

        class VisibilityProvider {
            constructor() {
                this.settings = {};
                this.settingsHtml = '';
            }
            async loadSettings(settings) {
                loadAttempts += 1;
                if (loadAttempts === 1) throw new Error('initial load offline');
                this.settings = settings || {};
            }
            async checkReady() {}
            async fetchTtsVoiceObjects() {
                if (flipVisibilityOnFetch) {
                    flipVisibilityOnFetch = false;
                    visible = false;
                }
                return [{ name: 'Voice One', voice_id: 'voice-1', lang: 'en-US' }];
            }
            async getVoice(name) { return { name, voice_id: 'voice-1' }; }
            async generateTts(text, voiceId, key, signal) { return generateTts(text, voiceId, key, signal); }
        }

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        activeHarness = await loadTtsModule({
            ttsSettings: {
                enabled: true,
                auto_generation: true,
                narrate_user: true,
                currentProvider: 'VisTest',
                VisTest: { voiceMap: { '[Default Voice]': 'Voice One', Mona: 'Voice One' } },
            },
        });
        activeHarness.ttsModule.registerTtsProvider('VisTest', VisibilityProvider);
        await activeHarness.ttsModule.init();
        await drainMacrotasks();
        expect(loadAttempts).toBe(1);
        expect(warnSpy).toHaveBeenCalled();

        const message = { name: 'Mona', mes: 'Hello' };

        // Visibility turns false while initVoiceMap awaits provider voices; auto narration cancels.
        flipVisibilityOnFetch = true;
        await expect(activeHarness.ttsModule.narrateTtsMessage(message, { isStillVisible: () => visible })).resolves.toBe(false);
        await drainMacrotasks();
        expect(generateTts).not.toHaveBeenCalled();
        // Provider readiness retried on demand after the initial init failure.
        expect(loadAttempts).toBe(2);

        // Manual Speak ignores visibility revalidation and resets active playback.
        await expect(activeHarness.ttsModule.narrateTtsMessage(message, { manual: true, isStillVisible: () => false })).resolves.toBe(true);
        await drainMacrotasks();
        expect(activeHarness.cancelTtsPlay).toHaveBeenCalledTimes(1);
        expect(generateTts).toHaveBeenCalledTimes(1);

        // Visible automatic narration succeeds once the thread stays visible.
        await expect(activeHarness.ttsModule.narrateTtsMessage(message, { isStillVisible: () => true })).resolves.toBe(true);
        await drainMacrotasks();
        expect(generateTts).toHaveBeenCalledTimes(2);
    });

    test('provider loads run in order and A -> B -> A ends on A without reusing the stale A promise', async () => {
        activeHarness = await loadTtsModule();
        const releases = [];
        const events = [];
        const queue = activeHarness.ttsModule.createTtsProviderLoadQueue(async provider => {
            events.push(`start:${provider}`);
            await new Promise(resolve => releases.push(resolve));
            events.push(`end:${provider}`);
            return provider;
        });

        const firstA = queue('A');
        expect(queue('A')).toBe(firstA);
        const b = queue('B');
        const secondA = queue('A');
        expect(secondA).not.toBe(firstA);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['start:A']);

        releases.shift()();
        await firstA;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['start:A', 'end:A', 'start:B']);
        releases.shift()();
        await b;
        await new Promise(resolve => setTimeout(resolve, 0));
        releases.shift()();
        await secondA;
        expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:A', 'end:A']);
    });

    test('serialized provider queue continues after a failed load', async () => {
        activeHarness = await loadTtsModule();
        const queue = activeHarness.ttsModule.createTtsProviderLoadQueue(async provider => {
            if (provider === 'broken') throw new Error('broken');
            return provider;
        });

        await expect(queue('broken')).rejects.toThrow('broken');
        await expect(queue('working')).resolves.toBe('working');
    });

    test('voice-map requests coalesce unrestricted and speaker flags without dropping either', async () => {
        activeHarness = await loadTtsModule();
        let releaseFirst;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        const calls = [];
        const request = activeHarness.ttsModule.createTtsVoiceMapInitializer(async (unrestricted, speakers) => {
            calls.push([unrestricted, [...speakers].sort()]);
            if (calls.length === 1) await firstGate;
        });

        const restricted = request(false, ['Mona']);
        expect(request(true, ['Rin'])).toBe(restricted);
        await Promise.resolve();
        expect(calls).toEqual([[false, ['Mona']]]);
        releaseFirst();
        await restricted;
        expect(calls).toEqual([[false, ['Mona']], [true, ['Rin']]]);

        const failingRequest = activeHarness.ttsModule.createTtsVoiceMapInitializer(async () => { throw new Error('voices failed'); });
        await expect(failingRequest(false)).rejects.toThrow('voices failed');
    });

    test('unrestricted voice maps include the persona and requested speakers with multivoice expansion', async () => {
        activeHarness = await loadTtsModule({
            characters: [{ name: 'Roleplay' }],
            groupId: null,
            name1: 'Traveler',
            name2: 'Roleplay',
            ttsSettings: { multi_voice_enabled: true },
        });

        const names = activeHarness.ttsModule.getCharacters(true, ['Mona']);
        expect(names).toContain('[Default Voice]');
        expect(names).toContain('Traveler ("Quotes")');
        expect(names).toContain('Mona ("Quotes")');
        expect(names).toContain('Mona (*Text inside asterisks*)');
        expect(names).toContain('Mona (Other text)');

        activeHarness.extension_settings.tts.multi_voice_enabled = false;
        const plain = activeHarness.ttsModule.getCharacters(true, ['Mona']);
        expect(plain).toEqual(expect.arrayContaining(['[Default Voice]', 'Roleplay', 'Traveler', 'Mona']));
    });

    test('speaker mapping resolves expanded multivoice keys and gates enqueue', async () => {
        const generateTts = jest.fn(async () => 'data:audio/wav;base64,');
        class VoiceMapProvider {
            constructor() {
                this.settings = {};
                this.settingsHtml = '';
            }
            async loadSettings(settings) { this.settings = settings || {}; }
            async checkReady() {}
            async fetchTtsVoiceObjects() {
                return [
                    { name: 'voice-default', voice_id: 'id-default', lang: 'en-US' },
                    { name: 'voice-dialogue', voice_id: 'id-dialogue', lang: 'en-US' },
                    { name: 'voice-action', voice_id: 'id-action', lang: 'en-US' },
                    { name: 'voice-other', voice_id: 'id-other', lang: 'en-US' },
                ];
            }
            async getVoice(voiceName) { return { name: voiceName, voice_id: `id-${voiceName}` }; }
            async generateTts(text, voiceId, key, signal) { return generateTts(text, voiceId, key, signal); }
        }

        activeHarness = await loadTtsModule({
            characters: [{ name: 'Mona' }, { name: 'Rin' }],
            chat: [{ name: 'Rin', mes: 'hi' }],
            ttsSettings: {
                enabled: true,
                auto_generation: true,
                multi_voice_enabled: false,
                currentProvider: 'MapTest',
                MapTest: {
                    voiceMap: {
                        '[Default Voice]': '',
                        Mona: '[Default Voice]',
                    },
                },
            },
        });
        activeHarness.ttsModule.registerTtsProvider('MapTest', VoiceMapProvider);
        await activeHarness.ttsModule.init();
        await drainMacrotasks();

        // Unmapped default voice blocks Mona even though Mona points to [Default Voice].
        await expect(activeHarness.ttsModule.narrateTtsMessage({ name: 'Mona', mes: 'Hello' }, { unrestrictedVoiceMap: true }))
            .resolves.toBe(false);
        expect(generateTts).not.toHaveBeenCalled();

        // Once [Default Voice] resolves to a concrete voice, Mona passes the voice-map gate.
        activeHarness.extension_settings.tts.MapTest.voiceMap['[Default Voice]'] = 'voice-default';
        await expect(activeHarness.ttsModule.narrateTtsMessage({ name: 'Mona', mes: 'Hello' }, { unrestrictedVoiceMap: true }))
            .resolves.toBe(true);
        await drainMacrotasks();
        expect(generateTts).toHaveBeenCalledWith('Hello', 'id-voice-default', 'Mona', expect.any(AbortSignal));

        // Multi-voice requires expanded speaker keys; missing keys block narration.
        generateTts.mockClear();
        activeHarness.extension_settings.tts.multi_voice_enabled = true;
        activeHarness.extension_settings.tts.MapTest.voiceMap['[Default Voice]'] = '';
        await expect(activeHarness.ttsModule.narrateTtsMessage({ name: 'Rin', mes: 'Hey' }, { unrestrictedVoiceMap: true }))
            .resolves.toBe(false);
        expect(generateTts).not.toHaveBeenCalled();

        // Mapping all expanded multi-voice keys allows both narration and plain-name /speak lookup.
        Object.assign(activeHarness.extension_settings.tts.MapTest.voiceMap, {
            'Rin ("Quotes")': 'voice-dialogue',
            'Rin (*Text inside asterisks*)': 'voice-action',
            'Rin (Other text)': 'voice-other',
        });
        await expect(activeHarness.ttsModule.narrateTtsMessage({ name: 'Rin', mes: 'Plain line' }, { unrestrictedVoiceMap: true }))
            .resolves.toBe(true);
        await drainMacrotasks();
        expect(generateTts).toHaveBeenCalledWith('Plain line', 'id-voice-other', 'Rin (Other text)', expect.any(AbortSignal));

        // Plain-name /speak resolves through the expanded "(Other text)" voice map entry.
        generateTts.mockClear();
        activeHarness.state.name2 = 'Rin';
        const speakCommand = activeHarness.slashCommands.get('speak');
        await speakCommand.callback({ voice: 'Rin' }, 'Slash speech');
        await drainMacrotasks();
        expect(generateTts).toHaveBeenCalledWith('Slash speech', 'id-voice-other', 'Rin (Other text)', expect.any(AbortSignal));
    });

    test('queue wakeup survives real SimpleMutex release timing where a microtask is swallowed', async () => {
        // Demonstrate that a microtask wakeup runs before SimpleMutex clears isBusy and is dropped.
        const microtaskProcessed = [];
        const microtaskQueue = ['job1', 'job2'];
        const microtaskWrapper = new SimpleMutex(async () => {
            const job = microtaskQueue.shift();
            await Promise.resolve();
            if (job) microtaskProcessed.push(job);
            if (microtaskQueue.length > 0) queueMicrotask(() => void microtaskWrapper.update());
        });
        await microtaskWrapper.update();
        await new Promise(resolve => setTimeout(resolve, 15));
        expect(microtaskProcessed).toEqual(['job1']);

        // The real TTS queue uses real SimpleMutex + macrotask wakeup to drain multi-paragraph jobs completely.
        const spoken = [];
        class MultiJobProvider {
            constructor() {
                this.settings = {};
                this.settingsHtml = '';
            }
            async loadSettings(settings) { this.settings = settings || {}; }
            async checkReady() {}
            async fetchTtsVoiceObjects() { return [{ name: 'Voice One', voice_id: 'v1', lang: 'en-US' }]; }
            async getVoice(name) { return { name, voice_id: 'v1' }; }
            async generateTts(text) {
                spoken.push(text);
                return 'data:audio/wav;base64,';
            }
        }

        activeHarness = await loadTtsModule({
            ttsSettings: {
                enabled: true,
                auto_generation: true,
                narrate_by_paragraphs: true,
                currentProvider: 'WakeupTest',
                WakeupTest: { voiceMap: { '[Default Voice]': 'Voice One', Mona: 'Voice One' } },
            },
        });
        activeHarness.ttsModule.registerTtsProvider('WakeupTest', MultiJobProvider);
        await activeHarness.ttsModule.init();
        await drainMacrotasks();

        await activeHarness.ttsModule.narrateTtsMessage({ name: 'Mona', mes: 'First paragraph\nSecond paragraph' }, { manual: true });
        await drainMacrotasks(8);
        expect(spoken).toEqual(['First paragraph', 'Second paragraph']);
    });

    test('epoch guards discard late chunks and every started job gets one terminal event', async () => {
        let generateImpl = async () => 'chunk-single';
        let capturedSignal = null;

        class StreamingProvider {
            constructor() {
                this.settings = {};
                this.settingsHtml = '';
            }
            async loadSettings(settings) { this.settings = settings || {}; }
            async checkReady() {}
            async fetchTtsVoiceObjects() { return [{ name: 'Voice One', voice_id: 'voice-1', lang: 'en-US' }]; }
            async getVoice(name) { return { name, voice_id: 'voice-1' }; }
            async generateTts(text, voiceId, key, signal) {
                capturedSignal = signal;
                return generateImpl(text, voiceId, key, signal);
            }
        }

        activeHarness = await loadTtsModule({
            ttsSettings: {
                enabled: true,
                auto_generation: true,
                currentProvider: 'EpochTest',
                EpochTest: { voiceMap: { '[Default Voice]': 'Voice One', Mona: 'Voice One' } },
            },
        });
        activeHarness.ttsModule.registerTtsProvider('EpochTest', StreamingProvider);
        await activeHarness.ttsModule.init();
        await drainMacrotasks();

        const emitted = [];
        activeHarness.eventSource.emit.mockImplementation(async (event, payload) => {
            emitted.push([event, payload]);
            const handlers = [...(activeHarness.eventSource.listeners.get(event) || [])];
            for (const handler of handlers) {
                await handler(payload);
            }
        });

        // Success path: single response, provider gets an AbortSignal, one terminal success event.
        await activeHarness.ttsModule.narrateTtsMessage({ name: 'Mona', mes: 'hello' }, { messageId: 7, manual: true });
        await drainMacrotasks();

        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        expect(emitted.filter(([event]) => event === activeHarness.event_types.TTS_AUDIO_READY)).toHaveLength(1);
        expect(emitted.filter(([event]) => event === activeHarness.event_types.TTS_JOB_COMPLETE)).toEqual([
            [activeHarness.event_types.TTS_JOB_COMPLETE, expect.objectContaining({ messageId: 7, status: 'success' })],
        ]);

        // Cancellation path: MESSAGE_SWIPED triggers resetTtsPlayback between generator chunks.
        emitted.length = 0;
        let releaseSecond;
        const secondGate = new Promise(resolve => { releaseSecond = resolve; });
        generateImpl = async () => (async function* chunks() {
            yield 'first';
            await secondGate;
            yield 'second';
        })();

        await activeHarness.ttsModule.narrateTtsMessage({ name: 'Mona', mes: 'hello again' }, { messageId: 8, manual: true });
        await drainMacrotasks(3);
        expect(emitted.filter(([event]) => event === activeHarness.event_types.TTS_AUDIO_READY)).toHaveLength(1);
        expect(capturedSignal.aborted).toBe(false);

        await activeHarness.eventSource.emit(activeHarness.event_types.MESSAGE_SWIPED);
        expect(capturedSignal.aborted).toBe(true);
        releaseSecond();
        await drainMacrotasks(4);

        expect(emitted.filter(([event]) => event === activeHarness.event_types.TTS_AUDIO_READY)).toHaveLength(1);
        expect(emitted.filter(([event]) => event === activeHarness.event_types.TTS_JOB_COMPLETE)).toEqual([
            [activeHarness.event_types.TTS_JOB_COMPLETE, expect.objectContaining({ messageId: 8, status: 'cancelled' })],
        ]);
    });

    test('a failed provider job still emits exactly one terminal failure event', async () => {
        class ExplodingProvider {
            constructor() {
                this.settings = {};
                this.settingsHtml = '';
            }
            async loadSettings(settings) { this.settings = settings || {}; }
            async checkReady() {}
            async fetchTtsVoiceObjects() { return [{ name: 'Voice One', voice_id: 'voice-1', lang: 'en-US' }]; }
            async getVoice(name) { return { name, voice_id: 'voice-1' }; }
            async generateTts() { throw new Error('provider exploded'); }
        }

        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        activeHarness = await loadTtsModule({
            ttsSettings: {
                enabled: true,
                auto_generation: true,
                currentProvider: 'FailTest',
                FailTest: { voiceMap: { '[Default Voice]': 'Voice One', Mona: 'Voice One' } },
            },
        });
        activeHarness.ttsModule.registerTtsProvider('FailTest', ExplodingProvider);
        await activeHarness.ttsModule.init();
        await drainMacrotasks();

        const emitted = [];
        activeHarness.eventSource.emit.mockImplementation(async (event, payload) => {
            emitted.push([event, payload]);
        });

        await activeHarness.ttsModule.narrateTtsMessage({ name: 'Mona', mes: 'text' }, { messageId: 3, manual: true });
        await drainMacrotasks();

        expect(emitted.filter(([event]) => event === activeHarness.event_types.TTS_JOB_COMPLETE)).toEqual([
            [activeHarness.event_types.TTS_JOB_COMPLETE, expect.objectContaining({ messageId: 3, status: 'error' })],
        ]);
        expect(activeHarness.toastr.error).toHaveBeenCalledWith(expect.stringContaining('provider exploded'));
    });

    test('capability registration happens at activation start, before shell/provider work finishes', async () => {
        let resolveTemplate;
        const templatePromise = new Promise(resolve => { resolveTemplate = resolve; });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        class FailingInitProvider {
            constructor() {
                this.settings = {};
                this.settingsHtml = '';
            }
            async loadSettings() { throw new Error('provider boot failed'); }
            async checkReady() {}
            async fetchTtsVoiceObjects() { return []; }
        }

        activeHarness = await loadTtsModule({
            renderExtensionTemplateAsync: jest.fn(() => templatePromise),
            ttsSettings: {
                enabled: false,
                currentProvider: 'BootFail',
            },
        });
        activeHarness.ttsModule.registerTtsProvider('BootFail', FailingInitProvider);

        expect(getExtensionCapability('tts')).toBeNull();
        const initPromise = activeHarness.ttsModule.init();

        // Capability is already registered synchronously before template/provider work completes.
        const capability = getExtensionCapability('tts');
        expect(capability).toEqual(expect.objectContaining({
            ensureReady: expect.any(Function),
            narrateTtsMessage: expect.any(Function),
        }));

        resolveTemplate('<div id="tts_settings"><select id="tts_provider"></select><input type="checkbox" id="tts_enabled"><div id="tts_voicemap_block"></div><form id="tts_provider_settings"></form><input id="tts_voices"></div>');
        // Provider failure is non-fatal for shell initialization.
        await expect(initPromise).resolves.toBeUndefined();
        await drainMacrotasks();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('TTS provider initialization failed'),
            expect.any(Error),
        );

        activeHarness.ttsModule.deactivate();
        expect(getExtensionCapability('tts')).toBeNull();
    });
});
