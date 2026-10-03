import {
    CHROME_IDS,
    DEFAULT_INACTIVITY_THRESHOLD,
    DEFAULT_TALKATIVENESS,
    MAX_INACTIVITY_THRESHOLD,
    MIN_INACTIVITY_THRESHOLD,
    WEEKDAY_LABELS,
} from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadStore,
    getCurrentCharAvatar,
    parsePositiveInt,
    saveGroupConversationSettings,
} from './context.js';
import { confirmConversationAction, promptConversationText } from './dialogs.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../popup.js';
import { animateIn, animateOut, MOTION_FAST, SPRING_NAVIGATION, SPRING_SHEET } from '../sillybunny-motion.js';
import { applySettingsToPanel, saveCurrentPanelSettings, updateConversationChrome } from './interface.js';
import { isConversationActiveThread } from './notifications.js';
import { getScheduleEditorTargets } from './pals-rail.js';
import { bindPartnerList, bindWeeklyScheduleEditor, updateUserFooter } from './pickers.js';
import { updateConversationMemorySummary } from './prompt.js';
import { escapeHtmlAttribute, escapeHtmlText } from './render-utils.js';
import {
    clamp,
    getCurrentActivityFromSchedule,
    getStoredSchedule,
    normalizeScheduleBlock,
    parseScheduleTimeRange,
    saveStoredSchedule,
} from './schedule.js';
import { clearConversationMemorySummary, getConversationMemorySummary, getSettings, saveConversationMemorySummary, saveSettings } from './settings-store.js';
import { getConversationThread, hasConversationMessageContent } from './thread-store.js';
import {
    buildChimingPartnerOptions,
    buildConnectionProfileOptions,
    buildLorebookOptions,
    buildSettingsDrawerHtml,
    ensureConversationChrome,
} from './timeline-render.js';

const MOBILE_LAYOUT_QUERY = '(max-width: 768px)';

function isMobileConversationLayout() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

/**
 * Derives the mobile navigation page (`#sheld[data-sb-conversation-page]`) from the rail and
 * settings state. Every rail and settings open/close path calls this. The legacy settings
 * backdrop stays in the DOM for compatibility but never shows: the settings pane is non-modal.
 */
export function syncConversationPage() {
    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (backdrop instanceof HTMLElement) {
        backdrop.hidden = true;
    }

    const sheld = document.getElementById('sheld');
    if (!(sheld instanceof HTMLElement) || typeof sheld.setAttribute !== 'function') {
        return;
    }

    const settingsOpen = drawer instanceof HTMLElement
        && !drawer.hidden
        && drawer.dataset.closing !== 'true'
        && drawer.dataset.opening !== 'true';
    const palsOpen = palsRail instanceof HTMLElement && palsRail.dataset.open === 'true';
    const page = settingsOpen ? 'settings' : (palsOpen || !getCurrentCharAvatar()) ? 'pals' : 'chat';
    sheld.setAttribute('data-sb-conversation-page', page);
}

export const setConversationBackdropVisible = syncConversationPage;

// Settings docks as a third column only when the sidebar, a usable timeline and the pane all fit.
const SPLIT_LAYOUT_MIN_WIDTH = 1200;
let layoutObserver = null;
let settingsPaneMotionToken = 0;

function getConversationLayout() {
    const sheld = document.getElementById('sheld');
    if (sheld instanceof HTMLElement && sheld.dataset.sbConversationLayout) {
        return sheld.dataset.sbConversationLayout;
    }
    if (isMobileConversationLayout()) {
        return 'pages';
    }
    return typeof window !== 'undefined' && window.innerWidth >= SPLIT_LAYOUT_MIN_WIDTH ? 'split' : 'overlay';
}

