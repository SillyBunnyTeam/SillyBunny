import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { SAFE_TOAST_OPTIONS } from './constants.js';
import {
    getActiveConversationChat,
    getConversationAddress,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { isConversationActive } from './notifications.js';
import { isPendingServerReply } from './pending-reply.js';
import { readReactions, writeReactions } from './reaction-model.js';
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

// Matches MAX_TIMESTAMP in src/conversation-schema.js so client-created reminders stay within the server's accepted range.
const MAX_REMINDER_TIMESTAMP = 8_640_000_000_000_000;

export function parseReminderDelayToMs(rawDelay) {
    const delay = String(rawDelay || '').trim().toLowerCase();
    if (!delay) {
        return 0;
    }

    const match = delay.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|secs?|mins?|hours?|days?)$/);
    if (match) {
        const value = Number(match[1]);
        const unit = match[2];
        let multiplier = 0;
        if (unit.startsWith('s')) multiplier = 1000;
        else if (unit.startsWith('m')) multiplier = 60 * 1000;
        else if (unit.startsWith('h')) multiplier = 60 * 60 * 1000;
        else if (unit.startsWith('d')) multiplier = 24 * 60 * 60 * 1000;
        const ms = value * multiplier;
        return Number.isFinite(ms) && ms > 0 ? ms : 0;
    }

    const timeMatch = delay.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
        const hours = Number.parseInt(timeMatch[1], 10);
        const minutes = Number.parseInt(timeMatch[2], 10);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            return 0;
        }
        const now = new Date();
        const target = new Date(now.getTime());
        target.setHours(hours, minutes, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
        return target.getTime() - now.getTime();
    }

    if (/^\d+(?:\.\d+)?$/.test(delay)) {
        const numeric = Number(delay);
        const ms = numeric * 60 * 1000;
        return Number.isFinite(ms) && ms > 0 ? ms : 0;
    }

    return 0;
}

/**
 * @param {object} [options]
 * @param {string} [options.id] An id that the caller derives, so that the reminder of a reply that two pages land is added once. Without it a new id is made.
 */
export function addConversationReminder(avatar, groupId, delayText, memoText, { chatId = '', personaId = getConversationPersonaId(), id = '' } = {}) {
    const delayMs = parseReminderDelayToMs(delayText);
    if (delayMs <= 0) {
        console.warn(`Conversation Mode: invalid reminder delay "${delayText}"`);
        return null;
    }

    const now = Date.now();
    const triggerAt = Math.round(now + delayMs);
    if (!Number.isSafeInteger(triggerAt) || triggerAt < 0 || triggerAt > MAX_REMINDER_TIMESTAMP) {
        console.warn(`Conversation Mode: out-of-range reminder delay "${delayText}"`);
        return null;
    }

    const address = getConversationAddress(avatar, { groupId, personaId, chatId });
    const view = address ? conversationData.get(address.conversationId) : null;
    if (!view) {
        return null;
    }

    if (id && view.reminders.some(item => item.id === id)) {
        return null;
    }

    const reminder = {
        id: id || `rem_${now}_${Math.random().toString(36).slice(2)}`,
        avatar,
        chatId: address.chatId,
        triggerAt,
        text: String(memoText || '').trim().slice(0, 4000),
        fired: false,
        createdAt: now,
    };

    conversationData.patchConversation(view.id, { reminders: [...view.reminders, reminder] });

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

export function createConversationMessage({ role = 'character', name = getCurrentCharName(), mes = '', extra = {}, id = '' } = {}) {
    const createdAt = Date.now();
    return {
        id: id || `${createdAt}-${Math.random().toString(36).slice(2)}`,
        role,
        name,
        is_user: role === 'user',
        is_system: role === 'system',
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
 * Returns the messages of the chat by reference when it is loaded, and an empty list that cannot be changed when it is
 * not: nothing can be written to a chat that is not loaded. Copy it before speculative mutation.
 */
export function getConversationMessages(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return [];
    }

    return getActiveConversationChat(avatar, { chatId, groupId, personaId })?.messages ?? [];
}

export function getConversationMessageCount(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return getActiveConversationChat(avatar, { chatId, groupId, personaId })?.messageCount || 0;
}

/**
 * Turns the replies that the server wrote into the chat into bubbles. The finalizer is loaded only when the chat holds
 * one. A failure leaves the message pending, hidden from the timeline and the prompt, and the next load tries again, so
 * the caller's own work does not fail for it.
 */
async function landPendingReplies(address, chat) {
    if (!chat?.messages?.some(isPendingServerReply)) {
        return;
    }
    try {
        const { finalizePendingReplies } = await import('./reply-finalizer-browser.js');
        await finalizePendingReplies(address);
    } catch (error) {
        console.warn('Conversation Mode: a reply that the server wrote could not be landed', error);
    }
}

/**
 * Loads the chat that an avatar and a group name, so that it can be read and written. A reply that the server wrote
 * into the chat while no page was open is turned into bubbles first, so that a prompt or a new message never meets it
 * as one raw message.
 * @returns {Promise<{ conversationId: string, chatId: string }|null>} The address of the chat, or null when there is none.
 */
export async function ensureConversationChatLoaded(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = avatar ? getConversationAddress(avatar, { chatId, groupId, personaId }) : null;
    if (!address) {
        return null;
    }
    const loaded = await conversationData.loadChat(address);
    if (!loaded) {
        return null;
    }
    await landPendingReplies(address, loaded);
    return address;
}

/**
 * Reads a loaded chat from the server again, for a reply that the server wrote while this page waited for it (the
 * claim answered `committed`), and lands that reply as bubbles.
 * @returns {Promise<{ conversationId: string, chatId: string }|null>} The address, or null when the chat does not exist or could not be read.
 */
export async function reloadConversationChat(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = avatar ? getConversationAddress(avatar, { chatId, groupId, personaId }) : null;
    if (!address) {
        return null;
    }
    try {
        await landPendingReplies(address, await conversationData.reloadChat(address));
    } catch (error) {
        console.warn('Conversation Mode: the chat could not be read again after the server wrote a reply into it', error);
        return null;
    }
    return address;
}

function withRoleFlags(message) {
    return {
        ...message,
        is_user: message.is_user ?? message.role === 'user',
        is_system: message.is_system ?? message.role === 'system',
    };
}

/**
 * Replaces the messages of a loaded chat. `shrink` says that messages are deleted on purpose, so that the guard of the
 * server against a save that empties a chat by mistake does not refuse the save. It defaults to whether the list is
 * shorter than the chat is now, which a caller that changed the chat's own array before the call has to say itself.
 */
export function saveConversationMessages(avatar, messages, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), shrink = undefined } = {}) {
    const address = avatar ? getConversationAddress(avatar, { chatId, groupId, personaId }) : null;
    if (!address) {
        return;
    }

    const next = safeParseMessages(messages).map(withRoleFlags);
    conversationData.commitChat(address, (draft) => {
        draft.messages.splice(0, draft.messages.length, ...next);
    }, { shrink: shrink ?? next.length < (conversationData.chat(address)?.messages.length ?? 0) });
}

