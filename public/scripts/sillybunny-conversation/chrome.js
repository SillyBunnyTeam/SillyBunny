import { characters } from '../../script.js';
import { debounce_timeout } from '../constants.js';
import { loadStylesheetAsync } from '../dynamic-styles.js';
import { isIOSWebKitPlatform } from '../mobile-send-button.js';
import { shouldSendOnEnter } from '../RossAscends-mods.js';
import { debounce } from '../utils.js';
import { addConversationFilesToInput, clearConversationAttachmentInput, submitConversationInput, updateConversationAttachmentPreview } from './attachments.js';
import { CHROME_IDS, CONVERSATION_OPENED_EVENT } from './constants.js';
import { confirmConversationAction, promptConversationText } from './dialogs.js';
import {
    createConversationChat,
    deleteConversationByAvatar,
    deleteConversationChat,
    ensureDirectConversation,
    getConversationChats,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationKey,
    getConversationRecord,
    getCurrentCharAvatar,
    getRoleplayCurrentCharacter,
    isAvatarInConversationGroup,
    parsePositiveInt,
    renameConversationChat,
    setActiveConversationChat,
} from './context.js';
import { editConversationMessage } from './generation.js';
import {
    getConversationListEntries,
    handleCharacterMessagePolish,
    updateConversationHeader,
} from './interface.js';
import { bindConversationListControls } from './conversation-list-controls.js';
import { buildComposerMenuSections, buildHeaderMenuSections, buildMainMenuSections, buildNewMenuSections } from './conversation-menus.js';
import { setConversationListQuery } from './conversation-list-view.js';
import { getCharacterForAvatar } from './media.js';
import { clearAllConversationUnreadCounts, isConversationActive } from './notifications.js';
import { getDirectConversations } from './conversation-list.js';
import { switchConversationPersona } from './persona-switch.js';
import { getUserStatus, setActiveConversationPersonaAppendixIds, setUserStatus } from './personas.js';
import {
    editUserPersonaStatus,
    hideConversationPickers,
    renderConversationPersonaPicker,
    toggleStartDirectConversationPicker,
    toggleConversationGroupPicker,
    togglePersonaPicker,
    toggleUserStatusPicker,
    updateUserFooter,
} from './pickers.js';
import { afterConversationRender, scheduleInterfaceRefresh, scheduleConversationListRender, scheduleTimelineRender } from './render-scheduler.js';
import {
    closeConversationList,
    observeConversationLayout,
    openConversationList,
    syncConversationPage,
    toggleConversationList,
} from './conversation-pages.js';
import { getGlobalConversationSettings, getSettings } from './settings-store.js';
import { conversationState, sendQueue } from './state.js';
import { processSendQueue } from './send-queue.js';
import { createForcedConversationQueueItem } from './send-queue-utils.js';
import { getConversationMessageCount, getConversationMessages, updateLastUserActivity } from './conversation-store.js';
import { conversationData } from './conversation-data-browser.js';
import { setConversationMuted } from './conversation-list-actions.js';
import { getConversationDisplayName } from './media.js';
import { enterConversationSelection, initializeConversationSelection } from './selection.js';
import {
    branchConversationFromMessage,
    clearConversationReplyTarget,
    copyConversationMessage,
    deleteConversationMessage,
    generateConversationSelfieFromMessageCommand,
    ensureConversationChrome,
    quickConversationReminder,
    quickConversationSelfie,
    quickConversationSummarize,
    reactConversationMessage,
    regenerateConversationMessage,
    replyToConversationMessage,
    toggleConversationSearchBar,
    speakConversationMessage,
    toggleConversationMessagePin,
    updateConversationSearchQuery,
} from './timeline-render.js';
import { confirmMessageDeletion } from '../sillybunny-delete-confirm.js';
import { openActionMenu } from '../sillybunny-action-menu.js';
import { ensureDetailsStyles } from './details/styles.js';
import { applyEmojiFont } from './emoji/emoji-font.js';
import { insertEmojiAtCaret } from './emoji/emoji-insert.js';
import { hasNativeEmojiPicker, isEmojiShortcut } from './emoji/emoji-shortcut.js';

const CONVERSATION_STYLESHEET_HREF = 'css/sillybunny-conversation.css?v=20261125i';
const EDITOR_SHELL_STYLESHEET_HREF = 'css/sillybunny-editor-shell.css?v=20261125a';
const EDITOR_SHELL_STYLESHEET_ID = 'deferred-editor-shell-css';

/**
 * Sizes the composer entry to its content. Border-box height must include the border that
 * scrollHeight leaves out, or the entry stays 2px short and scrolls with a single line.
 * @param {HTMLTextAreaElement} input
 */