function waitForSplitSettingsTuck(onDone) {
    const sheld = document.getElementById('sheld');
    const reduced = typeof document !== 'undefined' && document.body?.classList.contains('reduced-motion') === true
        || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true);
    if (reduced || !(sheld instanceof HTMLElement) || typeof sheld.addEventListener !== 'function') {
        onDone();
        return;
    }

    let finished = false;
    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        sheld.removeEventListener('transitionend', onTransitionEnd);
        onDone();
    };
    const onTransitionEnd = (event) => {
        if (event.target === sheld && event.propertyName === 'grid-template-columns') {
            finish();
        }
    };
    sheld.addEventListener('transitionend', onTransitionEnd);
    if (typeof window?.setTimeout === 'function') {
        window.setTimeout(finish, 520);
        return;
    }
    finish();
}

/** Sets `#sheld[data-sb-conversation-layout]` to pages (mobile), split or overlay from the #sheld width. */
export function syncConversationLayout() {
    const sheld = document.getElementById('sheld');
    if (!(sheld instanceof HTMLElement)) {
        return;
    }
    const layout = isMobileConversationLayout()
        ? 'pages'
        : (typeof window !== 'undefined' && window.innerWidth >= SPLIT_LAYOUT_MIN_WIDTH) ? 'split' : 'overlay';
    if (sheld.dataset.sbConversationLayout !== layout) {
        sheld.dataset.sbConversationLayout = layout;
    }
}

export function observeConversationLayout(active) {
    const sheld = document.getElementById('sheld');
    if (!active) {
        layoutObserver?.disconnect();
        layoutObserver = null;
        sheld?.removeAttribute?.('data-sb-conversation-layout');
        return;
    }
    syncConversationLayout();
    if (!layoutObserver && sheld instanceof HTMLElement && typeof ResizeObserver === 'function') {
        layoutObserver = new ResizeObserver(() => syncConversationLayout());
        layoutObserver.observe(sheld);
    }
}

// Desktop: the overlay pane slides in from the inline-end edge on the sheet spring.
const SETTINGS_SHEET_ENTER = [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }];
const SETTINGS_SHEET_EXIT = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(24px)' }];
// Mobile: settings is a pushed navigation page.
const SETTINGS_PAGE_ENTER = [{ transform: 'translateX(100%)' }, { transform: 'none' }];
const SETTINGS_PAGE_EXIT = [{ transform: 'none' }, { transform: 'translateX(100%)' }];

export function closePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'false';
    }
    syncConversationPage();
}

export function openPalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'true';
    }
    syncConversationPage();
}

export function togglePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        return;
    }

    palsRail.dataset.open = palsRail.dataset.open === 'true' ? 'false' : 'true';
    syncConversationPage();
}

