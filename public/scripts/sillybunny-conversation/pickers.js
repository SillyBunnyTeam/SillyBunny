import {
    characters,
    default_avatar,
    default_user_avatar,
    getCharacters,
    getRequestHeaders,
    getThumbnailUrl,
    name1,
} from '../../script.js';
import { group_activation_strategy, group_generation_mode, groups } from '../group-chats.js';
import { user_avatar } from '../personas.js';
import { openConversationWorkspaceForAvatar } from './chrome.js';
import { AVAILABILITY_COPY, CHROME_IDS, DEFAULT_BRANCH_ID, WEEKDAY_LABELS } from './constants.js';
import {
    createConversationBranch,
    getConversationGroupById,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getDefaultGroupConversationSettings,
    normalizeConversationBranch,
    persistConversationStore,
} from './context.js';
import { renderPalsRail, saveCurrentPanelSettings } from './interface.js';
import { getCharacterForAvatar } from './media.js';
import {
    getActiveConversationPersonaAppendixIds,
    getConversationPersonaAppendices,
    getPersonaOptions,
    getUserPersonaStatus,
    getUserStatus,
    safeParseWeeklySchedule,
} from './personas.js';
import { closePalsRail, setConversationBackdropVisible } from './settings-panel.js';
import { conversationState } from './state.js';
import { escapeHtmlAttribute, escapeHtmlText } from './timeline-render.js';

export function renderWeeklyScheduleEditor(container, scheduleJson) {
    const entries = safeParseWeeklySchedule(scheduleJson);
    container.innerHTML = '';
    for (const entry of entries) {
        container.appendChild(createWeeklyScheduleRow(entry));
    }
}

export function createWeeklyScheduleRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'sb-conversation-weekly-row';
    const dayPills = WEEKDAY_LABELS.map((label, idx) => {
        const checked = Array.isArray(entry.days) && entry.days.includes(idx) ? ' checked' : '';
        return `<label class="sb-conversation-day-pill"><input type="checkbox" class="sb-conv-day-check" data-day="${idx}"${checked} /><span>${label}</span></label>`;
    }).join('');
    row.innerHTML = `
        <div class="sb-conversation-day-pills">${dayPills}</div>
        <div class="sb-conversation-weekly-row-meta">
            <input type="time" class="text_pole textarea_compact sb-conv-weekly-time" value="${escapeHtmlAttribute(entry.time || '08:00')}" aria-label="Schedule time" />
            <input type="text" class="text_pole textarea_compact sb-conv-weekly-message" value="${escapeHtmlAttribute(entry.message || '')}" placeholder="Good morning selfie!" aria-label="Schedule message" />
            <label class="checkbox_label sb-conv-weekly-enabled">
                <input type="checkbox" class="sb-conv-weekly-enabled-check"${entry.enabled !== false ? ' checked' : ''} />
                <span>On</span>
            </label>
            <button type="button" class="menu_button menu_button_icon sb-conv-weekly-remove" data-sb-conversation-action="weekly-remove" title="Remove slot" aria-label="Remove slot">
                <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
            </button>
        </div>
    `;
    return row;
}

export function addWeeklyScheduleRow() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    if (!(editor instanceof HTMLElement)) {
        return;
    }

    editor.appendChild(createWeeklyScheduleRow({ days: [], time: '08:00', message: '', enabled: true }));
    saveCurrentPanelSettings();
}

export function readWeeklyScheduleFromEditor() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    if (!(editor instanceof HTMLElement)) {
        return '[]';
    }

    const entries = [];
    for (const row of editor.querySelectorAll('.sb-conversation-weekly-row')) {
        const days = [];
        row.querySelectorAll('.sb-conv-day-check:checked').forEach((cb) => {
            const day = parseInt(cb.dataset.day, 10);
            if (!Number.isNaN(day)) {
                days.push(day);
            }
        });
        const timeEl = row.querySelector('.sb-conv-weekly-time');
        const messageEl = row.querySelector('.sb-conv-weekly-message');
        const enabledEl = row.querySelector('.sb-conv-weekly-enabled-check');
        entries.push({
            days,
            time: timeEl instanceof HTMLInputElement ? timeEl.value : '08:00',
            message: messageEl instanceof HTMLInputElement ? messageEl.value : '',
            enabled: enabledEl instanceof HTMLInputElement ? enabledEl.checked : true,
        });
    }

    return JSON.stringify(entries);
}