function resizeConversationInput(input) {
    // An empty entry uses the CSS height. Measuring before the lazy stylesheet applies, or while
    // the workspace is hidden, would pin a stale inline height until the next keystroke.
    if (!input.value) {
        input.style.removeProperty('height');
        input.dataset.sbOverflowing = 'false';
        return;
    }
    if (!input.clientWidth) {
        return;
    }
    input.style.height = 'auto';
    const style = getComputedStyle(input);
    const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const maxHeight = parseFloat(style.maxHeight) || Infinity;
    const needed = input.scrollHeight + border;
    input.style.height = `${Math.min(needed, maxHeight)}px`;
    input.dataset.sbOverflowing = needed > maxHeight + 1 ? 'true' : 'false';
}
const CONVERSATION_STYLESHEET_ID = 'sb-conversation-css';

// User custom CSS (#custom-style) must keep winning, so the lazily loaded sheet is inserted before it
// instead of being appended to the end of <head>. loadStylesheetAsync then adopts the link by id.
function insertConversationStylesheetLink() {
    const customStyle = document.getElementById('custom-style');
    if (document.getElementById(CONVERSATION_STYLESHEET_ID) || !(customStyle instanceof HTMLElement) || !customStyle.parentNode) {
        return;
    }
    const link = document.createElement('link');
    link.id = CONVERSATION_STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.media = 'print';
    link.href = CONVERSATION_STYLESHEET_HREF;
    customStyle.before(link);
}

// 'idle' | 'loading' | 'ready' | 'failed'. The chrome stays hidden while 'loading': revealing it
// before the lazy sheet applies paints one or more frames of unstyled markup on the first open.
let conversationStylesheetStatus = 'idle';

export function isConversationStylesheetLoading() {
    return conversationStylesheetStatus === 'loading';
}

// The composer focus requested by the open path waits for this refresh: the chrome stays hidden
// while the first sheet loads, and the composer is only enabled by the render flush.
function revealConversationWorkspaceAfterStylesheet() {
    if (!conversationState.conversationWorkspaceOpen) {
        return;
    }

    conversationState.timelineBottomScrollPending = true;
    scheduleInterfaceRefresh();
}

function ensureConversationStylesheet() {
    if (conversationStylesheetStatus === 'loading' || conversationStylesheetStatus === 'ready') {
        return;
    }

    conversationStylesheetStatus = 'loading';
    insertConversationStylesheetLink();
    // The details window is built from shared rows whose button, text-area and insensitive styles live in the editor shell,
    // and its own sheet loads here too, so that both are there before the window's first page draws.
    Promise.all([
        loadStylesheetAsync(CONVERSATION_STYLESHEET_HREF, { id: CONVERSATION_STYLESHEET_ID }),
        loadStylesheetAsync(EDITOR_SHELL_STYLESHEET_HREF, { id: EDITOR_SHELL_STYLESHEET_ID }),
        // A sheet that fails to load must not fail the mode's own: the window then opens unstyled.
        ensureDetailsStyles().catch(error => console.warn('Conversation Mode: the details stylesheet failed to load', error)),
    ])
        .then(() => {
            conversationStylesheetStatus = 'ready';
            const input = document.getElementById(CHROME_IDS.input);
            if (input instanceof HTMLTextAreaElement) {
                resizeConversationInput(input);
            }
            revealConversationWorkspaceAfterStylesheet();
        })
        .catch(error => {
            // Reveal unstyled rather than leave the workspace stuck closed. Drop the dead link:
            // loadStylesheetAsync adopts an existing link by id and would wait on it forever.
            conversationStylesheetStatus = 'failed';
            document.getElementById(CONVERSATION_STYLESHEET_ID)?.remove();
            console.warn('Conversation Mode: stylesheet failed to load', error);
            revealConversationWorkspaceAfterStylesheet();
        });
}

function requestConversationRuntimeStart() {
    window.dispatchEvent(new CustomEvent('sb:conversation-runtime-needed'));
}

function focusConversationInput({ skipIOS = false } = {}) {
    if (skipIOS && isIOSWebKitPlatform()) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (input instanceof HTMLTextAreaElement) {
        input.focus({ preventScroll: true });
    }
}

// The composer is disabled until the render flush picks a thread and hidden until the lazy sheet
// applies, so focus follows those instead of a fixed delay.
function focusConversationInputAfterRender() {
    afterConversationRender(() => {
        if (!conversationState.conversationWorkspaceOpen || !conversationState.conversationSelectedAvatar) {
            return true;
        }
        if (isConversationStylesheetLoading()) {
            return false;
        }

        const input = document.getElementById(CHROME_IDS.input);
        if (!(input instanceof HTMLTextAreaElement) || input.disabled) {
            return false;
        }

        input.focus({ preventScroll: true });
        return true;
    });
}

/**
 * Opens or closes the zoomed avatar of a character, the way roleplay does: the same window, key and place, so a position that
 * Moving UI saved in one mode is used in the other. The viewer loads on the first picture that is opened.
 * @param {string|undefined} file The avatar file of the character.
 */
async function showZoomedAvatar(file) {
    if (!file || file === 'none') {
        return;
    }

    const { toggleZoomedAvatar } = await import('../sillybunny-avatar-viewer.js');
    toggleZoomedAvatar({ file });
}

