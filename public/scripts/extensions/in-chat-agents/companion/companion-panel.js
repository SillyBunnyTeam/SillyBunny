import { chat } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { escapeHtml } from '../../../utils.js';
import {
    areAgentsGloballyEnabled,
    getAgents,
    getCompanionConfig,
    isAgentEnabledForCurrentScope,
    isCompanionAgent,
} from '../agent-store.js';
import {
    COMPANION_RESULTS_UPDATED_EVENT,
    getCompanionResults,
    runCompanionAgentOnMessage,
} from './companion-runner.js';
import { cleanCompanionAgentName, formatCompanionContent } from './companion-ui.js';

const PANEL_HISTORY_LIMIT = 5;

let panelInitialized = false;
let panelOpen = false;

function isAssistantMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

function getPanelAgents() {
    return getAgents().filter(agent => isCompanionAgent(agent) && agent.category !== 'tool');
}

/**
 * Collects the latest stored result (and a short history) per companion agent by walking
 * the chat backwards. Enabled agents without any stored state are included so the panel
 * can explain that they have not run yet.
 */
export function collectPanelAgentStates() {
    const byAgentId = new Map();

    for (const agent of getPanelAgents()) {
        if (isAgentEnabledForCurrentScope(agent)) {
            byAgentId.set(agent.id, { agentId: agent.id, agent, latest: null, history: [] });
        }
    }

    for (let messageIndex = chat.length - 1; messageIndex >= 0; messageIndex--) {
        const message = chat[messageIndex];
        if (!isAssistantMessage(message)) {
            continue;
        }

        for (const [agentId, result] of Object.entries(getCompanionResults(message))) {
            if (!result || typeof result !== 'object') {
                continue;
            }

            let state = byAgentId.get(agentId);
            if (!state) {
                const agent = getPanelAgents().find(candidate => candidate.id === agentId) ?? null;
                state = { agentId, agent, latest: null, history: [] };
                byAgentId.set(agentId, state);
            }

            const entry = { messageIndex, result };
            if (!state.latest) {
                state.latest = entry;
            } else if (state.history.length < PANEL_HISTORY_LIMIT) {
                state.history.push(entry);
            }
        }
    }

    return [...byAgentId.values()];
}

export function shouldShowCompanionPanelHandle() {
    if (!areAgentsGloballyEnabled()) {
        return false;
    }

    return collectPanelAgentStates().some(state => state.latest || state.agent);
}

function getStateDisplayName(state) {
    return cleanCompanionAgentName(state.agent?.name ?? state.latest?.result?.agentName);
}

function getStateIcon(state) {
    const icon = String(state.agent?.icon ?? state.latest?.result?.icon ?? '').trim();
    return icon || 'fa-user-astronaut';
}

function buildPanelEntryBody(agentId, entry) {
    const status = String(entry.result.status ?? 'done');
    if (status === 'pending') {
        return '<div class="ica--companion-pending"><i class="fa-solid fa-spinner fa-spin"></i><span>Updating…</span></div>';
    }

    if (status === 'error') {
        return `<div class="ica--companion-error">${escapeHtml(entry.result.error || 'Companion run failed.')}</div>`;
    }

    return formatCompanionContent(agentId, entry.result, chat[entry.messageIndex]);
}

function buildPanelAgentSection(state) {
    const agentId = state.agentId ?? state.agent?.id ?? '';
    const latest = state.latest;
    const name = getStateDisplayName(state);
    const icon = getStateIcon(state);

    if (!latest) {
        return `
            <section class="ica--tpanel-agent" data-agent-id="${escapeHtml(agentId)}">
                <div class="ica--tpanel-agent-head">
                    <span class="ica--tpanel-agent-name"><i class="fa-solid ${escapeHtml(icon)}"></i><span>${escapeHtml(name)}</span></span>
                </div>
                <div class="ica--cdash-empty">No state yet. It will appear after the next reply${getCompanionConfig(state.agent).trigger === 'manual' ? ' you run it on' : ''}.</div>
            </section>
        `;
    }

    const historyHtml = state.history.length > 0
        ? `
            <details class="ica--tpanel-history">
                <summary>Previous states (${state.history.length})</summary>
                ${state.history.map(entry => `
                    <div class="ica--tpanel-history-entry">
                        <div class="ica--tpanel-history-head">Message #${entry.messageIndex}</div>
                        <div class="ica--tpanel-agent-body">${buildPanelEntryBody(agentId, entry)}</div>
                    </div>
                `).join('')}
            </details>
        `
        : '';

    return `
        <section class="ica--tpanel-agent" data-agent-id="${escapeHtml(agentId)}" data-message-index="${latest.messageIndex}">
            <div class="ica--tpanel-agent-head">
                <span class="ica--tpanel-agent-name"><i class="fa-solid ${escapeHtml(icon)}"></i><span>${escapeHtml(name)}</span></span>
                <span class="ica--tpanel-agent-when">#${latest.messageIndex}</span>
                <span class="ica--tpanel-agent-actions">
                    <button type="button" class="ica--cdash-action" data-action="panel-regenerate" title="Regenerate this state" aria-label="Regenerate state"><i class="fa-solid fa-rotate-right"></i></button>
                    <button type="button" class="ica--cdash-action" data-action="panel-jump" title="Scroll to the source message" aria-label="Scroll to source message"><i class="fa-solid fa-comment-dots"></i></button>
                </span>
            </div>
            <div class="ica--tpanel-agent-body">${buildPanelEntryBody(agentId, latest)}</div>
            ${historyHtml}
        </section>
    `;
}

