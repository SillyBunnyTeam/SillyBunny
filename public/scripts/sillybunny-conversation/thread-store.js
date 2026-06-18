import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { DEFAULT_BRANCH_ID, MAX_THREAD_MESSAGES, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
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
import { setLastConversationPreview, stripPreviewText, updateLastPreviewFromConversation } from './typing.js';
import { getConversationAttachmentLabels, safeParseThread } from './thread-store-utils.js';

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
    safeParseThread,
} from './thread-store-utils.js';

export function markConversationSeen(avatar = getCurrentCharAvatar(), timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setConversationSessionMarker(avatar, 'seen_at', timestamp, { groupId });
}

export function getConversationSeenAt(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, 'seen_at', { groupId }), 0, 0);
}

export function getImageCooldownRemainingSeconds(avatar, settings, now = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const cooldownMinutes = parsePositiveInt(settings.image_gen_cooldown, 10, 0);
    if (!cooldownMinutes) {
        return 0;
    }

    const lastImageAt = parsePositiveInt(getConversationSessionMarker(avatar, 'image_at', { groupId }), 0, 0);
    const remainingMs = (cooldownMinutes * 60 * 1000) - (now - lastImageAt);
    return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function markImageGenerated(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    setConversationSessionMarker(avatar, 'image_at', timestamp, { groupId });
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

export function addConversationReminder(avatar, groupId, delayText, memoText) {
    const delayMs = parseReminderDelayToMs(delayText);
    if (delayMs <= 0) {
        console.warn(`Conversation Mode: invalid reminder delay "${delayText}"`);
        return null;
    }

    const triggerAt = Date.now() + delayMs;
    const store = getConversationStore();
    const characterStore = getConversationThreadStore(avatar, { groupId });
    const branchId = characterStore?.activeBranchId || DEFAULT_BRANCH_ID;

    const reminder = {
        id: `rem_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        avatar,
        groupId: groupId || '',
        branchId,
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

export function updateLastUserActivity(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setLastUserActivity(avatar, Date.now(), { groupId });
    // Marinara-style: any user activity resets the escalating follow-up counter.
    resetFollowupCount(avatar, { groupId });
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

export function getConversationThread(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return [];
    }

    return [...(getActiveConversationBranch(avatar, { groupId })?.messages ?? [])];
}

export function saveConversationThread(avatar, messages, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!branch) {
        return;
    }

    branch.messages = safeParseThread(messages).slice(-MAX_THREAD_MESSAGES);
    branch.updatedAt = Date.now();
    persistConversationStore();
}

export function appendConversationThreadMessage(avatar, messageInput, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const messages = getConversationThread(avatar, { groupId });
    const message = createConversationMessage(messageInput);
    messages.push(message);
    saveConversationThread(avatar, messages, { groupId });
    setLastConversationPreview(avatar, getConversationMessagePreviewText(message), { groupId });
    if (isConversationActiveThread(avatar, groupId)) {
        scheduleTimelineRender();
    }
    return message;
}

export function updateConversationThreadMessage(avatar, messageId, messageText, extra = null, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const messages = getConversationThread(avatar, { groupId });
    const message = messages.find(item => item.id === messageId);
    if (!message) {
        return;
    }

    message.mes = messageText;
    if (extra && typeof extra === 'object') {
        message.extra = { ...message.extra, ...extra };
    }
    saveConversationThread(avatar, messages, { groupId });
    updateLastPreviewFromConversation(avatar, { groupId });
    if (isConversationActiveThread(avatar, groupId)) {
        scheduleTimelineRender();
    }
}
