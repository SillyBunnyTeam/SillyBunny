import { generateRaw } from '../../script.js';
import { openConversationWorkspaceForAvatar, setConversationInterfaceActive } from './chrome.js';
import { CHROME_IDS, DEFAULT_BRANCH_ID, DEFAULT_SETTINGS, SETTINGS_FIELDS } from './constants.js';
import {
    getConversationBranches,
    getConversationGroupIdForAvatar,
    getConversationThreadStore,
    getCurrentCharacter,
    getCurrentCharAvatar,
    getCurrentCharName,
    getIdleActionFromSettings,
    parsePositiveInt,
    saveGroupConversationSettings,
} from './context.js';
import { normalizeConversationOutputText } from './generation.js';
import { getConversationDisplayName, getConversationParticipants, getEffectiveConversationStatus, renderConversationParticipantStack } from './media.js';
import {
    clearUnreadCount,
    getBadgeLabel,
    getUnreadCount,
    isConversationActiveThread,
    updateConversationNotificationIndicators,
} from './notifications.js';
import { getConversationRailItems } from './pals-rail.js';
import { getAvailabilityCopy, withConversationConnectionProfile } from './personas.js';
import { readChimingPartnersFromList, readWeeklyScheduleFromEditor, updateUserFooter } from './pickers.js';
import { clamp, getConversationReplyMaxTokens, getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { getSettings, saveSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationThread, saveConversationThread } from './thread-store.js';
import { renderConversationTimeline, updateConversationNotificationSettingsVisibility } from './timeline-render.js';
import { getActiveTypingParticipants, getLastConversationPreview, updateLastPreviewFromConversation } from './typing.js';
import { registerConversationRenderer, scheduleInterfaceRefresh, scheduleTimelineRender } from './render-scheduler.js';
import { hashConversationRenderFingerprint } from './render-utils.js';

function buildBranchListFingerprint(characterStore, activeBranchId) {
    return Object.entries(characterStore?.branches || {})
        .map(([id, branch]) => [
            branch?.id || id,
            branch?.name || '',
            branch?.preview || '',
            branch?.updatedAt || '',
            branch?.unread || 0,
            (branch?.id || id) === activeBranchId ? '1' : '0',
        ].join('\u001f'))
        .join('\u001e');
}

function buildPalsRailFingerprint(pals) {
    const parts = [String(pals.length), conversationState.conversationSelectedAvatar || '', conversationState.conversationSelectedGroupId || ''];
    for (const { character, index, settings, groupId, group } of pals) {
        const avatar = character?.avatar || '';
        const unreadCount = getUnreadCount(avatar, { groupId });
        const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
        const activeBranchId = characterStore?.activeBranchId || DEFAULT_BRANCH_ID;
        const participants = getConversationParticipants(avatar, settings, { groupId })
            .map((participant) => {
                const participantSettings = participant?.avatar === avatar ? settings : getSettings(participant?.avatar, { groupId });
                return `${participant?.avatar || ''}:${participant?.name || ''}:${getEffectiveConversationStatus(participant?.avatar, participantSettings)}`;
            })
            .join(',');
        const branches = buildBranchListFingerprint(characterStore, activeBranchId);

        parts.push([
            avatar,
            index,
            character?.name || '',
            groupId || '',
            group?.name || '',
            settings?.enabled ? '1' : '0',
            settings?.availability || '',
            settings?.multi_char_names || '',
            getConversationDisplayName(avatar, settings, { groupId }),
            getLastConversationPreview(avatar, { groupId }),
            unreadCount,
            isConversationActiveThread(avatar, groupId) ? '1' : '0',
            activeBranchId,
            participants,
            branches,
        ].join('\u001f'));
    }

    return hashConversationRenderFingerprint(parts.join('\u001e'));
}

function buildHeaderParticipantsFingerprint(participants, { groupId = '', status = 'online', interactive = false } = {}) {
    const participantParts = (Array.isArray(participants) ? participants : []).map(participant => [
        participant?.avatar || '',
        participant?.name || '',
        participant?.avatar ? getEffectiveConversationStatus(participant.avatar, getSettings(participant.avatar, { groupId })) : status,
    ].join('\u001f'));

    return hashConversationRenderFingerprint([
        groupId || '',
        status || '',
        interactive ? '1' : '0',
        participantParts.join('\u001e'),
    ].join('\u001f'));
}

function renderHeaderParticipantStack(container, participants, options = {}) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const fingerprint = buildHeaderParticipantsFingerprint(participants, {
        groupId: options.groupId,
        status: options.status,
        interactive: typeof options.onAvatarClick === 'function',
    });
    if (container.dataset.sbConversationFingerprint === fingerprint) {
        return;
    }

    container.dataset.sbConversationFingerprint = fingerprint;
    renderConversationParticipantStack(container, participants, options);
}