/**
 * Opens the details window of a conversation. The window and its pages load on first use.
 * @param {string} conversationId
 * @param {{ page?: string, avatar?: string }} [options] See `openConversationDetails` in `details/window.js` for the pages.
 * @returns {Promise<boolean>} Whether the window is open.
 */
export async function openConversationDetails(conversationId, options = {}) {
    const { openConversationDetails: open } = await import('./details/window.js');
    return open(conversationId, options);
}

/** Opens the mode-wide Preferences in the details window. */
export async function openConversationPreferences() {
    const { openConversationPreferences: open } = await import('./details/window.js');
    return open();
}

export async function selectConversation(avatar, { chatId = '', groupId = null, personaId = getConversationPersonaId(), showToast = false } = {}) {
    if (!avatar) {
        return false;
    }

    if (personaId && !await switchConversationPersona(personaId)) {
        return false;
    }

    const normalizedGroupId = groupId ? String(groupId) : '';
    return openConversationWorkspaceForAvatar(avatar, {
        chatId,
        groupId: normalizedGroupId || null,
        showToast,
    });
}

const USER_STATUS_MENU_ITEMS = Object.freeze([
    { status: 'online', label: 'Online' },
    { status: 'idle', label: 'Idle' },
    { status: 'dnd', label: 'Do Not Disturb' },
    { status: 'offline', label: 'Invisible' },
]);

// TODO(copy): the body of the alerts that ask before a chat or a conversation is deleted is a placeholder.
const DELETE_ALERT_BODY = 'TODO(copy)';

function getNameOfConversation(avatar, groupId) {
    return getConversationDisplayName(avatar, getSettings(avatar, { groupId }), { groupId });
}

function isConversationSelectedInWorkspace(avatar, groupId) {
    return conversationState.conversationSelectedAvatar === avatar && (conversationState.conversationSelectedGroupId || '') === (groupId || '');
}

function getActiveConversationIdentity() {
    const avatar = getCurrentCharAvatar();
    return { avatar, groupId: avatar ? getConversationGroupIdForAvatar(avatar) : '' };
}

function runFromMenu(action, data = {}, trigger = null) {
    return () => void runConversationAction(action, data, trigger);
}

function getOpenConversationId() {
    const { avatar, groupId } = getActiveConversationIdentity();
    return avatar ? getConversationRecord(avatar, { create: false, groupId })?.id ?? '' : '';
}

function openConversationOverflowMenu(trigger) {
    const { avatar, groupId } = getActiveConversationIdentity();
    const conversationId = getOpenConversationId();
    if (!avatar || !conversationId) {
        return;
    }

    const activeChatId = getConversationRecord(avatar, { create: false, groupId })?.activeChatId || '';
    const settings = getSettings(avatar, { groupId });
    openActionMenu({
        trigger,
        title: 'Conversation',
        sections: buildHeaderMenuSections({
            muted: Boolean(settings.notifications_muted),
            hasMessages: getConversationMessageCount(avatar, { groupId }) > 0,
            hasChat: Boolean(activeChatId),
        }, {
            openDetails: () => void openConversationDetails(conversationId),
            newChat: runFromMenu('new-chat'),
            addMember: () => void openConversationDetails(conversationId, { page: 'add-member' }),
            setMuted: (muted) => {
                setConversationMuted(conversationData, conversationId, muted);
                scheduleConversationListRender();
            },
            selectMessages: runFromMenu('select-messages', {}, trigger),
            deleteChat: runFromMenu('delete-chat', { avatar, groupId, chatId: activeChatId }),
            deleteConversation: runFromMenu('delete-conversation', { avatar, groupId }),
        }),
    });
}

/** A composer too narrow for its Emoji button does not draw it (a container rule of the stylesheet), and the "+" menu offers the action instead. */
function isComposerEmojiButtonHidden() {
    const button = document.getElementById(CHROME_IDS.emoji);
    return button instanceof HTMLElement && getComputedStyle(button).display === 'none';
}

/**
 * Opens the emoji chooser for the composer entry. The entry's selection is read first, because the chooser takes the focus.
 * @param {HTMLElement} trigger The Emoji button, or the "+" button when the Emoji button is not drawn.
 * @param {{ fromEntry?: boolean }} [options] `fromEntry`: the shortcut opened it, so a chooser that closes without a pick gives the focus back to the entry and not to the button.
 */
async function openComposerEmojiChooser(trigger, { fromEntry = false } = {}) {
    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement) || input.disabled) {
        return;
    }
    let range = { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length };
    const { openEmojiChooser } = await import('./emoji/emoji-chooser.js');
    openEmojiChooser({
        trigger,
        kind: 'insert',
        bounds: document.getElementById(CHROME_IDS.stage),
        onPick: (emoji, { keepOpen }) => {
            const caret = insertEmojiAtCaret(input, emoji, range, { focus: !keepOpen });
            range = { start: caret, end: caret };
        },
        onClose: fromEntry
            // The surface gives the focus to its trigger after this callback; only a focus that is on the trigger by then is moved, so a click elsewhere keeps its own.
            ? () => setTimeout(() => {
                if (document.activeElement === trigger) {
                    input.focus({ preventScroll: true });
                }
            }, 0)
            : null,
    });
}

