import { chat, is_send_press, name1 } from '../../script.js';
import { selected_group } from '../group-chats.js';
import { appendConversationMessage } from './attachments.js';
import {
    DEFAULT_INACTIVITY_THRESHOLD,
    DEFAULT_MAX_FOLLOWUPS,
    DEFAULT_SETTINGS,
    GROUP_ASIDE_COOLDOWN_MS,
    GROUP_ASIDE_MENTION_COOLDOWN_MS,
    LAST_CHIME_SESSION_PREFIX,
    LAST_IDLE_SESSION_PREFIX,
    MAX_INACTIVITY_THRESHOLD,
    MIN_INACTIVITY_THRESHOLD,
    PARALLEL_CHIME_MAX_PARTNERS,
    REMINDER_RETRY_DELAY_MS,
} from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationStore,
    getCurrentCharacter,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
    persistConversationStore,
} from './context.js';
import { generateConversationReply, postCharacterReply, postPartnerConversationReply, reportConversationGenerationError } from './generation.js';
import { loadCurrentPanelSettings } from './interface.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar } from './media.js';
import {
    buildGroupChatContext,
    getConversationRailItems,
    getCurrentGroupConversationMembers,
    getGroupAsideKey,
    getSelectedConversationGroup,
} from './pals-rail.js';
import {
    chooseConversationPartner,
    getAllowedPartnerCharacters,
    getConversationPartnerSettings,
    getLeastRecentPartner,
    getRecentlySilentMentionedPartner,
    isCharacterMentionedInText,
} from './partners.js';
import { getUserStatus, safeParseWeeklySchedule } from './personas.js';
import { clamp, getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import {
    getAutoCharacterChatCooldownMs,
    getConversationBranchActivityTime,
    getConversationSessionMarker,
    getFollowupCount,
    getLastAutoCharacterChatTime,
    getLastUserActivity,
    getSettings,
    setConversationSessionMarker,
    setFollowupCount,
    setLastAutoCharacterChatTime,
} from './settings-store.js';
import {
    conversationState,
    groupAsideBusyKeys,
    groupAsideLastSent,
    partnerReplyBusyKeys,
    sendQueue,
} from './state.js';
import { getConversationThread, getImageCooldownRemainingSeconds, markImageGenerated } from './thread-store.js';
import { getConversationActivityContext, withTypingParticipant } from './typing.js';

export function buildAutoMessageDirective(directive) {
    return directive;
}

export async function maybeGenerateSpontaneousImage(settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!settings.image_gen_enabled || !settings.spontaneous_selfies || getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { groupId }) > 0) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const prompt = buildCharacterImagePrompt(
        settings.selfie_prompt || settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
        'a spontaneous selfie in the current DM conversation',
        avatar,
    );
    const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '');
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { groupId });
        await appendConversationMessage('Snapped something for you.', {
            name: charName,
            role: 'character',
            extra: {
                conversation_mode_image: true,
                image_url: imageUrl,
                image_prompt: prompt,
            },
            groupId,
        }, avatar);
    }
}

export async function triggerAutoMessage(directive, settings, extra = {}, avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    if (conversationState.autoWorkerBusy || conversationState.conversationReplyBusy || is_send_press || !character || !avatar) {
        return false;
    }

    const groupId = extra.groupId || getConversationGroupIdForAvatar(avatar);

    conversationState.autoWorkerBusy = true;

    try {
        const quietPrompt = buildAutoMessageDirective(directive);
        const response = await generateConversationReply(quietPrompt, settings, {
            speakerName: character.name || 'Character',
            avatar,
            threadAvatar: avatar,
            groupId,
        });

        if (response?.trim()) {
            await withTypingParticipant(character, () => postCharacterReply(response.trim(), settings, {
                extra: {
                    conversation_mode_auto: true,
                    ...extra,
                },
                groupId,
            }, avatar), avatar);
            await maybeGenerateSpontaneousImage(settings, avatar, { groupId });
            return true;
        }
    } catch (error) {
        reportConversationGenerationError('auto-message', error, { level: 'warning' });
    } finally {
        conversationState.autoWorkerBusy = false;
    }

    return false;
}

export function getCurrentMinuteKey(date = new Date()) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

export function getCurrentDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function getLastAutoMessageTime(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.lastAutoMessageAt, 0, 0);
}

