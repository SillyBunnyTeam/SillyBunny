import { isPinned, readPinnedAt } from './pin-model.js';
import { groupReactions, readReactions } from './reaction-model.js';

export function hashConversationRenderFingerprint(value) {
    let hash = 0;
    const input = String(value || '');
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }

    return hash.toString(36);
}

export function escapeHtmlAttribute(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlText(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compactAttachmentFingerprint(item) {
    if (!item || typeof item !== 'object') {
        return '';
    }

    return [
        item.url || '',
        item.type || '',
        item.title || '',
        item.name || '',
        item.size || '',
    ].join('\u001e');
}

function compactReplyFingerprint(reply) {
    if (!reply || typeof reply !== 'object') {
        return '';
    }

    return [
        reply.messageId || '',
        reply.name || '',
        reply.role || '',
        reply.text || '',
        reply.attachmentSummary || '',
        reply.createdAt || '',
    ].join('\u001e');
}

function compactConversationCommandsFingerprint(commands) {
    if (!commands || typeof commands !== 'object') {
        return '';
    }

    return [
        Array.isArray(commands.selfieRequests) ? commands.selfieRequests.join('\u001e') : '',
        Array.isArray(commands.scheduleUpdates) ? commands.scheduleUpdates.join('\u001e') : '',
        Array.isArray(commands.reminders) ? commands.reminders.map(item => `${item?.delay || ''}:${item?.memo || ''}`).join('\u001e') : '',
    ].join('\u001d');
}

export function getConversationMessageExtraFingerprint(message) {
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    const media = Array.isArray(extra.media) ? extra.media.map(compactAttachmentFingerprint).join('\u001d') : '';
    const files = Array.isArray(extra.files) ? extra.files.map(compactAttachmentFingerprint).join('\u001d') : '';
    const reactions = groupReactions(readReactions(message))
        .map(chip => `${chip.key}:${chip.count}:${chip.mine ? 1 : 0}:${chip.reactors.map(reactor => reactor.by).join('+')}`)
        .join(',');

    return [
        extra.member_avatar || '',
        extra.image_url || '',
        extra.image_prompt || '',
        extra.media_display || '',
        extra.media_index || '',
        compactReplyFingerprint(extra.conversation_reply_to),
        compactConversationCommandsFingerprint(extra.conversation_commands),
        isPinned(message) ? `pin:${readPinnedAt(message)}` : '',
        extra.conversation_mode_image ? 'image' : '',
        extra.conversation_mode_ooc ? 'ooc' : '',
        extra.conversation_mode_reminder ? 'reminder' : '',
        reactions,
        media,
        files,
    ].join('\u001f');
}
