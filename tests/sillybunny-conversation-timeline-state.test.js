/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let currentAvatar = 'char.png';
let currentPersonaId = 'persona-a.png';
const stores = new Map();
const extractCharacterReplyCommands = jest.fn(rawText => ({ text: String(rawText || '').trim(), selfieRequests: [] }));
const generateConversationRaw = jest.fn();
const saveConversationThread = jest.fn();

function storeKey(personaId, avatar, groupId = '') {
    return [personaId, avatar, groupId].join('|');
}

function getStore(avatar, groupId, personaId) {
    return stores.get(storeKey(personaId, avatar, groupId)) || null;
}

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    default_user_avatar: 'default.png',
    getThumbnailUrl: () => '',
    messageFormatting: value => value,
    name1: 'User',
}));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_names: [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    createConversationBranch: (name, id = 'new-branch') => ({ id, name, messages: [] }),
    getActiveConversationBranch: (avatar, options = {}) => {
        const store = getStore(avatar, options.groupId || '', options.personaId || currentPersonaId);
        return store?.branches?.[options.branchId || store.activeBranchId] || null;
    },
    getConversationBranches: avatar => Object.values(getStore(avatar, '', currentPersonaId)?.branches || {}),
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getConversationThreadStore: (avatar, options = {}) => getStore(avatar, options.groupId || '', options.personaId || currentPersonaId),
    getCurrentCharAvatar: () => currentAvatar,
    getCurrentCharName: () => 'Aster',
    persistConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    extractCharacterReplyCommands,
    generateConversationRaw,
    generateSelfieFromContext: jest.fn(),
    normalizeConversationOutputText: value => String(value || '').trim(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => ({ avatar, name: 'Aster' }),
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pals-rail.js', () => ({
    getConversationMessageAvatar: () => '',
    getConversationMessageReceipt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/partners.js', () => ({
    escapeRegExp: value => value,
    getCharacterMentionHandles: () => [],
    parseAvatarList: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/prompt.js', () => ({
    buildConversationPromptMessages: async () => [],
    buildConversationSystemPrompt: () => '',
    renderConversationAttachments: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    schedulePalsRailRender: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({
    escapeHtmlAttribute: value => value,
    escapeHtmlText: value => value,
    getConversationMessageExtraFingerprint: () => '',
    hashConversationRenderFingerprint: value => value,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({ getConversationReplyMaxTokens: () => 100 }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-search.js', () => ({ getConversationTimelineMessages: messages => messages }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-slash-commands.js', () => ({
    appendConversationOocNote: jest.fn(),
    handleConversationSlashAction: jest.fn(),
    parseConversationReminderArgs: jest.fn(),
    parseConversationSlashCommand: jest.fn(),
    quickConversationSummarize: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/tts.js', () => ({ narrateConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
    addConversationReminder: jest.fn(),
    buildConversationMessageReplyReference: message => ({
        messageId: message.id,
        name: message.name,
        role: message.role,
        text: message.mes,
    }),
    getConversationAttachmentSummary: () => '',
    getConversationMessagePreviewText: message => message?.mes || '',
    getConversationSeenAt: () => 0,
    getConversationThread: (avatar, options = {}) => {
        const store = getStore(avatar, options.groupId || '', options.personaId || currentPersonaId);
        return store?.branches?.[options.branchId || store.activeBranchId]?.messages || [];
    },
    saveConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getPrimaryTypingParticipant: () => null,
    updateLastPreviewFromConversation: jest.fn(),
    withTypingParticipant: (_participant, task) => task(),
}));

const stateModule = await import('../public/scripts/sillybunny-conversation/state.js');
const {
    getActiveConversationReplyTarget,
    regenerateConversationMessage,
} = await import('../public/scripts/sillybunny-conversation/timeline-render.js');

function makeMessage(id, mes = `message ${id}`) {
    return {
        id,
        role: 'character',
        name: 'Aster',
        mes,
        created_at: 1,
        extra: {},
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('conversation timeline operation identity', () => {
    beforeEach(() => {
        currentAvatar = 'char.png';
        currentPersonaId = 'persona-a.png';
        stores.clear();
        stores.set(storeKey('persona-a.png', 'char.png'), {
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': { id: 'branch-a', messages: [makeMessage('message-1'), makeMessage('message-2')] },
                'branch-b': { id: 'branch-b', messages: [makeMessage('branch-b-message')] },
            },
        });
        stores.set(storeKey('persona-b.png', 'char.png'), {
            activeBranchId: 'branch-b',
            branches: { 'branch-b': { id: 'branch-b', messages: [makeMessage('persona-b-message')] } },
        });
        generateConversationRaw.mockReset();
        extractCharacterReplyCommands.mockReset().mockImplementation(rawText => ({ text: String(rawText || '').trim(), selfieRequests: [] }));
        saveConversationThread.mockClear();
        stateModule.regenerationBusyKeys.clear();
        stateModule.activeConversationGenerationOperations.clear();
        stateModule.activeConversationReplyOperations.clear();
        stateModule.conversationState.externalGenerationActive = false;
        stateModule.conversationState.conversationReplyBusy = false;
        stateModule.conversationState.generationActive = false;
        stateModule.conversationState.conversationReplyTarget = null;
        globalThis.toastr = { success: jest.fn(), warning: jest.fn() };
    });

    test('isolates and clears reply targets when persona or branch changes', () => {
        stateModule.conversationState.conversationReplyTarget = {
            avatar: 'char.png',
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            messageId: 'message-1',
            text: 'message 1',
        };
        expect(getActiveConversationReplyTarget()).not.toBeNull();

        stores.get(storeKey('persona-a.png', 'char.png')).activeBranchId = 'branch-b';
        expect(getActiveConversationReplyTarget()).toBeNull();
        expect(stateModule.conversationState.conversationReplyTarget).toBeNull();

        stateModule.conversationState.conversationReplyTarget = {
            avatar: 'char.png',
            branchId: 'branch-b',
            groupId: '',
            personaId: 'persona-a.png',
            messageId: 'branch-b-message',
            text: 'branch message',
        };
        currentPersonaId = 'persona-b.png';
        expect(getActiveConversationReplyTarget()).toBeNull();
    });

    test('guards duplicate regeneration and keeps busy state until all operations finish', async () => {
        const first = deferred();
        const second = deferred();
        generateConversationRaw
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);

        const firstRun = regenerateConversationMessage('message-1');
        const duplicateRun = regenerateConversationMessage('message-1');
        const secondRun = regenerateConversationMessage('message-2');
        await Promise.resolve();
        expect(generateConversationRaw).toHaveBeenCalledTimes(2);
        expect(stateModule.conversationState.conversationReplyBusy).toBe(true);

        first.resolve('first replacement');
        await firstRun;
        await duplicateRun;
        expect(stateModule.conversationState.conversationReplyBusy).toBe(true);

        second.resolve('second replacement');
        await secondRun;
        expect(stateModule.conversationState.conversationReplyBusy).toBe(false);
    });

    test('applies completion only to its captured persona and branch', async () => {
        const generation = deferred();
        generateConversationRaw.mockImplementationOnce(() => generation.promise);
        const oldMessage = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];
        const newPersonaMessage = stores.get(storeKey('persona-b.png', 'char.png')).branches['branch-b'].messages[0];

        const run = regenerateConversationMessage('message-1');
        currentPersonaId = 'persona-b.png';
        generation.resolve('captured replacement');
        await run;

        expect(oldMessage.mes).toBe('captured replacement');
        expect(newPersonaMessage.mes).toBe('message persona-b-message');
    });

    test('drops a stale regeneration completion after the source message is revised', async () => {
        const generation = deferred();
        generateConversationRaw.mockImplementationOnce(() => generation.promise);
        const message = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];

        const run = regenerateConversationMessage('message-1');
        message.mes = 'edited while generating';
        generation.resolve('stale replacement');
        await run;

        expect(message.mes).toBe('edited while generating');
        expect(saveConversationThread).not.toHaveBeenCalled();
    });

    test('drops a regeneration completion after preceding prompt context changes', async () => {
        const generation = deferred();
        generateConversationRaw.mockImplementationOnce(() => generation.promise);
        const messages = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages;

        const run = regenerateConversationMessage('message-2');
        messages[0].mes = 'preceding context edited';
        generation.resolve('stale replacement');
        await run;

        expect(messages[1].mes).toBe('message message-2');
        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(extractCharacterReplyCommands).not.toHaveBeenCalled();
    });

    test('parses regeneration commands once and replaces stale command metadata', async () => {
        extractCharacterReplyCommands.mockReturnValueOnce({
            text: 'clean replacement',
            selfieRequests: ['at the park'],
        });
        generateConversationRaw.mockResolvedValueOnce('clean replacement [selfie: context="at the park"]');
        const message = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];
        message.extra.conversation_commands = { selfieRequests: ['stale request'], stale: true };

        await regenerateConversationMessage('message-1');

        expect(extractCharacterReplyCommands).toHaveBeenCalledTimes(1);
        expect(message.mes).toBe('clean replacement');
        expect(message.extra.conversation_commands).toEqual({ selfieRequests: ['at the park'] });
    });

    test('removes stale command metadata when regenerated output has no commands', async () => {
        generateConversationRaw.mockResolvedValueOnce('plain replacement');
        const message = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];
        message.extra.conversation_commands = { selfieRequests: ['stale request'] };

        await regenerateConversationMessage('message-1');

        expect(message.extra.conversation_commands).toBeUndefined();
    });
});