export function setLastAutoMessageTime(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.lastAutoMessageAt = timestamp;
        persistConversationStore();
    }
}

export function getScheduleTriggerState(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const state = getActiveConversationBranch(avatar, { create: false, groupId })?.scheduleTriggers;
    return state && typeof state === 'object' ? state : {};
}

export function setScheduleTriggered(avatar, triggerKey, timestamp, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const state = getScheduleTriggerState(avatar, { groupId });
    state[triggerKey] = timestamp;

    const stateEntries = Object.entries(state).sort((first, second) => first[1] - second[1]);
    while (stateEntries.length > 100) {
        const [oldestKey] = stateEntries.shift();
        delete state[oldestKey];
    }

    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.scheduleTriggers = state;
        persistConversationStore();
    }
}

export function hasScheduleTriggered(avatar, triggerKey, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return Object.prototype.hasOwnProperty.call(getScheduleTriggerState(avatar, { groupId }), triggerKey);
}

export async function checkScheduledAutoMessages(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!settings.auto_message) {
        return false;
    }

    const hasLegacy = Boolean(settings.ai_schedule);
    const weeklyEntries = safeParseWeeklySchedule(settings.weekly_schedule);
    if (!hasLegacy && !weeklyEntries.length) {
        return false;
    }

    const currentDate = new Date(now);
    const currentMinute = getCurrentMinuteKey(currentDate);
    const currentDay = getCurrentDayKey(currentDate);
    const currentDayOfWeek = currentDate.getDay(); // 0=Sun..6=Sat

    // Weekly scheduler entries (item 3)
    for (const entry of weeklyEntries) {
        if (entry.enabled === false) {
            continue;
        }
        if (!Array.isArray(entry.days) || !entry.days.includes(currentDayOfWeek)) {
            continue;
        }
        if (!entry.time || entry.time !== currentMinute) {
            continue;
        }

        const triggerKey = `weekly:${currentDay}:${entry.time}:${entry.message}`;
        if (hasScheduleTriggered(avatar, triggerKey, { groupId })) {
            continue;
        }

        const triggered = await triggerAutoMessage(
            `[System directive: Your weekly schedule is due: "${entry.message}". Send a message with this context in mind.]`,
            settings,
            { schedule: `weekly:${entry.time}`, groupId },
            avatar,
        );
        if (triggered) {
            setScheduleTriggered(avatar, triggerKey, now, { groupId });
            setLastAutoMessageTime(avatar, now, { groupId });
        }

        return triggered;
    }

    // Legacy HH:MM and relative-minute schedule lines
    if (!hasLegacy) {
        return false;
    }

    for (const line of settings.ai_schedule.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const absoluteMatch = trimmed.match(/^(\d{2}):(\d{2})\s*-\s*(.*)$/);
        if (absoluteMatch && `${absoluteMatch[1]}:${absoluteMatch[2]}` === currentMinute) {
            const triggerKey = `absolute:${currentDay}:${currentMinute}:${trimmed}`;
            if (hasScheduleTriggered(avatar, triggerKey, { groupId })) {
                continue;
            }

            const triggered = await triggerAutoMessage(`[System directive: Your schedule is due: "${absoluteMatch[3]}". Send a message with this context in mind.]`, settings, { schedule: trimmed, groupId }, avatar);
            if (triggered) {
                setScheduleTriggered(avatar, triggerKey, now, { groupId });
                setLastAutoMessageTime(avatar, now, { groupId });
            }

            return triggered;
        }

        const relativeMatch = trimmed.match(/^(\d+)\s*-\s*(.*)$/);
        if (relativeMatch) {
            const delayMinutes = parsePositiveInt(relativeMatch[1], 0, 0);
            const lastUserActivity = getLastUserActivity(avatar, now, { groupId });
            const elapsedMinutes = (now - lastUserActivity) / (60 * 1000);

            if (delayMinutes > 0 && elapsedMinutes >= delayMinutes) {
                const triggerKey = `relative:${lastUserActivity}:${trimmed}`;
                if (hasScheduleTriggered(avatar, triggerKey, { groupId })) {
                    continue;
                }

                const triggered = await triggerAutoMessage(`[System directive: You are sending a check-in due to ${delayMinutes} minutes of silence: "${relativeMatch[2]}".]`, settings, { schedule: trimmed, groupId }, avatar);
                if (triggered) {
                    setScheduleTriggered(avatar, triggerKey, now, { groupId });
                    setLastAutoMessageTime(avatar, now, { groupId });
                }

                return triggered;
            }
        }
    }

    return false;
}

