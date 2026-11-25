import { isPendingServerReply } from './pending-reply.js';
import { conversationState } from './state.js';
import { getConversationAttachmentLabels, getConversationAttachmentSummary } from './conversation-store.js';

export function getConversationTimelineMessages(messages, { channel = conversationState.conversationTimelineChannel, query = conversationState.conversationTimelineSearchQuery } = {}) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return (Array.isArray(messages) ? messages : []).filter((message) => {
        // A reply that the server wrote waits as one message with the raw text until the finalizer turns it into bubbles.
        if (!message || isPendingServerReply(message)) {
            return false;
        }

        if (channel === 'pinned') {
            if (!message.extra?.conversation_pinned) {
                return false;
            }
        } else if (channel === 'selfies') {
            if (!message.extra?.conversation_mode_image) {
                return false;
            }
        } else if (channel === 'media') {
            if (!getConversationAttachmentLabels(message).length) {
                return false;
            }
        } else if (channel === 'ooc') {
            if (!message.extra?.conversation_mode_ooc) {
                return false;
            }
        } else if (channel === 'memories') {
            const isMemoryMessage = Boolean(
                message.extra?.conversation_pinned
                || message.extra?.conversation_mode_reminder
                || message.extra?.conversation_mode_image,
            );
            if (!isMemoryMessage) {
                return false;
            }
        }

        if (normalizedQuery) {
            const replyReference = message.extra?.conversation_reply_to;
            const haystack = [
                message.name,
                message.role,
                message.mes,
                getConversationAttachmentSummary(message),
                replyReference?.name,
                replyReference?.text,
                replyReference?.attachmentSummary,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(normalizedQuery)) {
                return false;
            }
        }

        return true;
    });
}
