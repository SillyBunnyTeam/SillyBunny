import { chat } from '../../../../script.js';
import { eventSource } from '../../../events.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getCompanionConfig,
    isAgentEnabledForCurrentScope,
    isCompanionAgent,
    isToolAgent,
} from '../agent-store.js';
import {
    COMPANION_RESULTS_UPDATED_EVENT,
    getCompanionResults,
    runCompanionAgentOnMessage,
    runCompanionsOnMessage,
} from './companion-runner.js';
import { openCompanionPanel } from './companion-panel.js';

const RECENT_NOTES_LIMIT = 20;
const NOTE_SNIPPET_LENGTH = 120;
const MESSAGE_INBOX_TEMPLATE_ID = 'tpl-message-inbox-companion';
const MESSAGE_INBOX_EMPTY_OUTPUTS = new Set(['phone-none', 'PHONE_NONE']);

function isSuppressedDashboardResult(agentId, result = {}) {
    if (!MESSAGE_INBOX_EMPTY_OUTPUTS.has(String(result?.content ?? '').trim())) {
        return false;
    }

    const agent = getAgentById(agentId);
    const templateId = String(agent?.sourceTemplateId ?? agent?.id ?? '').trim();
    return templateId === MESSAGE_INBOX_TEMPLATE_ID;
}

/**
 * Behavior owned by index.js (editor, list rendering, conversion flow) arrives through this seam
 * so the dashboard never imports index.js back.
 * @type {{
 *   openEditor: (agentId: string) => void,
 *   openCompanionDraftEditor: (options?: { autoOpenCompanionMaker?: boolean }) => void,
 *   toggleAgentEnabled: (agent: object) => Promise<void>,
 *   convertAgent: (agent: object, targetExecution: 'companion'|'inline') => Promise<boolean>,
 *   getVisibleAgents: () => object[],
 *   getLastAssistantMessageIndex: () => number,
 * }|null}
 */
let dashboardHooks = null;
let activeDashboardPopup = null;

export function configureCompanionDashboard(hooks) {
    dashboardHooks = hooks;
}

function isAssistantMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

function partitionDashboardAgents(agents = []) {
    const companions = [];
    const convertible = [];

    for (const agent of agents) {
        if (isToolAgent(agent)) {
            continue;
        }

        if (isCompanionAgent(agent)) {
            companions.push(agent);
        } else {
            convertible.push(agent);
        }
    }

    return { companions, convertible };
}

export function buildCompanionAgentRowHtml(agent) {
    const companion = getCompanionConfig(agent);
    const enabled = isAgentEnabledForCurrentScope(agent);
    const pills = [
        companion.trigger === 'manual' ? 'manual' : 'auto',
        ['panel', 'hidden'].includes(companion.displayMode) ? companion.displayMode : 'card',
        companion.format,
        companion.batch ? 'batch' : '',
        companion.feedback.enabled ? `feedback ×${companion.feedback.depth}` : '',
    ].filter(Boolean).map(label => `<span class="ica--card-pill">${escapeHtml(label)}</span>`).join('');

    return `
        <div class="ica--cdash-row${enabled ? ' is-enabled' : ''}" data-agent-id="${escapeHtml(agent.id)}">
            <button type="button" class="ica--cdash-toggle" data-action="toggle" title="${enabled ? 'Disable companion' : 'Enable companion'}" aria-pressed="${enabled}">
                <i class="fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
            </button>
            <div class="ica--cdash-row-main">
                <div class="ica--cdash-row-name">${escapeHtml(agent.name || 'Untitled Companion')}</div>
                <div class="ica--cdash-row-pills">${pills}</div>
            </div>
            <div class="ica--cdash-row-actions">
                <button type="button" class="ica--cdash-action" data-action="run" title="Run this companion on the last assistant reply" aria-label="Run companion"><i class="fa-solid fa-play"></i></button>
                <button type="button" class="ica--cdash-action" data-action="edit" title="Edit companion" aria-label="Edit companion"><i class="fa-solid fa-pen-to-square"></i></button>
                <button type="button" class="ica--cdash-action" data-action="to-inline" title="Convert back to inline execution" aria-label="Convert to inline"><i class="fa-solid fa-right-left"></i></button>
            </div>
        </div>
    `;
}