function openConversationComposerMenu(trigger) {
    openActionMenu({
        trigger,
        title: 'Add to Message',
        sections: buildComposerMenuSections({ enabled: Boolean(getCurrentCharAvatar()), showEmoji: isComposerEmojiButtonHidden() }, {
            insertEmoji: runFromMenu('open-emoji-chooser', {}, trigger),
            selfie: runFromMenu('quick-selfie'),
            remind: runFromMenu('quick-remind'),
            summarize: runFromMenu('quick-summarize'),
            forceReply: runFromMenu('force-response'),
        }),
    });
}

function openConversationPersonaMenu(trigger) {
    const current = getUserStatus();
    openActionMenu({
        trigger,
        title: 'Your Status',
        sections: [
            {
                items: USER_STATUS_MENU_ITEMS.map(({ status, label }) => ({
                    label,
                    checked: status === current,
                    data: { sbStatus: status },
                    onSelect: runFromMenu('set-user-status', { status }),
                })),
            },
            {
                items: [
                    { label: 'Set Status Message…', icon: 'fa-solid fa-user-pen', onSelect: runFromMenu('edit-user-persona-status') },
                    { label: 'Switch Persona…', icon: 'fa-solid fa-users', onSelect: runFromMenu('open-persona-picker', {}, trigger) },
                ],
            },
        ],
    });
}

function openConversationNewMenu(trigger) {
    openActionMenu({
        trigger,
        title: 'New',
        sections: buildNewMenuSections({
            newConversation: runFromMenu('open-start-direct-conversation', {}, trigger),
            newGroup: runFromMenu('open-new-group-chat', {}, trigger),
        }),
        alignment: 'end',
    });
}

function openConversationMainMenu(trigger) {
    openActionMenu({
        trigger,
        title: 'Main Menu',
        sections: buildMainMenuSections({
            markAllRead: runFromMenu('mark-all-read'),
            openPreferences: () => void openConversationPreferences(),
            openHelp: () => void import('../sillybunny-home/windows.js').then(({ openHelp }) => openHelp({ topic: 'start-a-conversation' })),
        }),
        alignment: 'end',
    });
}

/**
 * Runs one Conversation chrome action. Delegated clicks pass the clicked element; menu rows pass
 * their trigger and a plain dataset object so both paths share one implementation.
 * @param {string} action
 * @param {Record<string, string|undefined>} [data]
 * @param {HTMLElement|null} [target]
 * @param {Event|null} [event]
 */
