import { MEDIA_DISPLAY, MEDIA_TYPE } from '../constants.js';
import { clamp, parsePositiveIntValue } from './schedule-utils.js';

export function getConversationMediaAttachments(message) {
    return Array.isArray(message?.extra?.media) ? message.extra.media.filter(item => item?.url) : [];
}

export function getConversationPromptMediaAttachments(message) {
    const media = getConversationMediaAttachments(message)
        .filter(item => String(item?.type || MEDIA_TYPE.IMAGE) === MEDIA_TYPE.IMAGE);
    const generatedImage = message?.extra?.image_url;
    if (typeof generatedImage === 'string' && generatedImage) {
        media.push({ url: generatedImage, type: MEDIA_TYPE.IMAGE, title: 'Generated image' });
    }

    return media;
}

export function getConversationMediaDisplay(message) {
    const value = message?.extra?.media_display;
    return Object.values(MEDIA_DISPLAY).includes(value) ? value : MEDIA_DISPLAY.LIST;
}

export function getConversationMediaIndex(message, media) {
    if (!Array.isArray(media) || !media.length) {
        return 0;
    }

    return clamp(parsePositiveIntValue(message?.extra?.media_index, 0, 0), 0, media.length - 1);
}

export function getConversationFileAttachments(message) {
    return Array.isArray(message?.extra?.files) ? message.extra.files.filter(item => item?.url) : [];
}

export function hasConversationMessageContent(message) {
    return Boolean(
        message?.id
        && (
            String(message.mes || '').trim()
            || getConversationMediaAttachments(message).length
            || getConversationFileAttachments(message).length
            || message.extra?.image_url
        ),
    );
}

export function resolveConversationReminderBranchId(reminder, threadStore) {
    const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
    const branchId = String(reminder?.branchId || threadStore?.activeBranchId || '').trim();
    return branchId && branches[branchId] ? branchId : '';
}

export function normalizeConversationStoredMessage(message, index = 0, now = Date.now()) {
    if (!message || typeof message !== 'object') {
        return message;
    }

    if (message.id) {
        return message;
    }

    const createdAt = parsePositiveIntValue(message.created_at || message.send_date || now, now, 0);
    return {
        ...message,
        id: `legacy-${createdAt}-${index}`,
        created_at: message.created_at || createdAt,
    };
}

export function getConversationAttachmentLabels(message) {
    const labels = [];
    const generatedImage = message?.extra?.image_url;
    if (typeof generatedImage === 'string' && generatedImage) {
        labels.push('generated image');
    }

    for (const media of getConversationMediaAttachments(message)) {
        const title = String(media.title || '').trim();
        const type = String(media.type || 'media').trim() || 'media';
        labels.push(title ? `${type}: ${title}` : type);
    }

    for (const file of getConversationFileAttachments(message)) {
        const name = String(file.name || '').trim();
        labels.push(name ? `file: ${name}` : 'file');
    }

    return labels;
}

export function getConversationAttachmentSummary(message) {
    const labels = getConversationAttachmentLabels(message);
    return labels.length ? `[Attachments: ${labels.join('; ')}]` : '';
}

export function safeParseThread(stored) {
    if (!stored) {
        return [];
    }

    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        return Array.isArray(parsed)
            ? parsed.map(normalizeConversationStoredMessage).filter(hasConversationMessageContent)
            : [];
    } catch {
        return [];
    }
}
