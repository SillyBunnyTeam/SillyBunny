/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const VIEWER = '../public/scripts/sillybunny-avatar-viewer.js';
const SCRIPT = '../public/script.js';
const POWER_USER = '../public/scripts/power-user.js';
const MOVING_UI = '../public/scripts/RossAscends-mods.js';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const jquerySource = readFileSync(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8');
// The markup of the app itself, so that the test follows the template when the template changes.
const templateHtml = indexHtml.match(/<div id="zoomed_avatar_template"[\s\S]*?\n {8}<\/div>\n/)?.[0] ?? '';

let viewer;
let powerUser;
let loadMovingUIState;
let dragElement;

beforeEach(async () => {
    jest.resetModules();
    (0, eval)(jquerySource);
    $.fx.off = true;
    document.body.innerHTML = templateHtml;
    powerUser = { movingUI: false, zoomed_avatar_magnification: false };
    loadMovingUIState = jest.fn();
    dragElement = jest.fn();
    await jest.unstable_mockModule(SCRIPT, () => ({ animation_duration: 0, characters: [] }));
    await jest.unstable_mockModule(POWER_USER, () => ({ power_user: powerUser, loadMovingUIState }));
    await jest.unstable_mockModule(MOVING_UI, () => ({ dragElement, shouldSendOnEnter: () => true }));
    viewer = await import(VIEWER);
});

afterEach(() => {
    document.body.replaceChildren();
});

const zoomed = () => [...document.querySelectorAll('.zoomed_avatar[forChar]')];

describe('the key of a zoomed avatar', () => {
    test('is the avatar file without its extension, as roleplay has always named it', () => {
        expect(viewer.getZoomedAvatarKey('Seraphina.png')).toBe('Seraphina');
        expect(viewer.getZoomedAvatarKey('Alice Smith.png')).toBe('Alice Smith');
    });
});

describe('opening a zoomed avatar', () => {
    test('puts a draggable window with the character\'s picture in the body, under roleplay\'s id and key', () => {
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        const [avatar] = zoomed();
        expect(zoomed()).toHaveLength(1);
        expect(avatar.parentElement).toBe(document.body);
        expect(avatar.id).toBe('zoomFor_Seraphina');
        expect(avatar.getAttribute('forChar')).toBe('Seraphina');
        expect(avatar.classList.contains('draggable')).toBe(true);
        expect(avatar.querySelector('.drag-grabber').id).toBe('zoomFor_Seraphinaheader');
        expect(avatar.querySelector('img').getAttribute('src')).toBe('/characters/Seraphina.png');
        expect(avatar.querySelector('img').getAttribute('data-izoomify-url')).toBe('/characters/Seraphina.png');
        expect(avatar.style.display).toBe('flex');
    });

    test('loads the saved Moving UI position and makes the window draggable, in that order, once the window is in the page', () => {
        const calls = [];
        loadMovingUIState.mockImplementation(() => calls.push(['load', zoomed().length]));
        dragElement.mockImplementation(element => calls.push(['drag', element[0].id]));

        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        expect(calls).toEqual([['load', 1], ['drag', 'zoomFor_Seraphina']]);
    });

    test('shows the picture it is given when that is not the card picture, as roleplay does for a persona', () => {
        viewer.toggleZoomedAvatar({ file: 'user-default.png', src: '/User%20Avatars/user-default.png' });

        const image = zoomed()[0].querySelector('img');
        expect(image.getAttribute('src')).toBe('/User%20Avatars/user-default.png');
        expect(image.getAttribute('data-izoomify-url')).toBe('/User%20Avatars/user-default.png');
    });
});

describe('toggling a zoomed avatar', () => {
    test('closes it when it is already open', () => {
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        expect(zoomed()).toHaveLength(0);
    });

    test('opens it again after it was closed', () => {
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        expect(zoomed()).toHaveLength(1);
    });

    test('finds an open avatar whose key has a quote in it', () => {
        viewer.toggleZoomedAvatar({ file: 'The "Duke".png' });
        viewer.toggleZoomedAvatar({ file: 'The "Duke".png' });

        expect(zoomed()).toHaveLength(0);
    });
});

describe('the Close control of a zoomed avatar', () => {
    test('closes its own window and leaves the others', () => {
        powerUser.movingUI = true;
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Reisen.png' });

        zoomed()[0].querySelector('.dragClose').click();

        expect(zoomed().map(element => element.id)).toEqual(['zoomFor_Reisen']);
    });

    test('does not close the window when the press is anywhere else on it', () => {
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        zoomed()[0].querySelector('img').click();

        expect(zoomed()).toHaveLength(1);
    });
});

describe('the picture of a zoomed avatar', () => {
    test('is not dragged out of the window as an image', () => {
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        const drag = new Event('dragstart', { bubbles: true, cancelable: true });
        zoomed()[0].querySelector('img').dispatchEvent(drag);

        expect(drag.defaultPrevented).toBe(true);
    });

    test('is magnified on hover only when the setting is on', () => {
        const izoomify = jest.fn();
        $.fn.izoomify = izoomify;

        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        expect(izoomify).not.toHaveBeenCalled();

        powerUser.zoomed_avatar_magnification = true;
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });

        expect(izoomify).toHaveBeenCalledTimes(1);
        expect(izoomify.mock.contexts[0].hasClass('zoomed_avatar_container')).toBe(true);
    });
});

