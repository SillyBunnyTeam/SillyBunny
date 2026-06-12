import { DOMPurify, showdown } from '../../../../lib.js';
import { chat, saveChatDebounced, substituteParams, substituteParamsExtended } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getAgentRegexScripts,
    getCompanionConfig,
    getEnabledAgents,
    isCompanionAgent,
} from '../agent-store.js';
import { AGENT_REGEX_PLACEMENT, applyRegexScriptList } from '../regex-scripts.js';
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

function applyAgentRegexToCompanionContent(agentId, content, message) {
    const agent = getAgentById(agentId);
    const scripts = agent ? getAgentRegexScripts(agent) : [];
    if (scripts.length === 0) {
        return content;
    }

    // Same semantics as the chat message display path: a converted tracker's beautifier
    // regex keeps working on its note card. Sanitization happens after, in the format step.
    return applyRegexScriptList(content, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        characterOverride: String(message?.name ?? '').trim(),
        isMarkdown: true,
        substituteParamsFn: substituteParams,
        substituteParamsExtendedFn: substituteParamsExtended,
    });
}

export function formatCompanionContent(agentId, result = {}, message = null) {
    const rawContent = String(result.content ?? '').trim();
    if (!rawContent) {
        return '<div class="ica--companion-empty">No note returned.</div>';
    }

    const content = applyAgentRegexToCompanionContent(agentId, rawContent, message);

    if (result.format === 'html') {
        return decorateChoiceLines(sanitizeCompanionHtml(content));
    }

    if (result.format === 'text') {
        return `<pre class="ica--companion-text">${escapeHtml(content)}</pre>`;
    }

    return decorateChoiceLines(sanitizeCompanionHtml(getMarkdownConverter().makeHtml(content)));
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

const OFF_LEDGER_DISPLAY_MODES = new Set(['hidden', 'panel']);

export function isHiddenCompanionResult(agentId, result = {}) {
    if (OFF_LEDGER_DISPLAY_MODES.has(result.displayMode)) {
        return true;
    }

    const agent = getAgentById(agentId);
    return Boolean(agent && OFF_LEDGER_DISPLAY_MODES.has(getCompanionConfig(agent).displayMode));
}

function getRenderableCompanionEntries(message) {
    return Object.entries(getCompanionResults(message))
        .filter(([agentId, result]) => result && typeof result === 'object' && !isHiddenCompanionResult(agentId, result))
        .sort(([, left], [, right]) => getResultSortValue(left) - getResultSortValue(right));
}

function buildCompanionBody(agentId, result, message) {
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

    return formatCompanionContent(agentId, result, message);
}

const RAW_ID_LABEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_ID_IN_NAME_RE = /\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;

function isReadableLabel(label) {
    return Boolean(label) && !RAW_ID_LABEL_RE.test(label);
}

/** Imported/AI-generated agents sometimes carry a uuid suffix in their name; never display it. */
export function cleanCompanionAgentName(name) {
    return String(name ?? '').replace(TRAILING_ID_IN_NAME_RE, '').trim() || 'Companion';
}

const CHOICE_PREFIX_RE = /^(?:[-*•→>]|\d+[.):]|[a-z][.)])\s+/i;
// Detection requires a real enumerator (1. / 2) / B)) — plain bullets are how trackers
// format state lines, and wrapping those turned ordinary panel taps into inserts.
const CHOICE_LINE_RE = /^(?:\d+[.):]|[a-z][.)])\s+\S/i;

/** Normalizes a clicked choice line: collapse whitespace and strip list enumeration. */
export function extractChoiceText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().replace(CHOICE_PREFIX_RE, '').trim();
}

function buildChoiceButtonHtml(innerHtml) {
    return `<button type="button" class="ica--choice-line" title="Put this choice in the message box">${innerHtml}</button>`;
}

function wrapChoiceSegment(segment) {
    const probe = document.createElement('div');
    probe.innerHTML = segment;
    const text = probe.textContent.replace(/\s+/g, ' ').trim();
    if (!CHOICE_LINE_RE.test(text) || probe.querySelector('button, a, details')) {
        return segment;
    }

    return buildChoiceButtonHtml(segment);
}

