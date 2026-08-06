/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

globalThis.HTMLElement = class HTMLElement {};

let currentPersonaId = 'persona-a.png';
const stores = new Map();
const generateConversationRaw = jest.fn();
const saveConversationThread = jest.fn();
const scheduleTimelineRender = jest.fn();

function key(personaId, avatar, groupId = '') {
    return `${personaId}|${avatar}|${groupId}`;
}

function getStore(personaId, avatar = 'char.png', groupId = '') {
    return stores.get(key(personaId, avatar, groupId));
}

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({ setConversationInterfaceActive: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationBranches: () => [],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getConversationThreadStore: (avatar, options = {}) => getStore(options.personaId || currentPersonaId, avatar, options.groupId || ''),
    getCurrentCharacter: () => ({ avatar: 'char.png', name: 'Aster' }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    getIdleActionFromSettings: () => 'disabled',
    parsePositiveInt: value => Number(value) || 0,
    saveGroupConversationSettings: jest.fn(),
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
    isConversationActiveThread: (_avatar, _groupId, options = {}) => options.personaId === currentPersonaId,
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pals-rail.js', () => ({ getConversationRailItems: () => [] }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({ getAvailabilityCopy: () => ({ detail: '', label: 'Online' }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pickers.js', () => ({
    readChimingPartnersFromList: () => '',
    readWeeklyScheduleFromEditor: () => '[]',
    updateUserFooter: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({
    clamp: value => value,
    getConversationReplyMaxTokens: () => 100,
    getCurrentActivityFromSchedule: () => null,
    getStoredSchedule: () => null,
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
    getConversationThread: (avatar, options = {}) => {
        const store = getStore(options.personaId || currentPersonaId, avatar, options.groupId || '');
        return store?.branches?.[options.branchId || store.activeBranchId]?.messages || [];
    },
    saveConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({
    renderConversationTimeline: jest.fn(),
    updateConversationNotificationSettingsVisibility: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getLastConversationPreview: () => '',
    updateLastPreviewFromConversation: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleTimelineRender,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({ hashConversationRenderFingerprint: value => value }));

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
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': { messages: [message('original')] },
                'branch-b': { messages: [message('other branch')] },
            },
        });
        stores.set(key('persona-b.png', 'char.png'), {
            activeBranchId: 'branch-b',
            branches: { 'branch-b': { messages: [message('other persona')] } },
        });
        generateConversationRaw.mockReset();
        saveConversationThread.mockClear();
        scheduleTimelineRender.mockClear();
        globalThis.toastr = { error: jest.fn(), success: jest.fn() };
    });

    test('re-resolves and saves only the captured persona branch after a switch', async () => {
        const generation = deferred();
        generateConversationRaw.mockReturnValueOnce(generation.promise);

        const run = handleCharacterMessagePolish('message-1');
        stores.get(key('persona-a.png', 'char.png')).activeBranchId = 'branch-b';
        currentPersonaId = 'persona-b.png';
        generation.resolve('polished original');
        await run;

        expect(stores.get(key('persona-a.png', 'char.png')).branches['branch-a'].messages[0].mes).toBe('polished original');
        expect(stores.get(key('persona-a.png', 'char.png')).branches['branch-b'].messages[0].mes).toBe('other branch');
        expect(stores.get(key('persona-b.png', 'char.png')).branches['branch-b'].messages[0].mes).toBe('other persona');
        expect(saveConversationThread).toHaveBeenCalledWith('char.png', expect.any(Array), {
            branchId: 'branch-a',
            create: false,
            groupId: '',
            personaId: 'persona-a.png',
        });
        expect(scheduleTimelineRender).not.toHaveBeenCalled();
    });

    test('drops a polish completion when the captured source message changed', async () => {
        const generation = deferred();
        generateConversationRaw.mockReturnValueOnce(generation.promise);
        const sourceMessage = stores.get(key('persona-a.png', 'char.png')).branches['branch-a'].messages[0];

        const run = handleCharacterMessagePolish('message-1');
        sourceMessage.mes = 'edited while polishing';
        generation.resolve('stale polish');
        await run;

        expect(sourceMessage.mes).toBe('edited while polishing');
        expect(saveConversationThread).not.toHaveBeenCalled();
    });
});