export function buildPanelHtml() {
    const states = collectPanelAgentStates();
    const body = states.length > 0
        ? states.map(buildPanelAgentSection).join('')
        : '<div class="ica--cdash-empty">No companion agents are enabled and no tracked state is stored in this chat yet. Convert a tracker to companion execution or enable a companion to see its state here.</div>';

    return `
        <div class="ica--tpanel-header">
            <span class="ica--tpanel-title"><i class="fa-solid fa-map-location-dot"></i> Tracker Panel</span>
            <button type="button" class="ica--cdash-action" data-action="panel-close" title="Close panel" aria-label="Close panel"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="ica--tpanel-body">${body}</div>
    `;
}

function renderPanel() {
    $('#ica--tracker-panel').html(buildPanelHtml());
}

export function updateCompanionPanelHandleVisibility() {
    $('#ica--tracker-panel-handle').toggle(shouldShowCompanionPanelHandle());
}

export function openCompanionPanel() {
    panelOpen = true;
    renderPanel();
    $('#ica--tracker-panel').addClass('is-open').attr('aria-hidden', 'false');
}

export function closeCompanionPanel() {
    panelOpen = false;
    $('#ica--tracker-panel').removeClass('is-open').attr('aria-hidden', 'true');
}

export function toggleCompanionPanel() {
    if (panelOpen) {
        closeCompanionPanel();
    } else {
        openCompanionPanel();
    }
}

async function handlePanelAction(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = $(event.currentTarget);
    const action = button.attr('data-action');

    if (action === 'panel-close') {
        closeCompanionPanel();
        return;
    }

    const section = button.closest('.ica--tpanel-agent');
    const agentId = section.attr('data-agent-id') || '';
    const messageIndex = Number(section.attr('data-message-index'));

    if (action === 'panel-jump') {
        closeCompanionPanel();
        const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
        if (messageElement) {
            messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            toastr.info('That message is above the rendered window. Scroll up in the chat to load it.');
        }
        return;
    }

    if (action === 'panel-regenerate' && agentId && Number.isInteger(messageIndex)) {
        button.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agentId, messageIndex);
        } finally {
            button.prop('disabled', false);
            if (panelOpen) {
                renderPanel();
            }
        }
    }
}

export function initCompanionPanel() {
    if (panelInitialized) {
        return;
    }

    panelInitialized = true;
    $(document.body).append('<div id="ica--tracker-panel" class="ica--tpanel" aria-hidden="true"></div>');
    $(document.body).append(`
        <button type="button" id="ica--tracker-panel-handle" class="ica--tpanel-handle" title="Open the tracker panel" aria-label="Open the tracker panel" style="display:none">
            <i class="fa-solid fa-map-location-dot"></i>
            <span>Trackers</span>
        </button>
    `);

    $('#ica--tracker-panel').on('click', '[data-action]', handlePanelAction);
    $('#ica--tracker-panel-handle').on('click', () => toggleCompanionPanel());

    if (!$('#ica_tracker_panel_wand_item').length) {
        const menuItem = $(`
            <div id="ica_tracker_panel_wand_item" class="list-group-item flex-container flexGap5 interactable" title="Open the tracker panel" tabindex="0">
                <div class="fa-solid fa-map-location-dot extensionsMenuExtensionButton"></div>
                <span>Tracker Panel</span>
            </div>
        `);
        menuItem.on('click', () => openCompanionPanel());
        $('#extensionsMenu').append(menuItem);
    }

    eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, () => {
        if (panelOpen) {
            renderPanel();
        }
        updateCompanionPanelHandleVisibility();
    });

    const refreshEvents = [event_types.CHAT_CHANGED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED].filter(Boolean);
    for (const eventName of refreshEvents) {
        eventSource.on(eventName, () => {
            if (panelOpen) {
                renderPanel();
            }
            updateCompanionPanelHandleVisibility();
        });
    }

    updateCompanionPanelHandleVisibility();
}