export function formatScheduleTimestamp(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }

    try {
        return new Date(value).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

export async function openScheduleEditorModal(initialAvatar = getCurrentCharAvatar()) {
    const personaId = getConversationPersonaId();
    const targets = getScheduleEditorTargets(initialAvatar);
    let editAvatar = targets.some(target => target.avatar === initialAvatar) ? initialAvatar : targets[0]?.avatar;
    if (!editAvatar) {
        toastr.warning('No character available for schedule editing.');
        return;
    }

    function createEditableSchedule(schedule) {
        const editable = JSON.parse(JSON.stringify(schedule || {
            days: { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] },
            talkativeness: DEFAULT_TALKATIVENESS,
            inactivityThresholdMinutes: DEFAULT_INACTIVITY_THRESHOLD,
        }));

        if (!editable.days || typeof editable.days !== 'object') {
            editable.days = {};
        }

        for (let d = 0; d <= 6; d++) {
            if (!Array.isArray(editable.days[String(d)])) {
                editable.days[String(d)] = [];
            }
        }

        editable.talkativeness = clamp(parsePositiveInt(editable.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
        editable.inactivityThresholdMinutes = clamp(
            parsePositiveInt(editable.inactivityThresholdMinutes, DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
            MIN_INACTIVITY_THRESHOLD,
            MAX_INACTIVITY_THRESHOLD,
        );

        return editable;
    }

    const editedSchedulesByAvatar = new Map();
    const getEditedSchedule = (avatar) => {
        if (!editedSchedulesByAvatar.has(avatar)) {
            editedSchedulesByAvatar.set(avatar, createEditableSchedule(getStoredSchedule(avatar, { personaId })));
        }

        return editedSchedulesByAvatar.get(avatar);
    };

    let editedSchedule = getEditedSchedule(editAvatar);

    let currentTabDay = new Date().getDay();

    const modal = document.createElement('div');
    modal.id = 'sb_conversation_schedule_modal';
    modal.className = 'sb-conversation-schedule-editor';

    function updateModalBody() {
        const listContainer = modal.querySelector('.sb-schedule-modal-blocks-list');
        if (!listContainer) return;

        const dayBlocks = editedSchedule.days[String(currentTabDay)] || [];
        listContainer.innerHTML = '';

        if (!dayBlocks.length) {
            listContainer.innerHTML = '<div class="sb-conversation-empty sb-schedule-modal-empty">No time blocks for this day.</div>';
        } else {
            dayBlocks.forEach((block, idx) => {
                const row = document.createElement('div');
                row.className = 'sb-schedule-modal-row';

                const timeInput = document.createElement('input');
                timeInput.type = 'text';
                timeInput.className = 'text_pole textarea_compact sb-schedule-modal-time';
                timeInput.placeholder = '08:00-12:00';
                timeInput.setAttribute('aria-label', 'Time range');
                timeInput.value = block.time || '';
                timeInput.addEventListener('input', () => {
                    block.time = timeInput.value;
                });

                const activityInput = document.createElement('input');
                activityInput.type = 'text';
                activityInput.className = 'text_pole textarea_compact sb-schedule-modal-activity';
                activityInput.placeholder = 'e.g. working, sleeping';
                activityInput.setAttribute('aria-label', 'Activity');
                activityInput.value = block.activity || '';
                activityInput.addEventListener('input', () => {
                    block.activity = activityInput.value;
                });

                const statusSelect = document.createElement('select');
                statusSelect.className = 'text_pole sb-schedule-modal-status';
                statusSelect.setAttribute('aria-label', 'Status');
                ['online', 'idle', 'dnd', 'offline'].forEach(st => {
                    const opt = document.createElement('option');
                    opt.value = st;
                    opt.textContent = st;
                    if (block.status === st) opt.selected = true;
                    statusSelect.appendChild(opt);
                });
                statusSelect.addEventListener('change', () => {
                    block.status = statusSelect.value;
                });

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'menu_button menu_button_icon sb-schedule-modal-delete';
                delBtn.title = 'Remove time block';
                delBtn.setAttribute('aria-label', 'Remove time block');
                delBtn.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
                delBtn.addEventListener('click', () => {
                    editedSchedule.days[String(currentTabDay)].splice(idx, 1);
                    updateModalBody();
                });

                row.appendChild(timeInput);
                row.appendChild(activityInput);
                row.appendChild(statusSelect);
                row.appendChild(delBtn);
                listContainer.appendChild(row);
            });
        }
    }

    const targetOptionsHtml = targets.map((target) => {
        const source = target.sourceLabel ? ` (${target.sourceLabel})` : '';
        return `<option value="${escapeHtmlAttribute(target.avatar)}"${target.avatar === editAvatar ? ' selected' : ''}>${escapeHtmlText(target.name + source)}</option>`;
    }).join('');

    modal.innerHTML = `
        <h3 id="sb_schedule_modal_title" class="sb-schedule-modal-title">Weekly routine</h3>
        <div class="sb-schedule-modal-target">
            <label for="sb_schedule_modal_target">Editing schedule for</label>
            <select id="sb_schedule_modal_target" class="text_pole textarea_compact wide100p"${targets.length <= 1 ? ' disabled' : ''}>
                ${targetOptionsHtml}
            </select>
            <p class="sb-conversation-field-hint">Conversation members and current group-chat members use their own character-card schedules.</p>
        </div>
        <div class="sb-conversation-schedule-modal-tabs" role="toolbar" aria-label="Day of the week">
            ${WEEKDAY_LABELS.map((day, idx) => `
                <button type="button" class="menu_button sb-schedule-modal-tab" data-day="${idx}">${day}</button>
            `).join('')}
        </div>
        <div class="sb-schedule-modal-body">
            <div class="sb-schedule-modal-blocks-list"></div>
            <button type="button" class="menu_button sb-schedule-modal-add">
                <i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add time block</span>
            </button>
        </div>
        <div class="sb-schedule-modal-meta">
            <label class="sb-conversation-field-stack">
                <span>Talkativeness (0-100)</span>
                <input type="number" class="text_pole sb-schedule-modal-talkativeness" min="0" max="100" step="5" value="${editedSchedule.talkativeness}" />
            </label>
            <label class="sb-conversation-field-stack">
                <span>Inactivity threshold (minutes)</span>
                <input type="number" class="text_pole sb-schedule-modal-patience" min="15" max="360" step="5" value="${editedSchedule.inactivityThresholdMinutes}" />
            </label>
        </div>
    `;

    function selectDayTab(dayIdx) {
        currentTabDay = dayIdx;
        modal.querySelectorAll('.sb-schedule-modal-tab').forEach(btn => {
            const isSelected = parseInt(btn.dataset.day, 10) === currentTabDay;
            btn.classList.toggle('is-selected', isSelected);
            btn.setAttribute('aria-pressed', String(isSelected));
        });
        updateModalBody();
    }

    function syncScheduleMetaInputs() {
        const talkInput = modal.querySelector('.sb-schedule-modal-talkativeness');
        if (talkInput instanceof HTMLInputElement) {
            talkInput.value = String(editedSchedule.talkativeness ?? DEFAULT_TALKATIVENESS);
        }

        const patienceInput = modal.querySelector('.sb-schedule-modal-patience');
        if (patienceInput instanceof HTMLInputElement) {
            patienceInput.value = String(editedSchedule.inactivityThresholdMinutes ?? DEFAULT_INACTIVITY_THRESHOLD);
        }
    }

    function selectScheduleTarget(nextAvatar) {
        if (!nextAvatar || nextAvatar === editAvatar || !targets.some(target => target.avatar === nextAvatar)) {
            return;
        }

        editAvatar = nextAvatar;
        editedSchedule = getEditedSchedule(editAvatar);
        syncScheduleMetaInputs();
        selectDayTab(currentTabDay);
    }

    syncScheduleMetaInputs();
    selectDayTab(currentTabDay);

    const targetSelect = modal.querySelector('#sb_schedule_modal_target');
    if (targetSelect instanceof HTMLSelectElement) {
        targetSelect.addEventListener('change', () => {
            selectScheduleTarget(targetSelect.value);
        });
    }

    modal.querySelectorAll('.sb-schedule-modal-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            selectDayTab(parseInt(btn.dataset.day, 10));
        });
    });

    const addBtn = modal.querySelector('.sb-schedule-modal-add');
    addBtn?.addEventListener('click', () => {
        const dayBlocks = editedSchedule.days[String(currentTabDay)] || [];
        dayBlocks.push({ time: '12:00-14:00', activity: 'free time', status: 'online' });
        editedSchedule.days[String(currentTabDay)] = dayBlocks;
        updateModalBody();
    });

    const talkInput = modal.querySelector('.sb-schedule-modal-talkativeness');
    talkInput?.addEventListener('input', () => {
        editedSchedule.talkativeness = clamp(parseInt(talkInput.value, 10) || 50, 0, 100);
    });

    const patienceInput = modal.querySelector('.sb-schedule-modal-patience');
    patienceInput?.addEventListener('input', () => {
        editedSchedule.inactivityThresholdMinutes = clamp(parseInt(patienceInput.value, 10) || 120, MIN_INACTIVITY_THRESHOLD, MAX_INACTIVITY_THRESHOLD);
    });

    const popup = new Popup(modal, POPUP_TYPE.TEXT, null, {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
    });
    popup.dlg.classList.add('sb-conversation-dialog', 'sb-conversation-schedule-dialog');
    popup.dlg.setAttribute('aria-labelledby', 'sb_schedule_modal_title');
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE || !editAvatar) {
        return;
    }

    const normalized = {
        days: {},
        talkativeness: editedSchedule.talkativeness,
        inactivityThresholdMinutes: editedSchedule.inactivityThresholdMinutes,
        generatedAt: Date.now(),
    };

    for (let d = 0; d <= 6; d++) {
        const rawBlocks = editedSchedule.days[String(d)] || [];
        const normalizedBlocks = [];
        for (const b of rawBlocks) {
            const norm = normalizeScheduleBlock(b);
            if (norm) {
                normalizedBlocks.push(norm);
            }
        }
        normalizedBlocks.sort((x, y) => {
            const xr = parseScheduleTimeRange(x.time);
            const yr = parseScheduleTimeRange(y.time);
            return (xr?.startMinutes ?? Number.MAX_SAFE_INTEGER) - (yr?.startMinutes ?? Number.MAX_SAFE_INTEGER);
        });
        normalized.days[String(d)] = normalizedBlocks;
    }

    saveStoredSchedule(editAvatar, normalized, { personaId });
    const editTarget = targets.find(target => target.avatar === editAvatar);
    const editGroupId = editTarget?.groupId || '';
    const editSettings = getSettings(editAvatar, { groupId: editGroupId, personaId });
    editSettings.auto_schedule = JSON.stringify(normalized);
    editSettings.talkativeness = normalized.talkativeness;
    editSettings.inactivity_threshold = normalized.inactivityThresholdMinutes;
    editSettings.schedule_generated_at = normalized.generatedAt;
    if (editGroupId) {
        saveGroupConversationSettings(editGroupId, editSettings, { personaId });
    }
    saveSettings(editAvatar, editSettings, { groupId: editGroupId, personaId });
    if (isConversationActiveThread(editAvatar, editGroupId, { personaId })) {
        applySettingsToPanel(editSettings);
        renderScheduleDisplay();
        updateConversationChrome(editSettings);
    } else {
        const currentAvatar = getCurrentCharAvatar();
        const currentGroupId = getConversationGroupIdForAvatar(currentAvatar);
        const currentPersonaId = getConversationPersonaId();
        updateConversationChrome(getSettings(currentAvatar, { groupId: currentGroupId, personaId: currentPersonaId }));
    }
    const targetName = targets.find(target => target.avatar === editAvatar)?.name || 'character';
    toastr.success(`Schedule saved for ${targetName}.`);
}

