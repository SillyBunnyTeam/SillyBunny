import { animation_duration, characters } from '../../script.js';
import { debounce_timeout } from '../constants.js';
import { loadStylesheetAsync } from '../dynamic-styles.js';
import { isIOSWebKitPlatform } from '../mobile-send-button.js';
import { getUserAvatar } from '../personas.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../popup.js';
import { loadMovingUIState, power_user } from '../power-user.js';
import { dragElement, shouldSendOnEnter } from '../RossAscends-mods.js';
import { debounce } from '../utils.js';
import { addConversationFilesToInput, clearConversationAttachmentInput, processSendQueue, submitConversationInput, updateConversationAttachmentPreview } from './attachments.js';
import { CHROME_IDS, DEFAULT_BRANCH_ID, DEFAULT_GROUNDED_DIALOGUE_RULES, GEECHAN_DEFAULT_PROMPT } from './constants.js';
import { confirmConversationAction, promptConversationText } from './dialogs.js';
import {
    createConversationBranchForAvatar,
    deleteConversationBranch,
    getConversationBranches,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadKey,
    getConversationThreadStore,
    getCurrentCharacter,
    getCurrentCharAvatar,
    getRoleplayCurrentCharacter,
    isAvatarInConversationGroup,
    parsePositiveInt,
    renameConversationBranch,
    resetCharacterConversationBranches,
    saveGroupConversationSettings,
    setActiveConversationBranch,
} from './context.js';
import { editConversationMessage } from './generation.js';
import {
    applySettingsToPanel,
    handleCharacterMessagePolish,
    saveCurrentPanelSettings,
    updateConversationChrome,
    updateConversationHeader,
} from './interface.js';
import { getCharacterForAvatar } from './media.js';
import { clearAllConversationUnreadCounts, clearUnreadCount, isConversationActiveThread } from './notifications.js';
import { getConversationPals, getConversationRailItems, getCurrentGroupConversationMembers } from './pals-rail.js';
import { switchConversationPersona } from './persona-switch.js';
import { editUserPersonaStatus, getUserStatus, setActiveConversationPersonaAppendixIds, setUserStatus } from './personas.js';
import {
    addWeeklyScheduleRow,
    handleCreateConversationGroupFromPicker,
    hideConversationPickers,
    hideConversationStartPicker,
    openAddMemberPicker,
    renderConversationPersonaPicker,
    toggleAddDmPicker,
    toggleConversationGroupPicker,
    togglePersonaPicker,
    toggleUserStatusPicker,
    updateUserFooter,
} from './pickers.js';
import { scheduleInterfaceRefresh, schedulePalsRailRender, scheduleTimelineRender } from './render-scheduler.js';
import { generateCharacterSchedule, saveStoredSchedule } from './schedule.js';
import {
    clearConversationMemoryFromPanel,
    closeConversationSettings,
    closePalsRail,
    forceCreateMemoryFromPanel,
    observeConversationLayout,
    openConversationSettings,
    openScheduleEditorModal,
    refreshConversationMemoryFromPanel,
    renderConversationMemoryPanel,
    renderScheduleDisplay,
    syncConversationPage,
    togglePalsRail,
} from './settings-panel.js';
import { getSettings, resetFollowupCount, saveSettings } from './settings-store.js';
import { conversationState, sendQueue } from './state.js';
import { createForcedConversationQueueItem } from './send-queue-utils.js';
import { getConversationThread, updateLastUserActivity } from './thread-store.js';
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
    setConversationTimelineChannel,
    toggleConversationSearchBar,
    speakConversationMessage,
    toggleConversationMessagePin,
    updateConversationNotificationSettingsVisibility,
    updateConversationSearchQuery,
} from './timeline-render.js';
import { setLastConversationPreview } from './typing.js';
import { confirmMessageDeletion } from '../sillybunny-delete-confirm.js';
import { MOBILE_QUERY, openActionMenu } from '../sillybunny-action-menu.js';

const CONVERSATION_STYLESHEET_HREF = 'css/sillybunny-conversation.css?v=20261003o';

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

function ensureConversationStylesheet() {
    if (conversationState.conversationCssLoaded) {
        return;
    }

    conversationState.conversationCssLoaded = true;
    insertConversationStylesheetLink();
    loadStylesheetAsync(CONVERSATION_STYLESHEET_HREF, { id: CONVERSATION_STYLESHEET_ID })
        .then(() => {
            const input = document.getElementById(CHROME_IDS.input);
            if (input instanceof HTMLTextAreaElement) {
                resizeConversationInput(input);
            }
            if (conversationState.conversationWorkspaceOpen) {
                conversationState.timelineBottomScrollPending = true;
                scheduleTimelineRender();
            }
        })
        .catch(error => {
            conversationState.conversationCssLoaded = false;
            console.warn('Conversation Mode: stylesheet failed to load', error);
        });
}

