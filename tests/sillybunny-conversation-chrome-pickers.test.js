/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const closeActionMenu = jest.fn();
const openActionMenu = jest.fn();
const enterConversationSelection = jest.fn();
const openEmojiChooser = jest.fn();
const promptConversationText = jest.fn(async () => 'Coffee break');
const setUserPersonaStatus = jest.fn();
const closePicker = jest.fn();
const openPicker = jest.fn(() => ({ isOpen: true }));
const hideConversationPickersSpy = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    default_user_avatar: '',
    getThumbnailUrl: () => '',
    name1: 'User',
}));
await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ debounce_timeout: { short: 50 } }));
await jest.unstable_mockModule('../public/scripts/dynamic-styles.js', () => ({ loadStylesheetAsync: jest.fn(async () => undefined) }));
await jest.unstable_mockModule('../public/scripts/mobile-send-button.js', () => ({ isIOSWebKitPlatform: () => false }));
await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ shouldSendOnEnter: () => true }));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ debounce: fn => fn, flashHighlight: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'u.png' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({ closeActionMenu, openActionMenu }));
await jest.unstable_mockModule('../public/scripts/sillybunny-delete-confirm.js', () => ({ confirmMessageDeletion: jest.fn(async () => false) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-motion.js', () => ({
    MOTION_EASE_OUT_CUBIC: 'ease',
    MOTION_FAST: 150,
    SPRING_SHEET: {},
    play: jest.fn(),
    stopMotion: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker, openPicker }));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/lazy-image.js', () => ({ createLazyImage: () => document.createElement('img') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/sheet-gestures.js', () => ({
    bindSheetGestures: jest.fn(),
    createSheetHandle: () => document.createElement('div'),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/attachments.js', () => ({
    addConversationFilesToInput: jest.fn(),
    clearConversationAttachmentInput: jest.fn(),
    submitConversationInput: jest.fn(),
    updateConversationAttachmentPreview: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/composer-draft.js', () => ({
    stashComposerDraft: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/dialogs.js', () => ({
    confirmConversationAction: jest.fn(async () => false),
    promptConversationText,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    createConversationChat: jest.fn(),
    deleteConversationByAvatar: jest.fn(),
    deleteConversationChat: jest.fn(),
    ensureDirectConversation: jest.fn(),
    getConversationChats: () => [],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationKey: () => '',
    getConversationPersonaId: () => 'u.png',
    getConversationRecord: () => null,
    getCurrentCharAvatar: () => null,
    getRoleplayCurrentCharacter: () => null,
    isAvatarInConversationGroup: () => false,
    makeConversationGroup: jest.fn(),
    parsePositiveInt: () => 0,
    renameConversationChat: jest.fn(),
    setActiveConversationChat: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ editConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/interface.js', () => ({
    getConversationListEntries: () => [],
    handleCharacterMessagePolish: jest.fn(),
    updateConversationHeader: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-controls.js', () => ({
    bindConversationListControls: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-folders-browser.js', () => ({
    conversationFolders: { subscribe: jest.fn(), load: jest.fn() },
    installConversationFoldersHooks: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-view.js', () => ({
    announceInList: jest.fn(),
    setConversationListQuery: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-folders.js', () => ({
    openNewFolderPopover: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: () => null,
    getConversationDisplayName: () => '',
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    clearAllConversationUnreadCounts: jest.fn(async () => ({ cleared: 0, removedLegacy: 0 })),
    isConversationActive: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list.js', () => ({
    getDirectConversations: () => [],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/persona-switch.js', () => ({
    switchConversationPersona: jest.fn(async () => true),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getActiveConversationPersonaAppendixIds: () => [],
    getConversationPersonaAppendices: () => [],
    getPersonaOptions: () => [],
    getUserPersonaStatus: () => '',
    getUserStatus: () => 'online',
    setActiveConversationPersonaAppendixIds: jest.fn(),
    setUserPersonaStatus,
    setUserStatus: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({
    afterConversationRender: jest.fn(),
    scheduleConversationListRender: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-pages.js', () => ({
    closeConversationList: jest.fn(),
    observeConversationLayout: jest.fn(),
    openConversationList: jest.fn(),
    syncConversationPage: jest.fn(),
    toggleConversationList: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({
    getGlobalConversationSettings: () => ({}),
    getSettings: () => ({}),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/screen-target.js', () => ({
    isComposerHeld: () => false,
    withConversationSwitch: fn => fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/send-queue.js', () => ({ processSendQueue: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    getConversationMessageCount: () => 0,
    getConversationMessages: () => [],
    updateLastUserActivity: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { get: () => null },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-actions.js', () => ({
    setConversationMuted: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/selection.js', () => ({
    enterConversationSelection,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-long-press.js', () => ({
    bindMessageLongPress: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-menu.js', () => ({
    openConversationMessageMenuAt: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/timeline-render.js', () => ({
    branchConversationFromMessage: jest.fn(),
    clearConversationReplyTarget: jest.fn(),
    copyConversationMessage: jest.fn(),
    deleteConversationMessage: jest.fn(),
    ensureConversationChrome: jest.fn(),
    generateConversationSelfieFromMessageCommand: jest.fn(),
    quickConversationReminder: jest.fn(),
    quickConversationSelfie: jest.fn(),
    quickConversationSummarize: jest.fn(),
    regenerateConversationMessage: jest.fn(),
    replyToConversationMessage: jest.fn(),
    speakConversationMessage: jest.fn(),
    toggleConversationMessagePin: jest.fn(),
    toggleConversationSearchBar: jest.fn(),
    updateConversationSearchQuery: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reactions-ui.js', () => ({
    openReactionChooser: jest.fn(),
    reactConversationMessage: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/styles.js', () => ({
    ensureDetailsStyles: jest.fn(async () => undefined),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-font.js', () => ({
    applyEmojiFont: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-chooser.js', () => ({
    openEmojiChooser,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/character-picker-options.js', () => ({
    getCharacterPickerOptions: () => ({ items: [] }),
}));

const { CHROME_IDS } = await import('../public/scripts/sillybunny-conversation/constants.js');
const { conversationState } = await import('../public/scripts/sillybunny-conversation/state.js');
const { runConversationAction, setConversationInterfaceActive } = await import('../public/scripts/sillybunny-conversation/chrome.js');
const { editUserPersonaStatus, showConversationPicker } = await import('../public/scripts/sillybunny-conversation/pickers.js');

describe('chrome.js and pickers.js regressions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        hideConversationPickersSpy.mockClear();
        document.body.replaceChildren();
        conversationState.conversationWorkspaceOpen = true;
        window.matchMedia = jest.fn(() => ({ matches: false }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        document.body.replaceChildren();
    });

    test('select-message resolves a hidden menu-only trigger to the visible message menu trigger', async () => {
        const message = document.createElement('article');
        message.className = 'sb-conversation-message';
        const actions = document.createElement('span');
        actions.className = 'sb-conversation-message-actions';
        const selectBtn = document.createElement('button');
        selectBtn.dataset.sbMenuOnly = '';
        const desktopMenu = document.createElement('button');
        desktopMenu.className = 'sb-conversation-message-menu';
        const mobileMenu = document.createElement('button');
        mobileMenu.className = 'sb-conversation-mobile-menu-trigger';
        mobileMenu.style.display = 'none';
        actions.append(selectBtn, desktopMenu);
        message.append(actions, mobileMenu);
        document.body.append(message);

        await runConversationAction('select-message', { messageId: 'm1' }, selectBtn);
        expect(enterConversationSelection).toHaveBeenLastCalledWith('m1', desktopMenu);

        // Coarse pointer / mobile layout where desktop actions are hidden and mobile trigger is visible.
        actions.style.display = 'none';
        mobileMenu.style.display = 'inline-flex';
        await runConversationAction('select-message', { messageId: 'm1' }, selectBtn);
        expect(enterConversationSelection).toHaveBeenLastCalledWith('m1', mobileMenu);

        // When no visible trigger exists, pass null so selection mode falls back to focusing the list.
        mobileMenu.style.display = 'none';
        await runConversationAction('select-message', { messageId: 'm1' }, selectBtn);
        expect(enterConversationSelection).toHaveBeenLastCalledWith('m1', null);
    });

    test('setConversationInterfaceActive(false) closes any open action menu without animation or focus restore', () => {
        const sheld = document.createElement('div');
        sheld.id = 'sheld';
        sheld.dataset.sbConversationMode = 'on';
        document.body.append(sheld);

        setConversationInterfaceActive(false);

        expect(closeActionMenu).toHaveBeenCalledWith({ animate: false, restoreFocus: false });
    });

    test('openComposerEmojiChooser aborts when workspace closes or input disables before opening', async () => {
        const input = document.createElement('textarea');
        input.id = CHROME_IDS.input;
        const trigger = document.createElement('button');
        document.body.append(input, trigger);

        conversationState.conversationWorkspaceOpen = false;
        await runConversationAction('open-emoji-chooser', {}, trigger);
        expect(openEmojiChooser).not.toHaveBeenCalled();

        conversationState.conversationWorkspaceOpen = true;
        await runConversationAction('open-emoji-chooser', {}, trigger);
        expect(openEmojiChooser).toHaveBeenCalledTimes(1);
    });

    test('editUserPersonaStatus hides pickers through hideConversationPickers so backdrop and aria-expanded reset', async () => {
        const anchor = document.createElement('button');
        const backdrop = document.createElement('div');
        backdrop.id = CHROME_IDS.pickerBackdrop;
        const picker = document.createElement('div');
        picker.id = CHROME_IDS.userStatusPicker;
        picker.hidden = true;
        document.body.append(anchor, backdrop, picker);

        showConversationPicker(picker, anchor);
        expect(picker.hidden).toBe(false);
        expect(backdrop.dataset.open).toBe('true');
        expect(anchor.getAttribute('aria-expanded')).toBe('true');

        await editUserPersonaStatus();

        expect(setUserPersonaStatus).toHaveBeenCalledWith('Coffee break');
        expect(picker.hidden).toBe(true);
        expect(backdrop.dataset.open).toBe('false');
        expect(anchor.getAttribute('aria-expanded')).toBe('false');
    });
});