export async function checkIdleAutoMessage(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const followupEnabled = Boolean(settings.idle_followup);
    const spontaneousEnabled = Boolean(settings.idle_spontaneous);
    if (!followupEnabled && !spontaneousEnabled) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now, { groupId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit) {
        return false;
    }

    const followupSessionKey = `${LAST_IDLE_SESSION_PREFIX}followup`;
    if (followupEnabled && getConversationSessionMarker(avatar, followupSessionKey, { groupId }) !== String(lastUserActivity)) {
        const triggered = await triggerAutoMessage(
            '[System directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]',
            settings,
            { idle_action: 'followup', groupId },
            avatar,
        );
        if (triggered) {
            setConversationSessionMarker(avatar, followupSessionKey, lastUserActivity, { groupId });
            setLastAutoMessageTime(avatar, now, { groupId });
        }
        return triggered;
    }

    const spontaneousIdleLimit = followupEnabled ? settings.idle_limit * 2 : settings.idle_limit;
    if (!spontaneousEnabled || idleMinutes < spontaneousIdleLimit) {
        return false;
    }

    const spontaneousSessionKey = `${LAST_IDLE_SESSION_PREFIX}spontaneous`;
    if (getConversationSessionMarker(avatar, spontaneousSessionKey, { groupId }) === String(lastUserActivity)) {
        return false;
    }

    const triggered = await triggerAutoMessage(
        '[System directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]',
        settings,
        { idle_action: 'spontaneous', groupId },
        avatar,
    );
    if (triggered) {
        setConversationSessionMarker(avatar, spontaneousSessionKey, lastUserActivity, { groupId });
        setLastAutoMessageTime(avatar, now, { groupId });
    }

    return triggered;
}

export function buildProactiveDirective(activity, status, now = new Date()) {
    const hour = now.getHours();
    let timeOfDay = 'evening';
    if (hour < 5) {
        timeOfDay = 'late night';
    } else if (hour < 12) {
        timeOfDay = 'morning';
    } else if (hour < 17) {
        timeOfDay = 'afternoon';
    } else if (hour < 21) {
        timeOfDay = 'evening';
    } else {
        timeOfDay = 'night';
    }

    const statusNote = status === 'dnd'
        ? 'You are busy and only have a brief moment.'
        : status === 'idle'
            ? 'You have a spare moment between things.'
            : 'You are free and feel like reaching out.';

    return `[System directive: It is ${timeOfDay} and you are currently ${activity} (status: ${status}). ${statusNote} The user has not replied in a while. Reach out to them yourself with a short, natural direct message. Reference your current activity or the time of day if it feels right. Do not wait for them to speak first.]`;
}