describe('opening a second avatar', () => {
    test('closes the first when Moving UI is off', () => {
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Reisen.png' });

        expect(zoomed().map(element => element.id)).toEqual(['zoomFor_Reisen']);
    });

    test('keeps the first when Moving UI is on, so that windows can be placed side by side', () => {
        powerUser.movingUI = true;

        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        viewer.toggleZoomedAvatar({ file: 'Reisen.png' });

        expect(zoomed().map(element => element.id)).toEqual(['zoomFor_Seraphina', 'zoomFor_Reisen']);
    });
});

describe('the two modes', () => {
    const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
    const resolvePublic = relativePath => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));

    test('share the window: conversation mode opens the shared viewer and has no rule that places a copy', async () => {
        const noop = () => {};
        const noopAsync = async () => {};
        const mocks = [
            ['scripts/constants.js', { debounce_timeout: { quick: 0, normal: 0, relaxed: 0 } }],
            ['scripts/dynamic-styles.js', { loadStylesheetAsync: noopAsync }],
            ['scripts/mobile-send-button.js', { isIOSWebKitPlatform: () => false }],
            ['scripts/RossAscends-mods.js', { shouldSendOnEnter: () => true, dragElement }],
            ['scripts/utils.js', { debounce: fn => fn, flashHighlight: noop }],
            ['scripts/sillybunny-delete-confirm.js', { confirmMessageDeletion: noopAsync }],
            ['scripts/sillybunny-action-menu.js', { closeActionMenu: noop, openActionMenu: noop }],
            ['scripts/sillybunny-conversation/attachments.js', { addConversationFilesToInput: noop, clearConversationAttachmentInput: noop, submitConversationInput: noopAsync, updateConversationAttachmentPreview: noop }],
            ['scripts/sillybunny-conversation/composer-draft.js', { stashComposerDraft: noop }],
            ['scripts/sillybunny-conversation/constants.js', { CHROME_IDS: {}, CONVERSATION_OPENED_EVENT: 'opened' }],
            ['scripts/sillybunny-conversation/dialogs.js', { confirmConversationAction: noopAsync, promptConversationText: noopAsync }],
            ['scripts/sillybunny-conversation/context.js', {
                createConversationChat: noop, deleteConversationByAvatar: noopAsync, deleteConversationChat: noopAsync,
                ensureDirectConversation: noopAsync, getConversationChats: () => [], getConversationGroupIdForAvatar: () => '',
                getConversationPersonaId: () => '', getConversationKey: () => '', getConversationRecord: () => null,
                getCurrentCharAvatar: () => '', getRoleplayCurrentCharacter: () => null, isAvatarInConversationGroup: () => false,
                parsePositiveInt: () => -1, renameConversationChat: noop, setActiveConversationChat: noop,
            }],
            ['scripts/sillybunny-conversation/generation.js', { editConversationMessage: noop }],
            ['scripts/sillybunny-conversation/interface.js', { getConversationListEntries: () => [], handleCharacterMessagePolish: noopAsync, updateConversationHeader: noop }],
            ['scripts/sillybunny-conversation/conversation-list-controls.js', { bindConversationListControls: noop }],
            ['scripts/sillybunny-conversation/conversation-folders-browser.js', { conversationFolders: {}, installConversationFoldersHooks: noop }],
            ['scripts/sillybunny-conversation/conversation-menus.js', { buildComposerMenuSections: () => [], buildHeaderMenuSections: () => [], buildMainMenuSections: () => [], buildNewMenuSections: () => [] }],
            ['scripts/sillybunny-conversation/conversation-list-view.js', { announceInList: noop, setConversationListQuery: noop }],
            ['scripts/sillybunny-conversation/conversation-list-folders.js', { openNewFolderPopover: noop }],
            ['scripts/sillybunny-conversation/media.js', { getCharacterForAvatar: () => null, getConversationDisplayName: () => '' }],
            ['scripts/sillybunny-conversation/notifications.js', { clearAllConversationUnreadCounts: noopAsync, isConversationActive: () => false }],
            ['scripts/sillybunny-conversation/conversation-list.js', { getDirectConversations: () => [] }],
            ['scripts/sillybunny-conversation/persona-switch.js', { switchConversationPersona: noopAsync }],
            ['scripts/sillybunny-conversation/personas.js', { getUserStatus: () => 'online', setActiveConversationPersonaAppendixIds: noop, setUserStatus: noop }],
            ['scripts/sillybunny-conversation/pickers.js', { editUserPersonaStatus: noop, hideConversationPickers: noop, renderConversationPersonaPicker: noop, toggleStartDirectConversationPicker: noop, toggleConversationGroupPicker: noop, togglePersonaPicker: noop, toggleUserStatusPicker: noop, updateUserFooter: noop }],
            ['scripts/sillybunny-conversation/render-scheduler.js', { afterConversationRender: noop, scheduleInterfaceRefresh: noop, scheduleConversationListRender: noop, scheduleTimelineRender: noop }],
            ['scripts/sillybunny-conversation/conversation-pages.js', { closeConversationList: noop, observeConversationLayout: noop, openConversationList: noop, syncConversationPage: noop, toggleConversationList: noop }],
            ['scripts/sillybunny-conversation/settings-store.js', { getGlobalConversationSettings: () => ({}), getSettings: () => ({}) }],
            ['scripts/sillybunny-conversation/screen-target.js', { isComposerHeld: () => false, withConversationSwitch: fn => fn() }],
            ['scripts/sillybunny-conversation/state.js', { conversationState: {}, sendQueue: [] }],
            ['scripts/sillybunny-conversation/send-queue.js', { processSendQueue: noopAsync }],
            ['scripts/sillybunny-conversation/send-queue-utils.js', { createForcedConversationQueueItem: () => ({}) }],
            ['scripts/sillybunny-conversation/conversation-store.js', { getConversationMessageCount: () => 0, getConversationMessages: () => [], updateLastUserActivity: noop }],
            ['scripts/sillybunny-conversation/pin-events-ui.js', { PIN_EVENT_ACTIONS: { show: 'show', openPinned: 'open' }, findMessageNode: () => null }],
            ['scripts/sillybunny-conversation/pin-model.js', { hasPinnedMessage: () => false }],
            ['scripts/sillybunny-conversation/conversation-data-browser.js', { conversationData: {} }],
            ['scripts/sillybunny-conversation/conversation-list-actions.js', { setConversationMuted: noop }],
            ['scripts/sillybunny-conversation/selection.js', { enterConversationSelection: noop }],
            ['scripts/sillybunny-conversation/message-long-press.js', { bindMessageLongPress: noop }],
            ['scripts/sillybunny-conversation/message-menu.js', { openConversationMessageMenuAt: noop }],
            ['scripts/sillybunny-conversation/timeline-render.js', {
                branchConversationFromMessage: noopAsync, clearConversationReplyTarget: noop, copyConversationMessage: noopAsync,
                deleteConversationMessage: noop, generateConversationSelfieFromMessageCommand: noopAsync, ensureConversationChrome: noop,
                quickConversationReminder: noopAsync, quickConversationSelfie: noopAsync, quickConversationSummarize: noopAsync,
                regenerateConversationMessage: noopAsync, replyToConversationMessage: noop, toggleConversationSearchBar: noop,
                speakConversationMessage: noopAsync, toggleConversationMessagePin: noop, updateConversationSearchQuery: noop,
            }],
            ['scripts/sillybunny-conversation/reactions-ui.js', { openReactionChooser: noopAsync, reactConversationMessage: noop }],
            ['scripts/sillybunny-conversation/details/styles.js', { ensureDetailsStyles: noopAsync }],
            ['scripts/sillybunny-conversation/emoji/emoji-font.js', { applyEmojiFont: noop }],
            ['scripts/sillybunny-conversation/emoji/emoji-insert.js', { insertEmojiAtCaret: () => 0 }],
            ['scripts/sillybunny-conversation/emoji/emoji-shortcut.js', { hasNativeEmojiPicker: () => false, isEmojiShortcut: () => false }],
        ];
        await jest.unstable_mockModule(SCRIPT, () => ({ animation_duration: 0, characters: [] }));
        for (const [relativePath, exports] of mocks) {
            await jest.unstable_mockModule(resolvePublic(relativePath), () => exports);
        }

        const { runConversationAction } = await import('../public/scripts/sillybunny-conversation/chrome.js');
        await runConversationAction('zoom-avatar', { avatarFile: 'Seraphina.png' });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(zoomed().map(element => element.id)).toEqual(['zoomFor_Seraphina']);

        // Calling toggleZoomedAvatar from roleplay closes the exact same window opened by conversation mode.
        viewer.toggleZoomedAvatar({ file: 'Seraphina.png' });
        expect(zoomed()).toHaveLength(0);

        const conversationCss = read('../public/css/sillybunny-conversation.css');
        expect(conversationCss).not.toMatch(/zoomed[-_]avatar/);
        expect(read('../public/css/sillybunny-theme.css')).not.toContain('sb-conversation-zoomed-avatar');
    });
});
