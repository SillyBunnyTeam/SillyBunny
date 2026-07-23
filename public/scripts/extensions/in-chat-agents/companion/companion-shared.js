/**
 * Shared companion constants and helpers.
 *
 * This module has ZERO imports and no side effects on import: it is the single
 * source of truth for the template IDs, value sets and small helpers that
 * the companion runner, UI, panel and dashboard all need. Keeping it dependency
 * free means every consumer (and every test) can import it as the real module
 * without dragging in script.js or other heavy runtime singletons.
 */

export const CHATROOM_TEMPLATE_ID = 'tpl-chatroom-companion';
export const DIRECTORS_COMMENTARY_TEMPLATE_ID = 'tpl-directors-commentary-companion';
export const PLOT_COMPASS_TEMPLATE_ID = 'tpl-plot-compass-companion';
export const CHAT_ONLY_TEMPLATE_ID = 'tpl-chat-only-companion';
export const MESSAGE_INBOX_TEMPLATE_ID = 'tpl-message-inbox-companion';
export const MEMORY_SHARD_TEMPLATE_ID = 'tpl-memory-shard-companion';
export const EXPRESSIONS_AGENT_TEMPLATE_ID = 'tpl-expressions-agent';
export const COMPANION_RESULTS_EXTRA_KEY = 'inChatAgentCompanionResults';

const ESCAPED_MACRO_OPEN_RE = /\\\{\\\{/g;
const ESCAPED_MACRO_CLOSE_RE = /\\\}\\\}/g;
const ENTITY_OPEN_BRACE_RE = /&(?:#123|#x7b|lcub);/gi;
const ENTITY_CLOSE_BRACE_RE = /&(?:#125|#x7d|rcub);/gi;

export const CHATROOM_CUSTOM_STYLE_VALUE = 'custom';
export const CHATROOM_STYLE_VALUES = new Set([
    'mixed',
    'in-world',
    'discord/twitch',
    'twitter/x',
    'reddit',
    'ao3/wattpad',
    'newsroom',
    'thread-board/4chan',
    'infomercial',
    CHATROOM_CUSTOM_STYLE_VALUE,
]);

export const CHATROOM_REPLY_MAX_CHARS = 2000;

export const MESSAGE_INBOX_EMPTY_OUTPUTS = new Set(['phone-none', 'PHONE_NONE']);

export const CHAT_ONLY_INPUT_MAX_CHARS = 2000;
export const CHAT_ONLY_TRANSCRIPT_MAX_CHARS = 12000;
export const PLOT_COMPASS_OBJECTIVE_MAX_CHARS = 2000;

/**
 * The template an agent was created from, falling back to its own id.
 * @param {object} [agent]
 * @returns {string}
 */
export function getAgentTemplateId(agent = {}) {
    return String(agent?.sourceTemplateId ?? agent?.id ?? '').trim();
}

export function getCompanionReferenceIds(agent = {}) {
    const ids = [agent?.id, getAgentTemplateId(agent)];
    const seenIds = new Set();

    return ids
        .map(id => String(id ?? '').trim())
        .filter(id => {
            if (!id || seenIds.has(id)) return false;

            seenIds.add(id);
            return true;
        });
}

export function isMessageInboxAgent(agent = null) {
    return getAgentTemplateId(agent) === MESSAGE_INBOX_TEMPLATE_ID;
}

export function isChatroomAgent(agent = null) {
    return getAgentTemplateId(agent) === CHATROOM_TEMPLATE_ID;
}

export function isChatOnlyAgent(agent = null) {
    return getAgentTemplateId(agent) === CHAT_ONLY_TEMPLATE_ID;
}

export function isPlotCompassAgent(agent = null) {
    return getAgentTemplateId(agent) === PLOT_COMPASS_TEMPLATE_ID;
}

export function isExpressionsAgent(agent = null) {
    return getAgentTemplateId(agent) === EXPRESSIONS_AGENT_TEMPLATE_ID;
}

export function normalizeChatOnlyInput(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(0, CHAT_ONLY_INPUT_MAX_CHARS);
}

export function normalizeChatOnlyTranscript(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(-CHAT_ONLY_TRANSCRIPT_MAX_CHARS);
}

export function appendChatOnlyUserMessage(transcript = '', userInput = '') {
    const previous = normalizeChatOnlyTranscript(transcript);
    const nextLine = `You: ${normalizeChatOnlyInput(userInput)}`;
    return normalizeChatOnlyTranscript(previous ? `${previous}\n\n${nextLine}` : nextLine);
}

export function normalizePlotCompassObjective(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(0, PLOT_COMPASS_OBJECTIVE_MAX_CHARS);
}

export function normalizeChatroomReply(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n').trim().slice(0, CHATROOM_REPLY_MAX_CHARS);
}

/**
 * A message authored by the assistant (not the user, not a system note).
 * @param {object} message
 * @returns {boolean}
 */
export function isAssistantMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system);
}