export function readPartnersFromList(listId) {
    const list = document.getElementById(listId);
    if (!(list instanceof HTMLElement)) {
        return '';
    }

    const checked = [];
    list.querySelectorAll('.sb-conversation-partner-checkbox:checked').forEach((cb) => {
        if (cb instanceof HTMLInputElement && cb.value) {
            checked.push(cb.value);
        }
    });
    return checked.join(', ');
}

export function readChimingPartnersFromList() {
    return readPartnersFromList('sb_conv_chiming_partner_list');
}

export function updateUserFooter() {
    const footer = document.getElementById(CHROME_IDS.railFooter);
    if (!(footer instanceof HTMLElement)) {
        return;
    }

    const personaName = name1 || 'You';
    const status = getUserStatus();
    const statusCopy = AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
    const personaStatus = getUserPersonaStatus();

    const avatarEl = document.getElementById('sb_conv_footer_persona_avatar');
    const nameEl = document.getElementById('sb_conv_footer_persona_name');
    const statusEl = document.getElementById('sb_conv_footer_user_status');
    const activeDot = footer.querySelector('.sb-conversation-rail-footer-dot');

    if (avatarEl instanceof HTMLImageElement) {
        const activeAvatar = typeof user_avatar === 'string' ? user_avatar : null;
        avatarEl.src = activeAvatar ? getThumbnailUrl('persona', activeAvatar) : (default_user_avatar || '');
        avatarEl.alt = personaName;
    }
    if (nameEl instanceof HTMLElement) {
        nameEl.textContent = personaName;
    }
    if (statusEl instanceof HTMLElement) {
        statusEl.textContent = personaStatus || statusCopy.label;
        statusEl.dataset.status = status;
        statusEl.title = personaStatus ? `${statusCopy.label}: ${statusCopy.detail}` : statusCopy.detail;
    }
    if (activeDot instanceof HTMLElement) {
        activeDot.dataset.status = status;
    }
}

export function toggleUserStatusPicker() {
    const picker = document.getElementById(CHROME_IDS.userStatusPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    picker.hidden = !isHidden;
}

export function renderConversationPersonaPicker(picker) {
    picker.innerHTML = '';
    const personas = getPersonaOptions();
    if (!personas.length) {
        picker.innerHTML = '<div class="sb-conversation-empty">No personas configured.</div>';
        return;
    }

    for (const { avatarId, personaName } of personas) {
        const entry = document.createElement('div');
        entry.className = 'sb-conversation-persona-entry';
        entry.dataset.personaAvatar = avatarId;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sb-conversation-persona-option';
        btn.dataset.sbConversationAction = 'pick-persona';
        btn.dataset.personaAvatar = avatarId;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', String(avatarId === user_avatar));

        const img = document.createElement('img');
        img.src = getThumbnailUrl('persona', avatarId);
        img.alt = '';
        img.loading = 'lazy';

        const name = document.createElement('span');
        name.className = 'sb-conversation-persona-option-name';
        name.textContent = personaName;
        btn.append(img, name);
        entry.appendChild(btn);

        const appendices = getConversationPersonaAppendices(avatarId);
        if (appendices.length) {
            const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId));
            const notes = document.createElement('div');
            notes.className = 'sb-conversation-persona-notes';

            const notesTitle = document.createElement('div');
            notesTitle.className = 'sb-conversation-persona-notes-title';
            notesTitle.textContent = 'Scenario Notes';
            notes.appendChild(notesTitle);

            for (const appendix of appendices) {
                const label = document.createElement('label');
                label.className = 'sb-conversation-persona-note-option';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = appendix.id;
                checkbox.dataset.personaAvatar = avatarId;
                checkbox.className = 'sb-conversation-persona-note-checkbox';
                checkbox.checked = activeIds.has(appendix.id);
                const noteName = document.createElement('span');
                noteName.textContent = appendix.name;
                label.append(checkbox, noteName);
                notes.appendChild(label);
            }

            entry.appendChild(notes);
        }

        picker.appendChild(entry);
    }
}

