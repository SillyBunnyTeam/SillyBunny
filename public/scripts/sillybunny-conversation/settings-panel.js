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
    getConversationThreadStore,
    getCurrentCharAvatar,
    parsePositiveInt,
    saveGroupConversationSettings,
} from './context.js';
import { applySettingsToPanel, saveCurrentPanelSettings, updateConversationChrome } from './interface.js';
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

export function setConversationBackdropVisible() {
    const backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(backdrop instanceof HTMLElement)) {
        return;
    }

    const settingsOpen = drawer instanceof HTMLElement && !drawer.hidden;
    const palsOpen = palsRail instanceof HTMLElement && palsRail.dataset.open === 'true';
    backdrop.hidden = !(settingsOpen || palsOpen);
}

export function closePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (palsRail instanceof HTMLElement) {
        palsRail.dataset.open = 'false';
    }
    setConversationBackdropVisible();
}

export function togglePalsRail() {
    const palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        return;
    }

    palsRail.dataset.open = palsRail.dataset.open === 'true' ? 'false' : 'true';
    setConversationBackdropVisible();
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

export function openScheduleEditorModal(initialAvatar = getCurrentCharAvatar()) {
    const targets = getScheduleEditorTargets(initialAvatar);
    let editAvatar = targets.some(target => target.avatar === initialAvatar) ? initialAvatar : targets[0]?.avatar;
    if (!editAvatar) {
        toastr.warning('No character available for schedule editing.');
        return;
    }

    const previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.id = 'sb_conversation_schedule_modal';
    overlay.className = 'sb-conversation-schedule-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(8px);
        z-index: 9999;
        display: grid;
        align-items: center;
        justify-items: center;
        place-items: center;
        min-height: 100vh;
        height: 100vh;
        min-height: 100dvh;
        height: 100dvh;
        padding: max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom));
        box-sizing: border-box;
        overflow: hidden;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
    `;

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
            editedSchedulesByAvatar.set(avatar, createEditableSchedule(getStoredSchedule(avatar)));
        }

        return editedSchedulesByAvatar.get(avatar);
    };

    let editedSchedule = getEditedSchedule(editAvatar);

    let currentTabDay = new Date().getDay();

    const modal = document.createElement('div');
    modal.className = 'sb-conversation-schedule-modal sb-shell-root';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'sb_schedule_modal_title');
    modal.tabIndex = -1;
    modal.style.cssText = `
        display: flex;
        flex-direction: column;
        width: min(650px, calc(100vw - 20px));
        max-height: calc(100vh - 20px);
        max-height: calc(100dvh - 20px);
        margin: 0;
        background: var(--SmartThemeBlurTintColor);
        border: 1px solid var(--sb-shell-border);
        border-radius: var(--sb-radius-md, 12px);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        color: var(--SmartThemeBodyColor);
        overflow: hidden;
    `;

    function updateModalBody() {
        const listContainer = modal.querySelector('.sb-schedule-modal-blocks-list');
        if (!listContainer) return;

        const dayBlocks = editedSchedule.days[String(currentTabDay)] || [];
        listContainer.innerHTML = '';

        if (!dayBlocks.length) {
            listContainer.innerHTML = '<div class="sb-conversation-empty" style="text-align: center; padding: 20px; opacity: 0.7;">No blocks scheduled for this day. Click "Add Time Block" below to create one!</div>';
        } else {
            dayBlocks.forEach((block, idx) => {
                const row = document.createElement('div');
                row.className = 'sb-schedule-modal-row';
                row.style.cssText = `
                    display: grid;
                    grid-template-columns: 130px 1fr 100px auto;
                    gap: 10px;
                    align-items: center;
                    margin-bottom: 8px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid color-mix(in srgb, var(--sb-shell-border) 40%, transparent);
                `;

                const timeInput = document.createElement('input');
                timeInput.type = 'text';
                timeInput.className = 'text_pole textarea_compact sb-schedule-modal-time';
                timeInput.placeholder = '08:00-12:00';
                timeInput.value = block.time || '';
                timeInput.style.fontFamily = 'monospace';
                timeInput.addEventListener('input', () => {
                    block.time = timeInput.value;
                });

                const activityInput = document.createElement('input');
                activityInput.type = 'text';
                activityInput.className = 'text_pole textarea_compact sb-schedule-modal-activity';
                activityInput.placeholder = 'e.g. working, sleeping';
                activityInput.value = block.activity || '';
                activityInput.addEventListener('input', () => {
                    block.activity = activityInput.value;
                });

                const statusSelect = document.createElement('select');
                statusSelect.className = 'text_pole sb-schedule-modal-status';
                statusSelect.style.height = '32px';
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
                delBtn.className = 'menu_button menu_button_icon';
                delBtn.style.padding = '4px 8px';
                delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
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
        <div class="sb-conversation-schedule-modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid var(--sb-shell-border);">
            <span id="sb_schedule_modal_title" style="font-weight: var(--sb-weight-title); font-size: 1.1em;"><i class="fa-solid fa-calendar-days" style="color: var(--sb-accent); margin-right: 8px;"></i>Edit Weekly Routine</span>
            <button type="button" class="menu_button menu_button_icon sb-schedule-modal-close" style="padding: 4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="sb-schedule-modal-target" style="display: grid; gap: 6px; padding: 12px 20px; border-bottom: 1px solid var(--sb-shell-border); background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 82%, transparent);">
            <label for="sb_schedule_modal_target" style="font-size: var(--sb-type-meta); font-weight: var(--sb-weight-control); opacity: 0.82;">Editing schedule for</label>
            <select id="sb_schedule_modal_target" class="text_pole textarea_compact wide100p"${targets.length <= 1 ? ' disabled' : ''}>
                ${targetOptionsHtml}
            </select>
            <p class="sb-conversation-field-hint" style="margin: 0;">Conversation members and current group-chat members use their own character-card schedules.</p>
        </div>
        <div class="sb-conversation-schedule-modal-tabs" style="display: flex; gap: 4px; padding: 10px 20px; background: rgba(0,0,0,0.15); border-bottom: 1px solid var(--sb-shell-border); overflow-x: auto;">
            ${WEEKDAY_LABELS.map((day, idx) => `
                <button type="button" class="menu_button sb-schedule-modal-tab" data-day="${idx}" style="flex: 1; padding: 6px 4px; font-size: var(--sb-type-meta); min-width: 50px;">${day}</button>
            `).join('')}
        </div>
        <div style="flex: 1; overflow-y: auto; padding: 20px;" class="sb-schedule-modal-body">
            <div class="sb-schedule-modal-blocks-list" style="min-height: 120px;"></div>
            <button type="button" class="menu_button sb-schedule-modal-add" style="margin-top: 12px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;">
                <i class="fa-solid fa-plus"></i><span>Add Time Block</span>
            </button>
        </div>
        <div class="sb-conversation-schedule-modal-footer" style="padding: 16px 20px; border-top: 1px solid var(--sb-shell-border); background: rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 12px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="sb-conversation-field-stack">
                    <label style="font-size: var(--sb-type-meta); opacity: 0.8; margin-bottom: 4px;">Talkativeness (0-100)</label>
                    <input type="number" class="text_pole sb-schedule-modal-talkativeness" min="0" max="100" step="5" value="${editedSchedule.talkativeness}" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label style="font-size: var(--sb-type-meta); opacity: 0.8; margin-bottom: 4px;">Inactivity Threshold (mins)</label>
                    <input type="number" class="text_pole sb-schedule-modal-patience" min="15" max="360" step="5" value="${editedSchedule.inactivityThresholdMinutes}" />
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px;">
                <button type="button" class="menu_button sb-schedule-modal-save" style="padding: 6px 14px; font-weight: var(--sb-weight-control); color: white;">Save Changes</button>
                <button type="button" class="menu_button sb-schedule-modal-cancel" style="padding: 6px 14px;">Cancel</button>
            </div>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function selectDayTab(dayIdx) {
        currentTabDay = dayIdx;
        modal.querySelectorAll('.sb-schedule-modal-tab').forEach(btn => {
            const btnDay = parseInt(btn.dataset.day, 10);
            if (btnDay === currentTabDay) {
                btn.style.borderColor = 'var(--sb-accent)';
                btn.style.background = 'color-mix(in srgb, var(--sb-accent) 15%, transparent)';
                btn.style.fontWeight = 'var(--sb-weight-control)';
            } else {
                btn.style.borderColor = '';
                btn.style.background = '';
                btn.style.fontWeight = '';
            }
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

    const closeBtn = modal.querySelector('.sb-schedule-modal-close');
    const cancelBtn = modal.querySelector('.sb-schedule-modal-cancel');
    const saveBtn = modal.querySelector('.sb-schedule-modal-save');

    function closeModal() {
        overlay.remove();
        previouslyFocusedElement?.focus?.({ preventScroll: true });
    }

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeModal();
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const focusable = Array.from(modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter(element => element instanceof HTMLElement && !element.hasAttribute('disabled') && element.offsetParent !== null);
        if (!focusable.length) {
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    setTimeout(() => {
        modal.focus({ preventScroll: true });
    }, 0);

    saveBtn?.addEventListener('click', () => {
        if (!editAvatar) {
            closeModal();
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

        saveStoredSchedule(editAvatar, normalized);
        const editTarget = targets.find(target => target.avatar === editAvatar);
        const editGroupId = editTarget?.groupId || '';
        const editSettings = getSettings(editAvatar, { groupId: editGroupId });
        editSettings.auto_schedule = JSON.stringify(normalized);
        editSettings.talkativeness = normalized.talkativeness;
        editSettings.inactivity_threshold = normalized.inactivityThresholdMinutes;
        editSettings.schedule_generated_at = normalized.generatedAt;
        if (editGroupId) {
            saveGroupConversationSettings(editGroupId, editSettings);
        }
        saveSettings(editAvatar, editSettings, { groupId: editGroupId });
        if (editAvatar === getCurrentCharAvatar()) {
            applySettingsToPanel(editSettings);
            renderScheduleDisplay();
            updateConversationChrome(editSettings);
        } else {
            const currentAvatar = getCurrentCharAvatar();
            const currentGroupId = getConversationGroupIdForAvatar(currentAvatar);
            updateConversationChrome(getSettings(currentAvatar, { groupId: currentGroupId }));
        }
        const targetName = targets.find(target => target.avatar === editAvatar)?.name || 'character';
        toastr.success(`Schedule saved for ${targetName}.`);
        closeModal();
    });
}

export function renderScheduleDisplay() {
    const display = document.getElementById('sb_conv_schedule_display');
    if (!(display instanceof HTMLElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const schedule = avatar ? getStoredSchedule(avatar) : null;

    if (!schedule || !schedule.days) {
        display.dataset.empty = 'true';
        display.innerHTML = '<p class="sb-conversation-schedule-empty">No schedule yet. Generate one to give this character a daily rhythm and let them message you on their own.</p>';
        return;
    }

    display.dataset.empty = 'false';
    const now = new Date();
    const todayIndex = now.getDay();
    const current = getCurrentActivityFromSchedule(schedule, avatar, now);
    const todayBlocks = Array.isArray(schedule.days[todayIndex]) ? schedule.days[todayIndex] : [];

    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId });
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
    const newMemory = globalThis.prompt?.('Enter or override the memory summary for this Conversation:', currentMemory);
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

export function clearConversationMemoryFromPanel() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Pick a DM first.');
        return;
    }

    const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm('Clear the memory summary for this Conversation? This does not delete chat messages.')
        : true;
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
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId });
    chrome.drawer.innerHTML = buildSettingsDrawerHtml();

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
    chrome.drawer.hidden = false;
    setConversationBackdropVisible();
    chrome.drawer.querySelector('input, select, textarea, button')?.focus?.({ preventScroll: true });
}

export function closeConversationSettings() {
    const drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (drawer instanceof HTMLElement) {
        const shouldSave = drawer.hidden === false;
        drawer.hidden = true;
        if (shouldSave) {
            saveCurrentPanelSettings();
        }
    }
    setConversationBackdropVisible();
}