export function buildConvertibleAgentRowHtml(agent) {
    return `
        <div class="ica--cdash-row" data-agent-id="${escapeHtml(agent.id)}">
            <div class="ica--cdash-row-main">
                <div class="ica--cdash-row-name">${escapeHtml(agent.name || 'Untitled Agent')}</div>
                <div class="ica--cdash-row-pills">
                    <span class="ica--card-pill">${escapeHtml(agent.category || 'custom')}</span>
                    <span class="ica--card-pill">${escapeHtml(agent.phase || 'pre')}</span>
                </div>
            </div>
            <div class="ica--cdash-row-actions">
                <button type="button" class="ica--cdash-action" data-action="to-companion" title="Convert to Companion (runs as a side note card, never edits the reply)" aria-label="Convert to Companion"><i class="fa-solid fa-user-astronaut"></i></button>
            </div>
        </div>
    `;
}

export function collectRecentNoteEntries(limit = RECENT_NOTES_LIMIT) {
    const entries = [];

    for (let messageIndex = chat.length - 1; messageIndex >= 0 && entries.length < limit; messageIndex--) {
        const message = chat[messageIndex];
        if (!isAssistantMessage(message)) {
            continue;
        }

        for (const [agentId, result] of Object.entries(getCompanionResults(message))) {
            if (entries.length >= limit) {
                break;
            }

            if (!result || typeof result !== 'object' || result.status !== 'done' || isSuppressedDashboardResult(agentId, result)) {
                continue;
            }

            const content = String(result.content ?? '').replace(/\s+/g, ' ').trim();
            entries.push({
                messageIndex,
                agentId,
                agentName: String(result.agentName ?? '').trim() || getAgentById(agentId)?.name || 'Companion',
                snippet: content.length > NOTE_SNIPPET_LENGTH ? `${content.slice(0, NOTE_SNIPPET_LENGTH)}…` : content,
            });
        }
    }

    return entries;
}

function buildRecentNotesHtml(entries) {
    if (entries.length === 0) {
        return '<div class="ica--cdash-empty">No companion notes in this chat yet. Notes appear under assistant replies once a companion runs.</div>';
    }

    return entries.map(entry => `
        <button type="button" class="ica--cdash-note" data-action="jump" data-message-index="${entry.messageIndex}" title="Scroll to this message">
            <span class="ica--cdash-note-head">
                <i class="fa-solid fa-note-sticky"></i>
                <span>${escapeHtml(entry.agentName)}</span>
                <span class="ica--cdash-note-index">#${entry.messageIndex}</span>
            </span>
            <span class="ica--cdash-note-snippet">${escapeHtml(entry.snippet)}</span>
        </button>
    `).join('');
}

export function buildDashboardHtml() {
    const globallyEnabled = areAgentsGloballyEnabled();
    const agents = dashboardHooks?.getVisibleAgents?.() ?? [];
    const { companions, convertible } = partitionDashboardAgents(agents);
    const noticeHtml = globallyEnabled
        ? ''
        : '<div class="ica--cdash-notice"><i class="fa-solid fa-power-off"></i> In-Chat Agents are globally disabled. Companions will not run until they are re-enabled.</div>';
    const disabledAttribute = globallyEnabled ? '' : ' disabled';

    return `
        <div class="ica--cdash-header">
            <div class="ica--cdash-title"><i class="fa-solid fa-user-astronaut"></i> Companion Agents</div>
            <div class="ica--cdash-subtitle">Companions run as separate auxiliary LLM calls and render as collapsible note cards under assistant replies — they never edit the reply itself.</div>
            ${noticeHtml}
            <div class="ica--cdash-toolbar">
                <button type="button" class="menu_button menu_button_icon" data-action="run-all" title="Run every enabled companion on the last assistant reply"${disabledAttribute}>
                    <i class="fa-solid fa-play"></i>
                    <span>Run All on Last Reply</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-action="open-panel" title="Open the slide-out companion panel with the latest state">
                    <i class="fa-solid fa-user-astronaut"></i>
                    <span>Companion Panel</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-action="new-companion" title="Create a new companion from scratch">
                    <i class="fa-solid fa-plus"></i>
                    <span>New Companion</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-action="ai-maker" title="Describe a companion and let AI draft it">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>AI Maker</span>
                </button>
            </div>
        </div>
        <div class="ica--cdash-section" data-section="companions">
            <div class="ica--cdash-section-title">Companions <span class="ica--cdash-count">${companions.length}</span></div>
            <div class="ica--cdash-rows">
                ${companions.length > 0
        ? companions.map(buildCompanionAgentRowHtml).join('')
        : '<div class="ica--cdash-empty">No companion agents yet. Create one above, install one from Templates, or convert an existing agent below.</div>'}
            </div>
        </div>
        <div class="ica--cdash-section" data-section="convertible">
            <div class="ica--cdash-section-title">Convert an existing agent <span class="ica--cdash-count">${convertible.length}</span></div>
            <div class="ica--cdash-rows">
                ${convertible.length > 0
        ? convertible.map(buildConvertibleAgentRowHtml).join('')
        : '<div class="ica--cdash-empty">Every eligible agent already runs as a companion.</div>'}
            </div>
        </div>
        <div class="ica--cdash-section" data-section="notes">
            <div class="ica--cdash-section-title">Recent notes</div>
            <div class="ica--cdash-rows">${buildRecentNotesHtml(collectRecentNoteEntries())}</div>
        </div>
    `;
}

