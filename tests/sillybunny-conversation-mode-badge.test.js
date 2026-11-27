/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// What the page tells the control for the chat mode in the top bar (`sillybunny-tabs.js` draws it): the unread count of
// the conversations, while the user is not in Conversation Mode. The mode publishes the count and its name, and the bar
// reads them.
const TEXT = 'sbConversationUnread';
const NAME = 'sbConversationUnreadName';
const UNREAD_CHANGED = 'sb:conversation-unread-changed';
let totalUnread = 0;
const conversationState = {
    conversationWorkspaceOpen: false,
    faviconUpdateToken: 0,
    originalDocumentTitle: '',
    originalFaviconHref: '',
};

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ playMessageSound: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/lazy-parts.js', () => ({ selectConversation: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({
    CHROME_IDS: { listToggle: 'list-toggle' },
    CONVERSATION_UNREAD_CHANGED_EVENT: UNREAD_CHANGED,
    CONVERSATION_UNREAD_DATASET: { text: TEXT, name: NAME },
    SAFE_TOAST_OPTIONS: {},
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    clearLegacyConversationUnreadStorage: () => 0,
    getCharacterForAvatar: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'persona.png',
    getConversationKey: () => '',
    getConversationRecord: () => ({ chats: [] }),
    getCurrentCharAvatar: () => '',
    shouldSurfaceConversationNotification: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { totalUnread: () => totalUnread },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/preview-utils.js', () => ({ stripPreviewText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState }));

const {
    describeModeToggleUnread,
    updateConversationNotificationIndicators,
    updateModeToggleUnread,
} = await import('../public/scripts/sillybunny-conversation/notifications.js');

describe('the unread count for the control of the chat mode', () => {
    describe('describeModeToggleUnread', () => {
        test('names the count, with the count in the name so that the visible number is part of it', () => {
            expect(describeModeToggleUnread(3, false)).toEqual({ text: '3', name: '3 Unread' });
            expect(describeModeToggleUnread(1, false)).toEqual({ text: '1', name: '1 Unread' });
        });

        test('reads 99+ above 99, in the text and in the name', () => {
            expect(describeModeToggleUnread(99, false)).toEqual({ text: '99', name: '99 Unread' });
            expect(describeModeToggleUnread(100, false)).toEqual({ text: '99+', name: '99+ Unread' });
        });

        test('shows nothing when no message is unread', () => {
            expect(describeModeToggleUnread(0, false)).toBeNull();
            expect(describeModeToggleUnread(-1, false)).toBeNull();
            expect(describeModeToggleUnread(Number.NaN, false)).toBeNull();
        });

        test('shows nothing while Conversation Mode is open, because the list there holds the counts', () => {
            expect(describeModeToggleUnread(5, true)).toBeNull();
        });
    });

    describe('updateModeToggleUnread', () => {
        let events;
        const listener = event => events.push(event.detail);

        beforeEach(() => {
            events = [];
            conversationState.conversationWorkspaceOpen = false;
            window.addEventListener(UNREAD_CHANGED, listener);
        });

        afterEach(() => {
            window.removeEventListener(UNREAD_CHANGED, listener);
            delete document.documentElement.dataset[TEXT];
            delete document.documentElement.dataset[NAME];
        });

        test('writes the text and the name on the root element and says that they changed', () => {
            updateModeToggleUnread(3);

            expect(document.documentElement.dataset[TEXT]).toBe('3');
            expect(document.documentElement.dataset[NAME]).toBe('3 Unread');
            expect(events).toEqual([{ text: '3', name: '3 Unread' }]);
        });

        test('says nothing again while the count stays the same, and says it when the count changes', () => {
            updateModeToggleUnread(3);
            updateModeToggleUnread(3);
            updateModeToggleUnread(4);

            expect(events.map(detail => detail.text)).toEqual(['3', '4']);
        });

        test('removes the text and the name when everything is read, and says it once', () => {
            updateModeToggleUnread(2);
            updateModeToggleUnread(0);
            updateModeToggleUnread(0);

            expect(TEXT in document.documentElement.dataset).toBe(false);
            expect(NAME in document.documentElement.dataset).toBe(false);
            expect(events).toEqual([{ text: '2', name: '2 Unread' }, { text: '', name: '' }]);
        });

        test('removes them while Conversation Mode is open, and writes them again when it closes', () => {
            updateModeToggleUnread(2);
            conversationState.conversationWorkspaceOpen = true;
            updateModeToggleUnread(2);

            expect(TEXT in document.documentElement.dataset).toBe(false);

            conversationState.conversationWorkspaceOpen = false;
            updateModeToggleUnread(2);

            expect(document.documentElement.dataset[TEXT]).toBe('2');
            expect(events.map(detail => detail.text)).toEqual(['2', '', '2']);
        });

        test('is part of the indicators that follow the unread count of the data module', () => {
            totalUnread = 7;

            updateConversationNotificationIndicators();

            expect(document.documentElement.dataset[TEXT]).toBe('7');
            expect(document.documentElement.dataset[NAME]).toBe('7 Unread');

            totalUnread = 0;
            updateConversationNotificationIndicators();

            expect(TEXT in document.documentElement.dataset).toBe(false);
        });

        test('put no dot on the Characters button, because the mode control carries the count', () => {
            document.body.innerHTML = '<div id="rightNavDrawerIcon"></div><div id="rm_button_characters"></div>';
            totalUnread = 4;

            updateConversationNotificationIndicators();

            expect(document.querySelector('#rightNavDrawerIcon *, #rm_button_characters *')).toBeNull();
            totalUnread = 0;
            document.body.innerHTML = '';
        });
    });
});
