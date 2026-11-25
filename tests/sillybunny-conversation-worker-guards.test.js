import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { resolveConversationReminderChatId } from '../public/scripts/sillybunny-conversation/conversation-store-utils.js';

const PERSONA = 'persona-a.png';
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

/** The conversations that the page holds, as the data module's cache would answer them. */
const views = new Map();
const patchConversation = jest.fn();
const generateConversationReply = jest.fn();
const postCharacterReply = jest.fn();
const postMemberConversationReply = jest.fn();
let railItems = [];
let member = null;

function makeView(id, { kind = 'direct', characters = ['char.png'], hasUserMessage = true, chats } = {}) {
    const view = {
        id,
        kind,
        personaId: PERSONA,
        characters,
        activeChatId: 'main',
        chats: chats ?? [{ id: 'main', hasUserMessage, messageCount: hasUserMessage ? 2 : 0, lastMessageRole: hasUserMessage ? 'member' : '' }],
        reminders: [],
    };
    views.set(id, view);
    return view;
}

const SETTINGS = {
    cooldown: 0,
    enabled: true,
    proactive_messaging: true,
    inactivity_threshold: 5,
    max_followups: 3,
    multi_char: true,
    multi_char_names: ['member.png'],
    auto_character_chat: true,
};

function railItemFor(view) {
    return {
        character: { avatar: 'char.png', name: 'Aster' },
        settings: SETTINGS,
        groupId: view.kind === 'group' ? view.id : '',
    };
}

