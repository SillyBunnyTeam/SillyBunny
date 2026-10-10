import {
    characters,
    default_avatar,
    default_user_avatar,
    getThumbnailUrl,
    name1,
} from '../../script.js';
import { user_avatar } from '../personas.js';
import { selectConversationThread } from './chrome.js';
import { AVAILABILITY_COPY, CHROME_IDS, DEFAULT_BRANCH_ID, WEEKDAY_LABELS } from './constants.js';
import {
    createConversationBranch,
    createConversationGroupRecord,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getDefaultGroupConversationSettings,
    normalizeConversationBranch,
    persistConversationStore,
} from './context.js';
import { saveCurrentPanelSettings } from './interface.js';
import { getCharacterForAvatar } from './media.js';
import {
    getActiveConversationPersonaAppendixIds,
    getConversationPersonaAppendices,
    getPersonaOptions,
    getUserPersonaStatus,
    getUserStatus,
    safeParseWeeklySchedule,
} from './personas.js';
import { schedulePalsRailRender } from './render-scheduler.js';
import { escapeHtmlAttribute, escapeHtmlText } from './render-utils.js';
import { closePalsRail } from './settings-panel.js';
import { conversationState } from './state.js';

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
            <label class="sb-conversation-pref-row sb-conv-weekly-enabled">
                <span class="sb-conversation-pref-copy">On</span>
                <input type="checkbox" class="sb-conversation-switch sb-conv-weekly-enabled-check"${entry.enabled !== false ? ' checked' : ''} />
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

const PICKER_MOBILE_QUERY = '(max-width: 768px)';
const PICKER_GAP = 6;
const PICKER_MARGIN = 8;
let activePicker = null;
let pickerDismissBound = false;

function isPickerSheetLayout() {
    return window.matchMedia(PICKER_MOBILE_QUERY).matches;
}

function setPickerExpanded(anchor, expanded) {
    if (anchor instanceof HTMLElement) {
        anchor.setAttribute('aria-expanded', String(Boolean(expanded)));
    }
}

function clearPickerPosition(picker) {
    if (!(picker instanceof HTMLElement)) {
        return;
    }
    picker.style.removeProperty('top');
    picker.style.removeProperty('left');
    picker.style.removeProperty('inset');
    picker.style.removeProperty('max-block-size');
}

// Pickers are absolutely positioned inside #sheld, so coordinates are relative to its padding box.
function positionConversationPicker(picker, anchor, { preferBelow = false } = {}) {
    clearPickerPosition(picker);
    const container = picker.offsetParent;
    if (isPickerSheetLayout() || !(anchor instanceof HTMLElement) || !anchor.isConnected || !(container instanceof HTMLElement)) {
        return;
    }

    const bounds = container.getBoundingClientRect();
    const originX = bounds.left + container.clientLeft;
    const originY = bounds.top + container.clientTop;
    const rect = anchor.getBoundingClientRect();
    const width = picker.offsetWidth;
    const natural = picker.scrollHeight + 2;
    const viewBottom = Math.min(bounds.bottom, window.innerHeight);
    const viewTop = Math.max(bounds.top, 0);
    const below = viewBottom - rect.bottom - PICKER_GAP - PICKER_MARGIN;
    const above = rect.top - viewTop - PICKER_GAP - PICKER_MARGIN;
    const placeAbove = preferBelow
        ? below < 160 && above > below
        : natural > below && above > below;
    const available = Math.max(160, placeAbove ? above : below);
    const height = Math.min(natural, available);
    const startAligned = (rect.left + rect.right) / 2 < (bounds.left + bounds.right) / 2;
    let left = startAligned ? rect.left : rect.right - width;
    const minLeft = bounds.left + PICKER_MARGIN;
    const maxLeft = bounds.right - PICKER_MARGIN - width;
    left = maxLeft < minLeft
        ? Math.max(bounds.left, Math.min(left, bounds.right - width))
        : Math.min(Math.max(left, minLeft), maxLeft);
    const top = placeAbove ? rect.top - PICKER_GAP - height : rect.bottom + PICKER_GAP;
    picker.style.maxBlockSize = `${Math.floor(available)}px`;
    picker.style.left = `${Math.round(left - originX)}px`;
    picker.style.top = `${Math.round(Math.max(top, viewTop + PICKER_MARGIN) - originY)}px`;
}