function requestConversationRuntimeStart() {
    window.dispatchEvent(new CustomEvent('sb:conversation-runtime-needed'));
}

async function openGroundedDialogueRulesEditor() {
    const backingInput = document.getElementById('sb_conv_grounded_dialogue_rules');
    if (!(backingInput instanceof HTMLTextAreaElement)) {
        toastr.warning('Open Conversation settings before editing Grounded Dialogue Rules.');
        return;
    }

    const content = document.createElement('div');
    content.id = 'sb_conversation_grounded_rules_modal';
    content.className = 'sb-conversation-grounded-rules-editor';

    const title = document.createElement('h3');
    title.id = 'sb_conversation_grounded_rules_title';
    title.textContent = 'Grounded Dialogue Rules';

    const hint = document.createElement('p');
    hint.className = 'sb-conversation-field-hint';
    hint.textContent = 'This global block is added to Conversation Mode prompts only when the Grounded Dialogue Rules toggle is on.';

    const editor = document.createElement('textarea');
    editor.className = 'text_pole textarea_compact wide100p sb-conversation-grounded-rules-input';
    editor.rows = 18;
    editor.value = backingInput.value || DEFAULT_GROUNDED_DIALOGUE_RULES;
    editor.setAttribute('aria-labelledby', title.id);
    content.append(title, hint, editor);

    const popup = new Popup(content, POPUP_TYPE.TEXT, null, {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        customButtons: [{
            text: 'Reset to default',
            classes: ['sb-conversation-dialog-reset'],
            action: () => {
                editor.value = DEFAULT_GROUNDED_DIALOGUE_RULES;
                editor.focus({ preventScroll: true });
            },
        }],
        onOpen: () => editor.focus({ preventScroll: true }),
    });
    popup.dlg.classList.add('sb-conversation-dialog', 'sb-conversation-grounded-rules-dialog');
    popup.dlg.setAttribute('aria-labelledby', title.id);
    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    backingInput.value = editor.value;
    backingInput.dispatchEvent(new Event('input', { bubbles: true }));
    saveCurrentPanelSettings();
    toastr.success('Grounded Dialogue Rules updated.');
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

function getConversationFullAvatarUrl(file, type) {
    if (!file || file === 'none') {
        return '';
    }

    if (type === 'persona') {
        return getUserAvatar(file);
    }

    return `/characters/${encodeURIComponent(file)}`;
}

function getConversationZoomedAvatarElement(avatarKey) {
    return $('.zoomed_avatar').filter(function () {
        return $(this).attr('forChar') === avatarKey;
    });
}

function removeConversationZoomedAvatar($avatar) {
    $avatar.fadeOut(animation_duration, () => {
        $avatar.remove();
    });
}

function showConversationZoomedAvatar(target) {
    const file = target.dataset.avatarFile || '';
    const type = target.dataset.avatarType || 'avatar';
    const avatarSrc = getConversationFullAvatarUrl(file, type);
    if (!avatarSrc) {
        return;
    }

    const avatarKey = `${type}:${file}`;
    const existingAvatar = getConversationZoomedAvatarElement(avatarKey);
    if (existingAvatar.length) {
        removeConversationZoomedAvatar(existingAvatar);
        return;
    }

    if (!power_user.movingUI) {
        $('.zoomed_avatar').each(function () {
            const currentForChar = $(this).attr('forChar');
            if (currentForChar && currentForChar !== avatarKey) {
                $(this).remove();
            }
        });
    }

    const template = $('#zoomed_avatar_template').html();
    if (!template) {
        return;
    }

    const safeId = avatarKey.replace(/[^\w-]/g, '_');
    const newElement = $(template);
    newElement.attr('forChar', avatarKey);
    newElement.attr('id', `zoomFor_${safeId}`);
    newElement.addClass('draggable sb-conversation-zoomed-avatar');
    newElement.find('.drag-grabber').attr('id', `zoomFor_${safeId}header`);

    const zoomedAvatarImgElement = newElement.find('.zoomed_avatar_img');
    zoomedAvatarImgElement.attr('src', avatarSrc);
    zoomedAvatarImgElement.attr('data-izoomify-url', avatarSrc);
    zoomedAvatarImgElement.on('dragstart', (event) => {
        event.preventDefault();
        return false;
    });

    newElement.on('click touchend', '.dragClose', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeConversationZoomedAvatar(newElement);
    });

    $('body').append(newElement);
    newElement.fadeIn(animation_duration);
    loadMovingUIState();
    newElement.css('display', 'flex');
    dragElement(newElement);

    if (power_user.zoomed_avatar_magnification) {
        newElement.find('.zoomed_avatar_container').izoomify();
    }
}