export async function checkProactiveMessaging(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!settings.proactive_messaging) {
        return false;
    }

    // The user being on Do Not Disturb fully suppresses proactive messaging.
    if (getUserStatus() === 'dnd') {
        return false;
    }

    const schedule = getStoredSchedule(avatar);
    const current = getCurrentActivityFromSchedule(schedule, avatar, new Date(now));

    // The character never initiates while offline.
    if (current.status === 'offline') {
        return false;
    }

    const thread = getConversationThread(avatar, { groupId });
    const lastMessage = thread[thread.length - 1];
    const lastUserActivity = getLastUserActivity(avatar, now, { groupId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);
    const maxFollowups = clamp(parsePositiveInt(settings.max_followups, DEFAULT_MAX_FOLLOWUPS, 1), 1, 3);
    const sentCount = getFollowupCount(avatar, { groupId });

    // Catch-up: the user messaged while the character was unavailable and it is
    // now back online. Respond regardless of the inactivity threshold.
    const isCatchUp = Boolean(lastMessage) && lastMessage.role === 'user' && sentCount === 0;

    if (!isCatchUp) {
        if (sentCount >= maxFollowups) {
            return false;
        }

        let thresholdMinutes = clamp(
            parsePositiveInt(settings.inactivity_threshold, DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
            MIN_INACTIVITY_THRESHOLD,
            MAX_INACTIVITY_THRESHOLD,
        );

        // Busy characters wait three times as long before reaching out.
        if (current.status === 'dnd') {
            thresholdMinutes *= 3;
        }

        if (sentCount === 0) {
            // First proactive message is measured from the user's last activity.
            if (idleMinutes < thresholdMinutes) {
                return false;
            }
        } else {
            // Follow-ups use an escalating cooldown measured from the last auto message.
            const elapsedSinceAuto = (now - getLastAutoMessageTime(avatar, { groupId })) / (60 * 1000);
            const followupThreshold = thresholdMinutes * Math.pow(2, sentCount);
            if (elapsedSinceAuto < followupThreshold) {
                return false;
            }
        }
    }

    const directive = buildProactiveDirective(current.activity, current.status, new Date(now));
    const triggered = await triggerAutoMessage(directive, settings, {
        proactive: true,
        proactive_status: current.status,
        groupId,
    }, avatar);

    if (triggered) {
        setFollowupCount(avatar, sentCount + 1, { groupId });
        setLastAutoMessageTime(avatar, now, { groupId });
    }

    return triggered;
}

export function getPartnerReplyBusyKey(avatar, partnerAvatar, scope) {
    return `${avatar || 'thread'}:${partnerAvatar || 'partner'}:${scope || 'reply'}`;
}

export function getConversationPartnerChimeCandidates(avatar, selectedAvatars, { max = PARALLEL_CHIME_MAX_PARTNERS, groupId = getConversationGroupIdForAvatar(avatar), settings = getSettings(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId, includeThreadPartners: true });
    const candidates = [];
    const addCandidate = (partner) => {
        if (partner?.avatar && !candidates.some(candidate => candidate.avatar === partner.avatar)) {
            candidates.push(partner);
        }
    };

    addCandidate(getRecentlySilentMentionedPartner(avatar, selectedAvatars, settings, { groupId }));
    addCandidate(getLeastRecentPartner(avatar, selectedAvatars, settings, { groupId }));

    const shuffled = [...partners].sort(() => Math.random() - 0.5);
    for (const partner of shuffled) {
        if (candidates.length >= max) {
            break;
        }
        addCandidate(partner);
    }

    return candidates.slice(0, max);
}

export async function triggerConversationPartnerChime(partner, settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!partner?.avatar || !avatar) {
        return false;
    }

    const busyKey = getPartnerReplyBusyKey(avatar, partner.avatar, `chime:${groupId || 'solo'}`);
    if (partnerReplyBusyKeys.has(busyKey)) {
        return false;
    }

    partnerReplyBusyKeys.add(busyKey);
    try {
        const partnerName = partner.name || 'A friend';
        const partnerSettings = getConversationPartnerSettings(partner.avatar, settings, { groupId });
        const partnerContext = getConversationActivityContext(partnerSettings, partner.avatar);
        const character = getCharacterForAvatar(avatar);
        const charName = character?.name || getCurrentCharName();
        const userName = name1 || 'User';
        const directive = `[System directive: You are ${partnerName}, chiming in on a private group DM conversation between ${charName} and ${userName}. You are currently ${partnerContext.activity} (status: ${partnerContext.status}). If you were mentioned recently, answer naturally. Otherwise add one short message only if you have something distinct to contribute. Other people may be typing at the same time; do not wait for them. Output only your message body, without a name prefix.]`;
        const response = await generateConversationReply(directive, partnerSettings, {
            trimNames: false,
            speakerName: partnerName,
            avatar,
            threadAvatar: avatar,
            speakerAvatar: partner.avatar,
            groupId,
        });

        if (response?.trim()) {
            await postPartnerConversationReply(response.trim(), partner, partnerSettings, {
                avatar,
                extra: {
                    conversation_mode_chime: true,
                    partner_avatar: partner.avatar,
                },
                groupId,
            });
            return true;
        }
    } catch (error) {
        reportConversationGenerationError('partner chime', error, { toast: false });
    } finally {
        partnerReplyBusyKeys.delete(busyKey);
    }

    return false;
}

export async function triggerMultiCharacterChime(settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getConversationPartnerChimeCandidates(avatar, settings.multi_char_names, { groupId, settings });
    if (!partners.length) {
        return false;
    }

    const results = await Promise.allSettled(partners.map(partner => triggerConversationPartnerChime(partner, settings, avatar, { groupId })));
    return results.some(result => result.status === 'fulfilled' && result.value === true);
}