function syncPickerBackdrop() {
    const backdrop = document.getElementById(CHROME_IDS.pickerBackdrop);
    if (backdrop instanceof HTMLElement) {
        backdrop.dataset.open = String(Boolean(activePicker));
    }
}

function handlePickerPointerDown(event) {
    if (!activePicker) {
        return;
    }
    const target = event.target instanceof Node ? event.target : null;
    if (target && (activePicker.picker.contains(target) || activePicker.anchor?.contains?.(target))) {
        return;
    }
    // Menus opened from inside a picker live in document.body; leave the picker alone for them.
    if (target instanceof Element && target.closest('.sb-action-popover, .sb-action-sheet, .sb-action-sheet-backdrop, .popup, dialog')) {
        return;
    }
    hideConversationPickers();
}

function handlePickerKeydown(event) {
    if (!activePicker || event.key !== 'Escape' || event.isComposing) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideConversationPickers({ restoreFocus: true });
}

function handlePickerLayoutChange() {
    if (activePicker) {
        positionConversationPicker(activePicker.picker, activePicker.anchor, { preferBelow: activePicker.preferBelow });
    }
}

function bindPickerDismissal() {
    if (pickerDismissBound) {
        return;
    }
    pickerDismissBound = true;
    window.addEventListener('pointerdown', handlePickerPointerDown, true);
    window.addEventListener('keydown', handlePickerKeydown, true);
    window.addEventListener('resize', handlePickerLayoutChange, { passive: true });
    const backdrop = document.getElementById(CHROME_IDS.pickerBackdrop);
    if (backdrop instanceof HTMLElement && backdrop.dataset.sbConversationBound !== 'true') {
        backdrop.dataset.sbConversationBound = 'true';
        backdrop.addEventListener('click', () => hideConversationPickers({ restoreFocus: true }));
    }
}

/** Shows one Conversation picker: an anchored popover on desktop, a bottom sheet on mobile. */
export function showConversationPicker(picker, anchor = null, { preferBelow = false } = {}) {
    if (!(picker instanceof HTMLElement)) {
        return;
    }
    bindPickerDismissal();
    if (activePicker && activePicker.picker !== picker) {
        activePicker.picker.hidden = true;
        setPickerExpanded(activePicker.anchor, false);
    }
    const fallbackAnchor = activePicker?.picker === picker ? activePicker.anchor : null;
    const fallbackPreferBelow = activePicker?.picker === picker ? Boolean(activePicker.preferBelow) : false;
    activePicker = {
        picker,
        anchor: anchor instanceof HTMLElement ? anchor : fallbackAnchor,
        preferBelow: Boolean(preferBelow || fallbackPreferBelow),
    };
    picker.hidden = false;
    setPickerExpanded(activePicker.anchor, true);
    positionConversationPicker(picker, activePicker.anchor, { preferBelow: activePicker.preferBelow });
    syncPickerBackdrop();
}

export function hideConversationPickers({ restoreFocus = false } = {}) {
    const state = activePicker;
    activePicker = null;
    for (const id of [CHROME_IDS.addDmPicker, CHROME_IDS.personaPicker, CHROME_IDS.userStatusPicker]) {
        const picker = document.getElementById(id);
        if (picker instanceof HTMLElement) {
            picker.setAttribute('hidden', '');
            clearPickerPosition(picker);
        }
    }
    setPickerExpanded(state?.anchor, false);
    syncPickerBackdrop();
    if (restoreFocus && state?.anchor?.isConnected) {
        state.anchor.focus({ preventScroll: true });
    }
}

function getPickerAnchor(selector) {
    const anchor = document.querySelector(selector);
    return anchor instanceof HTMLElement && anchor.getClientRects().length ? anchor : null;
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
    const personaButton = footer.querySelector('[data-sb-conversation-action="open-persona-menu"]');
    if (personaButton instanceof HTMLElement) {
        const label = `${personaName}: ${personaStatus || statusCopy.label}`;
        personaButton.title = label;
        personaButton.setAttribute('aria-label', label);
    }
}