export function togglePersonaPicker() {
    const picker = document.getElementById(CHROME_IDS.personaPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');

    if (isHidden) {
        renderConversationPersonaPicker(picker);
    }

    picker.hidden = !isHidden;
}

export function bindWeeklyScheduleEditor() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    const hiddenInput = document.getElementById('sb_conv_weekly_schedule');
    if (!(editor instanceof HTMLElement)) {
        return;
    }

    const scheduleJson = hiddenInput instanceof HTMLInputElement ? hiddenInput.value : '[]';
    renderWeeklyScheduleEditor(editor, scheduleJson);

    if (editor.dataset.sbConversationBound !== 'true') {
        editor.dataset.sbConversationBound = 'true';
        editor.addEventListener('change', saveCurrentPanelSettings);
    }
}

export function bindPartnerList(listId, searchId) {
    const list = document.getElementById(listId);
    if (!(list instanceof HTMLElement) || list.dataset.sbConversationBound === 'true') {
        return;
    }

    list.dataset.sbConversationBound = 'true';
    list.addEventListener('change', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.sb-conversation-partner-checkbox')) {
            saveCurrentPanelSettings();
        }
    });

    const searchInput = document.getElementById(searchId);
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            const options = list.querySelectorAll('.sb-conversation-partner-option');
            options.forEach(opt => {
                if (opt instanceof HTMLElement) {
                    const charName = opt.dataset.charName || '';
                    if (charName.includes(query)) {
                        opt.style.display = '';
                    } else {
                        opt.style.display = 'none';
                    }
                }
            });
        });
    }
}