export async function checkMultiCharacterChime(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const mentionedPartner = getRecentlySilentMentionedPartner(avatar, settings.multi_char_names, settings, { groupId });
    if (!settings.multi_char && !mentionedPartner) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now, { groupId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (!mentionedPartner && idleMinutes < Math.max(0.75, settings.idle_limit / 4)) {
        return false;
    }

    const sessionKey = LAST_CHIME_SESSION_PREFIX;
    if (getConversationSessionMarker(avatar, sessionKey, { groupId }) === String(lastUserActivity)) {
        return false;
    }

    const triggered = !settings.multi_char && mentionedPartner
        ? await triggerConversationPartnerChime(mentionedPartner, settings, avatar, { groupId })
        : await triggerMultiCharacterChime(settings, avatar, { groupId });
    if (triggered) {
        setConversationSessionMarker(avatar, sessionKey, lastUserActivity, { groupId });
        setLastAutoMessageTime(avatar, now, { groupId });
    }

    return triggered;
}

export async function triggerAutoCharacterChat(avatar, settings, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partner = getLeastRecentPartner(avatar, settings.multi_char_names, settings, { groupId })
        || chooseConversationPartner(avatar, settings.multi_char_names, settings, { groupId });
    if (!partner) {
        return false;
    }

    const busyKey = getPartnerReplyBusyKey(avatar, partner.avatar, `auto-chat:${groupId || 'solo'}`);
    if (partnerReplyBusyKeys.has(busyKey)) {
        return false;
    }

    partnerReplyBusyKeys.add(busyKey);
    try {
        const partnerName = partner.name || 'A friend';
        const partnerSettings = getConversationPartnerSettings(partner.avatar, settings, { groupId });
        const partnerContext = getConversationActivityContext(partnerSettings, partner.avatar);
        if (partnerContext.status === 'offline') {
            return false;
        }

        const character = getCharacterForAvatar(avatar);
        const charName = character?.name || getCurrentCharName();
        const otherMembers = [character, ...getAllowedPartnerCharacters(settings.multi_char_names, avatar, settings, { groupId })]
            .filter(member => member?.avatar && member.avatar !== partner.avatar);
        const target = otherMembers.length ? otherMembers[Math.floor(Math.random() * otherMembers.length)] : character;
        const targetName = target?.name || charName;
        const directive = `[System directive: You are ${partnerName}, speaking autonomously in a private group DM. Aim this message at ${targetName}, not the user, unless the user is directly relevant. You are currently ${partnerContext.activity} (status: ${partnerContext.status}). This is character-to-character ambient chat, so continue the casual conversation or start a friendly new topic with one short, natural message. Other people may reply later. Output only your message body, without a name prefix.]`;
        const response = await generateConversationReply(directive, partnerSettings, {
            trimNames: false,
            speakerName: partnerName,
            avatar,
            threadAvatar: avatar,
            speakerAvatar: partner.avatar,
            groupId,
        });

        if (response?.trim()) {
            await postPartnerConversationReply(response.trim(), partner, partnerSettings, {
                avatar,
                extra: { conversation_mode_auto_chat: true, partner_avatar: partner.avatar },
                groupId,
            });
            return true;
        }
    } catch (error) {
        reportConversationGenerationError('character-to-character chat', error, { toast: false });
    } finally {
        partnerReplyBusyKeys.delete(busyKey);
    }

    return false;
}

export async function checkAutoCharacterChat(avatar, settings, now, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!settings.auto_character_chat) {
        return false;
    }

    const lastAutoChatAt = getLastAutoCharacterChatTime(avatar, { groupId });
    const cooldownBaseline = lastAutoChatAt || getConversationBranchActivityTime(avatar, { groupId });
    if (now - cooldownBaseline < getAutoCharacterChatCooldownMs(settings)) {
        return false;
    }

    const triggered = await triggerAutoCharacterChat(avatar, settings, { groupId });
    if (triggered) {
        setLastAutoCharacterChatTime(avatar, now, { groupId });
        setLastAutoMessageTime(avatar, now, { groupId });
    }

    return triggered;
}

