import { DOMPurify, showdown } from '../../../../lib.js';
import { chat, saveChatDebounced } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getCompanionConfig,
    getEnabledAgents,
    isCompanionAgent,
} from '../agent-store.js';
import {
    COMPANION_RESULTS_UPDATED_EVENT,
    deleteCompanionResult,
    getCompanionResults,
    runCompanionAgentOnMessage,
    runCompanionsOnMessage,
    updateCompanionResult,
} from './companion-runner.js';

let companionUiInitialized = false;
let companionMarkdownConverter = null;
const companionMessageRuns = new Set();

function getMarkdownConverter() {
    if (!companionMarkdownConverter) {
        companionMarkdownConverter = new showdown.Converter({
            simpleLineBreaks: true,
            tables: true,
            strikethrough: true,
        });
    }

    return companionMarkdownConverter;
}

function isAssistantMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

function getMessageIndexFromElement(element) {
    const messageIndex = Number($(element).closest('.mes').attr('mesid'));
    return Number.isFinite(messageIndex) ? messageIndex : -1;
}

function sanitizeCompanionHtml(html = '') {
    return DOMPurify.sanitize(String(html ?? ''), {
        ADD_ATTR: ['target', 'rel'],
    });
}

function formatCompanionContent(result = {}) {
    const content = String(result.content ?? '').trim();
    if (!content) {
        return '<div class="ica--companion-empty">No note returned.</div>';
    }

    if (result.format === 'html') {
        return sanitizeCompanionHtml(content);
    }

    if (result.format === 'text') {
        return `<pre class="ica--companion-text">${escapeHtml(content)}</pre>`;
    }

    return sanitizeCompanionHtml(getMarkdownConverter().makeHtml(content));
}

function getResultStatus(result = {}) {
    return ['pending', 'done', 'error', 'cancelled'].includes(result.status) ? result.status : 'done';
}

function getStatusLabel(status) {
    switch (status) {
        case 'pending': return 'Running';
        case 'error': return 'Error';
        case 'cancelled': return 'Cancelled';
        default: return 'Ready';
    }
}

