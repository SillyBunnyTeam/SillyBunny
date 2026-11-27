/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

globalThis.HTMLElement = class HTMLElement {};

let currentPersonaId = 'persona-a.png';
const stores = new Map();
const generateConversationRaw = jest.fn();
const saveConversationMessages = jest.fn();
const scheduleTimelineRender = jest.fn();

function key(personaId, avatar, groupId = '') {
    return `${personaId}|${avatar}|${groupId}`;
}

function getStore(personaId, avatar = 'char.png', groupId = '') {
    return stores.get(key(personaId, avatar, groupId));
}

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({ isConversationStylesheetLoading: () => false, setConversationInterfaceActive: jest.fn() }));
await jest.unstable_mockModule('../public/script.js', () => ({ online_status: 'Connected' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationChats: () => [],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getActiveConversationChat: () => null,
    getConversationRecord: (avatar, options = {}) => {
        const store = getStore(options.personaId || currentPersonaId, avatar, options.groupId || '');
        return store ? { id: 'conv_test', activeChatId: store.activeChatId, chats: Object.values(store.chats) } : null;
    },
    getCurrentCharacter: () => ({ avatar: 'char.png', name: 'Aster' }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    parsePositiveInt: value => Number(value) || 0,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationRaw,
    normalizeConversationOutputText: value => String(value || '').trim(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getConversationDisplayName: () => 'Aster',
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
    renderConversationParticipantStack: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    clearUnreadCount: jest.fn(),
    getBadgeLabel: value => String(value || ''),
    getUnreadCount: () => 0,
    isConversationActive: (_avatar, _groupId, options = {}) => options.personaId === currentPersonaId,
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({ getConversationRailItems: () => [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getAvailabilityCopy: () => ({ detail: '', label: 'Online' }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pickers.js', () => ({
    readChimingMembersFromList: () => '',
    readWeeklyScheduleFromEditor: () => '[]',
    updateUserFooter: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    clamp: value => value,
    getCharacterStatus: () => ({ status: 'online', activity: null, source: 'manual' }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getSettings: () => ({ prose_polisher: true }),
    saveSettings: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({
    conversationState: {
        conversationSelectedAvatar: 'char.png',
        conversationSelectedGroupId: null,
        conversationWorkspaceOpen: true,
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationMessages: (avatar, options = {}) => {
        const store = getStore(options.personaId || currentPersonaId, avatar, options.groupId || '');
        return store?.chats?.[options.chatId || store.activeChatId]?.messages || [];
    },
    saveConversationMessages,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({
    renderConversationTimeline: jest.fn(),
    syncSettingsDrawerRows: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/screen-target.js', () => ({ isConversationSwitching: () => false }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/composer-draft.js', () => ({ swapComposerDraft: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getLastConversationPreview: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleTimelineRender,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({ hashConversationRenderFingerprint: value => value }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-folders-browser.js', () => ({
    conversationFolders: { status: () => 'ready', load: jest.fn(), layout: () => ({ folders: [], favoritesExpanded: true, signature: '' }), folderOf: () => '' },
}));

const { handleCharacterMessagePolish } = await import('../public/scripts/sillybunny-conversation/interface.js');

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function message(mes) {
    return { id: 'message-1', role: 'character', name: 'Aster', mes, created_at: 1, extra: {} };
}

describe('Conversation prose polish identity', () => {
    beforeEach(() => {
        currentPersonaId = 'persona-a.png';
        stores.clear();
        stores.set(key('persona-a.png', 'char.png'), {
            activeChatId: 'branch-a',
            chats: {
                'branch-a': { messages: [message('original')] },
                'branch-b': { messages: [message('other branch')] },
            },
        });
        stores.set(key('persona-b.png', 'char.png'), {
            activeChatId: 'branch-b',
            chats: { 'branch-b': { messages: [message('other persona')] } },
        });
        generateConversationRaw.mockReset();
        saveConversationMessages.mockClear();
        scheduleTimelineRender.mockClear();
        globalThis.toastr = { error: jest.fn(), success: jest.fn() };
    });

    test('re-resolves and saves only the captured persona branch after a switch', async () => {
        const generation = deferred();
        generateConversationRaw.mockReturnValueOnce(generation.promise);

        const run = handleCharacterMessagePolish('message-1');
        stores.get(key('persona-a.png', 'char.png')).activeChatId = 'branch-b';
        currentPersonaId = 'persona-b.png';
        generation.resolve('polished original');
        await run;

        expect(stores.get(key('persona-a.png', 'char.png')).chats['branch-a'].messages[0].mes).toBe('polished original');
        expect(stores.get(key('persona-a.png', 'char.png')).chats['branch-b'].messages[0].mes).toBe('other branch');
        expect(stores.get(key('persona-b.png', 'char.png')).chats['branch-b'].messages[0].mes).toBe('other persona');
        expect(saveConversationMessages).toHaveBeenCalledWith('char.png', expect.any(Array), {
            chatId: 'branch-a',
            create: false,
            groupId: '',
            personaId: 'persona-a.png',
        });
        expect(scheduleTimelineRender).not.toHaveBeenCalled();
    });

    test('drops a polish completion when the captured source message changed', async () => {
        const generation = deferred();
        generateConversationRaw.mockReturnValueOnce(generation.promise);
        const sourceMessage = stores.get(key('persona-a.png', 'char.png')).chats['branch-a'].messages[0];

        const run = handleCharacterMessagePolish('message-1');
        sourceMessage.mes = 'edited while polishing';
        generation.resolve('stale polish');
        await run;

        expect(sourceMessage.mes).toBe('edited while polishing');
        expect(saveConversationMessages).not.toHaveBeenCalled();
    });
});