export async function checkGroupChatMention(messageId) {
    if (!selected_group) {
        return;
    }

    const message = chat[messageId];
    if (!message || message.role !== 'user' || !message.mes) {
        return;
    }

    const members = getCurrentGroupConversationMembers({ requireRoleplayReactions: true });
    const memberCharacters = members.map(item => item.character).filter(Boolean);
    const mentionedMembers = members.filter(({ character }) => isCharacterMentionedInText(character, message.mes, memberCharacters));
    if (!mentionedMembers.length) {
        return;
    }

    setTimeout(() => {
        for (const { character } of mentionedMembers) {
            void triggerGroupAsideDM(character, { reason: 'mention', sourceMessageId: messageId });
        }
    }, 900);
}

export async function triggerGroupAsideDM(character, { reason = 'random', sourceMessageId = null } = {}) {
    const group = getSelectedConversationGroup();
    if (!group || !character?.avatar || !group.members?.includes(character.avatar) || group.disabled_members?.includes(character.avatar)) {
        return false;
    }

    const groupId = String(group.id || '');
    const settings = getSettings(character.avatar, { groupId });
    if (!settings.enabled || !settings.roleplay_reactions) {
        return false;
    }

    const current = getConversationActivityContext(settings, character.avatar);
    if (current.status === 'offline') {
        return false;
    }

    const key = getGroupAsideKey(character.avatar, group.id);
    if (groupAsideBusyKeys.has(key)) {
        return false;
    }

    const now = Date.now();
    const cooldown = reason === 'mention' ? GROUP_ASIDE_MENTION_COOLDOWN_MS : GROUP_ASIDE_COOLDOWN_MS;
    if (now - (groupAsideLastSent.get(key) || 0) < cooldown) {
        return false;
    }

    const groupContext = buildGroupChatContext();
    if (!groupContext) {
        return false;
    }

    groupAsideBusyKeys.add(key);
    try {
        const userName = name1 || 'User';
        const characterName = character.name || 'Character';
        const reasonLine = reason === 'mention'
            ? `${userName} just mentioned or addressed you in the group chat. Send them a private aside DM about it.`
            : 'Send a private aside DM while the group chat is ongoing. React to the group if there is something worth reacting to; otherwise start a natural casual DM topic.';
        const directive = `[System directive: You are ${characterName}, currently present in the active group chat. ${reasonLine} This message goes only to ${userName} in Conversation Mode, not into the group chat. Keep it short, casual, in-character, and suitable as one or two chat bubbles. Output only your DM body, without a name prefix.\n\nRecent group chat context:\n${groupContext}]`;
        const response = await generateConversationReply(directive, settings, {
            speakerName: characterName,
            trimNames: false,
            avatar: character.avatar,
            groupId: null,
        });

        if (response?.trim()) {
            const extra = {
                conversation_mode_group_aside: true,
                conversation_mode_gossip: true,
                gossip_source_group: true,
                group_aside_reason: reason,
                source_group_id: group.id,
            };
            if (sourceMessageId !== null && typeof sourceMessageId !== 'undefined') {
                extra.source_group_message_id = sourceMessageId;
            }

            await withTypingParticipant(character, () => postCharacterReply(response.trim(), settings, { extra, groupId: null }, character.avatar), character.avatar);
            groupAsideLastSent.set(key, Date.now());
            return true;
        }
    } catch (err) {
        reportConversationGenerationError('group aside DM', err, { toast: false });
    } finally {
        groupAsideBusyKeys.delete(key);
    }

    return false;
}

export async function triggerRoleplayDM() {
    const character = getCurrentCharacter();
    const avatar = getCurrentCharAvatar();
    if (!character || !avatar) return;

    const settings = getSettings(avatar, { groupId: '' });
    const sheld = document.getElementById('sheld');
    if (!settings.enabled || (sheld instanceof HTMLElement && sheld.dataset.sbConversationMode === 'on')) {
        return;
    }

    const snippet = [];
    const startIdx = Math.max(0, chat.length - 6);
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (msg && msg.mes) {
            snippet.push(`${msg.name || (msg.is_user ? 'User' : 'Character')}: ${msg.mes}`);
        }
    }

    if (!snippet.length) return;

    const chatText = snippet.join('\n');
    const directive = `[System directive: You are sending a private direct message (DM) to {{user}} to comment on the ongoing roleplay/story scene. Step out of the main scene and send a short, private, personal DM sharing your inner thoughts, a side-comment, or a private reaction to what just happened. Keep it short, casual, and completely in-character. Do not continue the roleplay scene; write a private side-message.\n\nRoleplay context:\n${chatText}]`;

    try {
        console.log(`Generating private roleplay DM from ${character.name}...`);
        const response = await generateConversationReply(directive, settings, {
            speakerName: character.name || 'Character',
            trimNames: true,
            avatar,
        });

        if (response?.trim()) {
            await postCharacterReply(response.trim(), settings, {
                extra: { conversation_mode_gossip: true, gossip_source_roleplay: true },
            }, avatar);
        }
    } catch (err) {
        reportConversationGenerationError('roleplay side DM', err, { toast: false });
    }
}

