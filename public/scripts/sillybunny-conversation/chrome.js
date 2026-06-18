import { characters } from '../../script.js';
import { extension_settings } from '../extensions.js';
import { selected_group } from '../group-chats.js';
import { setUserAvatar } from '../personas.js';
import { shouldSendOnEnter } from '../RossAscends-mods.js';
import { clearConversationAttachmentInput, processSendQueue, submitConversationInput, updateConversationAttachmentPreview } from './attachments.js';
import { CHROME_IDS, GEECHAN_DEFAULT_PROMPT } from './constants.js';
import {
    createConversationBranchForAvatar,
    deleteConversationBranch,
    getConversationBranches,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
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
    syncConversationToolsVisibility,
    updateConversationChrome,
    updateConversationHeader,
} from './interface.js';
import { getCharacterForAvatar } from './media.js';
import { clearUnreadCount, isConversationActiveThread } from './notifications.js';
import { getConversationPals, getConversationRailItems, getCurrentGroupConversationMembers } from './pals-rail.js';
import { editUserPersonaStatus, setActiveConversationPersonaAppendixIds, setUserStatus } from './personas.js';
import {
    addWeeklyScheduleRow,
    handleCreateConversationGroupFromPicker,
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
    openConversationSettings,
    openScheduleEditorModal,
    refreshConversationMemoryFromPanel,
    renderConversationMemoryPanel,
    renderScheduleDisplay,
    togglePalsRail,
} from './settings-panel.js';
import { getSettings, resetFollowupCount, saveSettings } from './settings-store.js';
import { conversationState, sendQueue } from './state.js';
import { updateLastUserActivity } from './thread-store.js';
import {
    addConversationFilesToInput,
    branchConversationFromMessage,
    copyConversationMessage,
    deleteConversationMessage,
    ensureConversationChrome,
    quickConversationReminder,
    quickConversationSelfie,
    quickConversationSummarize,
    reactConversationMessage,
    regenerateConversationMessage,
    setConversationTimelineChannel,
    toggleConversationMessagePin,
    updateConversationNotificationSettingsVisibility,
    updateConversationSearchQuery,
} from './timeline-render.js';
import { setLastConversationPreview } from './typing.js';

