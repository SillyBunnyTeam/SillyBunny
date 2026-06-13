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
    saveAgent,
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
const MESSAGE_INBOX_TEMPLATE_ID = 'tpl-message-inbox-companion';
const MESSAGE_INBOX_EMPTY_OUTPUTS = new Set(['phone-none', 'PHONE_NONE']);
const CHATROOM_TEMPLATE_ID = 'tpl-chatroom-companion';
const CHATROOM_STYLE_VALUES = new Set([
    'mixed',
    'in-world',
    'discord/twitch',
    'twitter/x',
    'reddit',
    'ao3/wattpad',
    'newsroom',
    'thread-board/4chan',
    'custom',
]);
const CHAT_ONLY_TEMPLATE_ID = 'tpl-chat-only-companion';
const PLOT_COMPASS_TEMPLATE_ID = 'tpl-plot-compass-companion';
const CHAT_ONLY_INPUT_MAX_CHARS = 2000;
const CHAT_ONLY_TRANSCRIPT_MAX_CHARS = 12000;
const PLOT_COMPASS_OBJECTIVE_MAX_CHARS = 2000;

function getAgentTemplateId(agent = {}) {
    return String(agent?.sourceTemplateId ?? agent?.id ?? '').trim();
}

function isMessageInboxAgent(agent = null) {
    return getAgentTemplateId(agent) === MESSAGE_INBOX_TEMPLATE_ID;
}

function isChatroomAgent(agent = null) {
    return getAgentTemplateId(agent) === CHATROOM_TEMPLATE_ID;
}

function isChatOnlyAgent(agent = null) {
    return getAgentTemplateId(agent) === CHAT_ONLY_TEMPLATE_ID;
}

function isPlotCompassAgent(agent = null) {
    return getAgentTemplateId(agent) === PLOT_COMPASS_TEMPLATE_ID;
}

function normalizeChatOnlyInput(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(0, CHAT_ONLY_INPUT_MAX_CHARS);
}

function normalizeChatOnlyTranscript(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(-CHAT_ONLY_TRANSCRIPT_MAX_CHARS);
}

function appendChatOnlyUserMessage(transcript = '', userInput = '') {
    const previous = normalizeChatOnlyTranscript(transcript);
    const nextLine = `You: ${normalizeChatOnlyInput(userInput)}`;
    return normalizeChatOnlyTranscript(previous ? `${previous}\n\n${nextLine}` : nextLine);
}

function normalizePlotCompassObjective(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(0, PLOT_COMPASS_OBJECTIVE_MAX_CHARS);
}

function normalizeChatroomField(value = '') {
    return String(value ?? '').replaceAll('|', '/').replaceAll(/\r?\n/g, ' ').trim();
}

// Hues the template instructs the model to use.
const CHATROOM_VALID_TONES = new Set(['18', '42', '92', '150', '205', '265', '315']);

function normalizeMarkerlessChatroomContent(content = '') {
    const text = String(content ?? '').replaceAll(/\r\n?/g, '\n').trim();
    if (!text || /^(?:CHATROOM_STYLE|chatroom-style|CHATROOM|chatroom)\|/m.test(text)) {
        return content;
    }

    // Expect first line: `style|...` (may have the style value duplicated after the pipe)
    const styleMatch = text.match(/^\s*([^|\n]+)\|([\s\S]*)$/);
    const style = styleMatch?.[1]?.trim().toLowerCase() || '';
    if (!CHATROOM_STYLE_VALUES.has(style)) {
        return content;
    }

    let rest = styleMatch[2].trim();

    // Strip duplicated style prefix emitted by some models: "mixed|mixed @..." → "@..."
    if (rest.toLowerCase().startsWith(style)) {
        rest = rest.slice(style.length).trim();
    }

    // Split into individual post tokens on @ boundaries.
    // Each model post looks like: @Handle/meta/HUE/message text[/mood]
    const rawTokens = rest.split(/(?=@[A-Za-z])/).map(t => t.trim()).filter(Boolean);

    const rows = [];
    for (const token of rawTokens) {
        // Strip leading @
        const t = token.startsWith('@') ? token.slice(1) : token;
        const parts = t.split('/');
        if (parts.length < 4) continue;

        const speaker = parts[0].trim();
        const meta = parts[1].trim();
        const tone = parts[2].trim();
        if (!speaker || !CHATROOM_VALID_TONES.has(tone)) continue;

        // Remaining parts joined as message (model may put a mood word as last slash-token)
        const message = parts.slice(3).join(' ').trim();
        if (!message) continue;

        rows.push(`chatroom|${normalizeChatroomField(speaker)}|${normalizeChatroomField(meta)}|${tone}|${normalizeChatroomField(message)}`);
    }

    if (!rows.length) {
        return content;
    }

    return ['chatroom-style|' + style, ...rows, 'chatroom-end'].join('\n');
}

