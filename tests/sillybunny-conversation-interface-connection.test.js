/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let onlineStatus = 'no_connection';
let currentAvatar = 'char.png';
let openChat = null;
let switching = false;
let conversationRecord = null;
let toolButtons = [];
const renderConversationTimeline = jest.fn();
const swapComposerDraft = jest.fn();
const elements = new Map();
const conversationState = {
    lastRenderedConversationKey: '',
    conversationUnavailableGroupId: null,
    conversationUploadActive: false,
    conversationWorkspaceOpen: true,
};

globalThis.HTMLElement = class HTMLElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement extends HTMLElement {};
globalThis.HTMLButtonElement = class HTMLButtonElement extends HTMLElement {};
const input = new HTMLTextAreaElement();
const send = new HTMLButtonElement();
globalThis.document = {
    getElementById: id => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: selector => String(selector).includes('sb-conversation-composer-tool') ? toolButtons : [],
};

await jest.unstable_mockModule('../public/script.js', () => ({
    get online_status() {
        return onlineStatus;
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({
    isConversationStylesheetLoading: () => false,
    setConversationInterfaceActive: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { setOpen: jest.fn(), chat: () => null, loadChat: jest.fn(async () => null) },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getActiveConversationChat: () => openChat,
    getConversationChats: () => [],
    getConversationGroupById: id => id ? { name: 'Group DM' } : null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona.png',
    getConversationRecord: () => conversationRecord,
    getCurrentCharacter: () => currentAvatar ? { avatar: currentAvatar, name: 'Aster' } : null,
    getCurrentCharAvatar: () => currentAvatar,
    getCurrentCharName: () => 'Aster',
    parsePositiveInt: value => Number(value) || 0,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    generateConversationRaw: jest.fn(),
    normalizeConversationOutputText: value => String(value || '').trim(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-identity-utils.js', () => ({
    getConversationMessageRevision: jest.fn(),
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
    isConversationActive: () => false,
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    getConversationRailItems: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getAvailabilityCopy: () => ({ detail: '', label: 'Online' }),
}));
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationMessages: () => [],
    saveConversationMessages: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({
    renderConversationTimeline,
    syncSettingsDrawerRows: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/screen-target.js', () => ({
    isConversationSwitching: () => switching,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/composer-draft.js', () => ({
    swapComposerDraft,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getLastConversationPreview: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({
    hashConversationRenderFingerprint: value => value,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-folders-browser.js', () => ({
    conversationFolders: { status: () => 'ready', load: jest.fn(), layout: () => ({ folders: [], favoritesExpanded: true, signature: '' }), folderOf: () => '' },
}));

const { CHROME_IDS } = await import('../public/scripts/sillybunny-conversation/constants.js');

describe('Conversation composer connection state', () => {
    beforeEach(() => {
        jest.resetModules();
        onlineStatus = 'no_connection';
        currentAvatar = 'char.png';
        openChat = null;
        switching = false;
        conversationRecord = null;
        toolButtons = [];
        renderConversationTimeline.mockReset();
        swapComposerDraft.mockReset();
        conversationState.lastRenderedConversationKey = '';
        conversationState.conversationUnavailableGroupId = null;
        conversationState.conversationUploadActive = false;
        conversationState.conversationWorkspaceOpen = true;
        Object.assign(input, { disabled: false, placeholder: '' });
        Object.assign(send, { disabled: false });
        elements.clear();
        elements.set(CHROME_IDS.input, input);
        elements.set(CHROME_IDS.send, send);
    });

    test('disables sending with the exact offline placeholder', async () => {
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(false);
        expect(input.placeholder).toBe('Not connected to API!');
        expect(send.disabled).toBe(true);
    });

    test('enables sending with the normal placeholder when connected', async () => {
        onlineStatus = 'Connected';
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(false);
        expect(input.placeholder).toBe('Type your message…');
        expect(send.disabled).toBe(false);
    });

    test('keeps the unavailable-group copy when connected without a character', async () => {
        onlineStatus = 'Connected';
        currentAvatar = '';
        conversationState.conversationUnavailableGroupId = 'group-1';

        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(true);
        expect(input.placeholder).toBe('This group has no eligible Conversation members yet…');
        expect(send.disabled).toBe(true);
    });

    test('keeps the composer off while the chat that is open is being read from the server', async () => {
        onlineStatus = 'Connected';
        openChat = { id: 'main', loaded: false };
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(true);
        expect(send.disabled).toBe(true);

        openChat = { id: 'main', loaded: true };
        refreshConversationInterface();

        expect(input.disabled).toBe(false);
        expect(send.disabled).toBe(false);
    });

    test('keeps Send disabled when a connected interface refresh runs during an upload', async () => {
        onlineStatus = 'Connected';
        conversationState.conversationUploadActive = true;
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(false);
        expect(input.placeholder).toBe('Type your message…');
        expect(send.disabled).toBe(true);
    });

    test('keeps the composer off from the start of a switch to another conversation until it ends, so that nothing is sent to the new one from the old one', async () => {
        onlineStatus = 'Connected';
        const tool = new HTMLButtonElement();
        toolButtons = [tool];
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        switching = true;
        refreshConversationInterface();

        expect(input.disabled).toBe(true);
        expect(send.disabled).toBe(true);
        expect(tool.disabled).toBe(true);

        switching = false;
        refreshConversationInterface();

        expect(input.disabled).toBe(false);
        expect(send.disabled).toBe(false);
        expect(tool.disabled).toBe(false);
    });

    test('moves the draft out of the composer, and the draft of the conversation that is drawn into it, when the timeline draws another conversation', async () => {
        onlineStatus = 'Connected';
        conversationState.lastRenderedConversationKey = 'drawn-before';
        renderConversationTimeline.mockImplementation(() => {
            conversationState.lastRenderedConversationKey = 'drawn-now';
        });
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(swapComposerDraft).toHaveBeenCalledTimes(1);
        expect(swapComposerDraft).toHaveBeenCalledWith('drawn-before', 'drawn-now', '');
    });

    test('tells the draft store which conversation is drawn by its id, so that a conversation made after another one was deleted is not given that one\'s draft', async () => {
        onlineStatus = 'Connected';
        conversationRecord = { id: 'conv_2', activeChatId: 'main' };
        renderConversationTimeline.mockImplementation(() => {
            conversationState.lastRenderedConversationKey = 'drawn-now';
        });
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(swapComposerDraft).toHaveBeenCalledWith('', 'drawn-now', 'conv_2');
    });

    test('moves no draft while the workspace is closed, since nothing is drawn', async () => {
        conversationState.conversationWorkspaceOpen = false;
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(swapComposerDraft).not.toHaveBeenCalled();
    });
});
