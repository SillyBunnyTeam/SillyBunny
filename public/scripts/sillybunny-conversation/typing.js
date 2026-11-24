import { DEFAULT_REPLY_DELAY_MULTIPLIER, DEFAULT_SETTINGS, DEFAULT_TALKATIVENESS, STATUS_NOTICE_COOLDOWN_MS } from './constants.js';
import {
    getActiveConversationChat,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getConversationKey,
    getCurrentCharAvatar,
    parsePositiveInt,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import { isConversationActive } from './notifications.js';
import { getAvailabilityCopy } from './personas.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { clamp, getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { getConversationSessionMarker, getLastUserActivity, setConversationSessionMarker } from './settings-store.js';
import { activeTypingParticipants } from './state.js';
import { appendConversationChatMessage } from './conversation-store.js';

export function getConversationActivityContext(settings, avatar, now = new Date(), { personaId = getConversationPersonaId() } = {}) {
    const schedule = getStoredSchedule(avatar, { personaId });
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar, now, { personaId });
    }

    const status = settings?.availability || DEFAULT_SETTINGS.availability;
    const copy = getAvailabilityCopy(status);
    return { status, activity: copy.detail.replace(/\.$/, '').toLowerCase(), source: 'manual' };
}

export function getReplyDelayMs(messageText, settings, avatar, { personaId = getConversationPersonaId() } = {}) {
    const multiplier = clamp(parsePositiveInt(settings?.reply_delay_multiplier, DEFAULT_REPLY_DELAY_MULTIPLIER, 0), 0, 300) / 100;
    if (multiplier <= 0) {
        return 0;
    }

    const current = getConversationActivityContext(settings, avatar, new Date(), { personaId });
    const status = current.status || 'online';
    const baseMs = { online: 450, idle: 900, dnd: 1600, offline: 2200 }[status] ?? 450;
    const perCharMs = { online: 18, idle: 32, dnd: 52, offline: 68 }[status] ?? 18;
    const talkativeness = clamp(parsePositiveInt(settings?.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
    const talkFactor = 1.15 - (talkativeness / 200);
    const delay = (baseMs + String(messageText || '').length * perCharMs * talkFactor) * multiplier;
    return Math.min(9000, Math.max(350, Math.round(delay)));
}

export async function waitForReplyDelay(messageText, settings, avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const delay = getReplyDelayMs(messageText, settings, avatar, { personaId });
    if (delay <= 0) {
        return;
    }

    if (isConversationActive(avatar, groupId, { chatId, personaId })) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
    await new Promise(resolve => setTimeout(resolve, delay));
}

export function getTypingParticipantMap(avatar = getCurrentCharAvatar(), { chatId = '', create = false, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const anchorAvatar = avatar || getCurrentCharAvatar();
    if (!anchorAvatar) {
        return null;
    }

    const storageKey = getConversationKey(anchorAvatar, groupId || '', { personaId });
    const resolvedChatId = chatId || getConversationRecord(anchorAvatar, { groupId, personaId })?.activeChatId || '';
    const conversationKey = resolvedChatId ? `${storageKey}:${resolvedChatId}` : storageKey;
    if (!conversationKey) {
        return null;
    }

    let participantMap = activeTypingParticipants.get(conversationKey);
    if (!participantMap && create) {
        participantMap = new Map();
        activeTypingParticipants.set(conversationKey, participantMap);
    }

    return participantMap || null;
}

export function getActiveTypingParticipants(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const participantMap = getTypingParticipantMap(avatar, { chatId, groupId, personaId });
    return participantMap ? Array.from(participantMap.values()).filter(participant => participant?.avatar) : [];
}

export function getPrimaryTypingParticipant(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const participants = getActiveTypingParticipants(avatar, { chatId, groupId, personaId });
    return participants.length ? participants[participants.length - 1] : null;
}

export async function withTypingParticipant(participant, task, avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const anchorAvatar = avatar || getCurrentCharAvatar();
    const participantAvatar = participant?.avatar || anchorAvatar;
    const participantMap = getTypingParticipantMap(anchorAvatar, { chatId, create: true, groupId, personaId });
    const previousTypingParticipant = participantMap?.get(participantAvatar) || null;
    if (participantMap && participantAvatar) {
        participantMap.set(participantAvatar, participant || { avatar: participantAvatar, name: 'Character' });
    }

    const isActive = isConversationActive(anchorAvatar, groupId, { chatId, personaId });
    if (isActive) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
    try {
        return await task();
    } finally {
        if (participantMap && participantAvatar) {
            if (previousTypingParticipant) {
                participantMap.set(participantAvatar, previousTypingParticipant);
            } else {
                participantMap.delete(participantAvatar);
            }
            const storageKey = getConversationKey(anchorAvatar, groupId || '', { personaId });
            const resolvedChatId = chatId || getConversationRecord(anchorAvatar, { groupId, personaId })?.activeChatId || '';
            const conversationKey = resolvedChatId ? `${storageKey}:${resolvedChatId}` : storageKey;
            if (!participantMap.size && conversationKey) {
                activeTypingParticipants.delete(conversationKey);
            }
        }
        if (isConversationActive(anchorAvatar, groupId, { chatId, personaId })) {
            scheduleInterfaceRefresh({ syncControls: false });
        }
    }
}

export function maybePostDelayedReplyNotice(avatar, settings, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), statusAvatar = avatar } = {}) {
    const current = getConversationActivityContext(settings, statusAvatar, new Date(), { personaId });
    if (current.source === 'manual' && ['dnd', 'offline'].includes(settings?.availability)) {
        return;
    }
    if (!['dnd', 'offline'].includes(current.status)) {
        return;
    }

    const lastUserActivity = getLastUserActivity(avatar, Date.now(), { chatId, groupId, personaId });
    const markerKey = 'sb_conv_busy_reply_notice';
    const markerValue = getConversationSessionMarker(avatar, markerKey, { chatId, groupId, personaId });
    const markerTime = parsePositiveInt(markerValue.split(':')[1], 0, 0);
    if (markerTime > 0 && Date.now() - markerTime < STATUS_NOTICE_COOLDOWN_MS) {
        return;
    }

    const character = getCharacterForAvatar(statusAvatar);
    const charName = character?.name || 'This character';
    appendConversationChatMessage(avatar, {
        role: 'system',
        name: 'Status',
        mes: `${charName} is ${current.activity} right now. Replies may take a little longer.`,
        extra: { conversation_mode_notice: true, availability: current.status, member_avatar: statusAvatar },
    }, { chatId, groupId, personaId });
    setConversationSessionMarker(avatar, markerKey, `${lastUserActivity}:${Date.now()}`, { chatId, groupId, personaId });
}

export function stripPreviewText(messageText) {
    return String(messageText || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 130);
}

export function splitChatroomMessages(text) {
    const parts = String(text || '')
        .split(/\n\s*\n+/)
        .map(part => part.trim())
        .filter(Boolean);
    return parts.length ? parts : [String(text || '').trim()].filter(Boolean);
}

/** The preview of a conversation in the list: what the list shows for its active chat, which the server and the cache work out from the last message. */
export function getLastConversationPreview(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return getActiveConversationChat(avatar, { groupId, personaId })?.preview || 'Conversation ready';
}