function autoGrowCompanionTextarea(textarea) {
    if (!textarea?.style) {
        return;
    }

    textarea.style.height = 'auto';
    const height = Math.min(140, Math.max(34, textarea.scrollHeight || 34));
    textarea.style.height = `${height}px`;
}

function autoGrowCompanionTextareas(root = document) {
    root?.querySelectorAll?.('.ica--chatonly-input, .ica--plot-objective-input')
        ?.forEach(autoGrowCompanionTextarea);
}

async function setAgentSetting(agent, key, value) {
    if (!agent) return;

    agent.settings = agent.settings && typeof agent.settings === 'object' && !Array.isArray(agent.settings)
        ? { ...agent.settings }
        : {};
    agent.settings[key] = value;
    await saveAgent(agent);
}

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
    const normalizedContent = isChatroomAgent(agent) ? normalizeMarkerlessChatroomContent(content) : content;
    return applyRegexScriptList(normalizedContent, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        characterOverride: String(message?.name ?? '').trim(),
        isMarkdown: true,
        substituteParamsFn: substituteParams,
        substituteParamsExtendedFn: substituteParamsExtended,
    });
}

export function formatCompanionContent(agentId, result = {}, message = null) {
    const rawContent = String(result.content ?? '').trim();
    if (isSuppressedCompanionResult(agentId, result)) {
        return '';
    }

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
    if (isSuppressedCompanionResult(agentId, result)) {
        return true;
    }

    if (OFF_LEDGER_DISPLAY_MODES.has(result.displayMode)) {
        return true;
    }

    const agent = getAgentById(agentId);
    return Boolean(agent && OFF_LEDGER_DISPLAY_MODES.has(getCompanionConfig(agent).displayMode));
}

export function isSilentCompanionAgent(agent = {}) {
    return isMessageInboxAgent(agent);
}