export function bindConversationChromeControls(sheld) {
    if (sheld.dataset.sbConversationChromeBound === 'true') {
        return;
    }

    sheld.dataset.sbConversationChromeBound = 'true';
    sheld.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-sb-conversation-action], .sb-conversation-pal, .sb-conversation-mobile-menu-trigger') : null;

        if (!target || (!target.closest('.sb-conversation-message-actions') && !target.closest('.sb-conversation-mobile-menu-trigger'))) {
            document.querySelectorAll('.sb-conversation-message-actions.open').forEach(el => {
                el.classList.remove('open');
            });
        }

        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.classList.contains('sb-conversation-mobile-menu-trigger')) {
            event.stopPropagation();
            const currentBubble = target.closest('.sb-conversation-message-bubble');
            const currentActionBar = currentBubble?.querySelector('.sb-conversation-message-actions');
            if (currentActionBar) {
                const isOpen = currentActionBar.classList.contains('open');
                document.querySelectorAll('.sb-conversation-message-actions.open').forEach(el => {
                    if (el !== currentActionBar) {
                        el.classList.remove('open');
                    }
                });
                if (isOpen) {
                    currentActionBar.classList.remove('open');
                } else {
                    currentActionBar.classList.add('open');
                }
            }
            return;
        }

        if (target.classList.contains('sb-conversation-pal')) {
            const avatar = target.dataset.avatar || characters[parsePositiveInt(target.dataset.characterIndex, -1, 0)]?.avatar;
            const groupId = target.dataset.groupId || '';
            if (avatar) {
                closePalsRail();
                openConversationWorkspaceForAvatar(avatar, {
                    groupId: groupId || null,
                    showToast: false,
                });
            }
            return;
        }

        switch (target.dataset.sbConversationAction) {
            case 'toggle-tools': {
                const currentVisible = localStorage.getItem('sb_conv_tools_visible') === 'true';
                localStorage.setItem('sb_conv_tools_visible', String(!currentVisible));
                syncConversationToolsVisibility();
                break;
            }
            case 'toggle-pals':
                togglePalsRail();
                break;
            case 'close-pals':
                closePalsRail();
                break;
            case 'open-settings':
                openConversationSettings();
                break;
            case 'close-settings':
                closeConversationSettings();
                break;
            case 'return-roleplay':
                disableConversationModeForCurrentCharacter();
                break;
            case 'polish-character-message':
                await handleCharacterMessagePolish(target.dataset.messageId, target);
                break;
            case 'open-add-member':
                openAddMemberPicker();
                break;
            case 'open-add-dm':
                toggleAddDmPicker();
                break;
            case 'open-new-group-chat':
                toggleConversationGroupPicker();
                break;
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
            case 'create-memory':
                await forceCreateMemoryFromPanel();
                break;
            case 'refresh-memory':
                await refreshConversationMemoryFromPanel();
                break;
            case 'clear-memory':
                clearConversationMemoryFromPanel();
                break;
            case 'stop-image-generation':
                conversationState.imageGenerationAbortController?.abort?.();
                conversationState.imageGenerationActive = false;
                conversationState.imageGenerationAbortController = null;
                scheduleTimelineRender();
                toastr.info('Image generation stopped.');
                break;
            case 'add-character-dm': {
                const index = parsePositiveInt(target.dataset.characterIndex, -1, 0);
                if (index >= 0) {
                    const char = characters[index];
                    if (char?.avatar) {
                        const charSettings = getSettings(char.avatar, { groupId: '' });
                        charSettings.enabled = true;
                        saveSettings(char.avatar, charSettings, { groupId: '' });
                        document.getElementById('sb_conversation_add_dm_picker')?.setAttribute('hidden', '');
                        closePalsRail();
                        openConversationWorkspaceForAvatar(char.avatar, {
                            groupId: null,
                            showToast: false,
                        });
                        schedulePalsRailRender();
                        setTimeout(() => {
                            const input = document.getElementById(CHROME_IDS.input);
                            if (input instanceof HTMLTextAreaElement) {
                                input.focus();
                            }
                        }, 100);
                    }
                }
                break;
            }
            case 'select-branch': {
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const branchId = target.dataset.branchId;
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
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const character = getCharacterForAvatar(avatar);
                if (!avatar) {
                    break;
                }
                const fallbackName = `Chat ${getConversationBranches(avatar, { groupId }).length + 1}`;
                const name = globalThis.prompt?.(`Name this Conversation branch for ${character?.name || 'this character'}`, fallbackName) || fallbackName;
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
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const branchId = target.dataset.branchId;
                const branch = getConversationBranches(avatar, { groupId }).find(item => item.id === branchId);
                if (avatar && branchId && branch) {
                    const name = globalThis.prompt?.('Rename Conversation branch', branch.name || 'Conversation');
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
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const branchId = target.dataset.branchId;
                const branch = getConversationBranches(avatar, { groupId }).find(item => item.id === branchId);
                if (avatar && branchId && branch) {
                    const confirmed = typeof globalThis.confirm === 'function'
                        ? globalThis.confirm(`Delete the "${branch.name || 'Conversation'}" branch? This cannot be undone.`)
                        : true;
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
                const avatar = target.dataset.avatar;
                const groupId = target.dataset.groupId || '';
                const character = getCharacterForAvatar(avatar);
                if (!avatar) {
                    break;
                }
                const name = character?.name || 'this character';
                const historyLabel = groupId ? `group Conversation history with ${name}` : `solo DM history with ${name}`;
                const confirmed = typeof globalThis.confirm === 'function'
                    ? globalThis.confirm(`Delete your previous ${historyLabel}? This cannot be undone.`)
                    : true;
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
                editConversationMessage(target.dataset.messageId);
                break;
            case 'copy-message':
                await copyConversationMessage(target.dataset.messageId);
                break;
            case 'toggle-message-pin':
                toggleConversationMessagePin(target.dataset.messageId);
                break;
            case 'react-message':
                reactConversationMessage(target.dataset.messageId, target.dataset.reaction);
                break;
            case 'branch-from-message':
                branchConversationFromMessage(target.dataset.messageId);
                break;
            case 'regenerate-message':
                await regenerateConversationMessage(target.dataset.messageId);
                break;
            case 'delete-message': {
                const confirmed = typeof globalThis.confirm === 'function'
                    ? globalThis.confirm('Delete this Conversation message?')
                    : true;
                if (confirmed) {
                    deleteConversationMessage(target.dataset.messageId);
                }
                break;
            }
            case 'quick-selfie':
                await quickConversationSelfie();
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
                    sendQueue.push({
                        avatar,
                        groupId,
                        text: '',
                        attachmentContext: '',
                        createdAt: Date.now(),
                        force: true,
                    });
                    void processSendQueue();
                }
                break;
            }
            case 'set-channel':
                setConversationTimelineChannel(target.dataset.channel);
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
            case 'weekly-remove': {
                const row = target.closest('.sb-conversation-weekly-row');
                if (row instanceof HTMLElement) {
                    row.remove();
                    saveCurrentPanelSettings();
                }
                break;
            }
            case 'set-user-status': {
                const status = target.dataset.status;
                if (status) {
                    setUserStatus(status);
                    updateUserFooter();
                    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');
                }
                break;
            }
            case 'open-user-status-picker':
                toggleUserStatusPicker();
                break;
            case 'edit-user-persona-status':
                editUserPersonaStatus();
                break;
            case 'open-persona-picker':
                togglePersonaPicker();
                break;
            case 'pick-persona': {
                const avatarId = target.dataset.personaAvatar;
                if (avatarId) {
                    await setUserAvatar(avatarId, { toastPersonaNameChange: false });
                    updateUserFooter();
                    saveCurrentPanelSettings();
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
                const genBtn = target;
                genBtn.setAttribute('disabled', '');
                toastr.info(`Generating schedule for ${character.name}…`);
                try {
                    const groupId = getConversationGroupIdForAvatar(genAvatar);
                    const schedule = await generateCharacterSchedule(character, { groupId });
                    if (schedule) {
                        saveStoredSchedule(genAvatar, schedule);
                        const genSettings = getSettings(genAvatar, { groupId });
                        genSettings.auto_schedule = JSON.stringify(schedule);
                        genSettings.talkativeness = schedule.talkativeness;
                        genSettings.inactivity_threshold = schedule.inactivityThresholdMinutes;
                        genSettings.schedule_generated_at = Date.now();
                        if (groupId) {
                            saveGroupConversationSettings(groupId, genSettings);
                        }
                        saveSettings(genAvatar, genSettings, { groupId });
                        applySettingsToPanel(genSettings);
                        renderScheduleDisplay();
                        updateConversationChrome(genSettings);
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
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight}px`;
        });
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
        searchInput.addEventListener('input', () => updateConversationSearchQuery(searchInput.value));
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
        palsSearch.addEventListener('input', () => {
            const query = palsSearch.value.toLowerCase().trim();
            const pals = document.querySelectorAll('.sb-conversation-pal');
            pals.forEach(pal => {
                if (pal instanceof HTMLElement) {
                    const palName = pal.querySelector('.sb-conversation-pal-name')?.textContent?.toLowerCase() || '';
                    const row = pal.closest('.sb-conversation-pal-row');
                    const targetElement = row instanceof HTMLElement ? row : pal;
                    if (palName.includes(query)) {
                        targetElement.style.display = '';
                    } else {
                        targetElement.style.display = 'none';
                    }
                }
            });
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
            setActiveConversationPersonaAppendixIds(avatarId, selectedIds);
            renderConversationPersonaPicker(personaPicker);
            updateUserFooter();
        });
    }
}

export function getDefaultConversationAvatar() {
    const group = getConversationGroupById(selected_group);
    const groupAvatar = group?.members
        ?.filter(avatar => avatar && !group.disabled_members?.includes(avatar))
        ?.find(avatar => getCharacterForAvatar(avatar));
    if (selected_group && groupAvatar) {
        return groupAvatar;
    }

    const currentAvatar = getRoleplayCurrentCharacter()?.avatar;
    if (currentAvatar) {
        return currentAvatar;
    }

    const pal = getConversationPals().find(item => item.character?.avatar);
    if (pal?.character?.avatar) {
        return pal.character.avatar;
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar)?.avatar || null;
}

export function openConversationWorkspaceForAvatar(avatar, { groupId = null, showToast = true } = {}) {
    const character = avatar ? getCharacterForAvatar(avatar) : null;
    const targetAvatar = character?.avatar || null;
    const targetGroupId = groupId && targetAvatar && isAvatarInConversationGroup(targetAvatar, groupId) ? String(groupId) : null;
    const threadChanged = conversationState.conversationSelectedAvatar !== targetAvatar || conversationState.conversationSelectedGroupId !== targetGroupId;
    conversationState.conversationWorkspaceOpen = true;
    conversationState.conversationSelectedAvatar = targetAvatar;
    conversationState.conversationSelectedGroupId = targetGroupId;
    if (threadChanged) {
        conversationState.conversationTimelineChannel = 'main';
        conversationState.conversationTimelineSearchQuery = '';
    }

    if (!targetAvatar) {
        scheduleInterfaceRefresh({ syncControls: false });
        setTimeout(() => {
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: false });
        }, 100);
        return false;
    }

    const settings = getSettings(targetAvatar, { groupId: targetGroupId });
    const wasEnabled = Boolean(settings.enabled);
    settings.enabled = true;
    saveSettings(targetAvatar, settings, { groupId: targetGroupId });
    applySettingsToPanel(settings);
    scheduleInterfaceRefresh({ syncControls: true });
    if (showToast && !wasEnabled) {
        toastr.info(`Conversation Mode activated for ${character.name || 'Character'}.`);
    }
    setTimeout(() => {
        document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: false });
    }, 100);
    return true;
}

export function openConversationWorkspaceFromWelcome() {
    const avatar = conversationState.conversationSelectedAvatar || getDefaultConversationAvatar();
    const groupId = selected_group && avatar && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null;
    if (!avatar || !openConversationWorkspaceForAvatar(avatar, { groupId, showToast: false })) {
        toastr.warning('Pick or import a character before opening Conversation Mode.');
        return false;
    }

    return true;
}

export function disableConversationModeForCurrentCharacter({ focusRoleplay = true } = {}) {
    conversationState.conversationWorkspaceOpen = false;
    conversationState.conversationSelectedAvatar = null;
    conversationState.conversationSelectedGroupId = null;
    conversationState.conversationTimelineChannel = 'main';
    conversationState.conversationTimelineSearchQuery = '';
    scheduleInterfaceRefresh({ syncControls: false });
    if (focusRoleplay) {
        document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
    }
}

export function getSelectedConnectionProfileName() {
    const manager = extension_settings.connectionManager;
    if (!manager || !Array.isArray(manager.profiles)) {
        return '';
    }
    const selected = manager.profiles.find((profile) => profile?.id === manager.selectedProfile);
    return selected?.name ?? '';
}

export function applyConversationContext(settings) {
    // Deprecated: rely entirely on temporary switches during generation to avoid corrupting global connection profile state.
}

export function restoreConversationContext() {
    // Deprecated: rely entirely on temporary switches during generation to avoid corrupting global connection profile state.
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
        restoreConversationContext();
        for (const id of [CHROME_IDS.header, CHROME_IDS.stage, CHROME_IDS.palsRail]) {
            const element = document.getElementById(id);
            if (element instanceof HTMLElement) {
                element.hidden = true;
            }
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
    const avatar = getCurrentCharAvatar();
    if (avatar) {
        const groupId = getConversationGroupIdForAvatar(avatar);
        applyConversationContext(getSettings(avatar, { groupId }));
    }
    updateUserFooter();
}