export function renderScheduleDisplay() {
    const display = document.getElementById('sb_conv_schedule_display');
    if (!(display instanceof HTMLElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    const schedule = avatar ? getStoredSchedule(avatar, { personaId }) : null;

    if (!schedule || !schedule.days) {
        display.dataset.empty = 'true';
        display.innerHTML = '<p class="sb-conversation-schedule-empty">No schedule yet. Generate one to give this character a daily rhythm and let them message you on their own.</p>';
        return;
    }

    display.dataset.empty = 'false';
    const now = new Date();
    const todayIndex = now.getDay();
    const current = getCurrentActivityFromSchedule(schedule, avatar, now, { personaId });
    const todayBlocks = Array.isArray(schedule.days[todayIndex]) ? schedule.days[todayIndex] : [];

    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    const talkativeness = parsePositiveInt(settings.talkativeness, DEFAULT_TALKATIVENESS, 0);
    const generatedLabel = formatScheduleTimestamp(settings.schedule_generated_at);

    const currentLine = `<div class="sb-conversation-schedule-now" data-status="${escapeHtmlAttribute(current.status)}">`
        + '<span class="sb-conversation-status-dot" data-status="' + escapeHtmlAttribute(current.status) + '"></span>'
        + `<span class="sb-conversation-schedule-now-text">Right now: <strong>${escapeHtmlText(current.activity)}</strong> (${escapeHtmlText(current.status)})</span>`
        + '</div>';

    let blocksHtml = '';
    if (todayBlocks.length) {
        const rows = todayBlocks.map((block) => {
            const isCurrent = current.source === 'schedule' && block.activity === current.activity && block.status === current.status;
            return `<li class="sb-conversation-schedule-block${isCurrent ? ' is-current' : ''}" data-status="${escapeHtmlAttribute(block.status)}">`
                + `<span class="sb-conversation-schedule-time">${escapeHtmlText(block.time)}</span>`
                + `<span class="sb-conversation-schedule-activity">${escapeHtmlText(block.activity)}</span>`
                + `<span class="sb-conversation-schedule-status" data-status="${escapeHtmlAttribute(block.status)}">${escapeHtmlText(block.status)}</span>`
                + '</li>';
        }).join('');
        blocksHtml = `<p class="sb-conversation-schedule-label">${escapeHtmlText(WEEKDAY_LABELS[todayIndex])} today</p><ul class="sb-conversation-schedule-blocks">${rows}</ul>`;
    } else {
        blocksHtml = `<p class="sb-conversation-schedule-empty">No blocks scheduled for ${escapeHtmlText(WEEKDAY_LABELS[todayIndex])}.</p>`;
    }

    const metaParts = [`Talkativeness ${talkativeness}`];
    if (generatedLabel) {
        metaParts.push(`Updated ${generatedLabel}`);
    }
    const metaHtml = `<p class="sb-conversation-schedule-meta">${escapeHtmlText(metaParts.join(' \u00b7 '))}</p>`;

    display.innerHTML = currentLine + blocksHtml + metaHtml;
}

export function renderConversationMemoryPanel() {
    const memoryInput = document.getElementById('sb_conv_memory_summary');
    const meta = document.getElementById('sb_conv_memory_meta');
    if (!(memoryInput instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const branch = avatar ? getActiveConversationBranch(avatar, { create: false, groupId }) : null;
    const threadStore = avatar ? getConversationThreadStore(avatar, { create: false, groupId }) : null;
    const memorySummary = getConversationMemorySummary(avatar, { groupId });
    const messageCount = Array.isArray(branch?.messages) ? branch.messages.filter(message => hasConversationMessageContent(message) && message.role !== 'system').length : 0;
    const summarizedCount = parsePositiveInt(threadStore?.memoryMessageCount ?? branch?.memoryMessageCount, 0, 0);

    memoryInput.value = memorySummary;
    memoryInput.placeholder = messageCount
        ? 'No memory summary yet. Click Refresh memory to write one now, or keep chatting and it will update automatically.'
        : 'No memory summary yet. This branch has no messages to summarize.';

    if (meta instanceof HTMLElement) {
        const branchName = branch?.name || 'Current branch';
        meta.textContent = `Persistent for this Conversation · ${branchName} has ${messageCount} message${messageCount === 1 ? '' : 's'} · summarized through ${summarizedCount}`;
    }
}

export async function forceCreateMemoryFromPanel() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Pick a DM first.');
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const currentMemory = getConversationMemorySummary(avatar, { groupId }) || '';
    const newMemory = await promptConversationText({
        title: 'Memory summary',
        text: 'Enter or override the memory summary for this Conversation.',
        defaultValue: currentMemory,
        rows: 6,
    });
    if (typeof newMemory !== 'string') {
        return;
    }

    const trimmedMemory = newMemory.trim();
    const messages = getConversationThread(avatar, { groupId });
    saveConversationMemorySummary(avatar, trimmedMemory, messages.length, { groupId });
    toastr.success('Conversation memory updated.');
    renderConversationMemoryPanel();
}

export async function refreshConversationMemoryFromPanel() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Pick a DM first.');
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const refreshed = await updateConversationMemorySummary(avatar, { force: true, groupId, notify: true });
    if (!refreshed) {
        renderConversationMemoryPanel();
    }
}

export async function clearConversationMemoryFromPanel() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Pick a DM first.');
        return;
    }

    const confirmed = await confirmConversationAction({
        title: 'Clear the memory summary?',
        text: 'This does not delete chat messages.',
        confirmLabel: 'Clear',
    });
    if (!confirmed) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    if (clearConversationMemorySummary(avatar, { groupId })) {
        toastr.success('Conversation memory cleared.');
    }
}

