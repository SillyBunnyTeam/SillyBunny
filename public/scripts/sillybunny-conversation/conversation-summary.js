/**
 * What the list shows for a chat, worked out in the browser for a chat that is loaded. It must give the answer of
 * `summarizeChatRecords()` in `src/conversation-schema.js` for the same messages (a test runs both), so that a badge
 * does not change when the page loads the list from the server again.
 */

const PREVIEW_LENGTH = 160;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

function isTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function isUserLine(message) {
    return message.is_user === true || message.role === 'user';
}

function isSystemLine(message) {
    return message.is_system === true || message.role === 'system';
}

function getLineTime(message) {
    if (isTimestamp(message.created_at)) {
        return message.created_at;
    }
    const parsed = typeof message.send_date === 'string' ? Date.parse(message.send_date) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getLineRole(message) {
    if (isUserLine(message)) {
        return 'user';
    }
    if (isSystemLine(message)) {
        return 'system';
    }
    return message.role === 'member' ? 'member' : 'character';
}

function toPreview(text) {
    return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
}

/**
 * @param {object[]} messages The messages of the chat, without its header.
 * @param {string} readThrough The id of the last message that the user has seen. Empty: nothing was read. An id that
 * names no message counts no unread message.
 * @returns {{ messageCount: number, lastMessageAt: number, preview: string, unread: number, lastMessageRole: string, hasUserMessage: boolean }}
 */
export function summarizeChat(messages, readThrough) {
    const last = messages[messages.length - 1];
    let firstUnread = 0;
    if (readThrough) {
        const readIndex = messages.findIndex(message => message.id === readThrough);
        firstUnread = readIndex < 0 ? messages.length : readIndex + 1;
    }
    return {
        messageCount: messages.length,
        lastMessageAt: last ? getLineTime(last) : 0,
        preview: last ? toPreview(last.mes) : '',
        unread: messages.slice(firstUnread).filter(message => !isUserLine(message) && !isSystemLine(message)).length,
        lastMessageRole: last ? getLineRole(last) : '',
        hasUserMessage: messages.some(isUserLine),
    };
}