export function renderPalsRail() {
    const list = document.getElementById(CHROME_IDS.palsList);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const pals = getConversationRailItems();
    const fingerprint = buildPalsRailFingerprint(pals);
    if (fingerprint === conversationState.lastPalsRailFingerprint && list.dataset.sbConversationFingerprint === fingerprint) {
        return;
    }

    conversationState.lastPalsRailFingerprint = fingerprint;
    list.dataset.sbConversationFingerprint = fingerprint;
    list.textContent = '';

    if (!pals.length) {
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-empty';
        empty.textContent = 'Use + to start a DM with a character.';
        list.appendChild(empty);
        updateConversationNotificationIndicators();
        return;
    }

    for (const { character, index, settings, groupId, group } of pals) {
        const unreadCount = getUnreadCount(character.avatar, { groupId });
        const row = document.createElement('div');
        row.className = 'sb-conversation-pal-row';
        row.dataset.groupId = groupId || '';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-conversation-pal';
        button.dataset.characterIndex = String(index);
        button.dataset.avatar = character.avatar;
        button.dataset.groupId = groupId || '';
        button.dataset.unread = String(unreadCount > 0);
        button.setAttribute('aria-current', String(isConversationActiveThread(character.avatar, groupId)));
        button.innerHTML = `
            <span class="sb-conversation-pal-avatar"></span>
            <span class="sb-conversation-pal-copy">
                <span class="sb-conversation-pal-name-row"><span class="sb-conversation-pal-name"></span><span class="sb-conversation-pal-kind"></span></span>
                <span class="sb-conversation-pal-preview"></span>
            </span>
            <span class="sb-conversation-pal-unread" aria-hidden="true"></span>
        `;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'sb-conversation-pal-delete fa-solid fa-trash-can';
        deleteButton.dataset.sbConversationAction = 'delete-dm';
        deleteButton.dataset.avatar = character.avatar;
        deleteButton.dataset.groupId = groupId || '';
        const deleteTitle = groupId
            ? `Delete group Conversation history with ${character.name || 'Character'}`
            : `Delete solo DM history with ${character.name || 'Character'}`;
        deleteButton.title = deleteTitle;
        deleteButton.setAttribute('aria-label', deleteTitle);

        const avatarStack = button.querySelector('.sb-conversation-pal-avatar');
        const name = button.querySelector('.sb-conversation-pal-name');
        const kind = button.querySelector('.sb-conversation-pal-kind');
        const preview = button.querySelector('.sb-conversation-pal-preview');
        const unreadBadge = button.querySelector('.sb-conversation-pal-unread');

        renderConversationParticipantStack(avatarStack, getConversationParticipants(character.avatar, settings, { groupId }), {
            status: getEffectiveConversationStatus(character.avatar, settings),
            max: 3,
        });
        if (name instanceof HTMLElement) {
            name.textContent = groupId
                ? getConversationDisplayName(character.avatar, settings, { groupId })
                : character.name || 'Character';
        }
        if (kind instanceof HTMLElement) {
            kind.textContent = groupId ? (group?.name || 'Group DM') : 'Solo';
        }
        if (preview instanceof HTMLElement) {
            preview.textContent = getLastConversationPreview(character.avatar, { groupId });
        }
        if (unreadBadge instanceof HTMLElement) {
            unreadBadge.textContent = getBadgeLabel(unreadCount);
            unreadBadge.hidden = unreadCount <= 0;
        }

        const characterStore = getConversationThreadStore(character.avatar, { create: false, groupId });
        const activeBranchId = characterStore?.activeBranchId || DEFAULT_BRANCH_ID;
        const branchList = document.createElement('div');
        branchList.className = 'sb-conversation-branch-list';
        for (const branch of getConversationBranches(character.avatar, { groupId })) {
            const branchRow = document.createElement('div');
            branchRow.className = 'sb-conversation-branch-row';
            branchRow.dataset.active = String(branch.id === activeBranchId);

            const branchButton = document.createElement('button');
            branchButton.type = 'button';
            branchButton.className = 'sb-conversation-branch-button';
            branchButton.dataset.sbConversationAction = 'select-branch';
            branchButton.dataset.avatar = character.avatar;
            branchButton.dataset.groupId = groupId || '';
            branchButton.dataset.branchId = branch.id;
            branchButton.innerHTML = '<span class="sb-conversation-branch-name"></span><span class="sb-conversation-branch-preview"></span>';
            const branchName = branchButton.querySelector('.sb-conversation-branch-name');
            const branchPreview = branchButton.querySelector('.sb-conversation-branch-preview');
            if (branchName instanceof HTMLElement) {
                branchName.textContent = branch.name || 'Conversation';
            }
            if (branchPreview instanceof HTMLElement) {
                branchPreview.textContent = branch.preview || 'Conversation ready';
            }

            const renameBranch = document.createElement('button');
            renameBranch.type = 'button';
            renameBranch.className = 'sb-conversation-branch-action fa-solid fa-pen';
            renameBranch.dataset.sbConversationAction = 'rename-branch';
            renameBranch.dataset.avatar = character.avatar;
            renameBranch.dataset.groupId = groupId || '';
            renameBranch.dataset.branchId = branch.id;
            renameBranch.title = `Rename ${branch.name || 'conversation'}`;
            renameBranch.setAttribute('aria-label', renameBranch.title);

            const deleteBranch = document.createElement('button');
            deleteBranch.type = 'button';
            deleteBranch.className = 'sb-conversation-branch-action fa-solid fa-trash-can';
            deleteBranch.dataset.sbConversationAction = 'delete-branch';
            deleteBranch.dataset.avatar = character.avatar;
            deleteBranch.dataset.groupId = groupId || '';
            deleteBranch.dataset.branchId = branch.id;
            deleteBranch.title = `Delete ${branch.name || 'conversation'}`;
            deleteBranch.setAttribute('aria-label', deleteBranch.title);

            branchRow.append(branchButton, renameBranch, deleteBranch);
            branchList.appendChild(branchRow);
        }

        const newBranch = document.createElement('button');
        newBranch.type = 'button';
        newBranch.className = 'sb-conversation-new-branch';
        newBranch.dataset.sbConversationAction = 'new-branch';
        newBranch.dataset.avatar = character.avatar;
        newBranch.dataset.groupId = groupId || '';
        newBranch.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i><span>New branch</span>';
        branchList.appendChild(newBranch);

        row.append(button, deleteButton, branchList);
        list.appendChild(row);
    }
    updateConversationNotificationIndicators();
}