/**
 * A message that can host companion results (assistant or user, but not a system note).
 * @param {object} message
 * @returns {boolean}
 */
export function isValidCompanionMessage(message) {
    return Boolean(message && !message.is_system);
}

export function normalizeCompanionMacroSyntax(content = '') {
    return String(content ?? '')
        .replace(ESCAPED_MACRO_OPEN_RE, '{{')
        .replace(ESCAPED_MACRO_CLOSE_RE, '}}')
        .replace(ENTITY_OPEN_BRACE_RE, '{')
        .replace(ENTITY_CLOSE_BRACE_RE, '}');
}

function getActiveCompanionResults(message) {
    const swipeInfo = !message?.is_user
        && typeof message?.swipe_id === 'number'
        && Array.isArray(message?.swipe_info)
        ? message.swipe_info[message.swipe_id]
        : null;
    const stored = swipeInfo?.extra
        ? swipeInfo.extra[COMPANION_RESULTS_EXTRA_KEY]
        : message?.extra?.[COMPANION_RESULTS_EXTRA_KEY];

    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function isRetainedCompanionResult(result) {
    return Boolean(
        result
        && result.status === 'done'
        && result.includeInChatHistory === true
        && String(result.content ?? '').trim(),
    );
}

/**
 * Whether a hidden host has retained Companion output configured to remain in context.
 * @param {object} message
 * @returns {boolean}
 */
export function hasCompanionChatHistoryForHiddenHost(message) {
    if (!message?.is_system || message?.is_user) {
        return false;
    }

    return Object.values(getActiveCompanionResults(message))
        .some(result => isRetainedCompanionResult(result) && result.keepInChatHistoryWhenHostHidden === true);
}

/**
 * Selects the latest retained results for each Companion across the supplied candidate messages.
 * @param {object[]} messages
 * @param {{ policyMessages?: object[] }} options
 * @returns {Map<object, Set<string>>}
 */
export function selectCompanionChatHistory(messages = [], { policyMessages = messages } = {}) {
    const policyByAgent = new Map();

    for (const message of policyMessages) {
        if (!message || message.is_user) continue;

        for (const [agentId, result] of Object.entries(getActiveCompanionResults(message))) {
            if (isRetainedCompanionResult(result)) {
                policyByAgent.set(agentId, result);
            }
        }
    }

    const candidatesByAgent = new Map();

    for (const message of messages) {
        if (!message || message.is_user) continue;

        for (const [agentId, result] of Object.entries(getActiveCompanionResults(message))) {
            if (!isRetainedCompanionResult(result)) continue;

            if (!message.is_system || result.keepInChatHistoryWhenHostHidden === true) {
                const candidates = candidatesByAgent.get(agentId) ?? [];
                candidates.push({ message, result });
                candidatesByAgent.set(agentId, candidates);
            }
        }
    }

    const selections = new Map();
    for (const [agentId, candidates] of candidatesByAgent) {
        const policy = policyByAgent.get(agentId) ?? candidates.at(-1)?.result ?? {};
        const depth = Math.max(1, Math.min(50, Math.floor(Number(policy.chatHistoryDepth) || 1)));
        const selected = policy.includeAllChatHistory === false
            ? candidates.slice(-depth)
            : candidates;

        for (const { message } of selected) {
            const agentIds = selections.get(message) ?? new Set();
            agentIds.add(agentId);
            selections.set(message, agentIds);
        }
    }

    return selections;
}

/**
 * Builds the prompt-only assistant message containing retained companion results.
 * @param {object} message
 * @param {(content: string) => string} resolveMacros
 * @param {{ agentIds?: Set<string>|null, includeOriginal?: boolean }} options
 * @returns {string}
 */
export function projectCompanionChatHistory(message, resolveMacros = content => content, { agentIds = null, includeOriginal = true } = {}) {
    const originalMessage = String(message?.mes ?? '');
    if (!message || message.is_user || (message.is_system && !(agentIds instanceof Set))) {
        return originalMessage;
    }

    const retainedContent = Object.entries(getActiveCompanionResults(message))
        .filter(([agentId, result]) => isRetainedCompanionResult(result) && (!(agentIds instanceof Set) || agentIds.has(agentId)))
        .map(([, result]) => result)
        .map(result => normalizeCompanionMacroSyntax(result.content ?? ''))
        .map(content => String(resolveMacros(content) ?? '').trim())
        .filter(Boolean);

    if (retainedContent.length === 0) {
        return includeOriginal ? originalMessage : '';
    }

    return [includeOriginal ? originalMessage : '', ...retainedContent].filter(Boolean).join('\n\n');
}