export async function checkConversationReminders(now) {
    const store = getConversationStore();
    if (!Array.isArray(store.reminders) || !store.reminders.length) {
        return false;
    }

    const dueReminders = store.reminders.filter(rem => {
        const retryAfter = parsePositiveInt(rem.retryAfter, 0, 0);
        return now >= rem.triggerAt && !rem.fired && (!retryAfter || now >= retryAfter);
    });
    if (!dueReminders.length) {
        return false;
    }

    const reminder = dueReminders[0];
    const avatar = reminder.avatar;
    const groupId = reminder.groupId || '';
    const settings = getSettings(avatar, { groupId });

    if (!settings.enabled) {
        reminder.fired = true;
        reminder.skippedAt = now;
        persistConversationStore();
        return false;
    }

    console.log('Conversation Mode: triggering reminder auto-reply', reminder);

    const deferReminderRetry = () => {
        reminder.lastAttemptAt = now;
        reminder.retryAfter = now + REMINDER_RETRY_DELAY_MS;
        persistConversationStore();
    };

    try {
        const directive = `[System directive: This is a scheduled reminder. Send a DM to the user reminding them about: "${reminder.text}". Do not mention system/bracketed code, just say it naturally in-character as a DM ping.]`;

        const triggered = await triggerAutoMessage(directive, settings, {
            conversation_mode_reminder: true,
            reminder_text: reminder.text,
            reminder_id: reminder.id,
            partner_avatar: groupId ? avatar : undefined,
            groupId: groupId || undefined,
        }, avatar);

        if (triggered) {
            reminder.fired = true;
            reminder.firedAt = Date.now();
            delete reminder.retryAfter;
            persistConversationStore();
            return true;
        }

        deferReminderRetry();
        return false;
    } catch (error) {
        reportConversationGenerationError('reminder', error, { level: 'warning' });
        deferReminderRetry();
        return false;
    }
}

export async function conversationModeAutoMessageWorker() {
    if (getUserStatus() === 'offline') {
        return;
    }

    if (conversationState.autoWorkerBusy || conversationState.conversationReplyBusy || conversationState.sendQueueProcessing || sendQueue.length || is_send_press) {
        return;
    }

    const now = Date.now();

    if (await checkConversationReminders(now)) {
        return;
    }

    for (const { character, settings, groupId = '' } of getConversationRailItems()) {
        const avatar = character.avatar;
        const elapsedSeconds = (now - getLastAutoMessageTime(avatar, { groupId })) / 1000;
        if (elapsedSeconds < settings.cooldown) {
            continue;
        }

        if (await checkScheduledAutoMessages(avatar, settings, now, { groupId })) {
            return;
        }

        // Marinara-style proactive loop takes priority over legacy idle action.
        if (settings.proactive_messaging) {
            if (await checkProactiveMessaging(avatar, settings, now, { groupId })) {
                return;
            }
        } else if (await checkIdleAutoMessage(avatar, settings, now, { groupId })) {
            return;
        }

        if (await checkMultiCharacterChime(avatar, settings, now, { groupId })) {
            return;
        }

        if (await checkAutoCharacterChat(avatar, settings, now, { groupId })) {
            return;
        }
    }
}

export async function handleAvailabilityAutoResponder(settings = getSettings(), avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return false;
    }

    if (!settings.enabled || !['offline', 'dnd'].includes(settings.availability)) {
        return false;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const offlineText = (settings.offline_message || DEFAULT_SETTINGS.offline_message).replace('{{char}}', charName);
    await appendConversationMessage(offlineText, {
        extra: {
            conversation_mode_auto_responder: true,
            availability: settings.availability,
        },
        groupId,
    }, avatar);
    return true;
}

export function handleChatChanged() {
    loadCurrentPanelSettings();
}
