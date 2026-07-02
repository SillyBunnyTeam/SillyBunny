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
import { getObject, parsePositiveInt, isObject } from './conversation-utils.js';
import { getActiveConversationBranch } from './conversation-threads.js';

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
    const createdAt = parsePositiveInt(source.created_at, Date.now(), 0);
    return {
        id: source.id || `${createdAt}-${Math.random().toString(36).slice(2)}`,
        role: source.role || fallback.role || 'user',
        name: source.name || fallback.name || 'User',
        mes: String(source.mes ?? source.text ?? fallback.mes ?? ''),
        send_date: source.send_date || new Date(createdAt).toISOString(),
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
        role: message.role || body.role || fallbackRole,
        name: message.name || body.name,
        mes: message.mes ?? message.text ?? body.mes ?? body.text ?? '',
        extra: getObject(message.extra || body.extra),
    };
}