export function updateConversationHeader(settings = getSettings()) {
    const character = getCurrentCharacter();
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const stage = document.getElementById(CHROME_IDS.stage);
    const name = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-name]`);
    const status = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status]`);
    const participantsContainer = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-participants]`);
    const addMemberButton = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-action="open-add-member"]`);
    const statusCopy = getAvailabilityCopy(settings.availability);
    const schedule = avatar ? getStoredSchedule(avatar) : null;
    const current = schedule ? getCurrentActivityFromSchedule(schedule, avatar) : null;
    const effectiveStatus = current ? current.status : settings.availability;

    if (!avatar || !character) {
        if (stage instanceof HTMLElement) {
            stage.dataset.ambientStatus = 'offline';
        }
        if (addMemberButton instanceof HTMLButtonElement) {
            addMemberButton.hidden = true;
        }
        renderHeaderParticipantStack(participantsContainer, [], { status: 'offline' });
        if (name instanceof HTMLElement) {
            name.textContent = 'Conversation';
        }
        if (status instanceof HTMLElement) {
            status.textContent = 'Pick or start a DM from the Pals rail.';
        }
        return;
    }

    if (stage instanceof HTMLElement) {
        stage.dataset.ambientStatus = String(effectiveStatus || settings.availability || 'online');
    }

    const participants = getConversationParticipants(avatar, settings, { groupId });
    const partnerCount = Math.max(0, participants.length - 1);
    if (addMemberButton instanceof HTMLButtonElement) {
        addMemberButton.hidden = !conversationState.conversationWorkspaceOpen;
        const label = conversationState.conversationSelectedGroupId ? 'Add member to group Conversation' : 'Add member to this DM';
        addMemberButton.title = label;
        addMemberButton.setAttribute('aria-label', label);
    }
    renderHeaderParticipantStack(participantsContainer, participants, {
        status: effectiveStatus,
        groupId,
        onAvatarClick: groupId ? (participant) => {
            if (participant?.avatar) {
                openConversationWorkspaceForAvatar(participant.avatar, { groupId: null, showToast: false });
            }
        } : null,
    });
    if (name instanceof HTMLElement) {
        name.textContent = getConversationDisplayName(avatar, settings);
    }
    if (status instanceof HTMLElement) {
        const typingParticipants = getActiveTypingParticipants(avatar, { groupId });
        if (typingParticipants.length) {
            const typingNames = typingParticipants.map(participant => participant?.name || 'Character').filter(Boolean);
            if (typingNames.length > 2) {
                status.textContent = 'Several people are typing...';
            } else if (typingNames.length > 1) {
                status.textContent = `${typingNames.join(', ')} are writing...`;
            } else {
                status.textContent = `${typingNames[0] || 'Character'} is writing...`;
            }
        } else if (current) {
            const currentCopy = getAvailabilityCopy(current.status);
            const delayedNotice = ['dnd', 'offline'].includes(current.status) ? ' · replies may be delayed' : '';
            const partnerNotice = partnerCount ? ` · ${partnerCount} pal${partnerCount === 1 ? '' : 's'} can chime in` : '';
            status.textContent = `${currentCopy.label} · ${current.activity}${delayedNotice}${partnerNotice}`;
        } else {
            const partnerNotice = partnerCount ? ` ${partnerCount} pal${partnerCount === 1 ? '' : 's'} can chime in.` : '';
            status.textContent = `${statusCopy.label}: ${statusCopy.detail}${partnerNotice}`;
        }
    }
}