export function openConversationSettings() {
    const chrome = ensureConversationChrome();
    if (!chrome) {
        return;
    }

    closePalsRail();
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    chrome.drawer.innerHTML = buildSettingsDrawerHtml();
    chrome.drawer.dataset.conversationAvatar = avatar || '';
    chrome.drawer.dataset.conversationGroupId = groupId || '';
    chrome.drawer.dataset.conversationPersonaId = personaId;

    // Refresh live-data dropdowns before showing the drawer.
    const lorebookSelect = document.getElementById('sb_conv_lorebook_override');
    if (lorebookSelect instanceof HTMLSelectElement) {
        lorebookSelect.innerHTML = buildLorebookOptions(settings.lorebook_override);
    }
    const profileSelect = document.getElementById('sb_conv_connection_profile');
    if (profileSelect instanceof HTMLSelectElement) {
        profileSelect.innerHTML = buildConnectionProfileOptions(settings.connection_profile);
    }
    const partnerList = document.getElementById('sb_conv_chiming_partner_list');
    if (partnerList instanceof HTMLElement) {
        partnerList.innerHTML = buildChimingPartnerOptions(settings.multi_char_names);
    }

    applySettingsToPanel(settings);
    bindWeeklyScheduleEditor();
    bindPartnerList('sb_conv_chiming_partner_list', 'sb_conv_multi_char_search');
    renderScheduleDisplay();
    renderConversationMemoryPanel();
    updateUserFooter();
    const wasHidden = chrome.drawer.hidden;
    chrome.drawer.hidden = false;
    delete chrome.drawer.dataset.closing;
    settingsPaneMotionToken += 1;
    const focusSettings = () => chrome.drawer.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
    if (wasHidden) {
        const layout = getConversationLayout();
        if (layout === 'split') {
            // Paint the closed 0-width column first so the grid can interpolate to the pane width.
            chrome.drawer.dataset.opening = 'true';
            syncConversationPage();
            void chrome.sheld.offsetWidth;
            delete chrome.drawer.dataset.opening;
            syncConversationPage();
            focusSettings();
            return;
        }
        if (layout === 'pages') {
            animateIn(chrome.drawer, SETTINGS_PAGE_ENTER, SPRING_NAVIGATION);
        } else {
            animateIn(chrome.drawer, SETTINGS_SHEET_ENTER, SPRING_SHEET);
        }
    }
    syncConversationPage();
    focusSettings();
}