function closeConversationZoomedAvatars() {
    const $avatars = $('.zoomed_avatar.sb-conversation-zoomed-avatar:visible');
    if (!$avatars.length) {
        return false;
    }

    $avatars.each(function () {
        removeConversationZoomedAvatar($(this));
    });
    return true;
}

let conversationZoomEscapeBound = false;

function bindConversationZoomEscape() {
    if (conversationZoomEscapeBound || typeof document === 'undefined') {
        return;
    }

    conversationZoomEscapeBound = true;
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) {
            return;
        }

        if (closeConversationZoomedAvatars()) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
}

export async function selectConversationThread(avatar, { branchId = '', groupId = null, personaId = getConversationPersonaId(), showToast = false } = {}) {
    if (!avatar) {
        return false;
    }

    if (personaId && !await switchConversationPersona(personaId)) {
        return false;
    }

    const normalizedGroupId = groupId ? String(groupId) : '';
    return openConversationWorkspaceForAvatar(avatar, {
        branchId,
        groupId: normalizedGroupId || null,
        showToast,
    });
}

const USER_STATUS_MENU_ITEMS = Object.freeze([
    { status: 'online', label: 'Online' },
    { status: 'idle', label: 'Idle' },
    { status: 'dnd', label: 'Do not disturb' },
    { status: 'offline', label: 'Invisible' },
]);

function getActiveThreadIdentity() {
    const avatar = getCurrentCharAvatar();
    return { avatar, groupId: avatar ? getConversationGroupIdForAvatar(avatar) : '' };
}

function getStatusDotIcon(status) {
    const dot = document.createElement('span');
    dot.className = 'sb-conversation-status-dot';
    dot.dataset.status = status;
    return dot;
}

function runFromMenu(action, data = {}, trigger = null) {
    return () => void runConversationAction(action, data, trigger);
}

function openConversationBranchMenu(trigger) {
    const { avatar, groupId } = getActiveThreadIdentity();
    if (!avatar) {
        togglePalsRail();
        return;
    }

    const activeBranchId = getConversationThreadStore(avatar, { create: false, groupId })?.activeBranchId || DEFAULT_BRANCH_ID;
    const branches = getConversationBranches(avatar, { groupId });
    const activeBranch = branches.find(branch => branch.id === activeBranchId);
    const identity = { avatar, groupId };
    openActionMenu({
        trigger,
        title: 'Branches',
        sections: [
            {
                items: branches.map(branch => ({
                    label: branch.name || 'Conversation',
                    icon: branch.id === activeBranchId ? 'fa-solid fa-check' : 'fa-solid fa-code-branch',
                    detail: branch.unread > 0 ? String(branch.unread) : '',
                    onSelect: runFromMenu('select-branch', { ...identity, branchId: branch.id }),
                })),
            },
            {
                items: [
                    { label: 'New branch…', icon: 'fa-solid fa-plus', onSelect: runFromMenu('new-branch', identity) },
                    { label: 'Rename branch…', icon: 'fa-solid fa-pen', disabled: !activeBranch, onSelect: runFromMenu('rename-branch', { ...identity, branchId: activeBranchId }) },
                ],
            },
            {
                items: [
                    { label: 'Delete branch…', icon: 'fa-solid fa-trash-can', danger: true, disabled: !activeBranch, onSelect: runFromMenu('delete-branch', { ...identity, branchId: activeBranchId }) },
                ],
            },
        ],
    });
}

