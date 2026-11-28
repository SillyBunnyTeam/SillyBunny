/** @jest-environment jsdom */
/* global globalThis */
import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';
import {
    CHROME_IDS,
    CONVERSATION_DETAILS_CLOSE_EVENT,
    DEFAULT_GROUNDED_DIALOGUE_RULES,
    DEFAULT_SETTINGS,
    SEND_QUEUE_COALESCE_MS,
} from '../public/scripts/sillybunny-conversation/constants.js';
import { buildReplySteps } from '../public/scripts/sillybunny-conversation/reply-steps.js';
import { chooseGroupSpeakers } from '../public/scripts/sillybunny-conversation/speaker-selection.js';
import {
    coalesceConversationQueueItems,
    createConversationQueueItem,
} from '../public/scripts/sillybunny-conversation/send-queue-utils.js';
import { buildConversationGroupReferenceContext } from '../public/scripts/sillybunny-conversation/shared-helpers.js';
import { loadTtsModule } from './util/tts-module-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));
const srcPath = rel => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const capabilityRegistryKey = Symbol.for('sillybunny.extensionCapabilities');

let activeTtsHarness = null;

afterEach(() => {
    activeTtsHarness?.cleanup();
    activeTtsHarness = null;
    delete globalThis[capabilityRegistryKey];
    delete globalThis.toastr;
    delete window.SillyTavern;
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

async function importGenerationAndPromptHarness({
    profiles = [{ id: 'prof-1', name: 'Scoped Profile' }],
    cmrsSendRequest = jest.fn(async () => ({ content: 'Scoped reply' })),
    generateRaw = jest.fn(async () => 'Active reply'),
    getProfileResponseLength = jest.fn(async () => 420),
    getActiveApiResponseLength = jest.fn(async len => (len > 0 ? len : 250)),
    messages = [],
    group = null,
    characters = [
        { name: 'Alice', avatar: 'alice.png', description: 'Kind barista', personality: 'Warm', scenario: 'Cafe' },
        { name: 'Bob', avatar: 'bob.png', description: 'Regular', personality: 'Cheerful', scenario: 'Cafe' },
    ],
    participants = [],
    characterStatus = { status: 'online', activity: 'brewing coffee', source: 'schedule' },
    memoryChat = null,
    settings = { ...DEFAULT_SETTINGS, connection_profile: 'Scoped Profile' },
} = {}) {
    jest.resetModules();
    const appended = [];
    const saveConversationMemorySummary = jest.fn();

    window.SillyTavern = cmrsSendRequest
        ? { getContext: () => ({ ConnectionManagerRequestService: { sendRequest: cmrsSendRequest } }) }
        : { getContext: () => ({}) };

    await jest.unstable_mockModule(pub('script.js'), () => ({
        characters,
        generateRaw,
        main_api: 'openai',
    }));
    await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({ user_avatar: 'user.png' }));
    await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({ power_user: { persona_description: '' } }));
    await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/llm-utils.js'), () => ({
        extractProfileResponseText: res => (typeof res === 'string' ? res : res?.content ?? ''),
    }));
    await jest.unstable_mockModule(pub('scripts/resumable-generation.js'), () => ({
        onServerOwnedReplyMissing: jest.fn(() => () => {}),
        registerGenerationCommitPlan: jest.fn(),
        settleGenerationCommit: jest.fn(async () => 'claimed'),
    }));
    await jest.unstable_mockModule(pub('scripts/util/abort-error.js'), () => ({
        isAbortLikeError: (err, signal) => Boolean(signal?.aborted || err?.name === 'AbortError'),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-provider-message.js'), () => ({
        extractProviderMessage: err => String(err?.message ?? err ?? ''),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
        getActiveConversationChat: jest.fn(() => memoryChat),
        getConversationGroupById: jest.fn(() => group),
        getConversationGroupIdForAvatar: jest.fn(() => group?.id || ''),
        getConversationPersonaId: jest.fn(() => 'persona-1'),
        getConversationRecord: jest.fn(() => ({ activeChatId: 'main', memoryMessageCount: 0 })),
        getConversationKey: jest.fn(() => 'conv-1'),
        getCurrentCharAvatar: jest.fn(() => 'alice.png'),
        getCurrentCharName: jest.fn(() => 'Alice'),
        parsePositiveInt: (v, fallback, min = 0) => {
            const n = Number.parseInt(String(v), 10);
            return Number.isFinite(n) && n >= min ? n : fallback;
        },
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/media.js'), () => ({
        buildCharacterImagePrompt: jest.fn(t => t),
        generateConversationImage: jest.fn(async () => ''),
        getCharacterAuthorNote: jest.fn(() => ''),
        getCharacterForAvatar: jest.fn(av => characters.find(c => c.avatar === av) || null),
        getCharacterImageDetails: jest.fn(() => ''),
        getConversationParticipants: jest.fn(() => participants),
        getParticipantNamesForDisplay: jest.fn(list => list.map(p => p.name)),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/message-writer.js'), () => ({
        appendConversationMessage: jest.fn(async (text, opts, anchorAvatar) => {
            const msg = {
                id: `m-${appended.length + 1}`,
                mes: text,
                role: opts.role,
                name: opts.name,
                extra: opts.extra,
                anchorAvatar,
            };
            appended.push(msg);
            messages.push(msg);
            return msg;
        }),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/dialogs.js'), () => ({
        confirmConversationAction: jest.fn(async () => true),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/personas.js'), () => ({
        composeConversationPersonaDescription: jest.fn(() => ''),
        getAvailabilityCopy: jest.fn(() => ({ label: 'Online' })),
        getConnectionProfiles: jest.fn(() => profiles),
        getConversationPersonaName: jest.fn(() => 'Alex'),
        getUserPersonaStatus: jest.fn(() => ''),
        getUserStatus: jest.fn(() => 'online'),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/response-length.js'), () => ({
        getActiveApiResponseLength,
        getProfileResponseLength,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/settings-store.js'), () => ({
        getConversationGroupMemorySummaries: jest.fn(() => []),
        getConversationMemorySummary: jest.fn(() => ''),
        getConversationSoloMemorySummary: jest.fn(() => null),
        getSettings: jest.fn(() => settings),
        loadRelatedMemoryChats: jest.fn(async () => {}),
        saveConversationMemorySummary,
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/schedule.js'), () => ({
        getCharacterStatus: jest.fn(() => characterStatus),
        getConversationRuntimeStatusKey: jest.fn(() => 'key'),
        parseDurationToMs: jest.fn(() => 0),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store.js'), () => ({
        addConversationReminder: jest.fn(),
        buildConversationMessageReplyReference: jest.fn(msg => (msg?.id ? { messageId: msg.id, name: msg.name, text: msg.mes } : null)),
        ensureConversationChatLoaded: jest.fn(async () => ({ conversationId: 'conv-1', chatId: 'main' })),
        getConversationAttachmentSummary: jest.fn(() => ''),
        getConversationFileAttachments: jest.fn(() => []),
        getConversationMediaAttachments: jest.fn(() => []),
        getConversationMediaDisplay: jest.fn(() => 0),
        getConversationMediaIndex: jest.fn(() => 0),
        getConversationMessages: jest.fn(() => messages),
        getConversationPromptMediaAttachments: jest.fn(() => []),
        getImageCooldownRemainingSeconds: jest.fn(() => 0),
        hasConversationMessageContent: jest.fn(msg => Boolean(msg?.mes)),
        markImageGenerated: jest.fn(),
        updateConversationChatMessage: jest.fn(),
        updateConversationChatMessageReactions: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/typing.js'), () => ({
        waitForReplyDelay: jest.fn(async () => {}),
        withTypingParticipant: jest.fn(async (_participant, fn) => fn()),
    }));
    await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/world-info.js'), () => ({
        getConversationWorldInfo: jest.fn(async () => null),
    }));

    const generation = await import(pub('scripts/sillybunny-conversation/generation.js'));
    const promptMod = await import(pub('scripts/sillybunny-conversation/prompt.js'));
    return {
        generation,
        promptMod,
        appended,
        cmrsSendRequest,
        generateRaw,
        getProfileResponseLength,
        getActiveApiResponseLength,
        saveConversationMemorySummary,
    };
}