export function closeConversationSettings(identity = null) {
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement) {
        const shouldSave = drawer.hidden === false;
        const capturedIdentity = {
            avatar: identity?.avatar || drawer.dataset.conversationAvatar || getCurrentCharAvatar(),
            groupId: Object.prototype.hasOwnProperty.call(identity || {}, 'groupId')
                ? identity.groupId || ''
                : drawer.dataset.conversationGroupId || '',
            personaId: identity?.personaId || drawer.dataset.conversationPersonaId || getConversationPersonaId(),
        };
        if (shouldSave) {
            const layout = getConversationLayout();
            if (layout === 'split') {
                // Keep the pane in the grid until the third column has tucked away.
                drawer.dataset.closing = 'true';
                const motionToken = ++settingsPaneMotionToken;
                syncConversationPage();
                waitForSplitSettingsTuck(() => {
                    if (motionToken !== settingsPaneMotionToken) {
                        return;
                    }
                    drawer.hidden = true;
                    delete drawer.dataset.closing;
                    syncConversationPage();
                });
            } else {
                const mobile = layout === 'pages';
                animateOut(drawer, mobile ? SETTINGS_PAGE_EXIT : SETTINGS_SHEET_EXIT, () => { drawer.hidden = true; }, mobile ? { duration: MOTION_FAST * 1.25 } : {});
                syncConversationPage();
            }
            saveCurrentPanelSettings(capturedIdentity);
        } else {
            drawer.hidden = true;
            delete drawer.dataset.closing;
            delete drawer.dataset.opening;
            syncConversationPage();
        }
        delete drawer.dataset.conversationAvatar;
        delete drawer.dataset.conversationGroupId;
        delete drawer.dataset.conversationPersonaId;
        return;
    }
    syncConversationPage();
}