/** Adds a message to a loaded chat. Load the chat first with `ensureConversationChatLoaded` when it may not be. */
export function appendConversationChatMessage(avatar, messageInput, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (!address) {
        return null;
    }

    // A message with an id of its own, such as the picture of a reply that two pages land, is added once.
    if (messageInput.id && conversationData.chat(address)?.messages.some(item => item.id === messageInput.id)) {
        return null;
    }
    const message = createConversationMessage(messageInput);
    conversationData.commitChat(address, (draft) => {
        draft.messages.push(message);
    });
    const isStillVisible = () => isConversationActive(avatar, groupId, { chatId: address.chatId, personaId });
    if (isStillVisible()) {
        scheduleTimelineRender();
        // TTS readiness can await provider/network work; the capability rechecks
        // this exact thread identity immediately before enqueueing audio.
        void narrateConversationMessage(message, { isStillVisible });
    }
    return message;
}

/**
 * Changes the reactions of a message of a loaded chat. The chat is written only when `change` answers other entries than
 * it was given, so that a reaction that is refused or already there costs no save.
 * @param {(entries: import('./reaction-model.js').ReactionEntry[]) => import('./reaction-model.js').ReactionEntry[]} change
 * Answers the entries that it was given when nothing is to change.
 * @returns {boolean} Whether the reactions changed.
 */
export function updateConversationChatMessageReactions(avatar, messageId, change, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    const message = address ? conversationData.chat(address)?.messages.find(item => item.id === messageId) : null;
    if (!address || !message) {
        return false;
    }

    const current = readReactions(message);
    const next = change(current);
    if (next === current) {
        return false;
    }
    conversationData.commitChat(address, (draft) => {
        const target = draft.messages.find(item => item.id === messageId);
        if (target) {
            writeReactions(target, next);
        }
    });
    if (isConversationActive(avatar, groupId, { chatId: address.chatId, personaId })) {
        scheduleTimelineRender();
    }
    return true;
}

export function updateConversationChatMessage(avatar, messageId, messageText, extra = null, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (!address || !conversationData.chat(address)) {
        return;
    }

    conversationData.commitChat(address, (draft) => {
        const message = draft.messages.find(item => item.id === messageId);
        if (!message) {
            return;
        }
        message.mes = messageText;
        if (extra && typeof extra === 'object') {
            message.extra = { ...message.extra, ...extra };
        }
    });
    if (isConversationActive(avatar, groupId, { chatId, personaId })) {
        scheduleTimelineRender();
    }
}