export function syncConversationToolsVisibility() {
    const tools = document.getElementById(CHROME_IDS.tools);
    const toggleBtn = document.getElementById('sb_conversation_toggle_tools');
    if (tools instanceof HTMLElement) {
        const visible = localStorage.getItem('sb_conv_tools_visible') === 'true';
        if (visible) {
            tools.classList.add('visible');
            tools.style.setProperty('display', 'grid', 'important');
            if (toggleBtn) {
                toggleBtn.classList.add('active');
            }
        } else {
            tools.classList.remove('visible');
            tools.style.setProperty('display', 'none', 'important');
            if (toggleBtn) {
                toggleBtn.classList.remove('active');
            }
        }
    }
}

export function updateConversationChrome(settings = getSettings()) {
    updateConversationHeader(settings);
    renderPalsRail();
}

export function refreshConversationInterface({ syncControls = false } = {}) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId });
    if (conversationState.conversationWorkspaceOpen && avatar && !settings.enabled) {
        settings.enabled = true;
        saveSettings(avatar, settings, { groupId });
    }
    const active = Boolean(conversationState.conversationWorkspaceOpen);

    setConversationInterfaceActive(active);

    if (syncControls && avatar) {
        applySettingsToPanel(settings);
    }

    if (active) {
        if (avatar) {
            clearUnreadCount(avatar, { groupId });
            updateLastPreviewFromConversation(avatar, { groupId });
        }
        renderConversationTimeline();
        updateConversationChrome(settings);
        updateUserFooter();
        syncConversationToolsVisibility();

        const input = document.getElementById(CHROME_IDS.input);
        const send = document.getElementById(CHROME_IDS.send);
        if (input instanceof HTMLTextAreaElement) {
            input.disabled = !avatar;
            input.placeholder = avatar ? 'Type your message...' : 'Pick or start a DM from the Pals rail...';
        }
        if (send instanceof HTMLButtonElement) {
            send.disabled = !avatar;
        }
    }

    updateProsePolisherButtonVisibility();
}