/**
 * Wraps choice-looking lines in real buttons so they are tappable everywhere (iOS included).
 * Three passes cover the shapes companion output takes: proper markdown lists; enumerated
 * lines left as <br>-separated text inside one block by showdown's simpleLineBreaks (raw
 * CYOA/direction output); and enumerated lines inside arbitrary styled markup produced by
 * agent beautifier regexes. Runs after sanitization; only our own button wrapper is added.
 */
export function decorateChoiceLines(html) {
    if (typeof document?.createElement !== 'function') {
        return html;
    }

    const container = document.createElement('div');
    container.innerHTML = html;

    for (const item of container.querySelectorAll('li')) {
        if (!item.querySelector('button, a, ul, ol') && item.textContent.trim()) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ica--choice-line';
            button.title = 'Put this choice in the message box';
            button.innerHTML = item.innerHTML;
            item.innerHTML = '';
            item.appendChild(button);
        }
    }

    for (const block of container.querySelectorAll('p, div')) {
        if (block.querySelector('button, a, p, div, ul, ol')) {
            continue;
        }

        const segments = block.innerHTML.split(/<br\s*\/?>/i);
        if (segments.length > 1) {
            block.innerHTML = segments.map(wrapChoiceSegment).join('<br>');
        }
    }

    // Deepest-match pass for beautified markup: wrap any innermost element whose own text
    // reads as a single enumerated choice (e.g. a styled row div emitted by a regex script).
    const candidates = [...container.querySelectorAll('*')].filter(element => {
        if (element.closest('button, a') || element.querySelector('button, a, br')) {
            return false;
        }

        return CHOICE_LINE_RE.test(element.textContent.replace(/\s+/g, ' ').trim());
    });

    for (const element of candidates) {
        const hasMatchingDescendant = candidates.some(other => other !== element && element.contains(other));
        if (hasMatchingDescendant) {
            continue;
        }

        element.innerHTML = buildChoiceButtonHtml(element.innerHTML);
    }

    return container.innerHTML;
}

/**
 * Puts a clicked companion choice (CYOA option, direction, suggestion) into the message box:
 * replaces an empty box, appends on a new line otherwise.
 * @returns {boolean} Whether anything was inserted.
 */
export function insertChoiceIntoMessageInput(rawText) {
    const choice = extractChoiceText(rawText);
    if (!choice) {
        return false;
    }

    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        toastr.warning('Could not find the message box.');
        return false;
    }

    const current = String(textarea.value ?? '');
    textarea.value = current.trim() ? `${current.replace(/\s+$/, '')}\n${choice}` : choice;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    globalThis.$?.(textarea).trigger('input');
    textarea.focus();
    toastr.success('Added to the message box.');
    return true;
}

function buildCompanionCard(agentId, result, message) {
    const status = getResultStatus(result);
    const agentName = cleanCompanionAgentName(result.agentName);
    const icon = String(result.icon ?? '').trim() || 'fa-user-astronaut';
    const profileLabel = String(result.profileLabel ?? '').trim();
    const modelLabel = String(result.modelLabel ?? '').trim();
    // Results saved before profile labels were resolved to names may carry raw profile ids.
    const meta = [profileLabel, modelLabel].filter(isReadableLabel).join(' / ');
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
            <div class="ica--companion-body">${buildCompanionBody(agentId, result, message)}</div>
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

    ledger.html(entries.map(([agentId, result]) => buildCompanionCard(agentId, result, message)).join(''));
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

export async function editCompanionResult(messageIndex, agentId, message, result) {
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
    // Document-level catch-all: covers cards and any other surface rendering companion
    // bodies. The panel binds its own element-level handler first (to close itself), and
    // its stopPropagation keeps this one from double-inserting.
    $(document).on('click', '.ica--choice-line', function (event) {
        event.preventDefault();
        event.stopPropagation();
        insertChoiceIntoMessageInput(this.textContent);
    });
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
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
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

    if (event_types.MESSAGE_DELETED) {
        // The payload is the deleted index, but every later message shifts down — re-render all.
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            renderAllCompanionResults();
            updateCompanionButtonVisibility();
        });
    }

    renderAllCompanionResults();
    updateCompanionButtonVisibility();
}