export async function runConversationAction(action, data = {}, target = null, event = null) {
    switch (action) {
        case 'zoom-avatar':
            event?.preventDefault?.();
            event?.stopPropagation?.();
            void showZoomedAvatar(data.avatarFile);
            break;
        case 'toggle-search':
            toggleConversationSearchBar();
            break;
        case 'open-details': {
            const conversationId = getOpenConversationId();
            if (conversationId) {
                await openConversationDetails(conversationId);
            }
            break;
        }
        case 'open-conversation-menu':
            openConversationOverflowMenu(target);
            break;
        case 'open-composer-menu':
            openConversationComposerMenu(target);
            break;
        case 'open-emoji-chooser':
            if (target) {
                await openComposerEmojiChooser(target);
            }
            break;
        case 'open-persona-menu':
            openConversationPersonaMenu(target);
            break;
        case 'open-new-menu':
            openConversationNewMenu(target);
            break;
        case 'open-main-menu':
            openConversationMainMenu(target);
            break;
        case 'toggle-list':
            toggleConversationList();
            break;
        case 'close-list':
            closeConversationList();
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
            break;
        case 'polish-character-message':
            await handleCharacterMessagePolish(data.messageId, target);
            break;
        case 'open-start-direct-conversation':
            toggleStartDirectConversationPicker(target);
            break;
        case 'open-new-group-chat':
            toggleConversationGroupPicker({ anchor: target });
            break;
        case 'mark-all-read': {
            const { cleared, removedLegacy } = await clearAllConversationUnreadCounts();
            scheduleConversationListRender();
            if (cleared > 0 || removedLegacy > 0) {
                toastr.success('Marked all conversations as read');
            } else {
                toastr.info('No unread conversations');
            }
            break;
        }
        case 'attach-file': {
            const fileInput = document.getElementById(CHROME_IDS.fileInput);
            if (fileInput instanceof HTMLInputElement) {
                fileInput.click();
            }
            break;
        }
        case 'clear-attachments':
            clearConversationAttachmentInput();
            break;
        case 'clear-reply-target':
            clearConversationReplyTarget();
            break;
        case 'stop-image-generation':
            conversationState.imageGenerationAbortController?.abort?.();
            conversationState.imageGenerationActive = false;
            conversationState.imageGenerationAbortController = null;
            scheduleTimelineRender();
            toastr.info('Image generation stopped');
            break;
        case 'start-direct-conversation': {
            const index = parsePositiveInt(data.characterIndex, -1, 0);
            if (index >= 0) {
                const char = characters[index];
                if (char?.avatar) {
                    if (isIOSWebKitPlatform()) {
                        focusConversationInput();
                    }

                    await ensureDirectConversation(char.avatar);
                    hideConversationPickers();
                    closeConversationList();
                    await selectConversation(char.avatar, {
                        groupId: null,
                        showToast: false,
                    });
                    scheduleConversationListRender();
                }
            }
            break;
        }
        case 'rename-chat': {
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const chatId = data.chatId;
            const chat = getConversationChats(avatar, { groupId }).find(item => item.id === chatId);
            if (avatar && chatId && chat) {
                const name = await promptConversationText({
                    title: 'Rename Chat',
                    defaultValue: chat.name || 'Conversation',
                    confirmLabel: 'Rename',
                });
                if (name?.trim()) {
                    renameConversationChat(avatar, chatId, name, { groupId });
                    scheduleConversationListRender();
                    if (isConversationActive(avatar, groupId)) {
                        updateConversationHeader(getSettings(avatar, { groupId }));
                    }
                }
            }
            break;
        }
        case 'delete-chat': {
            // Delete Chat: the user stays in the conversation (R5-24). The chat that takes the place of the deleted one opens.
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const chatId = data.chatId;
            const chat = getConversationChats(avatar, { groupId }).find(item => item.id === chatId);
            if (avatar && chatId && chat) {
                const confirmed = await confirmConversationAction({
                    title: `Delete the "${chat.name || 'Conversation'}" chat?`,
                    text: DELETE_ALERT_BODY,
                });
                if (confirmed) {
                    try {
                        await deleteConversationChat(avatar, chatId, { groupId });
                    } catch (error) {
                        console.error('Conversation Mode: the chat could not be deleted', error);
                        toastr.error('The chat could not be deleted');
                        break;
                    }
                    if (isConversationActive(avatar, groupId)) {
                        scheduleInterfaceRefresh();
                    } else {
                        scheduleConversationListRender();
                    }
                }
            }
            break;
        }
        case 'delete-conversation': {
            // Delete Conversation: the user goes to the list, not Home (R5-24).
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            if (!avatar) {
                break;
            }
            const confirmed = await confirmConversationAction({
                title: `Delete the conversation with ${getNameOfConversation(avatar, groupId)}?`,
                text: DELETE_ALERT_BODY,
            });
            if (!confirmed) {
                break;
            }
            try {
                await deleteConversationByAvatar(avatar, { groupId });
            } catch (error) {
                console.error('Conversation Mode: the conversation could not be deleted', error);
                toastr.error('The conversation could not be deleted');
                break;
            }
            hideConversationPickers();
            if (conversationState.conversationWorkspaceOpen && isConversationSelectedInWorkspace(avatar, groupId)) {
                await openConversationWorkspaceForAvatar(null, { showToast: false });
                openConversationList();
            }
            scheduleConversationListRender();
            break;
        }
        case 'new-chat': {
            const avatar = getCurrentCharAvatar();
            if (!avatar) {
                toastr.warning('Pick a conversation first');
                break;
            }
            const groupId = getConversationGroupIdForAvatar(avatar);
            createConversationChat(avatar, `Chat ${getConversationChats(avatar, { groupId }).length + 1}`, { groupId });
            updateLastUserActivity(avatar, { groupId });
            scheduleInterfaceRefresh();
            toastr.success('New chat started');
            break;
        }
        case 'edit-message':
            editConversationMessage(data.messageId);
            break;
        case 'reply-message':
            replyToConversationMessage(data.messageId);
            break;
        case 'copy-message':
            await copyConversationMessage(data.messageId);
            break;
        case 'select-message':
            enterConversationSelection(data.messageId, target);
            break;
        case 'select-messages':
            enterConversationSelection(null, target);
            break;
        case 'speak-message':
            await speakConversationMessage(data.messageId);
            break;
        case 'toggle-message-pin':
            toggleConversationMessagePin(data.messageId);
            break;
        case 'react-message':
            reactConversationMessage(data.messageId, data.reaction);
            break;
        case 'branch-from-message':
            await branchConversationFromMessage(data.messageId);
            break;
        case 'regenerate-message':
            await regenerateConversationMessage(data.messageId);
            break;
        case 'delete-message': {
            const messageId = data.messageId;
            if (await confirmMessageDeletion({ text: 'Delete this Conversation message?' })) {
                deleteConversationMessage(messageId);
            }
            break;
        }
        case 'quick-selfie':
            await quickConversationSelfie();
            break;
        case 'generate-selfie-command':
            await generateConversationSelfieFromMessageCommand(data.messageId, data.selfieIndex);
            break;
        case 'quick-remind':
            await quickConversationReminder();
            break;
        case 'quick-summarize':
            await quickConversationSummarize();
            break;
        case 'force-response': {
            const avatar = getCurrentCharAvatar();
            if (avatar) {
                const groupId = conversationState.conversationSelectedGroupId || '';
                const personaId = getConversationPersonaId();
                const conversationRecord = getConversationRecord(avatar, { groupId, personaId });
                const chatId = conversationRecord?.activeChatId || '';
                const messages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
                sendQueue.push(createForcedConversationQueueItem({
                    avatar,
                    chatId,
                    groupId,
                    personaId,
                    conversationKey: getConversationKey(avatar, groupId, { personaId }),
                    createdAt: Date.now(),
                }, messages));
                void processSendQueue();
            }
            break;
        }
        case 'set-user-status': {
            const status = data.status;
            if (status) {
                setUserStatus(status);
                updateUserFooter();
                hideConversationPickers({ restoreFocus: true });
            }
            break;
        }
        case 'open-user-status-picker':
            toggleUserStatusPicker(target);
            break;
        case 'edit-user-persona-status':
            await editUserPersonaStatus();
            break;
        case 'open-persona-picker':
            togglePersonaPicker(target);
            break;
        case 'pick-persona': {
            const avatarId = data.personaAvatar;
            if (avatarId) {
                if (!await switchConversationPersona(avatarId)) {
                    break;
                }
                updateUserFooter();
                const picker = document.getElementById(CHROME_IDS.personaPicker);
                if (picker instanceof HTMLElement) {
                    renderConversationPersonaPicker(picker);
                }
            }
            break;
        }
        default:
            break;
    }
}