describe('conversation mode scoped connection profile', () => {
    // Leaf modules run first so no earlier test registers an unstable_mockModule over them.
    test('connects Conversation messages to the TTS capability', async () => {
        jest.resetModules();
        const narrateTtsMessage = jest.fn(async () => true);
        Object.defineProperty(globalThis, capabilityRegistryKey, {
            configurable: true,
            value: new Map([['tts', { narrateTtsMessage }]]),
        });
        await jest.unstable_mockModule(pub('script.js'), () => ({ name1: 'Alex' }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store-utils.js'), () => ({
            getConversationAttachmentSummary: jest.fn(() => ''),
        }));
        const conversationTts = await import(pub('scripts/sillybunny-conversation/tts.js'));
        await expect(conversationTts.narrateConversationMessage(
            { role: 'character', name: 'Alice', mes: 'Hello there' },
            { manual: true, force: true },
        )).resolves.toBe(true);
        expect(narrateTtsMessage).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Alice', mes: 'Hello there', is_user: false }),
            expect.objectContaining({ manual: true, force: true, unrestrictedVoiceMap: true }),
        );
    });

    test('does not expose retired global profile-switch helpers or switch queue', async () => {
        jest.resetModules();
        await jest.unstable_mockModule(pub('script.js'), () => ({
            default_user_avatar: 'default.png',
            getThumbnailUrl: jest.fn(() => ''),
            name1: 'User',
            saveSettingsDebounced: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/events.js'), () => ({
            event_types,
            eventSource: new EventEmitter(),
        }));
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({ extension_settings: {} }));
        await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({
            getUserAvatar: jest.fn(() => ''),
            user_avatar: 'user.png',
        }));
        await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({ power_user: {} }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
            getConversationGroupIdForAvatar: jest.fn(() => ''),
            getConversationKey: jest.fn(() => 'conv-1'),
            getConversationPersonaId: jest.fn(() => 'user.png'),
            getConversationRecord: jest.fn(() => null),
            getConversationStore: jest.fn(() => ({})),
            getCurrentCharAvatar: jest.fn(() => ''),
            isAvatarInConversationGroup: jest.fn(() => false),
            persistConversationStore: jest.fn(),
        }));
        const personasMod = await import(pub('scripts/sillybunny-conversation/personas.js'));
        const stateMod = await import(pub('scripts/sillybunny-conversation/state.js'));

        expect(personasMod.withConversationConnectionProfile).toBeUndefined();
        expect(personasMod.applyConnectionProfileByName).toBeUndefined();
        expect(personasMod.queueConversationProfileSwitch).toBeUndefined();
        expect(personasMod.quoteSlashArg).toBeUndefined();
        expect(personasMod.getSelectedConnectionProfileName).toBeUndefined();
        expect(stateMod.conversationProfileSwitchQueue).toBeUndefined();
    });

    test('settings layering puts global and derived settings over conversation settings without forcing group overrides', async () => {
        jest.resetModules();
        const store = {
            settings: {
                connection_profile: 'Global Profile',
                simulate_reply_delay: false,
            },
        };
        const listResult = [{ id: 'grp-1', kind: 'group', characters: ['alice.png', 'bob.png'] }];
        const viewRecord = {
            id: 'grp-1',
            kind: 'group',
            characters: ['alice.png', 'bob.png'],
            extras: ['Charlie'],
            settings: {
                connection_profile: 'Stale Local Profile',
                proactive_messaging: true,
                availability: 'idle',
            },
        };
        const conversationData = {
            list: jest.fn(() => listResult),
            characterState: jest.fn(() => ({ statusOverride: 'dnd' })),
            whenReady: jest.fn(() => Promise.resolve()),
        };

        await jest.unstable_mockModule(pub('script.js'), () => ({
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            getThumbnailUrl: jest.fn(() => ''),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
            getActiveConversationChat: jest.fn(() => null),
            getConversationAddress: jest.fn(() => null),
            getConversationGroupAnchor: jest.fn(() => null),
            getConversationGroupIdForAvatar: jest.fn(() => 'grp-1'),
            getConversationPersonaId: jest.fn(() => 'persona-1'),
            getConversationRecord: jest.fn(() => viewRecord),
            getConversationStore: jest.fn(() => store),
            getCurrentCharAvatar: jest.fn(() => 'alice.png'),
            parsePositiveInt: (v, f) => Number(v) || f,
            safeParseSettings: s => ({ ...s }),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-data-browser.js'), () => ({
            conversationData,
        }));

        const settingsStore = await import(pub('scripts/sillybunny-conversation/settings-store.js'));
        expect(settingsStore.hasAnyConversationModeUsage()).toBe(true);
        expect(conversationData.list).toHaveBeenCalledWith({ personaId: 'persona-1' });

        const resolved = settingsStore.getSettings('alice.png', { groupId: 'grp-1', personaId: 'persona-1' });
        expect(resolved.connection_profile).toBe('Global Profile');
        expect(resolved.simulate_reply_delay).toBe(false);
        expect(resolved.availability).toBe('dnd');
        expect(resolved.multi_char_names).toBe('Charlie');
        expect(resolved.proactive_messaging).toBe(true);
    });

    test('generateConversationRaw routes through ConnectionManagerRequestService without touching the active profile and falls back cleanly', async () => {
        const harness = await importGenerationAndPromptHarness();

        const scopedReply = await harness.generation.generateConversationRaw(
            { prompt: [{ role: 'user', content: 'hello' }], systemPrompt: 'be kind' },
            { connection_profile: 'Scoped Profile' },
        );
        expect(scopedReply).toBe('Scoped reply');
        expect(harness.getProfileResponseLength).toHaveBeenCalledWith({ id: 'prof-1', name: 'Scoped Profile' });
        expect(harness.cmrsSendRequest).toHaveBeenCalledWith(
            'prof-1',
            [
                { role: 'system', content: 'be kind' },
                { role: 'user', content: 'hello' },
            ],
            420,
            expect.objectContaining({ extractData: true, includePreset: true, stream: false }),
        );
        expect(harness.generateRaw).not.toHaveBeenCalled();
        expect(harness.getActiveApiResponseLength).not.toHaveBeenCalled();

        harness.getProfileResponseLength.mockClear();
        await harness.generation.generateConversationRaw(
            { prompt: 'explicit len', responseLength: 128 },
            { connection_profile: 'Scoped Profile' },
        );
        expect(harness.getProfileResponseLength).not.toHaveBeenCalled();
        expect(harness.cmrsSendRequest).toHaveBeenLastCalledWith(
            'prof-1',
            [{ role: 'user', content: 'explicit len' }],
            128,
            expect.objectContaining({ extractData: true, includePreset: true }),
        );

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        harness.cmrsSendRequest.mockRejectedValueOnce(new Error('profile down'));
        const fallback = await harness.generation.generateConversationRaw(
            { prompt: 'retry', responseLength: 0 },
            { connection_profile: 'Scoped Profile' },
        );
        expect(fallback).toBe('Active reply');
        expect(harness.getActiveApiResponseLength).toHaveBeenCalledWith(0);
        expect(harness.generateRaw).toHaveBeenCalledWith(expect.objectContaining({ responseLength: 250 }));
        expect(warnSpy).toHaveBeenCalled();
    });

    test('reply generation and memory summary both use the scoped generateConversationRaw path', async () => {
        const messages = [{ id: 'u1', role: 'user', name: 'Alex', mes: 'Remember my tea order.' }];
        const harness = await importGenerationAndPromptHarness({
            messages,
            memoryChat: { messages },
        });
        const reply = await harness.generation.generateConversationReply('Reply now', { connection_profile: 'Scoped Profile' });
        expect(reply).toBe('Scoped reply');
        expect(harness.cmrsSendRequest).toHaveBeenCalledTimes(1);
        expect(harness.generateRaw).not.toHaveBeenCalled();

        const updated = await harness.promptMod.updateConversationMemorySummary('alice.png', { force: true });
        expect(updated).toBe(true);
        expect(harness.cmrsSendRequest).toHaveBeenCalledTimes(2);
        expect(harness.generateRaw).not.toHaveBeenCalled();
    });

    test('routes explicitly prefixed group replies to the named participant and attaches reply references once per speaker', async () => {
        const steps = buildReplySteps('Bob: Hey everyone!\nAlice: Hi Bob!', {
            speaker: { avatar: 'alice.png', name: 'Alice' },
            speakers: [
                { avatar: 'alice.png', name: 'Alice' },
                { avatar: 'bob.png', name: 'Bob' },
            ],
        });
        expect(steps.map(step => [step.speakerAvatar, step.bubbles])).toEqual([
            ['bob.png', ['Hey everyone!']],
            ['alice.png', ['Hi Bob!']],
        ]);

        const history = [
            { id: 'u1', role: 'user', name: 'Alex', mes: 'Who is bringing snacks?' },
        ];
        const harness = await importGenerationAndPromptHarness({
            messages: history,
            group: { id: 'grp-1', members: ['alice.png', 'bob.png'] },
        });
        await harness.generation.postCharacterReply(
            'Bob: Chips!\nBob: And salsa!\nAlice: Drinks!',
            { ...DEFAULT_SETTINGS, simulate_reply_delay: false },
            { groupId: 'grp-1', personaId: 'persona-1' },
            'alice.png',
        );

        expect(harness.appended).toHaveLength(3);
        expect(harness.appended[0].extra.member_avatar).toBe('bob.png');
        expect(harness.appended[0].extra.conversation_reply_to).toEqual(expect.objectContaining({ messageId: 'u1' }));
        expect(harness.appended[1].extra.member_avatar).toBe('bob.png');
        expect(harness.appended[1].extra.conversation_reply_to).toBeUndefined();
        expect(harness.appended[2].extra.member_avatar).toBeUndefined();
        expect(harness.appended[2].extra.conversation_reply_to).toEqual(expect.objectContaining({ name: 'Bob' }));

        const secondTurn = await harness.generation.postCharacterReply(
            'Alice: Also ice!',
            { ...DEFAULT_SETTINGS, simulate_reply_delay: false },
            { groupId: 'grp-1', personaId: 'persona-1' },
            'alice.png',
        );
        expect(secondTurn).toContain('Also ice!');
        expect(harness.appended[3].extra.conversation_reply_to).toBeUndefined();
    });

    test('adds group reference context, device time context, optional Grounded Dialogue Rules, and omits inline reply quotes', async () => {
        const harness = await importGenerationAndPromptHarness({
            participants: [
                { name: 'Alice', avatar: 'alice.png' },
                { name: 'Bob', avatar: 'bob.png' },
            ],
        });

        const transcript = [
            { id: 'm1', role: 'member', name: 'Bob', mes: 'Morning!', extra: { member_avatar: 'bob.png' } },
            {
                id: 'm2',
                role: 'user',
                name: 'Alex',
                mes: 'Did you bring the coffee?',
                extra: { conversation_reply_to: { messageId: 'm1', name: 'Bob', text: 'Morning!' } },
            },
        ];
        const promptMessages = await harness.promptMod.buildConversationPromptMessages(
            transcript,
            'Reply now.',
            'Alice',
            { groupId: 'grp-1', personaId: 'persona-1' },
        );

        const groupRef = promptMessages.find(msg => msg.identifier === 'conversation-group-reference-context');
        expect(groupRef).toBeDefined();
        expect(groupRef.content).toContain('Bob');
        expect(groupRef.content).toContain('do not assume every you means');

        const transcriptTexts = promptMessages.map(msg => String(msg.content)).join('\n');
        expect(transcriptTexts).not.toContain('(replying to');

        // Implicit group reference context without an explicit conversation_reply_to cites the last non-user speaker.
        const implicitContext = buildConversationGroupReferenceContext(
            [
                { id: 'm1', role: 'member', name: 'Bob', mes: 'Morning!' },
                { id: 'm2', role: 'user', name: 'Alex', mes: 'Did you bring it?' },
            ],
            { groupId: 'grp-1', speakerName: 'Alice', userName: 'Alex' },
        );
        expect(implicitContext).toContain('last non-user speaker before it');
        expect(implicitContext).toContain('do not assume every you means');

        const speakers = chooseGroupSpeakers({
            members: [
                { avatar: 'alice.png', talkativeness: 0.9, mentioned: false },
                { avatar: 'bob.png', talkativeness: 0.9, mentioned: false },
            ],
            speakers: ['alice.png'],
            latestUserText: 'Hey everyone, how are you all doing?',
            random: () => 0.1,
        });
        expect(speakers.length).toBeGreaterThanOrEqual(1);

        expect(DEFAULT_SETTINGS.grounded_dialogue_rules_enabled).toBe(false);
        expect(DEFAULT_SETTINGS.grounded_dialogue_rules).toBe(DEFAULT_GROUNDED_DIALOGUE_RULES);

        const sysWithoutRules = harness.promptMod.buildConversationSystemPrompt({
            ...DEFAULT_SETTINGS,
            grounded_dialogue_rules_enabled: false,
        });
        expect(sysWithoutRules).toContain('Current device time context:');
        expect(sysWithoutRules).toContain('computer/phone time');
        expect(sysWithoutRules).toContain('brewing coffee');
        expect(sysWithoutRules).not.toContain('### Grounded Dialogue Rules');

        const sysWithRules = harness.promptMod.buildConversationSystemPrompt({
            ...DEFAULT_SETTINGS,
            grounded_dialogue_rules_enabled: true,
        });
        expect(sysWithRules).toContain('### Grounded Dialogue Rules');
    });

    test('renders streamlined composer chrome, clamps narrow popovers, and uses reply metadata instead of quoted text', async () => {
        jest.resetModules();
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            translate: s => String(s ?? ''),
        }));
        const { positionPopover } = await import(pub('scripts/sillybunny-action-menu.js'));
        const boundsEl = document.createElement('div');
        const trigger = document.createElement('button');
        const popover = document.createElement('div');
        document.body.append(boundsEl, trigger, popover);
        boundsEl.getBoundingClientRect = () => ({ left: 10, right: 170, top: 0, bottom: 500, width: 160, height: 500 });
        trigger.getBoundingClientRect = () => ({ left: 120, right: 150, top: 40, bottom: 72, width: 30, height: 32 });
        Object.defineProperty(popover, 'offsetWidth', { configurable: true, get: () => 156 });
        Object.defineProperty(popover, 'scrollHeight', { configurable: true, get: () => 80 });
        positionPopover(popover, trigger, null, boundsEl);
        const clampedLeft = Number.parseFloat(popover.style.left);
        expect(clampedLeft).toBeGreaterThanOrEqual(10);
        expect(clampedLeft).toBeLessThanOrEqual(14);

        jest.resetModules();
        const storedMessages = [
            { id: 'msg-42', role: 'character', name: 'Alice', mes: 'Meet at noon?' },
        ];
        await jest.unstable_mockModule(pub('script.js'), () => ({
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            chat: [],
            default_user_avatar: 'default.png',
            event_types,
            eventSource: new EventEmitter(),
            getThumbnailUrl: jest.fn(() => ''),
            messageFormatting: s => s,
            name1: 'Alex',
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/chrome.js'), () => ({
            bindConversationChromeControls: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
            selected_group: null,
        }));
        await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({ user_avatar: 'user.png' }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/dialogs.js'), () => ({
            promptConversationText: jest.fn(async () => null),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/generation.js'), () => ({
            commitCharacterReplyCommands: jest.fn(),
            extractCharacterReplyCommandParts: jest.fn(t => ({ text: t, selfieRequests: [], scheduleUpdates: [], reminders: [], reaction: null })),
            extractCharacterReplyCommands: jest.fn(() => []),
            generateConversationRaw: jest.fn(async () => ''),
            generateSelfieFromContext: jest.fn(async () => false),
            getCharacterReplyCommandMetadata: jest.fn(() => null),
            normalizeConversationOutputText: s => String(s ?? '').trim(),
            parseCommandArgs: jest.fn(() => ({})),
            reportConversationGenerationError: jest.fn(),
            splitMemberChatroomMessages: s => [s],
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/prompt.js'), () => ({
            buildConversationMemoryPrompt: jest.fn(() => ''),
            buildConversationPromptMessages: jest.fn(async () => []),
            buildConversationSystemPrompt: jest.fn(() => ''),
            convertImageUrlToBase64: jest.fn(async u => u),
            convertImageUrlsToBase64: jest.fn(async u => u),
            formatConversationFileSize: jest.fn(() => ''),
            formatConversationTranscript: jest.fn(() => ''),
            renderConversationAttachments: jest.fn(),
            scheduleConversationMemorySummary: jest.fn(),
            updateConversationMemorySummary: jest.fn(async () => false),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/pin-events-ui.js'), () => ({
            createPinnedMark: jest.fn(() => document.createElement('span')),
            detachPinEventRows: jest.fn(),
            placePinEventRows: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/reactions-ui.js'), () => ({
            createReactionChips: jest.fn(() => document.createElement('div')),
            createToolbarReactionButtons: jest.fn(() => []),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/world-info.js'), () => ({
            getConversationWorldInfo: jest.fn(async () => null),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => ({
            createStatusPage: jest.fn(() => document.createElement('div')),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/settings-store.js'), () => ({
            getSettings: jest.fn(() => ({ ...DEFAULT_SETTINGS })),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
            getActiveConversationChat: jest.fn(() => ({ id: 'main', messages: storedMessages })),
            getConversationChats: jest.fn(() => [{ id: 'main', name: 'Main' }]),
            getConversationGroupById: jest.fn(() => null),
            getConversationGroupIdForAvatar: jest.fn(() => ''),
            getConversationPersonaId: jest.fn(() => 'persona-1'),
            getConversationRecord: jest.fn(() => ({ activeChatId: 'main' })),
            getCurrentCharAvatar: jest.fn(() => 'alice.png'),
            getCurrentCharName: jest.fn(() => 'Alice'),
            parsePositiveInt: (v, f) => Number(v) || f,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store.js'), () => ({
            addConversationReminder: jest.fn(),
            appendConversationChatMessage: jest.fn(),
            buildConversationMessageReplyReference: jest.fn(msg => ({ messageId: msg.id, name: msg.name, text: msg.mes })),
            createConversationMessage: jest.fn(m => m),
            ensureConversationChatLoaded: jest.fn(async () => ({ conversationId: 'conv-1', chatId: 'main' })),
            getConversationAttachmentSummary: jest.fn(() => ''),
            getConversationFileAttachments: jest.fn(() => []),
            getConversationMediaAttachments: jest.fn(() => []),
            getConversationMessageCount: jest.fn(() => storedMessages.length),
            getConversationMessagePreviewText: jest.fn(m => m?.mes || ''),
            getConversationMessages: jest.fn(() => storedMessages),
            getConversationSeenAt: jest.fn(() => 0),
            getImageCooldownRemainingSeconds: jest.fn(() => 0),
            hasConversationMessageContent: jest.fn(() => true),
            markConversationSeen: jest.fn(),
            markImageGenerated: jest.fn(),
            parseReminderDelayToMs: jest.fn(() => 0),
            reloadConversationChat: jest.fn(async () => {}),
            saveConversationMessages: jest.fn(),
            updateConversationChatMessage: jest.fn(),
            updateConversationChatMessageReactions: jest.fn(),
            updateLastUserActivity: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-data-browser.js'), () => ({
            conversationData: { resolve: jest.fn(() => null) },
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/render-scheduler.js'), () => ({
            registerConversationRenderer: jest.fn(),
            scheduleConversationListRender: jest.fn(),
            scheduleInterfaceRefresh: jest.fn(),
            scheduleTimelineRender: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/tts.js'), () => ({
            narrateConversationMessage: jest.fn(async () => true),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/typing.js'), () => ({
            getActiveTypingParticipants: jest.fn(() => []),
            getPrimaryTypingParticipant: jest.fn(() => null),
            stripPreviewText: s => s,
            withTypingParticipant: jest.fn(async (_p, fn) => fn()),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/media.js'), () => ({
            getCharacterForAvatar: jest.fn(() => ({ name: 'Alice', avatar: 'alice.png' })),
            getCharacterIndexForAvatar: jest.fn(() => 0),
            getConversationParticipants: jest.fn(() => []),
            getEffectiveConversationStatus: jest.fn(() => 'online'),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
            getActiveConversationChat: jest.fn(() => ({ id: 'main', messages: storedMessages })),
            getConversationChats: jest.fn(() => [{ id: 'main', name: 'Main' }]),
            getConversationGroupAnchor: jest.fn(() => null),
            getConversationGroupById: jest.fn(() => null),
            getConversationGroupIdForAvatar: jest.fn(() => ''),
            getConversationKey: jest.fn(() => 'conv-1'),
            getConversationPersonaId: jest.fn(() => 'persona-1'),
            getConversationRecord: jest.fn(() => ({ activeChatId: 'main' })),
            getCurrentCharAvatar: jest.fn(() => 'alice.png'),
            getCurrentCharName: jest.fn(() => 'Alice'),
            parsePositiveInt: (v, f) => Number(v) || f,
        }));

        const { conversationState } = await import(pub('scripts/sillybunny-conversation/state.js'));
        const timelineMod = await import(pub('scripts/sillybunny-conversation/timeline-render.js'));

        document.body.innerHTML = '<div id="sheld"><div id="chat"></div></div>';
        timelineMod.ensureConversationChrome();

        const attachBtn = document.querySelector('.sb-conversation-composer-attach');
        expect(attachBtn?.getAttribute('data-sb-conversation-action')).toBe('attach-file');
        expect(document.querySelector('[data-sb-conversation-action="open-composer-menu"]')).not.toBeNull();
        expect(document.querySelector('.sb-conversation-composer-actions')).toBeNull();
        expect(document.querySelector('[data-sb-conversation-action="quick-selfie"]')).toBeNull();

        const input = document.getElementById(CHROME_IDS.input);
        input.value = 'Sounds good';
        timelineMod.replyToConversationMessage('msg-42');
        expect(conversationState.conversationReplyTarget).toEqual(expect.objectContaining({
            messageId: 'msg-42',
            name: 'Alice',
            avatar: 'alice.png',
            chatId: 'main',
        }));
        expect(input.value).toBe('Sounds good');
        expect(input.value).not.toContain('> **Alice');
        const replyPreview = document.getElementById(CHROME_IDS.replyPreview);
        expect(replyPreview.hidden).toBe(false);

        conversationState.conversationReplyTarget = { messageId: '', name: 'Alice', text: 'Orphan' };
        timelineMod.renderConversationComposerReplyPreview();
        expect(replyPreview.hidden).toBe(true);
    });

    test('keeps Conversation DM selection decoupled from roleplay chats and groups and preserves server list order', async () => {
        jest.resetModules();
        const eventSource = new EventEmitter();
        const selectConversation = jest.fn(async () => {});
        const selectCharacterById = jest.fn();
        const openGroupById = jest.fn();
        const listViews = [
            { id: 'conv-newest', kind: 'direct', characters: ['bob.png'], name: '', favorite: false, lastMessageRole: 'character' },
            { id: 'conv-active', kind: 'direct', characters: ['alice.png'], name: '', favorite: false, lastMessageRole: 'user' },
        ];
        const conversationData = {
            list: jest.fn(() => listViews),
            onRemoval: jest.fn(() => () => {}),
            subscribe: jest.fn(() => () => {}),
            whenReady: jest.fn(() => Promise.resolve()),
        };

        await jest.unstable_mockModule(pub('script.js'), () => ({
            characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob', avatar: 'bob.png' }],
            chat: [],
            default_user_avatar: 'default.png',
            getThumbnailUrl: jest.fn(() => ''),
            name1: 'Alex',
            selectCharacterById,
        }));
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
            selected_group: null,
            openGroupById,
        }));
        await jest.unstable_mockModule(pub('scripts/events.js'), () => ({ event_types, eventSource }));
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({ extension_settings: {} }));
        await jest.unstable_mockModule(pub('scripts/personas.js'), () => ({ user_avatar: 'user.png' }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-data-browser.js'), () => ({
            conversationData,
            installConversationDataHooks: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/deletion-guards.js'), () => ({
            generationTargets: {},
            installPageLeaveEffects: jest.fn(),
            installRemovalEffects: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/legacy-import.js'), () => ({
            importLegacyLocalStorage: jest.fn(async () => {}),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/lazy-parts.js'), () => ({
            bindWorkspacePrefetch: jest.fn(),
            disableConversationModeForCurrentCharacter: jest.fn(),
            handleRoleplayCharacterMessage: jest.fn(),
            handleRoleplayUserMessage: jest.fn(),
            installConversationReplyStream: jest.fn(),
            openConversationWorkspaceFromRequest: jest.fn(),
            selectConversation,
            startConversationWorker: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/notifications.js'), () => ({
            getActiveConversationKey: jest.fn(() => 'conv-active'),
            updateConversationNotificationIndicators: jest.fn(),
            updateModeToggleUnread: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/render-scheduler.js'), () => ({
            scheduleConversationListRender: jest.fn(),
            scheduleInterfaceRefresh: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/settings-store.js'), () => ({
            getSettings: jest.fn(() => ({ ...DEFAULT_SETTINGS })),
            hasAnyConversationModeUsage: jest.fn(() => true),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/context.js'), () => ({
            getConversationGroupById: jest.fn(() => null),
            getConversationGroupAnchor: jest.fn(() => null),
            getConversationGroupIdForAvatar: jest.fn(() => ''),
            getConversationPersonaId: jest.fn(() => 'persona-1'),
            getConversationKey: jest.fn(av => (av === 'alice.png' ? 'conv-active' : 'conv-newest')),
            getCurrentCharAvatar: jest.fn(() => 'alice.png'),
            parsePositiveInt: (v, f) => Number(v) || f,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/media.js'), () => ({
            getCharacterForAvatar: jest.fn(av => (av === 'alice.png' ? { name: 'Alice', avatar: 'alice.png' } : { name: 'Bob', avatar: 'bob.png' })),
            getCharacterIndexForAvatar: jest.fn(av => (av === 'alice.png' ? 0 : 1)),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/conversation-store.js'), () => ({
            getConversationMessages: jest.fn(() => []),
            getConversationSeenAt: jest.fn(() => 0),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation/typing.js'), () => ({
            stripPreviewText: s => s,
        }));

        const { conversationState } = await import(pub('scripts/sillybunny-conversation/state.js'));
        const { init } = await import(pub('scripts/sillybunny-conversation/init.js'));
        const { getConversationRailItems } = await import(pub('scripts/sillybunny-conversation/conversation-list.js'));

        conversationState.conversationWorkspaceOpen = true;
        conversationState.conversationReplyTarget = { messageId: 'old' };
        init();

        const items = getConversationRailItems({ personaId: 'persona-1' });
        expect(items.map(item => item.character.avatar)).toEqual(['bob.png', 'alice.png']);
        expect(conversationData.list).toHaveBeenCalledWith({ personaId: 'persona-1' });

        window.dispatchEvent(new CustomEvent('sb:roleplay-character-selected', { detail: { avatar: 'bob.png' } }));
        expect(selectConversation).toHaveBeenCalledWith('bob.png', { showToast: false });
        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(openGroupById).not.toHaveBeenCalled();

        const closedEvents = [];
        window.addEventListener(CONVERSATION_DETAILS_CLOSE_EVENT, () => closedEvents.push(true), { once: true });
        await eventSource.emit(event_types.PERSONA_CHANGED);
        expect(conversationState.conversationReplyTarget).toBeNull();
        expect(closedEvents).toEqual([true]);
    });

    test('suppresses the welcome chat surface while opening a Conversation recent chat and clears after two animation frames', async () => {
        jest.resetModules();
        const rafQueue = [];
        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = jest.fn(cb => {
            rafQueue.push(cb);
            return rafQueue.length;
        });

        let capturedOpenConversation = null;
        let resolveOpen;
        const openPromise = new Promise(resolve => { resolveOpen = resolve; });

        await jest.unstable_mockModule(pub('script.js'), () => ({
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            chat: [],
            deleteCharacterChatByName: jest.fn(),
            displayVersion: '2.0.0',
            doNewChat: jest.fn(),
            event_types,
            eventSource: new EventEmitter(),
            getCharacters: jest.fn(async () => {}),
            getCurrentChatId: jest.fn(() => ''),
            getRequestHeaders: jest.fn(() => ({})),
            getThumbnailUrl: jest.fn(() => ''),
            getMobileThumbnailUrl: jest.fn(() => ''),
            openCharacterChat: jest.fn(),
            printCharactersDebounced: jest.fn(),
            renameGroupOrCharacterChat: jest.fn(),
            saveSettingsDebounced: jest.fn(),
            selectCharacterById: jest.fn(),
            setActiveCharacter: jest.fn(),
            setActiveGroup: jest.fn(),
            system_avatar: '',
            this_chid: undefined,
        }));
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
            deleteGroupChatByName: jest.fn(),
            getGroupAvatar: jest.fn(),
            groups: [],
            openGroupById: jest.fn(),
            openGroupChat: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({ extension_settings: {} }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (s, ...v) => String.raw({ raw: s }, ...v),
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            callGenericPopup: jest.fn(),
            POPUP_TYPE: { CONFIRM: 2, INPUT: 3 },
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({
            confirmVerb: jest.fn(() => ({})),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-focus.js'), () => ({
            bindRovingFocus: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
            renderTemplateAsync: jest.fn(async () => ''),
        }));
        await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({
            accountStorage: { getItem: jest.fn(() => null), setItem: jest.fn() },
        }));
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            clamp: v => v,
            flashHighlight: jest.fn(),
            isElementInViewport: jest.fn(() => true),
            sortMoments: jest.fn(() => 0),
            timestampToMoment: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({
            utilityFormOptions: jest.fn(() => ({})),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/mount.js'), () => ({
            applyDisplayMode: jest.fn(() => 'home'),
            mountHome: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/modes.js'), () => ({
            parseDisplayMode: jest.fn(() => 'home'),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/focus.js'), () => ({
            captureHomeFocus: jest.fn(),
            restoreHomeFocus: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/menu.js'), () => ({
            openChatMenu: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/recent-chat.js'), () => ({
            resolveRecentChatTarget: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-temporary-chat.js'), () => ({
            leaveTemporaryChat: jest.fn(async () => true),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/assistant-registry.js'), () => ({
            ASSISTANT_POINTER_KEY: 'assistant',
            ASSISTANTS: [],
            getAssistant: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/assistant-pointer-migration.js'), () => ({
            migrateAssistantPointer: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/assistant-cards.js'), () => ({
            getAssistantCards: jest.fn(() => []),
            getAssistantPickerEntries: jest.fn(() => []),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/assistant-chat.js'), () => ({
            createAppAssistantActions: jest.fn(deps => {
                capturedOpenConversation = deps.openConversation;
                return {};
            }),
            reportFailure: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-home/assistant-managed-app.js'), () => ({
            createAppManagedAssistants: jest.fn(() => ({})),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-conversation.js'), () => ({
            openConversationWorkspaceForAvatar: jest.fn(() => openPromise),
        }));

        try {
            await import(pub('scripts/welcome-screen.js'));
            document.body.innerHTML = '<div id="chat"></div><div id="form_sheld"></div>';
            const chatEl = document.getElementById('chat');
            const formSheld = document.getElementById('form_sheld');

            const pending = capturedOpenConversation('alice.png', { chatId: 'main', groupId: '', enable: true });
            expect(chatEl.style.visibility).toBe('hidden');
            expect(formSheld.style.visibility).toBe('hidden');

            resolveOpen(true);
            await pending;
            expect(chatEl.style.visibility).toBe('hidden');
            expect(rafQueue).toHaveLength(1);
            rafQueue.shift()();
            expect(chatEl.style.visibility).toBe('hidden');
            expect(rafQueue).toHaveLength(1);
            rafQueue.shift()();
            expect(chatEl.style.visibility).toBe('');
            expect(formSheld.style.visibility).toBe('');
        } finally {
            window.requestAnimationFrame = origRaf;
        }
    });

    test('Pollinations TTS client and speech endpoint send literal text to /v1/audio/speech without prompt wrapping or modalities', async () => {
        // Test PollinationsTtsProvider using the real tts/index.js loaded via loadTtsModule (with skipProviders: ['pollinations.js']).
        const order = [];
        class OrderedProvider {
            settings = {};
            async loadSettings(settings) {
                this.settings = settings;
                order.push('loadSettings');
            }
            async checkReady() {
                order.push('checkReady');
            }
            async fetchTtsVoiceObjects() {
                order.push('fetchVoices');
                return [{ name: 'voice-a', voice_id: 'voice-a', preview_url: false, lang: 'en-US' }];
            }
            async getVoice(name) {
                order.push(`getVoice:${name}`);
                return { name, voice_id: name };
            }
            async* generateTts(text) {
                order.push(`generate:${text}`);
                yield {
                    ok: true,
                    headers: new Headers({ 'content-type': 'audio/mpeg' }),
                    blob: async () => new Blob([text], { type: 'audio/mpeg' }),
                };
            }
        }
        activeTtsHarness = await loadTtsModule({
            skipProviders: ['pollinations.js'],
            ttsSettings: {
                enabled: true,
                currentProvider: 'OrderedProvider',
                OrderedProvider: { voiceMap: { '[Default Voice]': 'voice-a', Alice: 'voice-a' } },
            },
        });
        activeTtsHarness.ttsModule.registerTtsProvider('OrderedProvider', OrderedProvider);
        await activeTtsHarness.ttsModule.init();
        const ok = await activeTtsHarness.ttsModule.narrateTtsMessage(
            { name: 'Alice', mes: 'First sentence.\nSecond sentence.', is_user: false, extra: {} },
            { manual: true, force: true, unrestrictedVoiceMap: true },
        );
        expect(ok).toBe(true);
        for (let i = 0; i < 6; i++) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        expect(order.indexOf('loadSettings')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('loadSettings')).toBeLessThan(order.findIndex(entry => entry.startsWith('generate:')));
        expect(order.filter(entry => entry.startsWith('generate:')).length).toBeGreaterThanOrEqual(1);

        const clientFetchCalls = [];
        globalThis.fetch = jest.fn(async (url, init) => {
            clientFetchCalls.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, blob: async () => new Blob(['audio']) };
        });
        const { PollinationsTtsProvider } = await import(pub('scripts/extensions/tts/pollinations.js'));
        const provider = new PollinationsTtsProvider();
        provider.settings = { model: 'openai-audio', voiceMap: {} };

        const chunks = [];
        for await (const res of provider.fetchTtsGeneration('Literal line to speak', 'nova')) {
            chunks.push(res);
        }
        expect(chunks).toHaveLength(1);
        expect(clientFetchCalls).toEqual([{
            url: '/api/speech/pollinations/generate',
            body: { model: 'openai-audio', text: 'Literal line to speak', voice: 'nova' },
        }]);

        jest.resetModules();
        const upstreamCalls = [];
        const mockFetch = jest.fn(async (url, init) => {
            upstreamCalls.push({ url, init, body: JSON.parse(init.body) });
            return {
                ok: true,
                status: 200,
                headers: new Map([['content-type', 'audio/mpeg']]),
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            };
        });
        await jest.unstable_mockModule('node-fetch', () => ({ default: mockFetch }));
        await jest.unstable_mockModule(srcPath('endpoints/secrets.js'), () => ({
            SECRET_KEYS: { POLLINATIONS: 'api_key_pollinations' },
            readSecret: jest.fn(() => 'poll-key'),
        }));
        await jest.unstable_mockModule(srcPath('util.js'), () => ({
            forwardFetchResponse: jest.fn((_from, to) => to.status(200).send(Buffer.from([1, 2, 3]))),
        }));
        await jest.unstable_mockModule(srcPath('transformers.js'), () => ({
            getPipeline: jest.fn(),
        }));

        const { router } = await import(srcPath('endpoints/speech.js'));
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: {} };
            next();
        });
        app.use(router);

        const server = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const { port } = server.address();
            const resStatus = await new Promise((resolve, reject) => {
                const payload = JSON.stringify({ model: 'openai-audio', text: 'Literal line to speak', voice: 'nova' });
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/pollinations/generate',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                }, res => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                });
                req.on('error', reject);
                req.end(payload);
            });
            expect(resStatus).toBe(200);
            expect(upstreamCalls).toHaveLength(1);
            expect(upstreamCalls[0].url).toBe('https://gen.pollinations.ai/v1/audio/speech');
            expect(upstreamCalls[0].body).toEqual({
                model: 'tts-1',
                input: 'Literal line to speak',
                voice: 'nova',
            });
            expect(upstreamCalls[0].body.modalities).toBeUndefined();
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('waits five seconds by default to coalesce rapid follow-up messages before replying', async () => {
        expect(SEND_QUEUE_COALESCE_MS).toBe(5000);

        const delays = [];
        const queue = [];
        const first = createConversationQueueItem({
            avatar: 'alice.png',
            chatId: 'main',
            personaId: 'persona-1',
            conversationKey: 'conv-1',
            text: 'First line',
            messageIds: ['m1'],
        });
        const second = createConversationQueueItem({
            avatar: 'alice.png',
            chatId: 'main',
            personaId: 'persona-1',
            conversationKey: 'conv-1',
            text: 'Second line',
            messageIds: ['m2'],
        });

        let round = 0;
        const merged = await coalesceConversationQueueItems(first, queue, {
            timeoutRef(cb, ms) {
                delays.push(ms);
                round += 1;
                if (round === 1) {
                    queue.push(second);
                }
                cb();
            },
        });

        expect(delays).toEqual([5000, 5000]);
        expect(merged.text).toBe('First line\n\nSecond line');
        expect(merged.messageIds).toEqual(['m1', 'm2']);
    });
});