await jest.unstable_mockModule('../public/script.js', () => ({ chat: [], is_send_press: false, name1: 'User' }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: (_avatar, { groupId = '' } = {}) => {
        const view = [...views.values()].find(item => (groupId ? item.id === groupId : item.kind === 'direct'));
        return view ? { ...view.chats.find(entry => entry.id === view.activeChatId) } : null;
    },
    getConversationAddress: (_avatar, { groupId = '', chatId = '' } = {}) => {
        const view = [...views.values()].find(item => (groupId ? item.id === groupId : item.kind === 'direct'));
        const entry = view?.chats.find(item => item.id === (chatId || view.activeChatId));
        return entry ? { conversationId: view.id, chatId: entry.id } : null;
    },
    getConversationGroupIdForAvatar: () => '',
    getConversationKey: () => 'conv_1_direct',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? PERSONA : value || ''),
    getConversationRecord: (_avatar, { groupId = '' } = {}) => [...views.values()].find(item => (groupId ? item.id === groupId : item.kind === 'direct')) ?? null,
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    getRoleplayCurrentCharacter: () => ({ avatar: 'char.png' }),
    getRoleplayGroupById: () => null,
    parsePositiveInt: (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: {
        list: () => [...views.values()],
        get: id => views.get(id) ?? null,
        patchConversation,
        loadChat: jest.fn(async () => ({})),
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationReply,
    postCharacterReply,
    postMemberConversationReply,
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({ loadCurrentPanelSettings: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    buildCharacterImagePrompt: () => '',
    generateConversationImage: jest.fn(),
    getCharacterForAvatar: avatar => ({ avatar, name: avatar === 'char.png' ? 'Aster' : 'Birch' }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ appendConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    buildGroupChatContext: () => '',
    getConversationRailItems: () => railItems,
    getCurrentGroupConversationMembers: () => [],
    getGroupAsideKey: () => '',
    getSelectedConversationGroup: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({
    chooseConversationMember: () => member,
    getAllowedMemberCharacters: () => (member ? [member] : []),
    getConversationMemberSettings: (_avatar, settings) => settings,
    getLeastRecentMember: () => member,
    getRecentlySilentMentionedMember: () => null,
    isCharacterMentionedInText: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getConversationPersonaName: () => 'User',
    getUserStatus: () => 'online',
    safeParseWeeklySchedule: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    clamp: (value, min, max) => Math.min(Math.max(value, min), max),
    getCurrentActivityFromSchedule: () => ({ activity: 'reading', status: 'online' }),
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ buildConversationRoleplayContext: () => '' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getAutoCharacterChatCooldownMs: () => 0,
    getConversationChatActivityTime: () => 0,
    getConversationSessionMarker: () => '',
    getFollowupCount: () => 0,
    getLastAutoCharacterChatTime: () => 0,
    getLastUserActivity: () => 0,
    getSettings: () => SETTINGS,
    setConversationSessionMarker: jest.fn(),
    setFollowupCount: jest.fn(),
    setLastAutoCharacterChatTime: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: {},
    groupAsideBusyKeys: new Set(),
    groupAsideLastSent: new Map(),
    memberReplyBusyKeys: new Set(),
    sendQueue: [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timers.js', () => ({
    clearConversationTimeouts: jest.fn(),
    setConversationTimeout: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationMessages: () => [],
    getImageCooldownRemainingSeconds: () => 0,
    markImageGenerated: jest.fn(),
    resolveConversationReminderChatId,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getConversationActivityContext: () => ({ activity: 'reading', source: 'manual', status: 'online' }),
    withTypingParticipant: (_participant, task) => task(),
}));

const {
    checkConversationReminders,
    conversationModeAutoMessageWorker,
    triggerAutoCharacterChat,
    triggerAutoMessage,
    triggerConversationMemberChime,
} = await import('../public/scripts/sillybunny-conversation/auto-engine.js');

const MEMBER = { avatar: 'member.png', name: 'Birch' };

beforeEach(() => {
    views.clear();
    railItems = [];
    member = null;
    for (const mock of [patchConversation, generateConversationReply, postCharacterReply, postMemberConversationReply]) {
        mock.mockReset();
    }
    generateConversationReply.mockResolvedValue('Hello there.');
    postCharacterReply.mockResolvedValue('Hello there.');
    postMemberConversationReply.mockResolvedValue(true);
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

/** Deletes the chat of a conversation while a reply for it is being generated. */
function deleteChatDuringGeneration(view) {
    generateConversationReply.mockImplementation(async () => {
        view.chats = [];
        return 'Hello there.';
    });
}

describe('the worker and a chat that has no message from the user', () => {
    test('does nothing in a direct chat that has none, however long the silence', async () => {
        const view = makeView('conv_1_direct', { hasUserMessage: false });
        railItems = [railItemFor(view)];

        await conversationModeAutoMessageWorker({ signal: new AbortController().signal });

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(postMemberConversationReply).not.toHaveBeenCalled();
    });

    test('does nothing in a group that has none, whatever its members would say to each other', async () => {
        const view = makeView('conv_2_group001', { kind: 'group', characters: ['char.png', 'member.png'], hasUserMessage: false });
        member = MEMBER;
        railItems = [railItemFor(view)];

        await conversationModeAutoMessageWorker({ signal: new AbortController().signal });

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('control: a chat with a message from the user is talked in, so the harness can see the difference', async () => {
        const view = makeView('conv_1_direct', { hasUserMessage: true });
        railItems = [railItemFor(view)];

        await conversationModeAutoMessageWorker({ signal: new AbortController().signal });

        expect(generateConversationReply).toHaveBeenCalled();
    });

    test('does nothing in a chat that lost its last message from the user since the tick began to build its list', async () => {
        const view = makeView('conv_1_direct', { hasUserMessage: true });
        railItems = [railItemFor(view)];
        view.chats[0].hasUserMessage = false;

        await conversationModeAutoMessageWorker({ signal: new AbortController().signal });

        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('a direct call for a chat that has none makes no request either', async () => {
        makeView('conv_1_direct', { hasUserMessage: false });

        const triggered = await triggerAutoMessage('[directive]', SETTINGS, {}, 'char.png', { chatId: 'main', personaId: PERSONA });

        expect(triggered).toBe(false);
        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('a reminder fires there anyway, because the user asked for it', async () => {
        makeView('conv_1_direct', { hasUserMessage: false });

        const triggered = await triggerAutoMessage('[directive]', SETTINGS, { conversation_mode_reminder: true }, 'char.png', { chatId: 'main', personaId: PERSONA, needsUserMessage: false });

        expect(triggered).toBe(true);
        expect(postCharacterReply).toHaveBeenCalled();
    });
});

describe('an automatic reply whose chat is deleted while it is generated', () => {
    test('is not written by triggerAutoMessage', async () => {
        const view = makeView('conv_1_direct');
        deleteChatDuringGeneration(view);

        const triggered = await triggerAutoMessage('[directive]', SETTINGS, {}, 'char.png', { chatId: 'main', personaId: PERSONA });

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postCharacterReply).not.toHaveBeenCalled();
        expect(triggered).toBe(false);
    });

    test('is handed a check that fails once the chat is gone, for the bubbles that follow the first', async () => {
        const view = makeView('conv_1_direct');

        await triggerAutoMessage('[directive]', SETTINGS, {}, 'char.png', { chatId: 'main', personaId: PERSONA });

        const { validateTarget } = postCharacterReply.mock.calls[0][2];
        expect(validateTarget()).toBe(true);
        view.chats = [];
        expect(validateTarget()).toBe(false);
    });

    test('is not written by triggerConversationMemberChime', async () => {
        const view = makeView('conv_2_group001', { kind: 'group', characters: ['char.png', 'member.png'] });
        deleteChatDuringGeneration(view);

        const triggered = await triggerConversationMemberChime(MEMBER, SETTINGS, 'char.png', { chatId: 'main', groupId: view.id, personaId: PERSONA });

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postMemberConversationReply).not.toHaveBeenCalled();
        expect(triggered).toBe(false);
    });

    test('is not written by triggerAutoCharacterChat', async () => {
        const view = makeView('conv_2_group001', { kind: 'group', characters: ['char.png', 'member.png'] });
        member = MEMBER;
        deleteChatDuringGeneration(view);

        const triggered = await triggerAutoCharacterChat('char.png', SETTINGS, { chatId: 'main', groupId: view.id, personaId: PERSONA });

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        expect(postMemberConversationReply).not.toHaveBeenCalled();
        expect(triggered).toBe(false);
    });

    test('is written when the chat is still there, and the writers get a check for the next bubble', async () => {
        const view = makeView('conv_2_group001', { kind: 'group', characters: ['char.png', 'member.png'] });
        member = MEMBER;

        expect(await triggerConversationMemberChime(MEMBER, SETTINGS, 'char.png', { chatId: 'main', groupId: view.id, personaId: PERSONA })).toBe(true);
        expect(await triggerAutoCharacterChat('char.png', SETTINGS, { chatId: 'main', groupId: view.id, personaId: PERSONA })).toBe(true);

        for (const call of postMemberConversationReply.mock.calls) {
            expect(call[3].validateTarget()).toBe(true);
        }
        expect(postMemberConversationReply).toHaveBeenCalledTimes(2);
    });

    test('is not started for a chat that does not exist', async () => {
        makeView('conv_2_group001', { kind: 'group', characters: ['char.png', 'member.png'] });
        member = MEMBER;

        expect(await triggerConversationMemberChime(MEMBER, SETTINGS, 'char.png', { chatId: 'gone', groupId: 'conv_2_group001', personaId: PERSONA })).toBe(false);
        expect(await triggerAutoCharacterChat('char.png', SETTINGS, { chatId: 'gone', groupId: 'conv_2_group001', personaId: PERSONA })).toBe(false);
        expect(generateConversationReply).not.toHaveBeenCalled();
    });
});

describe('a tick', () => {
    test('does not act on a conversation that was deleted earlier in the same tick', async () => {
        const first = makeView('conv_1_direct');
        const second = makeView('conv_2_group001', { kind: 'group', characters: ['char.png', 'member.png'] });
        railItems = [railItemFor(first), railItemFor(second)];
        generateConversationReply.mockImplementation(async () => {
            views.delete(second.id);
            return '';
        });

        await conversationModeAutoMessageWorker({ signal: new AbortController().signal });

        expect(generateConversationReply.mock.calls.length).toBeGreaterThan(0);
        for (const call of generateConversationReply.mock.calls) {
            expect(call[2].groupId || '').not.toBe(second.id);
        }
    });

    test('does not fire a reminder into a chat that was deleted', async () => {
        const view = makeView('conv_1_direct');
        view.reminders = [{ id: 'rem_1_aaaaaa', avatar: 'char.png', chatId: 'gone', text: 'water the plants', triggerAt: 1, fired: false }];

        await expect(checkConversationReminders(NOW)).resolves.toBe(false);

        expect(generateConversationReply).not.toHaveBeenCalled();
    });
});