export function bindConversationChromeControls(sheld) {
    if (sheld.dataset.sbConversationChromeBound === 'true') {
        return;
    }

    sheld.dataset.sbConversationChromeBound = 'true';
    initializeConversationSelection();
    sheld.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) {
            return;
        }

        const conversationList = document.getElementById(CHROME_IDS.conversationList);
        if (sheld.dataset.sbConversationPage === 'list' && getCurrentCharAvatar() && conversationList instanceof HTMLElement && event.target instanceof Node && conversationList.contains(event.target)) {
            event.preventDefault();
            void runConversationAction('close-list');
            return;
        }

        const tools = document.getElementById(CHROME_IDS.tools);
        if (tools instanceof HTMLElement && tools.dataset.open === 'true' && event.target instanceof Node && tools.contains(event.target)) {
            event.preventDefault();
            toggleConversationSearchBar(false);
            document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-action="toggle-search"]`)?.focus?.({ preventScroll: true });
        }
    });
    sheld.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action="zoom-avatar"]') : null;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        event.preventDefault();
        target.click();
    });

    sheld.addEventListener('click', async (event) => {
        // Message menu triggers are handled by sillybunny-conversation/message-menu.js.
        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action], .sb-conversation-list-item') : null;

        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.classList.contains('sb-conversation-list-item')) {
            const avatar = target.dataset.avatar || characters[parsePositiveInt(target.dataset.characterIndex, -1, 0)]?.avatar;
            const groupId = target.dataset.groupId || '';
            if (avatar) {
                closeConversationList();
                await selectConversation(avatar, {
                    groupId: groupId || null,
                    showToast: false,
                });
            }
            return;
        }

        await runConversationAction(target.dataset.sbConversationAction, target.dataset, target, event);
    });

    const form = document.getElementById(CHROME_IDS.form);
    if (form instanceof HTMLFormElement && form.dataset.sbConversationBound !== 'true') {
        form.dataset.sbConversationBound = 'true';
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitConversationInput();
        });
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (input instanceof HTMLTextAreaElement && input.dataset.sbConversationBound !== 'true') {
        input.dataset.sbConversationBound = 'true';
        input.addEventListener('keydown', (event) => {
            const emojiButton = document.getElementById(CHROME_IDS.emoji);
            if (isEmojiShortcut(event) && !hasNativeEmojiPicker(navigator.userAgent) && emojiButton instanceof HTMLElement && !input.disabled) {
                event.preventDefault();
                // The Emoji button is not drawn in a narrow composer, and the "+" button, which always is, takes its place.
                const anchor = getComputedStyle(emojiButton).display === 'none' ? input.closest('form')?.querySelector('.sb-conversation-composer-more') : emojiButton;
                if (anchor instanceof HTMLElement) {
                    void openComposerEmojiChooser(anchor, { fromEntry: true });
                }
                return;
            }
            if (event.isComposing || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || !shouldSendOnEnter()) {
                return;
            }

            event.preventDefault();
            void submitConversationInput();
        });
        input.addEventListener('input', () => resizeConversationInput(input));
        resizeConversationInput(input);
        input.addEventListener('paste', (event) => {
            const files = Array.from(event.clipboardData?.files || []);
            if (!files.length) {
                return;
            }

            event.preventDefault();
            addConversationFilesToInput(files);
        });
    }

    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (fileInput instanceof HTMLInputElement && fileInput.dataset.sbConversationBound !== 'true') {
        fileInput.dataset.sbConversationBound = 'true';
        fileInput.addEventListener('change', updateConversationAttachmentPreview);
    }

    const searchInput = document.getElementById(CHROME_IDS.search);
    if (searchInput instanceof HTMLInputElement && searchInput.dataset.sbConversationBound !== 'true') {
        searchInput.dataset.sbConversationBound = 'true';
        const debouncedSearch = debounce(() => updateConversationSearchQuery(searchInput.value), debounce_timeout.short);
        searchInput.addEventListener('input', debouncedSearch);
    }

    const stage = document.getElementById(CHROME_IDS.stage);
    if (stage instanceof HTMLElement && stage.dataset.sbConversationDropBound !== 'true') {
        stage.dataset.sbConversationDropBound = 'true';
        const stopDrag = () => {
            stage.dataset.dragging = 'false';
            const dropHint = document.getElementById(CHROME_IDS.dropHint);
            if (dropHint instanceof HTMLElement) {
                dropHint.hidden = true;
            }
        };

        stage.addEventListener('dragover', (event) => {
            event.preventDefault();
            stage.dataset.dragging = 'true';
            const dropHint = document.getElementById(CHROME_IDS.dropHint);
            if (dropHint instanceof HTMLElement) {
                dropHint.hidden = false;
            }
        });
        stage.addEventListener('dragleave', stopDrag);
        stage.addEventListener('drop', (event) => {
            event.preventDefault();
            stopDrag();
            const files = Array.from(event.dataTransfer?.files || []);
            if (files.length) {
                addConversationFilesToInput(files);
            }
        });
    }

    const listSearch = document.getElementById('sb_conversation_list_search');
    if (listSearch instanceof HTMLInputElement && listSearch.dataset.sbConversationBound !== 'true') {
        listSearch.dataset.sbConversationBound = 'true';
        const debouncedListFilter = debounce(() => {
            if (setConversationListQuery(listSearch.value)) {
                scheduleConversationListRender();
            }
        }, debounce_timeout.short);
        listSearch.addEventListener('input', debouncedListFilter);
    }

    const listItems = document.getElementById(CHROME_IDS.listItems);
    if (listItems instanceof HTMLElement) {
        bindConversationListControls(listItems, {
            getEntries: getConversationListEntries,
            runAction: runConversationAction,
            openDetails: openConversationDetails,
            render: scheduleConversationListRender,
        });
    }

    const personaPicker = document.getElementById(CHROME_IDS.personaPicker);
    if (personaPicker instanceof HTMLElement && personaPicker.dataset.sbConversationAppendicesBound !== 'true') {
        personaPicker.dataset.sbConversationAppendicesBound = 'true';
        personaPicker.addEventListener('change', (event) => {
            const checkbox = event.target instanceof Element
                ? event.target.closest('.sb-conversation-persona-note-checkbox')
                : null;
            if (!(checkbox instanceof HTMLInputElement)) {
                return;
            }

            const avatarId = checkbox.dataset.personaAvatar;
            if (!avatarId) {
                return;
            }

            const selectedIds = Array.from(personaPicker.querySelectorAll('.sb-conversation-persona-note-checkbox'))
                .filter(input => input instanceof HTMLInputElement && input.dataset.personaAvatar === avatarId && input.checked)
                .map(input => input.value);
            const anchorAvatar = getCurrentCharAvatar();
            setActiveConversationPersonaAppendixIds(avatarId, selectedIds, {
                avatar: anchorAvatar,
                groupId: getConversationGroupIdForAvatar(anchorAvatar),
                personaId: avatarId,
            });
            renderConversationPersonaPicker(personaPicker);
            updateUserFooter();
        });
    }
}

export function getDefaultConversationAvatar() {
    if (conversationState.conversationSelectedAvatar && getCharacterForAvatar(conversationState.conversationSelectedAvatar)) {
        return conversationState.conversationSelectedAvatar;
    }

    const conversation = getDirectConversations().find(item => item.character?.avatar);
    if (conversation?.character?.avatar) {
        return conversation.character.avatar;
    }

    const currentAvatar = getRoleplayCurrentCharacter()?.avatar;
    if (currentAvatar) {
        return currentAvatar;
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar)?.avatar || null;
}

function emitConversationWorkspaceStateChange() {
    window.dispatchEvent(new CustomEvent('sb:conversation-workspace-state-changed', {
        detail: {
            open: Boolean(conversationState.conversationWorkspaceOpen),
        },
    }));
}

/**
 * Opens the workspace on a conversation. The workspace and its chrome change at once; the returned promise settles
 * when the conversation is known to exist: with `enable` a direct conversation that is not there yet is made first.
 * @returns {Promise<boolean>} False when there is no such character, chat or conversation to open.
 */
export function openConversationWorkspaceForAvatar(avatar, { chatId = '', groupId = null, showToast = true, enable = false } = {}) {
    const character = avatar ? getCharacterForAvatar(avatar) : null;
    const targetAvatar = character?.avatar || null;
    const targetGroupId = groupId && targetAvatar && isAvatarInConversationGroup(targetAvatar, groupId) ? String(groupId) : null;
    if (chatId && targetAvatar && !getConversationChats(targetAvatar, { groupId: targetGroupId }).some(chat => chat.id === String(chatId))) {
        return Promise.resolve(false);
    }
    const wasWorkspaceOpen = Boolean(conversationState.conversationWorkspaceOpen);
    const conversationChanged = conversationState.conversationSelectedAvatar !== targetAvatar || conversationState.conversationSelectedGroupId !== targetGroupId;
    conversationState.conversationWorkspaceOpen = true;
    emitConversationWorkspaceStateChange();
    conversationState.conversationSelectedAvatar = targetAvatar;
    conversationState.conversationSelectedGroupId = targetGroupId;
    conversationState.conversationUnavailableGroupId = null;
    if (conversationChanged) {
        conversationState.conversationTimelineChannel = 'main';
        conversationState.conversationTimelineSearchQuery = '';
    }
    if (!wasWorkspaceOpen || conversationChanged) {
        conversationState.timelineBottomScrollPending = true;
    }
    ensureConversationStylesheet();
    applyEmojiFont({ useDeviceEmoji: Boolean(getGlobalConversationSettings().use_device_emoji) });

    if (!targetAvatar) {
        scheduleInterfaceRefresh();
        return Promise.resolve(false);
    }

    // Every way into a thread ends here, and Conversation opens no chat of the app, so Home hears about it from this event (Getting Started, step 3).
    window.dispatchEvent(new CustomEvent(CONVERSATION_OPENED_EVENT, { detail: { avatar: targetAvatar, groupId: targetGroupId } }));

    const wasEnabled = Boolean(getConversationRecord(targetAvatar, { groupId: targetGroupId }));
    const finish = () => {
        if (chatId) {
            setActiveConversationChat(targetAvatar, String(chatId), { groupId: targetGroupId });
        }
        requestConversationRuntimeStart();
        scheduleInterfaceRefresh();
        if (showToast && enable && !wasEnabled) {
            toastr.info(`Conversation Mode activated for ${character.name || 'Character'}`);
        }
        focusConversationInputAfterRender();
        return true;
    };
    if (enable && !targetGroupId && !wasEnabled) {
        scheduleInterfaceRefresh();
        return ensureDirectConversation(targetAvatar).then(finish, (error) => {
            console.error('Conversation Mode: the conversation could not be made', error);
            return false;
        });
    }
    return Promise.resolve(finish());
}

export function openConversationWorkspaceFromWelcome() {
    const avatar = conversationState.conversationSelectedAvatar || getDefaultConversationAvatar();
    const selectedGroupId = conversationState.conversationSelectedGroupId || '';
    const groupId = selectedGroupId && avatar && isAvatarInConversationGroup(avatar, selectedGroupId) ? selectedGroupId : null;
    if (!avatar || !getCharacterForAvatar(avatar)) {
        toastr.warning('Pick or import a character before opening Conversation Mode');
        return false;
    }

    void openConversationWorkspaceForAvatar(avatar, { groupId, showToast: false });
    return true;
}

export function disableConversationModeForCurrentCharacter({ focusRoleplay = true } = {}) {
    conversationState.conversationWorkspaceOpen = false;
    conversationState.conversationSelectedAvatar = null;
    conversationState.conversationSelectedGroupId = null;
    conversationState.conversationUnavailableGroupId = null;
    conversationState.conversationTimelineChannel = 'main';
    conversationState.conversationTimelineSearchQuery = '';
    emitConversationWorkspaceStateChange();
    scheduleInterfaceRefresh();
    if (focusRoleplay) {
        document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
    }
}

export function setConversationInterfaceActive(active) {
    const chrome = active ? ensureConversationChrome() : { sheld: document.getElementById('sheld') };
    if (!(chrome?.sheld instanceof HTMLElement)) {
        return;
    }

    if (!active) {
        chrome.sheld.removeAttribute('data-sb-conversation-mode');
        closeConversationList();
        hideConversationPickers();
        observeConversationLayout(false);
        chrome.sheld.removeAttribute('data-sb-conversation-page');
        for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.conversationList]) {
            const element = document.getElementById(id);
            if (element instanceof HTMLElement) {
                element.hidden = true;
            }
        }
        const timeline = document.getElementById(CHROME_IDS.timeline);
        if (timeline instanceof HTMLElement) {
            // Mobile Safari keeps hidden DOM expensive; rebuild the timeline lazily on next open.
            timeline.replaceChildren();
            timeline.removeAttribute('data-sb-conversation-fingerprint');
            conversationState.lastTimelineFingerprint = '';
            conversationState.lastRenderedAvatar = null;
            conversationState.lastRenderedConversationKey = '';
            conversationState.lastRenderedMessageCount = 0;
            conversationState.timelineBottomScrollPending = false;
        }
        return;
    }

    chrome.sheld.dataset.sbConversationMode = 'on';
    for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.conversationList]) {
        const element = document.getElementById(id);
        if (element instanceof HTMLElement) {
            element.hidden = false;
        }
    }
    updateUserFooter();
    observeConversationLayout(true);
    syncConversationPage();
}