async function closeDashboard() {
    const popup = activeDashboardPopup;
    if (popup) {
        await popup.completeAffirmative();
    }
}

function jumpToMessage(messageIndex) {
    const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
        toastr.info('That message is above the rendered window. Scroll up in the chat to load it.');
    }
}

async function handleDashboardAction(event, root, rerender) {
    const button = $(event.currentTarget);
    const action = button.attr('data-action');
    const agentId = button.closest('.ica--cdash-row').attr('data-agent-id') || '';
    const agent = agentId ? getAgentById(agentId) : null;

    if (action === 'run-all') {
        const lastIndex = dashboardHooks.getLastAssistantMessageIndex();
        if (lastIndex < 0) {
            toastr.warning('No assistant reply yet to run companions on.');
            return;
        }
        button.prop('disabled', true);
        try {
            const results = await runCompanionsOnMessage(lastIndex);
            if (!Object.keys(results ?? {}).length) {
                toastr.info('No companion agents ran for this reply.');
            }
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'open-panel') {
        await closeDashboard();
        openCompanionPanel();
        return;
    }

    if (action === 'new-companion') {
        await closeDashboard();
        dashboardHooks.openCompanionDraftEditor();
        return;
    }

    if (action === 'ai-maker') {
        await closeDashboard();
        dashboardHooks.openCompanionDraftEditor({ autoOpenCompanionMaker: true });
        return;
    }

    if (action === 'jump') {
        const messageIndex = Number(button.attr('data-message-index'));
        await closeDashboard();
        if (Number.isInteger(messageIndex)) {
            jumpToMessage(messageIndex);
        }
        return;
    }

    if (!agent) {
        toastr.warning('That agent no longer exists.');
        rerender();
        return;
    }

    if (action === 'toggle') {
        await dashboardHooks.toggleAgentEnabled(agent);
        rerender();
        return;
    }

    if (action === 'run') {
        const lastIndex = dashboardHooks.getLastAssistantMessageIndex();
        if (lastIndex < 0) {
            toastr.warning('No assistant reply yet to run this companion on.');
            return;
        }
        button.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agent.id, lastIndex);
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'edit') {
        await closeDashboard();
        dashboardHooks.openEditor(agent.id);
        return;
    }

    if (action === 'to-companion' || action === 'to-inline') {
        await dashboardHooks.convertAgent(agent, action === 'to-companion' ? 'companion' : 'inline');
        rerender();
    }
}

export async function openCompanionDashboard() {
    if (!dashboardHooks) {
        console.warn('[InChatAgents] Companion dashboard opened before configuration.');
        return;
    }

    if (activeDashboardPopup) {
        return;
    }

    const root = $('<div class="ica--cdash"></div>');
    const rerender = () => {
        const scrollContainer = root[0]?.closest?.('.popup-content');
        const scrollTop = scrollContainer?.scrollTop ?? 0;
        root.html(buildDashboardHtml());
        if (scrollContainer) {
            scrollContainer.scrollTop = scrollTop;
        }
    };

    rerender();
    root.on('click', '[data-action]', async event => {
        event.preventDefault();
        event.stopPropagation();
        await handleDashboardAction(event, root, rerender);
    });

    let rerenderTimeout = null;
    const onResultsUpdated = () => {
        clearTimeout(rerenderTimeout);
        rerenderTimeout = setTimeout(rerender, 100);
    };
    eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, onResultsUpdated);

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    activeDashboardPopup = popup;

    try {
        await popup.show();
    } finally {
        activeDashboardPopup = null;
        clearTimeout(rerenderTimeout);
        eventSource.removeListener(COMPANION_RESULTS_UPDATED_EVENT, onResultsUpdated);
    }
}

export function initCompanionWandMenuItem() {
    if ($('#ica_companions_wand_item').length) {
        return;
    }

    const menuItem = $(`
        <div id="ica_companions_wand_item" class="list-group-item flex-container flexGap5 interactable" title="Open the Companion Agents dashboard" tabindex="0">
            <div class="fa-solid fa-user-astronaut extensionsMenuExtensionButton"></div>
            <span>Companion Agents</span>
        </div>
    `);
    menuItem.on('click', () => openCompanionDashboard());
    $('#extensionsMenu').append(menuItem);
}
