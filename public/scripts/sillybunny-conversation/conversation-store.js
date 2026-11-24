import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { DEFAULT_CHAT_ID, MAX_CONVERSATION_MESSAGES, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    getActiveConversationChat,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationStore,
    getConversationRecord,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
    persistConversationStore,
} from './context.js';
import { isConversationActive } from './notifications.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { getConversationSessionMarker, resetFollowupCount, setConversationSessionMarker, setLastUserActivity } from './settings-store.js';
import { stripPreviewText } from './typing.js';
import { getConversationAttachmentLabels, getConversationAttachmentSummary, safeParseMessages } from './conversation-store-utils.js';
import { narrateConversationMessage } from './tts.js';

export {
    getConversationAttachmentLabels,
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationMediaDisplay,
    getConversationMediaIndex,
    getConversationPromptMediaAttachments,
    hasConversationMessageContent,
    normalizeConversationStoredMessage,
    resolveConversationReminderChatId,
    safeParseMessages,
} from './conversation-store-utils.js';
import { truncateConversationReplyPreview } from './preview-utils.js';

export function markConversationSeen(avatar = getCurrentCharAvatar(), timestamp = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    setConversationSessionMarker(avatar, 'seen_at', timestamp, { chatId, groupId, personaId });
}

export function getConversationSeenAt(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, 'seen_at', { chatId, groupId, personaId }), 0, 0);
}

export function getImageCooldownRemainingSeconds(avatar, settings, now = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const cooldownMinutes = parsePositiveInt(settings.image_gen_cooldown, 10, 0);
    if (!cooldownMinutes) {
        return 0;
    }

    const lastImageAt = parsePositiveInt(getConversationSessionMarker(avatar, 'image_at', { chatId, groupId, personaId }), 0, 0);
    const remainingMs = (cooldownMinutes * 60 * 1000) - (now - lastImageAt);
    return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function markImageGenerated(avatar, timestamp = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    setConversationSessionMarker(avatar, 'image_at', timestamp, { chatId, groupId, personaId });
}

export function parseReminderDelayToMs(rawDelay) {
    const delay = String(rawDelay || '').trim().toLowerCase();
    if (!delay) {
        return 0;
    }

    const match = delay.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|secs?|mins?|hours?|days?)$/);
    if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        if (unit.startsWith('s')) return value * 1000;
        if (unit.startsWith('m')) return value * 60 * 1000;
        if (unit.startsWith('h')) return value * 60 * 60 * 1000;
        if (unit.startsWith('d')) return value * 24 * 60 * 60 * 1000;
    }

    const numeric = parseFloat(delay);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric * 60 * 1000;
    }

    const timeMatch = delay.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const now = new Date();
        const target = new Date();
        target.setHours(hours, minutes, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
        return target.getTime() - now.getTime();
    }

    return 0;
}

export function addConversationReminder(avatar, groupId, delayText, memoText, { chatId = '', personaId = getConversationPersonaId() } = {}) {
    const delayMs = parseReminderDelayToMs(delayText);
    if (delayMs <= 0) {
        console.warn(`Conversation Mode: invalid reminder delay "${delayText}"`);
        return null;
    }

    const triggerAt = Date.now() + delayMs;
    const store = getConversationStore();
    const characterStore = getConversationRecord(avatar, { groupId, personaId });
    const resolvedChatId = chatId || characterStore?.activeBranchId || DEFAULT_CHAT_ID;

    const reminder = {
        id: `rem_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        avatar,
        groupId: groupId || '',
        personaId,
        branchId: resolvedChatId,
        triggerAt,
        text: String(memoText || '').trim(),
        fired: false,
        createdAt: Date.now(),
    };

    store.reminders.push(reminder);
    persistConversationStore();

    const triggerLabel = new Date(triggerAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    toastr.info(`Reminder scheduled: "${reminder.text}" at ${triggerLabel}`, '', SAFE_TOAST_OPTIONS);
    return reminder;
}

export function updateLastUserActivity(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    setLastUserActivity(avatar, Date.now(), { chatId, groupId, personaId });
    // Marinara-style: any user activity resets the escalating follow-up counter.
    resetFollowupCount(avatar, { chatId, groupId, personaId });
}

export function createConversationMessage({ role = 'character', name = getCurrentCharName(), mes = '', extra = {} } = {}) {
    const createdAt = Date.now();
    return {
        id: `${createdAt}-${Math.random().toString(36).slice(2)}`,
        role,
        name,
        mes,
        send_date: getMessageTimeStamp(),
        created_at: createdAt,
        extra,
    };
}

export function getConversationMessagePreviewText(message) {
    return stripPreviewText(message?.mes) || stripPreviewText(getConversationAttachmentLabels(message).join(', '));
}

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
 * Returns the active branch message array by reference. Copy it before speculative mutation.
 */
export function getConversationMessages(avatar = getCurrentCharAvatar(), { chatId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return [];
    }

    return getActiveConversationChat(avatar, { chatId, create, groupId, personaId })?.messages ?? [];
}

export function getConversationMessageCount(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId })?.messages?.length || 0;
}

export function saveConversationMessages(avatar, messages, { chatId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const chat = getActiveConversationChat(avatar, { chatId, create, groupId, personaId });
    if (!chat) {
        return;
    }

    chat.messages = safeParseMessages(messages).slice(-MAX_CONVERSATION_MESSAGES);
    chat.updatedAt = Date.now();
    persistConversationStore();
}

export function appendConversationChatMessage(avatar, messageInput, { chatId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const chat = getActiveConversationChat(avatar, { chatId, create, groupId, personaId });
    if (!chat) {
        return null;
    }

    const message = createConversationMessage(messageInput);
    chat.messages.push(message);
    if (chat.messages.length > MAX_CONVERSATION_MESSAGES) {
        chat.messages.splice(0, chat.messages.length - MAX_CONVERSATION_MESSAGES);
    }
    const preview = getConversationMessagePreviewText(message);
    if (preview) {
        chat.preview = preview;
    }
    chat.updatedAt = Date.now();
    persistConversationStore();
    const isStillVisible = () => isConversationActive(avatar, groupId, { chatId: chat.id, personaId });
    if (isStillVisible()) {
        scheduleTimelineRender();
        // TTS readiness can await provider/network work; the capability rechecks
        // this exact thread identity immediately before enqueueing audio.
        void narrateConversationMessage(message, { isStillVisible });
    }
    return message;
}

export function updateConversationChatMessage(avatar, messageId, messageText, extra = null, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const messages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
    const message = messages.find(item => item.id === messageId);
    if (!message) {
        return;
    }

    message.mes = messageText;
    if (extra && typeof extra === 'object') {
        message.extra = { ...message.extra, ...extra };
    }
    saveConversationMessages(avatar, messages, { chatId, create: false, groupId, personaId });
    const chat = getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId });
    if (chat) {
        chat.preview = getConversationMessagePreviewText(messages[messages.length - 1]) || 'Conversation ready';
    }
    if (isConversationActive(avatar, groupId, { chatId, personaId })) {
        scheduleTimelineRender();
    }
}