export function readSettingsFromPanel(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const settings = getSettings(avatar, { groupId });

    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            settings[field.key] = Boolean(element.checked);
        } else if (field.type === 'number') {
            const parsed = parsePositiveInt(element.value, field.fallback, field.min);
            settings[field.key] = typeof field.max === 'number' ? clamp(parsed, field.min, field.max) : parsed;
        } else {
            settings[field.key] = element.value ?? '';
        }
    }

    return settings;
}

export function saveCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);

    // Sync dynamic editor state into hidden backing inputs before reading
    const weeklyInput = document.getElementById('sb_conv_weekly_schedule');
    if (weeklyInput instanceof HTMLInputElement) {
        weeklyInput.value = readWeeklyScheduleFromEditor();
    }
    const chimingInput = document.getElementById('sb_conv_multi_char_names');
    if (chimingInput instanceof HTMLInputElement) {
        chimingInput.value = readChimingPartnersFromList();
    }

    const settings = readSettingsFromPanel(avatar, { groupId });
    settings.idle_action = getIdleActionFromSettings(settings);
    settings.reply_max_tokens = getConversationReplyMaxTokens(settings);
    settings.auto_chat_names = settings.multi_char_names;
    if (groupId) {
        saveGroupConversationSettings(groupId, settings);
    }
    saveSettings(avatar, settings, { groupId });
    scheduleInterfaceRefresh({ syncControls: false });
    updateGroupMembersVisibility();
}

export function applySettingsToPanel(settings) {
    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            element.checked = Boolean(settings[field.key]);
        } else {
            element.value = settings[field.key] ?? '';
        }
    }
    updateGroupMembersVisibility();
    updateConversationNotificationSettingsVisibility();
}

export function updateGroupMembersVisibility() {
    const checkbox = document.getElementById('sb_conv_multi_char');
    const wrapper = document.getElementById('sb_conv_group_members_wrapper');
    if (checkbox instanceof HTMLInputElement && wrapper instanceof HTMLElement) {
        wrapper.hidden = !checkbox.checked;
    }
}

export function loadCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();

    if (!avatar) {
        applySettingsToPanel(DEFAULT_SETTINGS);
        scheduleInterfaceRefresh({ syncControls: false });
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId });
    applySettingsToPanel(settings);
    scheduleInterfaceRefresh({ syncControls: false });
}

export function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    if (button instanceof HTMLElement) {
        button.classList.add('displayNone');
        button.hidden = true;
    }
}

export async function handleCharacterMessagePolish(messageId, buttonElement) {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const groupId = getConversationGroupIdForAvatar(avatar);
    const thread = getConversationThread(avatar, { groupId });
    const msg = thread.find(m => m.id === messageId);
    if (!msg || !msg.mes) {
        return;
    }

    if (buttonElement instanceof HTMLElement) {
        buttonElement.classList.remove('fa-wand-magic-sparkles');
        buttonElement.classList.add('fa-spinner', 'fa-spin');
    }

    try {
        const charName = getCurrentCharName();
        const systemPrompt = `You are an editor for ${charName}'s messages. Polish ${charName}'s reply in this instant messaging chatroom to make it more expressive, fitting for their personality, and natural. Correct any structural awkwardness while preserving the exact meaning, spelling quirks, and intent of the original text. Output only the polished reply without formatting prefixes or labels.`;
        const prompt = `Polish this message text:\n"${msg.mes}"`;
        const settings = getSettings(avatar, { groupId });
        const response = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt,
            systemPrompt,
            responseLength: 300,
            trimNames: true,
        }));

        if (response?.trim()) {
            msg.mes = normalizeConversationOutputText(response.trim());
            saveConversationThread(avatar, thread, { groupId });
            updateLastPreviewFromConversation(avatar, { groupId });
            scheduleTimelineRender();
            globalThis.toastr?.success?.('Character reply polished successfully!');
        } else {
            globalThis.toastr?.error?.('Polishing failed. No response received.');
        }
    } catch (error) {
        console.error('Character prose polishing error:', error);
        globalThis.toastr?.error?.('Error polishing character reply.');
    } finally {
        if (buttonElement instanceof HTMLElement) {
            buttonElement.classList.remove('fa-spinner', 'fa-spin');
            buttonElement.classList.add('fa-wand-magic-sparkles');
        }
    }
}

registerConversationRenderer('palsRail', renderPalsRail);
registerConversationRenderer('interface', refreshConversationInterface);