function openConversationOverflowMenu(trigger) {
    const { avatar, groupId } = getActiveThreadIdentity();
    const canEditSchedule = Boolean(avatar) || getCurrentGroupConversationMembers().length > 0;
    const addMemberLabel = groupId ? 'Add member to group…' : 'Add member…';
    openActionMenu({
        trigger,
        title: 'Conversation',
        sections: [
            {
                items: [
                    ...(avatar ? [{ label: addMemberLabel, icon: 'fa-solid fa-user-plus', onSelect: runFromMenu('open-add-member', {}, trigger) }] : []),
                    { label: 'New chat', icon: 'fa-solid fa-message', disabled: !avatar, onSelect: runFromMenu('new-chat') },
                    { label: 'Edit schedule…', icon: 'fa-solid fa-calendar-days', disabled: !canEditSchedule, onSelect: runFromMenu('edit-schedule') },
                    { label: 'Mark all as read', icon: 'fa-solid fa-check-double', onSelect: runFromMenu('mark-all-read') },
                    // The header gear covers settings on desktop; mobile hides the gear, so the menu keeps it there.
                    ...(typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY)?.matches
                        ? [{ label: 'Conversation settings', icon: 'fa-solid fa-gear', onSelect: runFromMenu('open-settings') }]
                        : []),
                ],
            },
            {
                items: avatar
                    ? [{ label: 'Delete conversation history…', icon: 'fa-solid fa-trash-can', danger: true, onSelect: runFromMenu('delete-dm', { avatar, groupId }) }]
                    : [],
            },
        ],
    });
}

function openConversationComposerMenu(trigger) {
    const hasThread = Boolean(getCurrentCharAvatar());
    openActionMenu({
        trigger,
        title: 'Add to message',
        sections: [
            {
                items: [
                    { label: 'Attach files', icon: 'fa-solid fa-paperclip', disabled: !hasThread, onSelect: runFromMenu('attach-file') },
                    { label: 'Send a selfie', icon: 'fa-solid fa-camera', disabled: !hasThread, onSelect: runFromMenu('quick-selfie') },
                    { label: 'Remind me', icon: 'fa-solid fa-bell', disabled: !hasThread, onSelect: runFromMenu('quick-remind') },
                    { label: 'Summarize memory', icon: 'fa-solid fa-book-open', disabled: !hasThread, onSelect: runFromMenu('quick-summarize') },
                    { label: 'Force a reply', icon: 'fa-solid fa-bolt', disabled: !hasThread, onSelect: runFromMenu('force-response') },
                ],
            },
        ],
    });
}

function openConversationPersonaMenu(trigger) {
    const current = getUserStatus();
    openActionMenu({
        trigger,
        title: 'Your status',
        sections: [
            {
                items: USER_STATUS_MENU_ITEMS.map(({ status, label }) => ({
                    label,
                    icon: getStatusDotIcon(status),
                    detail: status === current ? '✓' : '',
                    onSelect: runFromMenu('set-user-status', { status }),
                })),
            },
            {
                items: [
                    { label: 'Set status message…', icon: 'fa-solid fa-user-pen', onSelect: runFromMenu('edit-user-persona-status') },
                    { label: 'Switch persona…', icon: 'fa-solid fa-users', onSelect: runFromMenu('open-persona-picker', {}, trigger) },
                ],
            },
        ],
    });
}

