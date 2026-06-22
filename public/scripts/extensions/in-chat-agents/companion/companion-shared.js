/**
 * Shared companion constants and pure helpers.
 *
 * This module has ZERO imports and no side effects on purpose: it is the single
 * source of truth for the template IDs, value sets and small normalizers that
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
