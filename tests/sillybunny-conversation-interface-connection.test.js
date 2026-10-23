/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let onlineStatus = 'no_connection';
let currentAvatar = 'char.png';
const elements = new Map();
const conversationState = {
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
    querySelectorAll: () => [],
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationBranches: () => [],
    getConversationGroupById: id => id ? { name: 'Group DM' } : null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona.png',
    getConversationThreadStore: () => null,
    getCurrentCharacter: () => currentAvatar ? { avatar: currentAvatar, name: 'Aster' } : null,
    getCurrentCharAvatar: () => currentAvatar,
    getCurrentCharName: () => 'Aster',
    getIdleActionFromSettings: () => 'disabled',
    parsePositiveInt: value => Number(value) || 0,
    saveGroupConversationSettings: jest.fn(),
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
    isConversationActiveThread: () => false,
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/pals-rail.js', () => ({
    getConversationRailItems: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getAvailabilityCopy: () => ({ detail: '', label: 'Online' }),
}));
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
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/thread-store.js', () => ({
    getConversationThread: () => [],
    saveConversationThread: jest.fn(),
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
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-utils.js', () => ({
    hashConversationRenderFingerprint: value => value,
}));

const { CHROME_IDS } = await import('../public/scripts/sillybunny-conversation/constants.js');

describe('Conversation composer connection state', () => {
    beforeEach(() => {
        jest.resetModules();
        onlineStatus = 'no_connection';
        currentAvatar = 'char.png';
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
        expect(input.placeholder).toBe('Type your message...');
        expect(send.disabled).toBe(false);
    });

    test('keeps the unavailable-group copy when connected without a character', async () => {
        onlineStatus = 'Connected';
        currentAvatar = '';
        conversationState.conversationUnavailableGroupId = 'group-1';

        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(true);
        expect(input.placeholder).toBe('This group has no eligible Conversation members yet...');
        expect(send.disabled).toBe(true);
    });

    test('keeps Send disabled when a connected interface refresh runs during an upload', async () => {
        onlineStatus = 'Connected';
        conversationState.conversationUploadActive = true;
        const { refreshConversationInterface } = await import('../public/scripts/sillybunny-conversation/interface.js');
        refreshConversationInterface();

        expect(input.disabled).toBe(false);
        expect(input.placeholder).toBe('Type your message...');
        expect(send.disabled).toBe(true);
    });
});
