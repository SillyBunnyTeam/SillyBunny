import { isPendingServerReply } from './pending-reply.js';
import { conversationState } from './state.js';
import { getConversationAttachmentSummary } from './conversation-store.js';

export function getConversationTimelineMessages(messages, { query = conversationState.conversationTimelineSearchQuery } = {}) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return (Array.isArray(messages) ? messages : []).filter((message) => {
        // A reply that the server wrote waits as one message with the raw text until the finalizer turns it into bubbles.
        if (!message || isPendingServerReply(message)) {
            return false;
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
