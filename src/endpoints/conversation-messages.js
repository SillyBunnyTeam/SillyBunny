/**
 * Conversation Mode REST API - Message Management
 *
 * Functions for creating, appending, and formatting conversation messages.
 */

import { MAX_THREAD_MESSAGES } from '../../public/scripts/sillybunny-conversation/constants.js';
import {
    getConversationAttachmentLabels,
    getConversationAttachmentSummary,
    hasConversationMessageContent,
} from '../../public/scripts/sillybunny-conversation/thread-store-utils.js';
import { getObject, isObject, validateConversationAttachments } from './conversation-utils.js';
import { getActiveConversationBranch } from './conversation-threads.js';

const MAX_MESSAGE_TEXT_LENGTH = 256 * 1024;
const MAX_MESSAGE_FIELD_LENGTH = 512;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const ALLOWED_MESSAGE_ROLES = new Set(['user', 'character', 'assistant', 'partner', 'system']);

function parseConversationTimestamp(value, fallback = Date.now()) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const timestamp = Number(value);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_DATE_TIMESTAMP ? timestamp : fallback;
}

/**
 * Validate an API-supplied message before normalizing it.
 */
export function validateConversationMessageInput(input, { requiredRole = '' } = {}) {
    if (!isObject(input)) {
        return { valid: false, error: 'message_required' };
    }
    const role = input.role === undefined || input.role === '' ? (requiredRole || 'user') : input.role;
    if (typeof role !== 'string' || !ALLOWED_MESSAGE_ROLES.has(role) || (requiredRole && role !== requiredRole)) {
        return { valid: false, error: 'invalid_message_role' };
    }
    for (const field of ['id', 'name']) {
        if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > MAX_MESSAGE_FIELD_LENGTH)) {
            return { valid: false, error: `invalid_message_${field}` };
        }
    }
    const content = input.mes ?? input.text;
    if (content !== undefined && (typeof content !== 'string' || content.length > MAX_MESSAGE_TEXT_LENGTH)) {
        return { valid: false, error: 'invalid_message_content' };
    }
    if (input.created_at !== undefined) {
        const timestamp = Number(input.created_at);
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_TIMESTAMP) {
            return { valid: false, error: 'invalid_created_at' };
        }
    }
    const attachmentValidation = validateConversationAttachments(input.extra);
    if (!attachmentValidation.valid) {
        return attachmentValidation;
    }

    const message = createConversationMessage({ ...input, role });
    return hasConversationMessageContent(message)
        ? { valid: true, message }
        : { valid: false, error: 'message_required' };
}

/**
 * Strip HTML and normalize whitespace for preview text
 */
export function stripPreviewText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Get message preview text (from message or attachments)
 */
export function getConversationMessagePreviewText(message) {
    return stripPreviewText(message?.mes) || stripPreviewText(getConversationAttachmentLabels(message).join(', '));
}

/**
 * Truncate preview text to max length
 */
export function truncateConversationReplyPreview(value, maxLength = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Build a reply reference object from a message
 */
export function buildConversationMessageReplyReference(message) {
    if (!message?.id) {
        return null;
    }

    const text = truncateConversationReplyPreview(getConversationMessagePreviewText(message));
    const attachmentSummary = truncateConversationReplyPreview(getConversationAttachmentSummary(message));
    if (!text && !attachmentSummary) {
        return null;
    }

    return {
        messageId: message.id,
        name: message.name || 'Speaker',
        role: message.role || 'character',
        text,
        attachmentSummary,
        createdAt: message.created_at || Date.now(),
    };
}

/**
 * Update branch preview from the last message
 */
export function refreshBranchPreview(branch) {
    const lastMessage = branch.messages[branch.messages.length - 1];
    branch.preview = getConversationMessagePreviewText(lastMessage) || 'Conversation ready';
    branch.updatedAt = Date.now();
}

/**
 * Create a conversation message with normalized fields
 */
export function createConversationMessage(input = {}, fallback = {}) {
    const source = getObject(input);
    const createdAt = parseConversationTimestamp(source.created_at);
    const role = ALLOWED_MESSAGE_ROLES.has(source.role) ? source.role : (ALLOWED_MESSAGE_ROLES.has(fallback.role) ? fallback.role : 'user');
    return {
        id: typeof source.id === 'string' && source.id ? source.id : `${createdAt}-${Math.random().toString(36).slice(2)}`,
        role,
        name: source.name || fallback.name || 'User',
        mes: String(source.mes ?? source.text ?? fallback.mes ?? ''),
        send_date: typeof source.send_date === 'string' && source.send_date ? source.send_date : new Date(createdAt).toISOString(),
        created_at: createdAt,
        extra: getObject(source.extra),
    };
}

/**
 * Append a message to a conversation thread
 */
export function appendConversationMessage(store, avatar, messageInput, { groupId = '', personaId = '', fallback = {} } = {}) {
    const branch = getActiveConversationBranch(store, avatar, groupId, { create: true, personaId });
    if (!branch) {
        return null;
    }

    const message = createConversationMessage(messageInput, fallback);
    if (!hasConversationMessageContent(message)) {
        return null;
    }

    branch.messages.push(message);
    if (branch.messages.length > MAX_THREAD_MESSAGES) {
        branch.messages.splice(0, branch.messages.length - MAX_THREAD_MESSAGES);
    }
    if (message.role === 'user') {
        branch.lastActivity = Date.now();
        branch.followupCount = 0;
    }
    refreshBranchPreview(branch);
    return message;
}

/**
 * Extract incoming message from request body
 */
export function getIncomingMessage(body, fallbackRole = 'user') {
    const message = isObject(body.message) ? body.message : {};
    return {
        ...message,
        id: message.id ?? body.id,
        role: message.role || body.role || fallbackRole,
        name: message.name || body.name,
        mes: message.mes ?? message.text ?? body.mes ?? body.text ?? '',
        send_date: message.send_date ?? body.send_date,
        created_at: message.created_at ?? body.created_at,
        extra: message.extra !== undefined ? message.extra : (body.extra !== undefined ? body.extra : {}),
    };
}