function openConversationNewMenu(trigger) {
    openActionMenu({
        trigger,
        title: 'New conversation',
        sections: [
            {
                items: [
                    { label: 'New DM', icon: 'fa-solid fa-user-plus', onSelect: runFromMenu('open-add-dm', {}, trigger) },
                    { label: 'New group', icon: 'fa-solid fa-user-group', onSelect: runFromMenu('open-new-group-chat', {}, trigger) },
                ],
            },
            {
                items: [
                    { label: 'Mark all as read', icon: 'fa-solid fa-check-double', onSelect: runFromMenu('mark-all-read') },
                ],
            },
        ],
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
            showConversationZoomedAvatar(target);
            break;
        case 'toggle-search':
            toggleConversationSearchBar();
            break;
        case 'open-branch-menu':
            openConversationBranchMenu(target);
            break;
        case 'open-conversation-menu':
            openConversationOverflowMenu(target);
            break;
        case 'open-composer-menu':
            openConversationComposerMenu(target);
            break;
        case 'open-persona-menu':
            openConversationPersonaMenu(target);
            break;
        case 'open-new-menu':
            openConversationNewMenu(target);
            break;
        case 'toggle-pals':
            togglePalsRail();
            break;
        case 'close-pals':
            closePalsRail();
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
            break;
        case 'open-settings':
            hideConversationPickers();
            openConversationSettings();
            break;
        case 'close-settings':
            closeConversationSettings();
            break;
        case 'polish-character-message':
            await handleCharacterMessagePolish(data.messageId, target);
            break;
        case 'open-add-member':
            openAddMemberPicker();
            break;
        case 'open-add-dm':
            toggleAddDmPicker(target);
            break;
        case 'open-new-group-chat':
            toggleConversationGroupPicker({ anchor: target });
            break;
        case 'mark-all-read': {
            const { cleared, removedLegacy } = clearAllConversationUnreadCounts();
            schedulePalsRailRender();
            if (cleared > 0 || removedLegacy > 0) {
                toastr.success('Marked all Conversation pings as read.');
            } else {
                toastr.info('No Conversation pings to clear.');
            }
            break;
        }
        case 'create-conversation-group':
            await handleCreateConversationGroupFromPicker();
            break;
        case 'cancel-conversation-group':
            hideConversationStartPicker();
            break;
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
        case 'create-memory':
            await forceCreateMemoryFromPanel();
            break;
        case 'refresh-memory':
            await refreshConversationMemoryFromPanel();
            break;
        case 'clear-memory':
            await clearConversationMemoryFromPanel();
            break;
        case 'stop-image-generation':
            conversationState.imageGenerationAbortController?.abort?.();
            conversationState.imageGenerationActive = false;
            conversationState.imageGenerationAbortController = null;
            scheduleTimelineRender();
            toastr.info('Image generation stopped.');
            break;
        case 'add-character-dm': {
            const index = parsePositiveInt(data.characterIndex, -1, 0);
            if (index >= 0) {
                const char = characters[index];
                if (char?.avatar) {
                    if (isIOSWebKitPlatform()) {
                        focusConversationInput();
                    }

                    const charSettings = getSettings(char.avatar, { groupId: '' });
                    charSettings.enabled = true;
                    saveSettings(char.avatar, charSettings, { groupId: '' });
                    hideConversationPickers();
                    closePalsRail();
                    await selectConversationThread(char.avatar, {
                        groupId: null,
                        showToast: false,
                    });
                    schedulePalsRailRender();
                    setTimeout(() => {
                        focusConversationInput({ skipIOS: true });
                    }, 100);
                }
            }
            break;
        }
        case 'select-branch': {
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const branchId = data.branchId;
            if (avatar && branchId) {
                setActiveConversationBranch(avatar, branchId, { groupId });
                openConversationWorkspaceForAvatar(avatar, {
                    groupId: groupId || null,
                    showToast: false,
                });
                scheduleInterfaceRefresh({ syncControls: false });
                renderConversationMemoryPanel();
                document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
            }
            break;
        }
        case 'new-branch': {
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const character = getCharacterForAvatar(avatar);
            if (!avatar) {
                break;
            }
            const fallbackName = `Chat ${getConversationBranches(avatar, { groupId }).length + 1}`;
            const enteredName = await promptConversationText({
                title: 'New branch',
                text: `Name this Conversation branch for ${character?.name || 'this character'}.`,
                defaultValue: fallbackName,
                confirmLabel: 'Create',
            });
            if (enteredName === null) {
                break;
            }
            const name = enteredName.trim() || fallbackName;
            createConversationBranchForAvatar(avatar, name, { groupId });
            openConversationWorkspaceForAvatar(avatar, {
                groupId: groupId || null,
                showToast: false,
            });
            scheduleInterfaceRefresh({ syncControls: false });
            renderConversationMemoryPanel();
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
            break;
        }
        case 'rename-branch': {
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const branchId = data.branchId;
            const branch = getConversationBranches(avatar, { groupId }).find(item => item.id === branchId);
            if (avatar && branchId && branch) {
                const name = await promptConversationText({
                    title: 'Rename branch',
                    defaultValue: branch.name || 'Conversation',
                    confirmLabel: 'Rename',
                });
                if (name?.trim()) {
                    renameConversationBranch(avatar, branchId, name, { groupId });
                    schedulePalsRailRender();
                    if (isConversationActiveThread(avatar, groupId)) {
                        updateConversationHeader(getSettings(avatar, { groupId }));
                        renderConversationMemoryPanel();
                    }
                }
            }
            break;
        }
        case 'delete-branch': {
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const branchId = data.branchId;
            const branch = getConversationBranches(avatar, { groupId }).find(item => item.id === branchId);
            if (avatar && branchId && branch) {
                const confirmed = await confirmConversationAction({
                    title: `Delete the "${branch.name || 'Conversation'}" branch?`,
                    text: 'This cannot be undone.',
                });
                if (confirmed) {
                    deleteConversationBranch(avatar, branchId, { groupId });
                    if (isConversationActiveThread(avatar, groupId)) {
                        scheduleInterfaceRefresh({ syncControls: false });
                        renderConversationMemoryPanel();
                    } else {
                        schedulePalsRailRender();
                    }
                }
            }
            break;
        }
        case 'delete-dm': {
            const avatar = data.avatar;
            const groupId = data.groupId || '';
            const character = getCharacterForAvatar(avatar);
            if (!avatar) {
                break;
            }
            const name = character?.name || 'this character';
            const historyLabel = groupId ? `group Conversation history with ${name}` : `solo DM history with ${name}`;
            const confirmed = await confirmConversationAction({
                title: `Delete your previous ${historyLabel}?`,
                text: 'This cannot be undone.',
            });
            if (confirmed) {
                resetCharacterConversationBranches(avatar, { groupId });
                setLastConversationPreview(avatar, 'Conversation ready', { groupId });
                clearUnreadCount(avatar, { groupId });
                resetFollowupCount(avatar, { groupId });

                if (!groupId) {
                    const charSettings = getSettings(avatar, { groupId: '' });
                    charSettings.enabled = false;
                    saveSettings(avatar, charSettings, { groupId: '' });
                }

                if (isConversationActiveThread(avatar, groupId)) {
                    const remainingPals = getConversationRailItems()
                        .filter(item => !(item.character.avatar === avatar && item.groupId === groupId));
                    if (remainingPals.length > 0) {
                        const nextPal = remainingPals[0];
                        openConversationWorkspaceForAvatar(nextPal.character.avatar, { groupId: nextPal.groupId || null, showToast: false });
                        scheduleInterfaceRefresh({ syncControls: true });
                    } else {
                        conversationState.conversationWorkspaceOpen = false;
                        emitConversationWorkspaceStateChange();
                        scheduleInterfaceRefresh({ syncControls: false });
                    }
                } else {
                    schedulePalsRailRender();
                }
                toastr.success(`Deleted ${historyLabel}.`);
            }
            break;
        }
        case 'new-chat': {
            const avatar = getCurrentCharAvatar();
            if (!avatar) {
                toastr.warning('Pick a DM first.');
                break;
            }
            const groupId = getConversationGroupIdForAvatar(avatar);
            createConversationBranchForAvatar(avatar, `Chat ${getConversationBranches(avatar, { groupId }).length + 1}`, { groupId });
            updateLastUserActivity(avatar, { groupId });
            scheduleInterfaceRefresh({ syncControls: false });
            renderConversationMemoryPanel();
            toastr.success('New Conversation branch started.');
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
            branchConversationFromMessage(data.messageId);
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
                const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
                const branchId = threadStore?.activeBranchId || '';
                const messages = getConversationThread(avatar, { branchId, create: false, groupId, personaId });
                sendQueue.push(createForcedConversationQueueItem({
                    avatar,
                    branchId,
                    groupId,
                    personaId,
                    threadKey: getConversationThreadKey(avatar, groupId, { personaId }),
                    createdAt: Date.now(),
                }, messages));
                void processSendQueue();
            }
            break;
        }
        case 'set-channel':
            setConversationTimelineChannel(data.channel);
            break;
        case 'weekly-add':
            addWeeklyScheduleRow();
            break;
        case 'edit-schedule': {
            const avatar = getCurrentCharAvatar();
            if (avatar || getCurrentGroupConversationMembers().length) {
                openScheduleEditorModal(avatar);
            }
            break;
        }
        case 'reset-prompt': {
            const area = document.getElementById('sb_conv_geechan_chatroom_prompt');
            if (area instanceof HTMLTextAreaElement) {
                area.value = GEECHAN_DEFAULT_PROMPT;
                area.dispatchEvent(new Event('input', { bubbles: true }));
                toastr.success('System prompt reset to default Geechan preset.');
            }
            break;
        }
        case 'edit-grounded-dialogue-rules':
            openGroundedDialogueRulesEditor();
            break;
        case 'weekly-remove': {
            const row = target?.closest?.('.sb-conversation-weekly-row');
            if (row instanceof HTMLElement) {
                row.remove();
                saveCurrentPanelSettings();
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
        case 'generate-schedule': {
            if (conversationState.scheduleGenerationBusy) {
                break;
            }
            const character = getCurrentCharacter();
            const genAvatar = getCurrentCharAvatar();
            if (!character || !genAvatar) {
                toastr.warning('No character selected.');
                break;
            }
            conversationState.scheduleGenerationBusy = true;
            const genBtn = target instanceof HTMLElement ? target : document.createElement('button');
            const personaId = getConversationPersonaId();
            genBtn.setAttribute('disabled', '');
            toastr.info(`Generating schedule for ${character.name}…`);
            try {
                const groupId = getConversationGroupIdForAvatar(genAvatar);
                const schedule = await generateCharacterSchedule(character, { groupId, personaId });
                if (schedule) {
                    saveStoredSchedule(genAvatar, schedule, { personaId });
                    const genSettings = getSettings(genAvatar, { groupId, personaId });
                    genSettings.auto_schedule = JSON.stringify(schedule);
                    genSettings.talkativeness = schedule.talkativeness;
                    genSettings.inactivity_threshold = schedule.inactivityThresholdMinutes;
                    genSettings.schedule_generated_at = Date.now();
                    if (groupId) {
                        saveGroupConversationSettings(groupId, genSettings, { personaId });
                    }
                    saveSettings(genAvatar, genSettings, { groupId, personaId });
                    if (isConversationActiveThread(genAvatar, groupId, { personaId })) {
                        applySettingsToPanel(genSettings);
                        renderScheduleDisplay();
                        updateConversationChrome(genSettings);
                    }
                    toastr.success(`Schedule generated for ${character.name}.`);
                } else {
                    toastr.warning('Schedule generation returned no data. Try again.');
                }
            } catch (err) {
                console.error('Schedule generation error:', err);
                toastr.error('Schedule generation failed.');
            } finally {
                conversationState.scheduleGenerationBusy = false;
                genBtn.removeAttribute('disabled');
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
    bindConversationZoomEscape();
    sheld.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) {
            return;
        }

        const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
        if (drawer instanceof HTMLElement && !drawer.hidden && event.target instanceof Node && drawer.contains(event.target)) {
            event.preventDefault();
            closeConversationSettings();
            document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-action="open-settings"]`)?.focus?.({ preventScroll: true });
            return;
        }

        const palsRail = document.getElementById(CHROME_IDS.palsRail);
        if (sheld.dataset.sbConversationPage === 'pals' && getCurrentCharAvatar() && palsRail instanceof HTMLElement && event.target instanceof Node && palsRail.contains(event.target)) {
            event.preventDefault();
            void runConversationAction('close-pals');
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
        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action], .sb-conversation-pal') : null;

        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.classList.contains('sb-conversation-pal')) {
            const avatar = target.dataset.avatar || characters[parsePositiveInt(target.dataset.characterIndex, -1, 0)]?.avatar;
            const groupId = target.dataset.groupId || '';
            if (avatar) {
                closePalsRail();
                await selectConversationThread(avatar, {
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

    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement && drawer.dataset.sbConversationBound !== 'true') {
        drawer.dataset.sbConversationBound = 'true';
        drawer.addEventListener('change', saveCurrentPanelSettings);
    }

    const notificationMuted = document.getElementById('sb_conv_notifications_muted');
    if (notificationMuted instanceof HTMLInputElement && notificationMuted.dataset.sbConversationBound !== 'true') {
        notificationMuted.dataset.sbConversationBound = 'true';
        notificationMuted.addEventListener('change', updateConversationNotificationSettingsVisibility);
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

    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (backdrop instanceof HTMLElement && backdrop.dataset.sbConversationBound !== 'true') {
        backdrop.dataset.sbConversationBound = 'true';
        backdrop.addEventListener('click', () => {
            closeConversationSettings();
            closePalsRail();
        });
    }

    const palsSearch = document.getElementById('sb_conversation_pals_search');
    if (palsSearch instanceof HTMLInputElement && palsSearch.dataset.sbConversationBound !== 'true') {
        palsSearch.dataset.sbConversationBound = 'true';
        const debouncedPalsFilter = debounce(() => {
            const query = palsSearch.value.toLowerCase().trim();
            const pals = document.querySelectorAll('.sb-conversation-pal');
            pals.forEach(pal => {
                if (pal instanceof HTMLElement) {
                    const palName = pal.querySelector('.sb-conversation-pal-name')?.textContent?.toLowerCase() || '';
                    const row = pal.closest('.sb-conversation-pal-row');
                    const targetElement = row instanceof HTMLElement ? row : pal;
                    if (palName.includes(query)) {
                        targetElement.classList.remove('sb-conversation-hidden');
                    } else {
                        targetElement.classList.add('sb-conversation-hidden');
                    }
                }
            });
        }, debounce_timeout.short);
        palsSearch.addEventListener('input', debouncedPalsFilter);
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
            const threadAvatar = getCurrentCharAvatar();
            setActiveConversationPersonaAppendixIds(avatarId, selectedIds, {
                avatar: threadAvatar,
                groupId: getConversationGroupIdForAvatar(threadAvatar),
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

    const pal = getConversationPals().find(item => item.character?.avatar);
    if (pal?.character?.avatar) {
        return pal.character.avatar;
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

export function openConversationWorkspaceForAvatar(avatar, { branchId = '', groupId = null, showToast = true, enable = false } = {}) {
    closeConversationSettings();
    const character = avatar ? getCharacterForAvatar(avatar) : null;
    const targetAvatar = character?.avatar || null;
    const targetGroupId = groupId && targetAvatar && isAvatarInConversationGroup(targetAvatar, groupId) ? String(groupId) : null;
    if (branchId && targetAvatar && !getConversationBranches(targetAvatar, { groupId: targetGroupId }).some(branch => branch.id === String(branchId))) {
        return false;
    }
    const wasWorkspaceOpen = Boolean(conversationState.conversationWorkspaceOpen);
    const threadChanged = conversationState.conversationSelectedAvatar !== targetAvatar || conversationState.conversationSelectedGroupId !== targetGroupId;
    conversationState.conversationWorkspaceOpen = true;
    emitConversationWorkspaceStateChange();
    conversationState.conversationSelectedAvatar = targetAvatar;
    conversationState.conversationSelectedGroupId = targetGroupId;
    conversationState.conversationUnavailableGroupId = null;
    if (threadChanged) {
        conversationState.conversationTimelineChannel = 'main';
        conversationState.conversationTimelineSearchQuery = '';
    }
    if (!wasWorkspaceOpen || threadChanged) {
        conversationState.timelineBottomScrollPending = true;
    }
    ensureConversationStylesheet();

    if (!targetAvatar) {
        scheduleInterfaceRefresh({ syncControls: false });
        setTimeout(() => {
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
        }, 100);
        return false;
    }

    if (branchId) {
        setActiveConversationBranch(targetAvatar, String(branchId), { groupId: targetGroupId });
    }

    const settings = getSettings(targetAvatar, { groupId: targetGroupId });
    const wasEnabled = Boolean(settings.enabled);
    if (enable && !settings.enabled) {
        settings.enabled = true;
        saveSettings(targetAvatar, settings, { groupId: targetGroupId });
    }
    requestConversationRuntimeStart();
    applySettingsToPanel(settings);
    scheduleInterfaceRefresh({ syncControls: true });
    if (showToast && enable && !wasEnabled) {
        toastr.info(`Conversation Mode activated for ${character.name || 'Character'}.`);
    }
    setTimeout(() => {
        document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
    }, 100);
    return true;
}

export function openConversationWorkspaceFromWelcome() {
    const avatar = conversationState.conversationSelectedAvatar || getDefaultConversationAvatar();
    const selectedGroupId = conversationState.conversationSelectedGroupId || '';
    const groupId = selectedGroupId && avatar && isAvatarInConversationGroup(avatar, selectedGroupId) ? selectedGroupId : null;
    if (!avatar || !openConversationWorkspaceForAvatar(avatar, { groupId, showToast: false })) {
        toastr.warning('Pick or import a character before opening Conversation Mode.');
        return false;
    }

    return true;
}

export function getRoleplayAvatarForWelcome() {
    return conversationState.conversationSelectedAvatar || getRoleplayCurrentCharacter()?.avatar || null;
}

export function disableConversationModeForCurrentCharacter({ focusRoleplay = true } = {}) {
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    const groupId = getConversationGroupIdForAvatar(avatar);
    closeConversationSettings({ avatar, groupId, personaId });
    conversationState.conversationWorkspaceOpen = false;
    conversationState.conversationSelectedAvatar = null;
    conversationState.conversationSelectedGroupId = null;
    conversationState.conversationUnavailableGroupId = null;
    conversationState.conversationTimelineChannel = 'main';
    conversationState.conversationTimelineSearchQuery = '';
    emitConversationWorkspaceStateChange();
    scheduleInterfaceRefresh({ syncControls: false });
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
        closeConversationSettings();
        closePalsRail();
        hideConversationPickers();
        observeConversationLayout(false);
        chrome.sheld.removeAttribute('data-sb-conversation-page');
        for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.palsRail]) {
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
            conversationState.lastRenderedThreadKey = '';
            conversationState.lastRenderedMessageCount = 0;
            conversationState.timelineBottomScrollPending = false;
        }
        return;
    }

    chrome.sheld.dataset.sbConversationMode = 'on';
    for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.palsRail]) {
        const element = document.getElementById(id);
        if (element instanceof HTMLElement) {
            element.hidden = false;
        }
    }
    updateUserFooter();
    observeConversationLayout(true);
    syncConversationPage();
}
