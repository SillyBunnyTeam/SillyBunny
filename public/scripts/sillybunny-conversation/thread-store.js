import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { DEFAULT_BRANCH_ID, MAX_THREAD_MESSAGES, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationStore,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
    persistConversationStore,
} from './context.js';
import { isConversationActiveThread } from './notifications.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { getConversationSessionMarker, resetFollowupCount, setConversationSessionMarker, setLastUserActivity } from './settings-store.js';
import { stripPreviewText } from './typing.js';
import { getConversationAttachmentLabels, getConversationAttachmentSummary, safeParseThread } from './thread-store-utils.js';
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
    resolveConversationReminderBranchId,
    safeParseThread,
} from './thread-store-utils.js';

export function markConversationSeen(avatar = getCurrentCharAvatar(), timestamp = Date.now(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    setConversationSessionMarker(avatar, 'seen_at', timestamp, { branchId, groupId, personaId });
}

export function getConversationSeenAt(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, 'seen_at', { branchId, groupId, personaId }), 0, 0);
}

export function getImageCooldownRemainingSeconds(avatar, settings, now = Date.now(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const cooldownMinutes = parsePositiveInt(settings.image_gen_cooldown, 10, 0);
    if (!cooldownMinutes) {
        return 0;
    }

    const lastImageAt = parsePositiveInt(getConversationSessionMarker(avatar, 'image_at', { branchId, groupId, personaId }), 0, 0);
    const remainingMs = (cooldownMinutes * 60 * 1000) - (now - lastImageAt);
    return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function markImageGenerated(avatar, timestamp = Date.now(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    setConversationSessionMarker(avatar, 'image_at', timestamp, { branchId, groupId, personaId });
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

export function addConversationReminder(avatar, groupId, delayText, memoText, { branchId = '', personaId = getConversationPersonaId() } = {}) {
    const delayMs = parseReminderDelayToMs(delayText);
    if (delayMs <= 0) {
        console.warn(`Conversation Mode: invalid reminder delay "${delayText}"`);
        return null;
    }

    const triggerAt = Date.now() + delayMs;
    const store = getConversationStore();
    const characterStore = getConversationThreadStore(avatar, { groupId, personaId });
    const resolvedBranchId = branchId || characterStore?.activeBranchId || DEFAULT_BRANCH_ID;

    const reminder = {
        id: `rem_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        avatar,
        groupId: groupId || '',
        personaId,
        branchId: resolvedBranchId,
        triggerAt,
        text: String(memoText || '').trim(),
        fired: false,
        createdAt: Date.now(),
    };

    store.reminders.push(reminder);
    persistConversationStore();

    const triggerLabel = new Date(triggerAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    toastr.info(`Reminder scheduled: "${reminder.text}" at ${triggerLabel}.`, '', SAFE_TOAST_OPTIONS);
    console.log('Conversation Mode: added reminder', reminder);
    return reminder;
}

export function updateLastUserActivity(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    setLastUserActivity(avatar, Date.now(), { branchId, groupId, personaId });
    // Marinara-style: any user activity resets the escalating follow-up counter.
    resetFollowupCount(avatar, { branchId, groupId, personaId });
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

function truncateConversationReplyPreview(value, maxLength = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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
export function getConversationThread(avatar = getCurrentCharAvatar(), { branchId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return [];
    }

    return getActiveConversationBranch(avatar, { branchId, create, groupId, personaId })?.messages ?? [];
}

export function getConversationThreadCount(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId })?.messages?.length || 0;
}

export function saveConversationThread(avatar, messages, { branchId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const branch = getActiveConversationBranch(avatar, { branchId, create, groupId, personaId });
    if (!branch) {
        return;
    }

    branch.messages = safeParseThread(messages).slice(-MAX_THREAD_MESSAGES);
    branch.updatedAt = Date.now();
    persistConversationStore();
}

export function appendConversationThreadMessage(avatar, messageInput, { branchId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const branch = getActiveConversationBranch(avatar, { branchId, create, groupId, personaId });
    if (!branch) {
        return null;
    }

    const message = createConversationMessage(messageInput);
    branch.messages.push(message);
    if (branch.messages.length > MAX_THREAD_MESSAGES) {
        branch.messages.splice(0, branch.messages.length - MAX_THREAD_MESSAGES);
    }
    const preview = getConversationMessagePreviewText(message);
    if (preview) {
        branch.preview = preview;
    }
    branch.updatedAt = Date.now();
    persistConversationStore();
    const isStillVisible = () => isConversationActiveThread(avatar, groupId, { branchId: branch.id, personaId });
    if (isStillVisible()) {
        scheduleTimelineRender();
        // TTS readiness can await provider/network work; the capability rechecks
        // this exact thread identity immediately before enqueueing audio.
        void narrateConversationMessage(message, { isStillVisible });
    }
    return message;
}

export function updateConversationThreadMessage(avatar, messageId, messageText, extra = null, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const messages = getConversationThread(avatar, { branchId, create: false, groupId, personaId });
    const message = messages.find(item => item.id === messageId);
    if (!message) {
        return;
    }

    message.mes = messageText;
    if (extra && typeof extra === 'object') {
        message.extra = { ...message.extra, ...extra };
    }
    saveConversationThread(avatar, messages, { branchId, create: false, groupId, personaId });
    const branch = getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId });
    if (branch) {
        branch.preview = getConversationMessagePreviewText(messages[messages.length - 1]) || 'Conversation ready';
    }
    if (isConversationActiveThread(avatar, groupId, { branchId, personaId })) {
        scheduleTimelineRender();
    }
}