export function toggleUserStatusPicker(anchor = getPickerAnchor('[data-sb-conversation-action="open-persona-menu"]')) {
    const picker = document.getElementById(CHROME_IDS.userStatusPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    if (!picker.hidden) {
        hideConversationPickers({ restoreFocus: true });
        return;
    }
    const resolvedAnchor = anchor instanceof HTMLElement ? anchor : getPickerAnchor('[data-sb-conversation-action="open-persona-menu"]');
    showConversationPicker(picker, resolvedAnchor, { preferBelow: true });
    picker.querySelector('button')?.focus?.({ preventScroll: true });
}

export function renderConversationPersonaPicker(picker) {
    picker.innerHTML = '';
    const personas = getPersonaOptions();
    const threadAvatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(threadAvatar);
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
            const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId, {
                avatar: threadAvatar,
                groupId,
                personaId: avatarId,
            }));
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

export function togglePersonaPicker(anchor = getPickerAnchor('[data-sb-conversation-action="open-persona-menu"]')) {
    const picker = document.getElementById(CHROME_IDS.personaPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    if (!picker.hidden) {
        hideConversationPickers({ restoreFocus: true });
        return;
    }
    renderConversationPersonaPicker(picker);
    const resolvedAnchor = anchor instanceof HTMLElement ? anchor : getPickerAnchor('[data-sb-conversation-action="open-persona-menu"]');
    showConversationPicker(picker, resolvedAnchor, { preferBelow: true });
    (picker.querySelector('[aria-selected="true"]') || picker.querySelector('button'))?.focus?.({ preventScroll: true });
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

export function toggleAddDmPicker(anchor = getPickerAnchor('[data-sb-conversation-action="open-new-menu"]')) {
    const picker = document.getElementById(CHROME_IDS.addDmPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }
    const resolvedAnchor = anchor instanceof HTMLElement ? anchor : getPickerAnchor('[data-sb-conversation-action="open-new-menu"]');

    if (!picker.hasAttribute('hidden') && picker.dataset.pickerType === 'solo') {
        hideConversationPickers({ restoreFocus: true });
        return;
    }

    picker.dataset.pickerType = 'solo';
    picker.dataset.selectedMembers = '';
    picker.onchange = null;
    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span class="sb-conversation-add-dm-title">Create a solo DM</span>
            <p class="sb-conversation-field-hint sb-conversation-add-dm-description">Create a new solo DM with a character card of your choice.</p>
            <input type="search" id="sb_conversation_add_dm_search" class="sb-conversation-search-entry sb-conversation-add-dm-search" placeholder="Search characters..." autocomplete="off" />
        </div>
        <div class="sb-conversation-add-dm-list" id="sb_conversation_add_dm_list"></div>
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
                <button type="button" class="sb-conversation-add-dm-option" data-sb-conversation-action="add-character-dm" data-character-index="${idx}">
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" class="sb-conversation-group-member-avatar" loading="lazy" />
                    <span class="sb-conversation-group-member-name">${escapeHtmlText(name)}</span>
                </button>
            `);
        });

        if (!rows.length) {
            listContainer.innerHTML = '<div class="sb-conversation-empty sb-conversation-group-empty">No matching characters found.</div>';
        } else {
            listContainer.innerHTML = rows.join('');
        }
    }

    renderList();
    showConversationPicker(picker, resolvedAnchor);

    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus({ preventScroll: true });
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value.toLowerCase().trim());
        });
    }
}

export function hideConversationStartPicker() {
    hideConversationPickers({ restoreFocus: true });
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

    const group = createConversationGroupRecord(members, {
        name: buildConversationGroupName(members),
        avatarUrl: default_avatar,
        settings: getDefaultGroupConversationSettings(),
    });
    if (!group?.id) {
        toastr.error('Could not create group Conversation.');
        return null;
    }

    if (sourceAvatar && copySourceGroupId !== null) {
        copyConversationThreadToGroup(sourceAvatar, group.id, { sourceGroupId: copySourceGroupId || '' });
    }

    return group;
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

    hideConversationPickers();
    closePalsRail();
    const opened = await selectConversationThread(targetAvatar, {
        groupId: String(group.id),
        showToast: false,
    });
    if (opened) {
        schedulePalsRailRender();
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

export function toggleConversationGroupPicker({ sourceAvatar = '', sourceGroupId = '', anchor = getPickerAnchor('[data-sb-conversation-action="open-new-menu"]') } = {}) {
    const picker = document.getElementById(CHROME_IDS.addDmPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }
    const resolvedAnchor = anchor instanceof HTMLElement ? anchor : getPickerAnchor('[data-sb-conversation-action="open-new-menu"]');

    const normalizedSourceGroupId = sourceGroupId || '';
    const sourceMembers = normalizedSourceGroupId ? getCurrentGroupMemberAvatars(normalizedSourceGroupId) : [];
    const lockedMembers = new Set(sourceAvatar ? (sourceMembers.length ? sourceMembers : [sourceAvatar]) : []);
    const selectedMembers = new Set(lockedMembers);
    const copyFromCurrentThread = false;

    if (!picker.hasAttribute('hidden')
        && picker.dataset.pickerType === 'group'
        && picker.dataset.sourceAvatar === (sourceAvatar || '')
        && picker.dataset.copySourceGroupId === normalizedSourceGroupId) {
        hideConversationPickers({ restoreFocus: true });
        return;
    }

    picker.dataset.pickerType = 'group';
    picker.dataset.sourceAvatar = sourceAvatar || '';
    picker.dataset.copySource = String(copyFromCurrentThread);
    picker.dataset.copySourceGroupId = normalizedSourceGroupId;

    const title = sourceAvatar
        ? (normalizedSourceGroupId ? 'Add members to this group' : 'Add members to this DM')
        : 'Create a group DM';
    const description = sourceAvatar
        ? 'Selected members will open as a separate group Conversation with its own history and group controls.'
        : 'Create a new group DM with two or more of your character cards.';

    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span class="sb-conversation-add-dm-title">${escapeHtmlText(title)}</span>
            <p class="sb-conversation-field-hint sb-conversation-add-dm-description">${escapeHtmlText(description)}</p>
            <input type="search" id="sb_conversation_group_search" class="sb-conversation-search-entry sb-conversation-add-dm-search" placeholder="Search characters..." autocomplete="off" />
        </div>
        <div class="sb-conversation-add-dm-list sb-conversation-group-list" id="sb_conversation_group_list"></div>
        <div class="sb-conversation-group-picker-actions">
            <span id="sb_conversation_group_selected_count" class="sb-conversation-field-hint sb-conversation-group-selected-count"></span>
            <span class="sb-conversation-group-picker-buttons">
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
                <label class="sb-conversation-add-dm-option sb-conversation-group-member-option">
                    <input type="checkbox" class="sb-conversation-group-member-checkbox" value="${escapeHtmlAttribute(character.avatar)}"${checked}${disabled} />
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" class="sb-conversation-group-member-avatar" loading="lazy" />
                    <span class="sb-conversation-group-member-name">${escapeHtmlText(name)}</span>
                </label>
            `);
        });

        listContainer.innerHTML = rows.length
            ? rows.join('')
            : '<div class="sb-conversation-empty sb-conversation-group-empty">No matching characters found.</div>';
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
    showConversationPicker(picker, resolvedAnchor);

    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus({ preventScroll: true });
        searchInput.addEventListener('input', () => {
            renderList(searchInput.value.toLowerCase().trim());
        });
    }
}

export async function handleCreateConversationGroupFromPicker() {
    const picker = document.getElementById(CHROME_IDS.addDmPicker);
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

    toggleConversationGroupPicker({
        sourceAvatar: avatar,
        sourceGroupId: conversationState.conversationSelectedGroupId || '',
        anchor: getPickerAnchor(`#${CHROME_IDS.header} [data-sb-conversation-action="open-conversation-menu"]`),
    });
}