export function isSuppressedCompanionResult(agentId, result = {}) {
    if (!MESSAGE_INBOX_EMPTY_OUTPUTS.has(String(result?.content ?? '').trim())) {
        return false;
    }

    return isMessageInboxAgent(getAgentById(agentId));
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

function buildChatOnlyCardComposer(agentId) {
    const agent = getAgentById(agentId);
    if (!isChatOnlyAgent(agent)) {
        return '';
    }

    return `
        <div class="ica--chatonly-composer ica--companion-chatonly-composer">
            <div class="ica--chatonly-live ica--companion-chatonly-live"><i class="fa-solid fa-circle"></i><span>Private side chat</span></div>
            <textarea class="text_pole textarea_compact ica--chatonly-input ica--companion-chatonly-input" data-role="chat-only-input" rows="1" maxlength="${CHAT_ONLY_INPUT_MAX_CHARS}" placeholder="Type an aside..."></textarea>
            <button type="button" class="menu_button menu_button_icon ica--chatonly-send ica--companion-control-action" data-action="chat-only-send" title="Send this aside to Chat Only" aria-label="Send aside">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
}

function buildPlotCompassObjectiveComposer(agentId) {
    const agent = getAgentById(agentId);
    if (!isPlotCompassAgent(agent)) {
        return '';
    }

    const objective = normalizePlotCompassObjective(agent.settings?.plotCompassObjective);
    return `
        <div class="ica--plot-objective-composer ica--companion-plot-objective">
            <label>
                <span>Plot Objective</span>
                <textarea class="text_pole textarea_compact ica--plot-objective-input" data-role="plot-compass-objective" rows="1" maxlength="${PLOT_COMPASS_OBJECTIVE_MAX_CHARS}" placeholder="Where should the story go?">${escapeHtml(objective)}</textarea>
            </label>
            <button type="button" class="menu_button menu_button_icon ica--plot-objective-save ica--companion-control-action" data-action="plot-compass-save" title="Save objective and rerun Plot Compass" aria-label="Save Plot Objective">
                <i class="fa-solid fa-compass"></i>
            </button>
        </div>
    `;
}

function buildCompanionCardControls(agentId) {
    return [
        buildPlotCompassObjectiveComposer(agentId),
        buildChatOnlyCardComposer(agentId),
    ].filter(Boolean).join('');
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
            ${buildCompanionCardControls(agentId)}
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
    autoGrowCompanionTextareas(messageElement.get?.(0));
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

async function sendChatOnlyAside({ agentId, messageIndex, transcript = '', userInput = '', button = null, inputField = null } = {}) {
    const agent = getAgentById(agentId);
    if (!agent || !isChatOnlyAgent(agent)) {
        toastr.warning('Chat Only is not available.');
        return;
    }

    const normalizedInput = normalizeChatOnlyInput(userInput);
    if (!normalizedInput) {
        toastr.warning('Type an aside first.');
        return;
    }

    if (!isAssistantMessage(chat[messageIndex])) {
        toastr.warning('No assistant reply yet to chat beside.');
        return;
    }

    const nextTranscript = appendChatOnlyUserMessage(transcript, normalizedInput);
    button?.prop?.('disabled', true);
    inputField?.prop?.('disabled', true);
    try {
        await runCompanionAgentOnMessage(agentId, messageIndex, {
            pendingContent: nextTranscript,
            extraContextSections: [{
                title: 'Chat Only side chat',
                content: nextTranscript,
            }],
        });
        inputField?.val?.('');
        renderCompanionResultsForMessage(messageIndex);
    } finally {
        button?.prop?.('disabled', false);
        inputField?.prop?.('disabled', false);
    }
}

async function savePlotCompassObjective({ agentId, messageIndex, objective = '', button = null, inputField = null } = {}) {
    const agent = getAgentById(agentId);
    if (!agent || !isPlotCompassAgent(agent)) {
        toastr.warning('Plot Compass is not available.');
        return;
    }

    if (!isAssistantMessage(chat[messageIndex])) {
        toastr.warning('No assistant reply yet to plan from.');
        return;
    }

    const nextObjective = normalizePlotCompassObjective(objective);
    button?.prop?.('disabled', true);
    inputField?.prop?.('disabled', true);
    try {
        await setAgentSetting(agent, 'plotCompassObjective', nextObjective);
        await runCompanionAgentOnMessage(agentId, messageIndex);
        renderCompanionResultsForMessage(messageIndex);
        toastr.success(nextObjective ? 'Plot Objective saved.' : 'Plot Objective cleared.');
    } finally {
        button?.prop?.('disabled', false);
        inputField?.prop?.('disabled', false);
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

    if (action === 'chat-only-send') {
        const card = $(event.currentTarget).closest('.ica--companion-card');
        const inputField = card.find('[data-role="chat-only-input"]');
        await sendChatOnlyAside({
            agentId,
            messageIndex,
            transcript: result?.content ?? '',
            userInput: inputField.val(),
            button: $(event.currentTarget),
            inputField,
        });
        return;
    }

    if (action === 'plot-compass-save') {
        const card = $(event.currentTarget).closest('.ica--companion-card');
        const inputField = card.find('[data-role="plot-compass-objective"]');
        await savePlotCompassObjective({
            agentId,
            messageIndex,
            objective: inputField.val(),
            button: $(event.currentTarget),
            inputField,
        });
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
    $(document).on('click', '.ica--companion-action, .ica--companion-control-action', handleCompanionAction);
    $(document).on('input', '.ica--chatonly-input, .ica--plot-objective-input', function () {
        autoGrowCompanionTextarea(this);
    });
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