export function toggleAddDmPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    if (!picker.hasAttribute('hidden') && picker.dataset.pickerType === 'solo') {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.dataset.pickerType = 'solo';
    picker.dataset.selectedMembers = '';
    picker.onchange = null;
    picker.removeAttribute('hidden');
    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span style="font-weight: var(--sb-weight-title); font-size: var(--sb-type-meta);">Open a solo DM</span>
            <p class="sb-conversation-field-hint" style="margin: 4px 0 0;">This opens the character alone, even if they also have a group Conversation.</p>
            <input type="text" id="sb_conversation_add_dm_search" class="text_pole textarea_compact" placeholder="Search characters..." style="inline-size: 100%; margin-top: 8px;" />
        </div>
        <div class="sb-conversation-add-dm-list" id="sb_conversation_add_dm_list" style="margin-top: 8px; max-block-size: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div>
    `;

    const listContainer = document.getElementById('sb_conversation_add_dm_list');
    const searchInput = document.getElementById('sb_conversation_add_dm_search');

    function renderList(query = '') {
        if (!listContainer) return;
        const rows = [];
        (Array.isArray(characters) ? characters : []).forEach((character, idx) => {
            if (!character?.avatar) return;
            const name = character.name || 'Character';
            if (query && !name.toLowerCase().includes(query)) return;

            const thumb = getThumbnailUrl('avatar', character.avatar);
            rows.push(`
                <button type="button" class="sb-conversation-add-dm-option" data-sb-conversation-action="add-character-dm" data-character-index="${idx}" style="display: flex; align-items: center; gap: 8px; inline-size: 100%; background: none; border: none; padding: 6px; border-radius: var(--sb-radius-sm); text-align: left; cursor: pointer; color: inherit;">
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" style="inline-size: 24px; block-size: 24px; border-radius: 50%; object-fit: cover;" loading="lazy" />
                    <span style="font-size: var(--sb-type-caption);">${escapeHtmlText(name)}</span>
                </button>
            `);
        });

        if (!rows.length) {
            listContainer.innerHTML = '<div class="sb-conversation-empty" style="padding: 8px; font-size: var(--sb-type-meta); opacity: 0.7;">No matching characters found.</div>';
        } else {
            listContainer.innerHTML = rows.join('');
        }
    }

    renderList();

    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value.toLowerCase().trim());
        });
    }
}

export function hideConversationStartPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (picker instanceof HTMLElement) {
        picker.setAttribute('hidden', '');
    }
}

export function openPalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'true';
    }
    setConversationBackdropVisible();
}

export function getUniqueConversationGroupMembers(memberAvatars) {
    const members = [];
    for (const avatar of Array.isArray(memberAvatars) ? memberAvatars : []) {
        if (avatar && !members.includes(avatar) && getCharacterForAvatar(avatar)) {
            members.push(avatar);
        }
    }

    return members;
}

export function getConversationGroupMemberNames(memberAvatars) {
    return getUniqueConversationGroupMembers(memberAvatars)
        .map(avatar => getCharacterForAvatar(avatar)?.name || 'Character')
        .filter(Boolean);
}

export function buildConversationGroupName(memberAvatars) {
    const names = getConversationGroupMemberNames(memberAvatars);
    if (!names.length) {
        return 'Conversation Group';
    }

    const visibleNames = names.slice(0, 3).join(', ');
    const hiddenCount = Math.max(0, names.length - 3);
    return `Group: ${visibleNames}${hiddenCount ? ` +${hiddenCount}` : ''}`;
}

export function cloneConversationStoreValue(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

export function copyConversationThreadToGroup(sourceAvatar, targetGroupId, { sourceGroupId = '' } = {}) {
    if (!sourceAvatar || !targetGroupId) {
        return false;
    }

    const sourceStore = getConversationThreadStore(sourceAvatar, { create: false, groupId: sourceGroupId || '' });
    const targetStore = getConversationThreadStore(sourceAvatar, { create: true, groupId: targetGroupId });
    if (!sourceStore?.branches || !targetStore) {
        return false;
    }

    const clonedBranches = cloneConversationStoreValue(sourceStore.branches);
    targetStore.activeBranchId = sourceStore.activeBranchId || DEFAULT_BRANCH_ID;
    targetStore.branches = clonedBranches && typeof clonedBranches === 'object'
        ? clonedBranches
        : { [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID) };

    const activeBranchId = targetStore.activeBranchId || DEFAULT_BRANCH_ID;
    targetStore.branches[activeBranchId] = normalizeConversationBranch(targetStore.branches[activeBranchId], activeBranchId);
    targetStore.branches[activeBranchId].sessionMarkers = {
        ...(targetStore.branches[activeBranchId].sessionMarkers || {}),
        copied_to_group_at: Date.now(),
    };
    persistConversationStore();
    return true;
}

export async function createConversationGroup(memberAvatars, { sourceAvatar = '', copySourceGroupId = null } = {}) {
    const members = getUniqueConversationGroupMembers(memberAvatars);
    if (members.length < 2) {
        toastr.warning('Pick at least two characters for a group Conversation.');
        return null;
    }

    const chatId = `conversation_${Date.now()}`;
    const groupCreateModel = {
        name: buildConversationGroupName(members),
        members,
        avatar_url: default_avatar,
        allow_self_responses: false,
        activation_strategy: group_activation_strategy.NATURAL,
        generation_mode: group_generation_mode.SWAP,
        disabled_members: [],
        fav: false,
        chat_id: chatId,
        chats: [chatId],
        auto_mode_delay: 120,
        conversation_settings: getDefaultGroupConversationSettings(),
    };

    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        toastr.error(`Could not create group Conversation${detail ? `: ${detail.slice(0, 120)}` : '.'}`);
        return null;
    }

    const group = await response.json();
    if (!group?.id) {
        toastr.error('The group Conversation was created without a group id.');
        return null;
    }

    if (Array.isArray(groups)) {
        const existingIndex = groups.findIndex(item => String(item?.id) === String(group.id));
        if (existingIndex >= 0) {
            groups[existingIndex] = { ...groups[existingIndex], ...group };
        } else {
            groups.push(group);
        }
    }

    try {
        await getCharacters();
    } catch (error) {
        console.warn('Could not refresh characters after creating a Conversation group.', error);
    }

    return getConversationGroupById(group.id) || group;
}

export async function createAndOpenConversationGroup(memberAvatars, { sourceAvatar = '', copySourceGroupId = null } = {}) {
    const group = await createConversationGroup(memberAvatars, { sourceAvatar, copySourceGroupId });
    if (!group?.id || !Array.isArray(group.members)) {
        return false;
    }

    const targetAvatar = sourceAvatar && group.members.includes(sourceAvatar)
        ? sourceAvatar
        : group.members.find(avatar => getCharacterForAvatar(avatar));
    if (!targetAvatar) {
        toastr.warning('This group does not have any available character cards for Conversation Mode.');
        return false;
    }

    hideConversationStartPicker();
    closePalsRail();
    const opened = openConversationWorkspaceForAvatar(targetAvatar, {
        groupId: String(group.id),
        showToast: false,
    });
    if (opened) {
        renderPalsRail();
        setTimeout(() => {
            document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
        }, 100);
        toastr.success(`Opened group Conversation for ${group.name || 'this group'}.`);
    }

    return opened;
}

export function getCurrentGroupMemberAvatars(groupId) {
    const group = getConversationGroupById(groupId);
    if (!group?.members?.length) {
        return [];
    }

    return group.members.filter(avatar => avatar && !group.disabled_members?.includes(avatar) && getCharacterForAvatar(avatar));
}

export function toggleConversationGroupPicker({ sourceAvatar = '', sourceGroupId = '' } = {}) {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const normalizedSourceGroupId = sourceGroupId || '';
    const sourceMembers = normalizedSourceGroupId ? getCurrentGroupMemberAvatars(normalizedSourceGroupId) : [];
    const lockedMembers = new Set(sourceAvatar ? (sourceMembers.length ? sourceMembers : [sourceAvatar]) : []);
    const selectedMembers = new Set(lockedMembers);
    const copyFromCurrentThread = false;

    if (!picker.hasAttribute('hidden')
        && picker.dataset.pickerType === 'group'
        && picker.dataset.sourceAvatar === (sourceAvatar || '')
        && picker.dataset.copySourceGroupId === normalizedSourceGroupId) {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.dataset.pickerType = 'group';
    picker.dataset.sourceAvatar = sourceAvatar || '';
    picker.dataset.copySource = String(copyFromCurrentThread);
    picker.dataset.copySourceGroupId = normalizedSourceGroupId;
    picker.removeAttribute('hidden');

    const title = sourceAvatar
        ? (normalizedSourceGroupId ? 'Add members to this group' : 'Add members to this DM')
        : 'Start a group DM';
    const description = sourceAvatar
        ? 'Selected members will open as a separate group Conversation with its own history and group controls.'
        : 'Pick two or more characters to create a group Conversation independent of the active roleplay chat.';

    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span style="font-weight: var(--sb-weight-title); font-size: var(--sb-type-meta);">${escapeHtmlText(title)}</span>
            <p class="sb-conversation-field-hint" style="margin: 4px 0 0;">${escapeHtmlText(description)}</p>
            <input type="text" id="sb_conversation_group_search" class="text_pole textarea_compact" placeholder="Search characters..." style="inline-size: 100%; margin-top: 8px;" />
        </div>
        <div class="sb-conversation-add-dm-list" id="sb_conversation_group_list" style="margin-top: 8px; max-block-size: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div>
        <div class="sb-conversation-group-picker-actions" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px;">
            <span id="sb_conversation_group_selected_count" class="sb-conversation-field-hint" style="margin: 0;"></span>
            <span style="display: flex; gap: 6px;">
                <button type="button" class="menu_button" data-sb-conversation-action="cancel-conversation-group">Cancel</button>
                <button type="button" class="menu_button" data-sb-conversation-action="create-conversation-group">Create Group</button>
            </span>
        </div>
    `;

    const listContainer = document.getElementById('sb_conversation_group_list');
    const searchInput = document.getElementById('sb_conversation_group_search');
    const selectedCount = document.getElementById('sb_conversation_group_selected_count');
    const createButton = picker.querySelector('[data-sb-conversation-action="create-conversation-group"]');

    function syncSelectedMembers() {
        lockedMembers.forEach(avatar => selectedMembers.add(avatar));
        picker.dataset.selectedMembers = JSON.stringify([...selectedMembers]);
        if (selectedCount instanceof HTMLElement) {
            selectedCount.textContent = `${selectedMembers.size} selected`;
        }
        if (createButton instanceof HTMLButtonElement) {
            createButton.disabled = selectedMembers.size < 2;
        }
    }

    function renderList(query = '') {
        if (!(listContainer instanceof HTMLElement)) return;
        const rows = [];
        (Array.isArray(characters) ? characters : []).forEach((character) => {
            if (!character?.avatar) return;
            const name = character.name || 'Character';
            if (query && !name.toLowerCase().includes(query)) return;

            const checked = selectedMembers.has(character.avatar) ? ' checked' : '';
            const disabled = lockedMembers.has(character.avatar) ? ' disabled' : '';
            const thumb = getThumbnailUrl('avatar', character.avatar);
            rows.push(`
                <label class="sb-conversation-add-dm-option sb-conversation-group-member-option" style="display: flex; align-items: center; gap: 8px; inline-size: 100%; background: none; border: none; padding: 6px; border-radius: var(--sb-radius-sm); text-align: left; cursor: pointer; color: inherit;">
                    <input type="checkbox" class="sb-conversation-group-member-checkbox" value="${escapeHtmlAttribute(character.avatar)}"${checked}${disabled} />
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" style="inline-size: 24px; block-size: 24px; border-radius: 50%; object-fit: cover;" loading="lazy" />
                    <span style="font-size: var(--sb-type-caption);">${escapeHtmlText(name)}</span>
                </label>
            `);
        });

        listContainer.innerHTML = rows.length
            ? rows.join('')
            : '<div class="sb-conversation-empty" style="padding: 8px; font-size: var(--sb-type-meta); opacity: 0.7;">No matching characters found.</div>';
        syncSelectedMembers();
    }

    picker.onchange = (event) => {
        const checkbox = event.target instanceof HTMLInputElement && event.target.classList.contains('sb-conversation-group-member-checkbox')
            ? event.target
            : null;
        if (!checkbox) {
            return;
        }

        if (checkbox.checked) {
            selectedMembers.add(checkbox.value);
        } else if (!lockedMembers.has(checkbox.value)) {
            selectedMembers.delete(checkbox.value);
        }
        syncSelectedMembers();
    };

    renderList();

    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value.toLowerCase().trim());
        });
    }
}

export async function handleCreateConversationGroupFromPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return false;
    }

    let members = [];
    try {
        members = JSON.parse(picker.dataset.selectedMembers || '[]');
    } catch {
        members = [];
    }

    const sourceAvatar = picker.dataset.sourceAvatar || '';
    const copySourceGroupId = picker.dataset.copySource === 'true' ? picker.dataset.copySourceGroupId || '' : null;
    return createAndOpenConversationGroup(members, { sourceAvatar, copySourceGroupId });
}

export function openAddMemberPicker() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Open a Conversation before adding members.');
        return;
    }

    openPalsRail();
    toggleConversationGroupPicker({
        sourceAvatar: avatar,
        sourceGroupId: conversationState.conversationSelectedGroupId || '',
    });
}