function getResultSortValue(result = {}) {
    const timestamp = Date.parse(result.updatedAt ?? '');
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function isHiddenCompanionResult(agentId, result = {}) {
    if (result.displayMode === 'hidden') {
        return true;
    }

    const agent = getAgentById(agentId);
    return Boolean(agent && getCompanionConfig(agent).displayMode === 'hidden');
}

function getRenderableCompanionEntries(message) {
    return Object.entries(getCompanionResults(message))
        .filter(([agentId, result]) => result && typeof result === 'object' && !isHiddenCompanionResult(agentId, result))
        .sort(([, left], [, right]) => getResultSortValue(left) - getResultSortValue(right));
}

function buildCompanionBody(result) {
    const status = getResultStatus(result);

    if (status === 'pending') {
        return '<div class="ica--companion-pending"><i class="fa-solid fa-spinner fa-spin"></i><span>Companion is writing a note.</span></div>';
    }

    if (status === 'error') {
        return `<div class="ica--companion-error">${escapeHtml(result.error || 'Companion run failed.')}</div>`;
    }

    if (status === 'cancelled') {
        return '<div class="ica--companion-empty">Companion run was cancelled.</div>';
    }

    return formatCompanionContent(result);
}

function buildCompanionCard(agentId, result) {
    const status = getResultStatus(result);
    const agentName = String(result.agentName ?? '').trim() || 'Companion';
    const icon = String(result.icon ?? '').trim() || 'fa-user-astronaut';
    const profileLabel = String(result.profileLabel ?? '').trim();
    const modelLabel = String(result.modelLabel ?? '').trim();
    const meta = [profileLabel, modelLabel].filter(Boolean).join(' / ');
    const openAttribute = result.collapsed ? '' : ' open';

    return `
        <details class="ica--companion-card ica--companion-card--${escapeHtml(status)}" data-agent-id="${escapeHtml(agentId)}"${openAttribute}>
            <summary class="ica--companion-summary">
                <span class="ica--companion-title">
                    <i class="fa-solid ${escapeHtml(icon)}"></i>
                    <span>${escapeHtml(agentName)}</span>
                </span>
                <span class="ica--companion-summary-spacer"></span>
                ${meta ? `<span class="ica--companion-meta">${escapeHtml(meta)}</span>` : ''}
                <span class="ica--companion-status">${escapeHtml(getStatusLabel(status))}</span>
                <span class="ica--companion-actions">
                    <button type="button" class="ica--companion-action" data-action="regenerate" title="Regenerate companion note" aria-label="Regenerate companion note"><i class="fa-solid fa-rotate-right"></i></button>
                    <button type="button" class="ica--companion-action" data-action="edit" title="Edit companion note" aria-label="Edit companion note"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button type="button" class="ica--companion-action" data-action="copy" title="Copy companion note" aria-label="Copy companion note"><i class="fa-solid fa-copy"></i></button>
                    <button type="button" class="ica--companion-action caution" data-action="delete" title="Delete companion note" aria-label="Delete companion note"><i class="fa-solid fa-trash"></i></button>
                </span>
            </summary>
            <div class="ica--companion-body">${buildCompanionBody(result)}</div>
        </details>
    `;
}

export function renderCompanionResultsForMessage(messageIndex) {
    const message = chat[messageIndex];
    const messageElement = $(`.mes[mesid="${messageIndex}"]`);

    if (!messageElement.length) {
        return;
    }

    const entries = isAssistantMessage(message) ? getRenderableCompanionEntries(message) : [];
    let ledger = messageElement.find('.ica--companion-ledger');

    if (entries.length === 0) {
        ledger.remove();
        return;
    }

    if (!ledger.length) {
        ledger = $('<div class="ica--companion-ledger" aria-label="Companion notes"></div>');
        const textElement = messageElement.find('.mes_text').first();
        if (textElement.length) {
            textElement.after(ledger);
        } else {
            messageElement.find('.mes_block').first().append(ledger);
        }
    }

    ledger.html(entries.map(([agentId, result]) => buildCompanionCard(agentId, result)).join(''));
}

function renderAllCompanionResults() {
    for (let index = 0; index < chat.length; index++) {
        renderCompanionResultsForMessage(index);
    }
}

function hasRunnableCompanionAgents() {
    return areAgentsGloballyEnabled() && getEnabledAgents().some(agent => {
        return isCompanionAgent(agent) && String(agent.prompt ?? '').trim();
    });
}

export function updateCompanionButtonVisibility() {
    const shouldShow = hasRunnableCompanionAgents();
    $('.mes_run_companions').each(function () {
        const messageElement = $(this).closest('.mes');
        const isAssistant = messageElement.attr('is_user') !== 'true' && messageElement.attr('is_system') !== 'true';
        $(this).toggle(shouldShow && isAssistant);
    });
}

async function copyText(text) {
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

async function runCompanionsFromMessageButton(messageIndex, button) {
    if (!isAssistantMessage(chat[messageIndex])) {
        toastr.warning('Companions can run on assistant replies only.');
        return;
    }

    if (!hasRunnableCompanionAgents()) {
        toastr.info('No enabled companion agents are ready to run.');
        updateCompanionButtonVisibility();
        return;
    }

    const runKey = String(messageIndex);
    if (companionMessageRuns.has(runKey)) {
        return;
    }

    companionMessageRuns.add(runKey);
    const buttonElement = $(button);
    buttonElement.addClass('mes_run_companions--running').prop('disabled', true);

    try {
        const results = await runCompanionsOnMessage(messageIndex);
        renderCompanionResultsForMessage(messageIndex);
        if (!Object.keys(results ?? {}).length) {
            toastr.info('No companion agents ran for this reply.');
        }
    } finally {
        companionMessageRuns.delete(runKey);
        buttonElement.removeClass('mes_run_companions--running').prop('disabled', false);
        updateCompanionButtonVisibility();
    }
}

function getCompanionActionContext(element) {
    const card = $(element).closest('.ica--companion-card');
    const messageIndex = getMessageIndexFromElement(element);
    const agentId = card.attr('data-agent-id') || '';
    const message = chat[messageIndex];
    const result = getCompanionResults(message)[agentId];

    return { card, messageIndex, agentId, message, result };
}

async function editCompanionResult(messageIndex, agentId, message, result) {
    const editor = $(`
        <div class="ica--companion-edit-popup">
            <div class="ica--regex-note">Edit only this saved card. Regenerate to ask the model again.</div>
            <textarea class="text_pole textarea_compact" rows="12">${escapeHtml(result?.content ?? '')}</textarea>
        </div>
    `);
    const popupResult = await new Popup(editor, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save Note',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    }).show();

    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    updateCompanionResult(message, agentId, {
        status: 'done',
        content: editor.find('textarea').val()?.toString() ?? '',
        error: '',
    });
    saveChatDebounced({ deferBackup: false });
    renderCompanionResultsForMessage(messageIndex);
}

async function deleteCompanionCard(messageIndex, agentId, message) {
    const popupResult = await new Popup('Delete this companion note?', POPUP_TYPE.CONFIRM).show();
    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    deleteCompanionResult(message, agentId);
    saveChatDebounced({ deferBackup: false });
    renderCompanionResultsForMessage(messageIndex);
}

async function handleCompanionAction(event) {
    event.preventDefault();
    event.stopPropagation();

    const action = $(event.currentTarget).attr('data-action');
    const { messageIndex, agentId, message, result } = getCompanionActionContext(event.currentTarget);
    if (!isAssistantMessage(message) || !agentId) {
        toastr.warning('Invalid companion note.');
        return;
    }

    if (action === 'regenerate') {
        await runCompanionAgentOnMessage(agentId, messageIndex);
        renderCompanionResultsForMessage(messageIndex);
        return;
    }

    if (action === 'edit') {
        await editCompanionResult(messageIndex, agentId, message, result);
        return;
    }

    if (action === 'copy') {
        await copyText(String(result?.content ?? ''));
        toastr.success('Companion note copied.');
        return;
    }

    if (action === 'delete') {
        await deleteCompanionCard(messageIndex, agentId, message);
    }
}

function persistCompanionCollapseState(event) {
    const details = event.target;
    const messageIndex = getMessageIndexFromElement(details);
    const agentId = $(details).attr('data-agent-id') || '';
    const message = chat[messageIndex];

    if (!isAssistantMessage(message) || !agentId) {
        return;
    }

    const result = updateCompanionResult(message, agentId, {
        collapsed: !details.open,
    });
    if (result) {
        saveChatDebounced({ deferBackup: false });
    }
}

export function initCompanionCardUi() {
    if (companionUiInitialized) {
        return;
    }

    companionUiInitialized = true;
    $(document).on('click', '.mes_run_companions', async function () {
        const messageIndex = getMessageIndexFromElement(this);
        if (messageIndex < 0) {
            toastr.warning('Invalid message.');
            return;
        }
        await runCompanionsFromMessageButton(messageIndex, this);
    });
    $(document).on('click', '.ica--companion-action', handleCompanionAction);
    document.addEventListener('toggle', event => {
        if (event.target?.classList?.contains('ica--companion-card')) {
            persistCompanionCollapseState(event);
        }
    }, true);

    eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, ({ messageIndex } = {}) => {
        if (Number.isInteger(messageIndex)) {
            renderCompanionResultsForMessage(messageIndex);
        } else {
            renderAllCompanionResults();
        }
        updateCompanionButtonVisibility();
    });

    const renderEvents = [
        event_types.CHAT_CHANGED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
    ].filter(Boolean);

    for (const eventName of renderEvents) {
        eventSource.on(eventName, (messageIndex = null) => {
            if (Number.isInteger(messageIndex)) {
                renderCompanionResultsForMessage(messageIndex);
            } else {
                renderAllCompanionResults();
            }
            updateCompanionButtonVisibility();
        });
    }

    renderAllCompanionResults();
    updateCompanionButtonVisibility();
}
