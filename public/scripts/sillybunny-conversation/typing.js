import { DEFAULT_REPLY_DELAY_MULTIPLIER, DEFAULT_SETTINGS, DEFAULT_TALKATIVENESS, STATUS_NOTICE_COOLDOWN_MS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    parsePositiveInt,
    persistConversationStore,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import { isConversationActiveThread, updateConversationNotificationIndicators } from './notifications.js';
import { getAvailabilityCopy } from './personas.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { clamp, getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { getConversationSessionMarker, getLastUserActivity, setConversationSessionMarker } from './settings-store.js';
import { activeTypingParticipants } from './state.js';
import { appendConversationThreadMessage, getConversationMessagePreviewText, getConversationThread, hasConversationMessageContent } from './thread-store.js';

export function getConversationActivityContext(settings, avatar, now = new Date()) {
    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar, now);
    }

    const status = settings?.availability || DEFAULT_SETTINGS.availability;
    const copy = getAvailabilityCopy(status);
    return { status, activity: copy.detail.replace(/\.$/, '').toLowerCase(), source: 'manual' };
}

export function getReplyDelayMs(messageText, settings, avatar) {
    const multiplier = clamp(parsePositiveInt(settings?.reply_delay_multiplier, DEFAULT_REPLY_DELAY_MULTIPLIER, 0), 0, 300) / 100;
    if (multiplier <= 0) {
        return 0;
    }

    const current = getConversationActivityContext(settings, avatar);
    const status = current.status || 'online';
    const baseMs = { online: 450, idle: 900, dnd: 1600, offline: 2200 }[status] ?? 450;
    const perCharMs = { online: 18, idle: 32, dnd: 52, offline: 68 }[status] ?? 18;
    const talkativeness = clamp(parsePositiveInt(settings?.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
    const talkFactor = 1.15 - (talkativeness / 200);
    const delay = (baseMs + String(messageText || '').length * perCharMs * talkFactor) * multiplier;
    return Math.min(9000, Math.max(350, Math.round(delay)));
}

export async function waitForReplyDelay(messageText, settings, avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const delay = getReplyDelayMs(messageText, settings, avatar);
    if (delay <= 0) {
        return;
    }

    if (isConversationActiveThread(avatar, groupId, { branchId, personaId })) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
    await new Promise(resolve => setTimeout(resolve, delay));
}

export function getTypingParticipantMap(avatar = getCurrentCharAvatar(), { branchId = '', create = false, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const threadAvatar = avatar || getCurrentCharAvatar();
    if (!threadAvatar) {
        return null;
    }

    const storageKey = getConversationThreadKey(threadAvatar, groupId || '', { personaId });
    const resolvedBranchId = branchId || getConversationThreadStore(threadAvatar, { create: false, groupId, personaId })?.activeBranchId || '';
    const threadKey = resolvedBranchId ? `${storageKey}:${resolvedBranchId}` : storageKey;
    if (!threadKey) {
        return null;
    }

    let participantMap = activeTypingParticipants.get(threadKey);
    if (!participantMap && create) {
        participantMap = new Map();
        activeTypingParticipants.set(threadKey, participantMap);
    }

    return participantMap || null;
}

export function getActiveTypingParticipants(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const participantMap = getTypingParticipantMap(avatar, { groupId });
    return participantMap ? Array.from(participantMap.values()).filter(participant => participant?.avatar) : [];
}

export function getPrimaryTypingParticipant(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const participants = getActiveTypingParticipants(avatar, { groupId });
    return participants.length ? participants[participants.length - 1] : null;
}

export async function withTypingParticipant(participant, task, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const threadAvatar = avatar || getCurrentCharAvatar();
    const participantAvatar = participant?.avatar || threadAvatar;
    const participantMap = getTypingParticipantMap(threadAvatar, { branchId, create: true, groupId, personaId });
    const previousTypingParticipant = participantMap?.get(participantAvatar) || null;
    if (participantMap && participantAvatar) {
        participantMap.set(participantAvatar, participant || { avatar: participantAvatar, name: 'Character' });
    }

    const isThreadActive = isConversationActiveThread(threadAvatar, groupId, { branchId, personaId });
    if (isThreadActive) {
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
            const storageKey = getConversationThreadKey(threadAvatar, groupId || '', { personaId });
            const resolvedBranchId = branchId || getConversationThreadStore(threadAvatar, { create: false, groupId, personaId })?.activeBranchId || '';
            const threadKey = resolvedBranchId ? `${storageKey}:${resolvedBranchId}` : storageKey;
            if (!participantMap.size && threadKey) {
                activeTypingParticipants.delete(threadKey);
            }
        }
        if (isThreadActive) {
            scheduleInterfaceRefresh({ syncControls: false });
        }
    }
}

export function maybePostDelayedReplyNotice(avatar, settings, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), statusAvatar = avatar } = {}) {
    const current = getConversationActivityContext(settings, statusAvatar);
    if (current.source === 'manual' && ['dnd', 'offline'].includes(settings?.availability)) {
        return;
    }
    if (!['dnd', 'offline'].includes(current.status)) {
        return;
    }

    const lastUserActivity = getLastUserActivity(avatar, Date.now(), { branchId, groupId, personaId });
    const markerKey = 'sb_conv_busy_reply_notice';
    const markerValue = getConversationSessionMarker(avatar, markerKey, { branchId, groupId, personaId });
    const markerTime = parsePositiveInt(markerValue.split(':')[1], 0, 0);
    if (markerTime > 0 && Date.now() - markerTime < STATUS_NOTICE_COOLDOWN_MS) {
        return;
    }

    const character = getCharacterForAvatar(statusAvatar);
    const charName = character?.name || 'This character';
    appendConversationThreadMessage(avatar, {
        role: 'system',
        name: 'Status',
        mes: `${charName} is ${current.activity} right now. Replies may take a little longer.`,
        extra: { conversation_mode_notice: true, availability: current.status, partner_avatar: statusAvatar },
    }, { branchId, create: !branchId, groupId, personaId });
    setConversationSessionMarker(avatar, markerKey, `${lastUserActivity}:${Date.now()}`, { branchId, groupId, personaId });
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

export function setLastConversationPreview(avatar, messageText, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const preview = stripPreviewText(messageText);
    if (!avatar || !preview) {
        return;
    }

    const branch = getActiveConversationBranch(avatar, { branchId, create: !branchId, groupId, personaId });
    if (branch) {
        branch.preview = preview;
        branch.updatedAt = Date.now();
        persistConversationStore();
    }
}

export function getLastConversationPreview(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return getActiveConversationBranch(avatar, { create: false, groupId })?.preview || 'Conversation ready';
}

export function updateLastPreviewFromConversation(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const messages = getConversationThread(avatar, { branchId, create: !branchId, groupId, personaId });
    const message = [...messages].reverse().find(hasConversationMessageContent);
    if (message) {
        setLastConversationPreview(avatar, getConversationMessagePreviewText(message), { branchId, groupId, personaId });
    }

    updateConversationNotificationIndicators();
}
