import { chat, is_send_press } from '../../script.js';
import { selected_group } from '../group-chats.js';
import {
    DEFAULT_INACTIVITY_THRESHOLD,
    DEFAULT_MAX_FOLLOWUPS,
    DEFAULT_SETTINGS,
    AUTO_WORKER_INTERVAL_GLOBAL_KEY,
    AUTO_WORKER_INTERVAL_MS,
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
    getConversationPersonaId,
    getConversationStore,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getCurrentCharName,
    getRoleplayCurrentCharacter,
    getRoleplayGroupById,
    parsePositiveInt,
    persistConversationStore,
} from './context.js';
import { generateConversationReply, postCharacterReply, postPartnerConversationReply, reportConversationGenerationError } from './generation.js';
import { loadCurrentPanelSettings } from './interface.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar } from './media.js';
import { appendConversationMessage } from './message-writer.js';
import {
    buildGroupChatContext,
    getConversationRailItems,
    getCurrentGroupConversationMembers,
    getGroupAsideKey,
} from './pals-rail.js';
import {
    chooseConversationPartner,
    getAllowedPartnerCharacters,
    getConversationPartnerSettings,
    getLeastRecentPartner,
    getRecentlySilentMentionedPartner,
    isCharacterMentionedInText,
} from './partners.js';
import { getConversationPersonaName, getUserStatus, safeParseWeeklySchedule } from './personas.js';
import { clamp, getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { buildConversationRoleplayContext } from './shared-helpers.js';
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
import { clearConversationTimeouts, setConversationTimeout } from './timers.js';
import { getConversationThread, getImageCooldownRemainingSeconds, markImageGenerated, resolveConversationReminderBranchId } from './thread-store.js';
import { getConversationActivityContext, withTypingParticipant } from './typing.js';

function isAutoWorkerAborted(signal = conversationState.autoWorkerAbortController?.signal) {
    return Boolean(signal?.aborted);
}

export function stopConversationAutoWorker() {
    const existingAutoWorkerIntervalId = globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY];
    if (existingAutoWorkerIntervalId) {
        window.clearInterval(existingAutoWorkerIntervalId);
    }

    if (conversationState.autoWorkerIntervalId) {
        window.clearInterval(conversationState.autoWorkerIntervalId);
    }

    conversationState.autoWorkerIntervalId = null;
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY] = null;
    conversationState.autoWorkerAbortController?.abort?.();
    conversationState.autoWorkerAbortController = null;
    conversationState.autoWorkerStarted = false;
    clearConversationTimeouts();
}

export function startConversationAutoWorker() {
    stopConversationAutoWorker();

    const controller = new AbortController();
    conversationState.autoWorkerAbortController = controller;
    conversationState.autoWorkerIntervalId = window.setInterval(() => {
        void conversationModeAutoMessageWorker({ signal: controller.signal });
    }, AUTO_WORKER_INTERVAL_MS);
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY] = conversationState.autoWorkerIntervalId;
    conversationState.autoWorkerStarted = true;
}

export function buildAutoMessageDirective(directive) {
    return directive;
}

export async function maybeGenerateSpontaneousImage(settings, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!settings.image_gen_enabled || !settings.spontaneous_selfies || getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { branchId, groupId, personaId }) > 0) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const prompt = buildCharacterImagePrompt(
        settings.selfie_prompt || settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
        'a spontaneous selfie in the current DM conversation',
        avatar,
    );
    const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '', { avatar, character });
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { branchId, groupId, personaId });
        await appendConversationMessage('Snapped something for you.', {
            name: charName,
            role: 'character',
            extra: {
                conversation_mode_image: true,
                image_url: imageUrl,
                image_prompt: prompt,
            },
            branchId,
            groupId,
            personaId,
        }, avatar);
    }
}

export async function triggerAutoMessage(directive, settings, extra = {}, avatar = getCurrentCharAvatar(), { branchId = '', personaId = getConversationPersonaId() } = {}) {
    const character = getCharacterForAvatar(avatar);
    if (conversationState.autoWorkerBusy || conversationState.conversationReplyBusy || is_send_press || !character || !avatar) {
        return false;
    }

    const groupId = extra.groupId ?? getConversationGroupIdForAvatar(avatar);
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    const capturedBranchId = branchId || threadStore?.activeBranchId || '';
    if (!capturedBranchId || !threadStore?.branches?.[capturedBranchId]) {
        return false;
    }

    conversationState.autoWorkerBusy = true;

    try {
        const quietPrompt = buildAutoMessageDirective(directive);
        const response = await generateConversationReply(quietPrompt, settings, {
            speakerName: character.name || 'Character',
            avatar,
            branchId: capturedBranchId,
            threadAvatar: avatar,
            groupId,
            personaId,
        });

        if (response?.trim()) {
            const postedText = await withTypingParticipant(character, () => postCharacterReply(response.trim(), settings, {
                extra: {
                    conversation_mode_auto: true,
                    ...extra,
                },
                branchId: capturedBranchId,
                groupId,
                personaId,
            }, avatar), avatar, { branchId: capturedBranchId, groupId, personaId });
            if (!postedText) {
                return false;
            }
            await maybeGenerateSpontaneousImage(settings, avatar, { branchId: capturedBranchId, groupId, personaId });
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

export function getLastAutoMessageTime(avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId })?.lastAutoMessageAt, 0, 0);
}

export function setLastAutoMessageTime(avatar, timestamp = Date.now(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const branch = getActiveConversationBranch(avatar, { branchId, create: !branchId, groupId, personaId });
    if (branch) {
        branch.lastAutoMessageAt = timestamp;
        persistConversationStore();
    }
}

export function getScheduleTriggerState(avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const state = getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId })?.scheduleTriggers;
    return state && typeof state === 'object' ? state : {};
}

export function setScheduleTriggered(avatar, triggerKey, timestamp, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const state = getScheduleTriggerState(avatar, { branchId, groupId, personaId });
    state[triggerKey] = timestamp;

    const stateEntries = Object.entries(state).sort((first, second) => first[1] - second[1]);
    while (stateEntries.length > 100) {
        const [oldestKey] = stateEntries.shift();
        delete state[oldestKey];
    }

    const branch = getActiveConversationBranch(avatar, { branchId, create: !branchId, groupId, personaId });
    if (branch) {
        branch.scheduleTriggers = state;
        persistConversationStore();
    }
}

export function hasScheduleTriggered(avatar, triggerKey, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return Object.prototype.hasOwnProperty.call(getScheduleTriggerState(avatar, { branchId, groupId, personaId }), triggerKey);
}

export async function checkScheduledAutoMessages(avatar, settings, now, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
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
        if (hasScheduleTriggered(avatar, triggerKey, { branchId, groupId, personaId })) {
            continue;
        }

        const triggered = await triggerAutoMessage(
            `[System directive: Your weekly schedule is due: "${entry.message}". Send a message with this context in mind.]`,
            settings,
            { schedule: `weekly:${entry.time}`, groupId },
            avatar,
            { branchId, personaId },
        );
        if (triggered) {
            setScheduleTriggered(avatar, triggerKey, now, { branchId, groupId, personaId });
            setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
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
            if (hasScheduleTriggered(avatar, triggerKey, { branchId, groupId, personaId })) {
                continue;
            }

            const triggered = await triggerAutoMessage(`[System directive: Your schedule is due: "${absoluteMatch[3]}". Send a message with this context in mind.]`, settings, { schedule: trimmed, groupId }, avatar, { branchId, personaId });
            if (triggered) {
                setScheduleTriggered(avatar, triggerKey, now, { branchId, groupId, personaId });
                setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
            }

            return triggered;
        }

        const relativeMatch = trimmed.match(/^(\d+)\s*-\s*(.*)$/);
        if (relativeMatch) {
            const delayMinutes = parsePositiveInt(relativeMatch[1], 0, 0);
            const lastUserActivity = getLastUserActivity(avatar, now, { branchId, groupId, personaId });
            const elapsedMinutes = (now - lastUserActivity) / (60 * 1000);

            if (delayMinutes > 0 && elapsedMinutes >= delayMinutes) {
                const triggerKey = `relative:${lastUserActivity}:${trimmed}`;
                if (hasScheduleTriggered(avatar, triggerKey, { branchId, groupId, personaId })) {
                    continue;
                }

                const triggered = await triggerAutoMessage(`[System directive: You are sending a check-in due to ${delayMinutes} minutes of silence: "${relativeMatch[2]}".]`, settings, { schedule: trimmed, groupId }, avatar, { branchId, personaId });
                if (triggered) {
                    setScheduleTriggered(avatar, triggerKey, now, { branchId, groupId, personaId });
                    setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
                }

                return triggered;
            }
        }
    }

    return false;
}

export async function checkIdleAutoMessage(avatar, settings, now, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const followupEnabled = Boolean(settings.idle_followup);
    const spontaneousEnabled = Boolean(settings.idle_spontaneous);
    if (!followupEnabled && !spontaneousEnabled) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now, { branchId, groupId, personaId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (idleMinutes < settings.idle_limit) {
        return false;
    }

    const followupSessionKey = `${LAST_IDLE_SESSION_PREFIX}followup`;
    if (followupEnabled && getConversationSessionMarker(avatar, followupSessionKey, { branchId, groupId, personaId }) !== String(lastUserActivity)) {
        const triggered = await triggerAutoMessage(
            '[System directive: The user has been quiet for a while. Send a casual auto follow-up checking in or asking what they are up to.]',
            settings,
            { idle_action: 'followup', groupId },
            avatar,
            { branchId, personaId },
        );
        if (triggered) {
            setConversationSessionMarker(avatar, followupSessionKey, lastUserActivity, { branchId, groupId, personaId });
            setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
        }
        return triggered;
    }

    const spontaneousIdleLimit = followupEnabled ? settings.idle_limit * 2 : settings.idle_limit;
    if (!spontaneousEnabled || idleMinutes < spontaneousIdleLimit) {
        return false;
    }

    const spontaneousSessionKey = `${LAST_IDLE_SESSION_PREFIX}spontaneous`;
    if (getConversationSessionMarker(avatar, spontaneousSessionKey, { branchId, groupId, personaId }) === String(lastUserActivity)) {
        return false;
    }

    const triggered = await triggerAutoMessage(
        '[System directive: Send a spontaneous ping to the user, starting a new topic or sharing a casual thought.]',
        settings,
        { idle_action: 'spontaneous', groupId },
        avatar,
        { branchId, personaId },
    );
    if (triggered) {
        setConversationSessionMarker(avatar, spontaneousSessionKey, lastUserActivity, { branchId, groupId, personaId });
        setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
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

export async function checkProactiveMessaging(avatar, settings, now, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), lastAutoMessageAt = null, personaId = getConversationPersonaId() } = {}) {
    if (!settings.proactive_messaging) {
        return false;
    }

    // The user being on Do Not Disturb fully suppresses proactive messaging.
    if (getUserStatus() === 'dnd') {
        return false;
    }

    const schedule = getStoredSchedule(avatar, { personaId });
    const current = getCurrentActivityFromSchedule(schedule, avatar, new Date(now), { personaId });

    // The character never initiates while offline.
    if (current.status === 'offline') {
        return false;
    }

    const thread = getConversationThread(avatar, { branchId, create: false, groupId, personaId });
    const lastMessage = thread[thread.length - 1];
    const lastUserActivity = getLastUserActivity(avatar, now, { branchId, groupId, personaId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);
    const maxFollowups = clamp(parsePositiveInt(settings.max_followups, DEFAULT_MAX_FOLLOWUPS, 1), 1, 3);
    const sentCount = getFollowupCount(avatar, { branchId, groupId, personaId });

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
            const elapsedSinceAuto = (now - (lastAutoMessageAt ?? getLastAutoMessageTime(avatar, { branchId, groupId, personaId }))) / (60 * 1000);
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
    }, avatar, { branchId, personaId });

    if (triggered) {
        setFollowupCount(avatar, sentCount + 1, { branchId, groupId, personaId });
        setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
    }

    return triggered;
}

export function getPartnerReplyBusyKey(avatar, partnerAvatar, scope) {
    return `${avatar || 'thread'}:${partnerAvatar || 'partner'}:${scope || 'reply'}`;
}

export function getConversationPartnerChimeCandidates(avatar, selectedAvatars, { branchId = '', max = PARALLEL_CHIME_MAX_PARTNERS, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), settings = getSettings(avatar, { groupId, personaId }) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { branchId, groupId, includeThreadPartners: true, personaId });
    const candidates = [];
    const addCandidate = (partner) => {
        if (partner?.avatar && !candidates.some(candidate => candidate.avatar === partner.avatar)) {
            candidates.push(partner);
        }
    };

    addCandidate(getRecentlySilentMentionedPartner(avatar, selectedAvatars, settings, { branchId, groupId, personaId }));
    addCandidate(getLeastRecentPartner(avatar, selectedAvatars, settings, { branchId, groupId, personaId }));

    const shuffled = [...partners].sort(() => Math.random() - 0.5);
    for (const partner of shuffled) {
        if (candidates.length >= max) {
            break;
        }
        addCandidate(partner);
    }

    return candidates.slice(0, max);
}

export async function triggerConversationPartnerChime(partner, settings, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
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
        const partnerSettings = getConversationPartnerSettings(partner.avatar, settings, { groupId, personaId });
        const partnerContext = getConversationActivityContext(partnerSettings, partner.avatar, new Date(), { personaId });
        const character = getCharacterForAvatar(avatar);
        const charName = character?.name || getCurrentCharName();
        const userName = getConversationPersonaName(personaId, 'User');
        const directive = `[System directive: You are ${partnerName}, chiming in on a private group DM conversation between ${charName} and ${userName}. You are currently ${partnerContext.activity} (status: ${partnerContext.status}). If you were mentioned recently, answer naturally. Otherwise add one short message only if you have something distinct to contribute. Other people may be typing at the same time; do not wait for them. Output only your message body, without a name prefix.]`;
        const response = await generateConversationReply(directive, partnerSettings, {
            trimNames: false,
            speakerName: partnerName,
            avatar,
            branchId,
            threadAvatar: avatar,
            speakerAvatar: partner.avatar,
            groupId,
            personaId,
        });

        if (response?.trim()) {
            await postPartnerConversationReply(response.trim(), partner, partnerSettings, {
                avatar,
                branchId,
                extra: {
                    conversation_mode_chime: true,
                    partner_avatar: partner.avatar,
                },
                groupId,
                personaId,
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

export async function triggerMultiCharacterChime(settings, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const partners = getConversationPartnerChimeCandidates(avatar, settings.multi_char_names, { branchId, groupId, personaId, settings });
    if (!partners.length) {
        return false;
    }

    const results = await Promise.allSettled(partners.map(partner => triggerConversationPartnerChime(partner, settings, avatar, { branchId, groupId, personaId })));
    return results.some(result => result.status === 'fulfilled' && result.value === true);
}

export async function checkMultiCharacterChime(avatar, settings, now, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const mentionedPartner = getRecentlySilentMentionedPartner(avatar, settings.multi_char_names, settings, { branchId, groupId, personaId });
    if (!settings.multi_char && !mentionedPartner) {
        return false;
    }

    const lastUserActivity = getLastUserActivity(avatar, now, { branchId, groupId, personaId });
    const idleMinutes = (now - lastUserActivity) / (60 * 1000);

    if (!mentionedPartner && idleMinutes < Math.max(0.75, settings.idle_limit / 4)) {
        return false;
    }

    const sessionKey = LAST_CHIME_SESSION_PREFIX;
    if (getConversationSessionMarker(avatar, sessionKey, { branchId, groupId, personaId }) === String(lastUserActivity)) {
        return false;
    }

    const triggered = !settings.multi_char && mentionedPartner
        ? await triggerConversationPartnerChime(mentionedPartner, settings, avatar, { branchId, groupId, personaId })
        : await triggerMultiCharacterChime(settings, avatar, { branchId, groupId, personaId });
    if (triggered) {
        setConversationSessionMarker(avatar, sessionKey, lastUserActivity, { branchId, groupId, personaId });
        setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
    }

    return triggered;
}

export async function triggerAutoCharacterChat(avatar, settings, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const partner = getLeastRecentPartner(avatar, settings.multi_char_names, settings, { branchId, groupId, personaId })
        || chooseConversationPartner(avatar, settings.multi_char_names, settings, { branchId, groupId, personaId });
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
        const partnerSettings = getConversationPartnerSettings(partner.avatar, settings, { groupId, personaId });
        const partnerContext = getConversationActivityContext(partnerSettings, partner.avatar, new Date(), { personaId });
        if (partnerContext.status === 'offline') {
            return false;
        }

        const character = getCharacterForAvatar(avatar);
        const charName = character?.name || getCurrentCharName();
        const otherMembers = [character, ...getAllowedPartnerCharacters(settings.multi_char_names, avatar, settings, { branchId, groupId, personaId })]
            .filter(member => member?.avatar && member.avatar !== partner.avatar);
        const target = otherMembers.length ? otherMembers[Math.floor(Math.random() * otherMembers.length)] : character;
        const targetName = target?.name || charName;
        const directive = `[System directive: You are ${partnerName}, speaking autonomously in a private group DM. Aim this message at ${targetName}, not the user, unless the user is directly relevant. You are currently ${partnerContext.activity} (status: ${partnerContext.status}). This is character-to-character ambient chat, so continue the casual conversation or start a friendly new topic with one short, natural message. Other people may reply later. Output only your message body, without a name prefix.]`;
        const response = await generateConversationReply(directive, partnerSettings, {
            trimNames: false,
            speakerName: partnerName,
            avatar,
            branchId,
            threadAvatar: avatar,
            speakerAvatar: partner.avatar,
            groupId,
            personaId,
        });

        if (response?.trim()) {
            await postPartnerConversationReply(response.trim(), partner, partnerSettings, {
                avatar,
                branchId,
                extra: { conversation_mode_auto_chat: true, partner_avatar: partner.avatar },
                groupId,
                personaId,
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

export async function checkAutoCharacterChat(avatar, settings, now, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!settings.auto_character_chat) {
        return false;
    }

    const lastAutoChatAt = getLastAutoCharacterChatTime(avatar, { branchId, groupId, personaId });
    const cooldownBaseline = lastAutoChatAt || getConversationBranchActivityTime(avatar, { branchId, groupId, personaId });
    if (now - cooldownBaseline < getAutoCharacterChatCooldownMs(settings)) {
        return false;
    }

    const triggered = await triggerAutoCharacterChat(avatar, settings, { branchId, groupId, personaId });
    if (triggered) {
        setLastAutoCharacterChatTime(avatar, now, { branchId, groupId, personaId });
        setLastAutoMessageTime(avatar, now, { branchId, groupId, personaId });
    }

    return triggered;
}

export function getRoleplaySourceMessageRevision(message) {
    return JSON.stringify({
        id: message?.id ?? '',
        is_user: Boolean(message?.is_user),
        mes: message?.mes || '',
        name: message?.name || '',
        original_avatar: message?.original_avatar || message?.extra?.original_avatar || message?.extra?.avatar || '',
        role: message?.role || '',
    });
}

function getRoleplayGroupRevision(group) {
    return JSON.stringify({
        disabled_members: Array.isArray(group?.disabled_members) ? group.disabled_members : [],
        id: group?.id || '',
        members: Array.isArray(group?.members) ? group.members : [],
    });
}

function isCapturedRoleplaySourceValid({ avatar = '', sourceGroupId = '', sourceGroupRevision = '', sourceMessageId = null, sourceMessageRevision = '' } = {}) {
    if (sourceMessageId !== null && typeof sourceMessageId !== 'undefined') {
        const currentMessage = chat[sourceMessageId];
        if (!currentMessage || getRoleplaySourceMessageRevision(currentMessage) !== sourceMessageRevision) {
            return false;
        }
    }
    if (sourceGroupId) {
        const currentGroup = getRoleplayGroupById(sourceGroupId);
        return String(selected_group || '') === sourceGroupId
            && Boolean(currentGroup)
            && getRoleplayGroupRevision(currentGroup) === sourceGroupRevision;
    }

    return !selected_group && (!avatar || getRoleplayCurrentCharacter()?.avatar === avatar);
}

export function captureGroupAsideRequest(character, { personaId = getConversationPersonaId(), reason = 'random', sourceGroup = null, sourceGroupId = String(selected_group || ''), sourceMessageId = null } = {}) {
    const group = sourceGroup || getRoleplayGroupById(sourceGroupId);
    const sourceMessage = sourceMessageId !== null && typeof sourceMessageId !== 'undefined' ? chat[sourceMessageId] : null;
    const branchId = getConversationThreadStore(character?.avatar, { create: false, groupId: '', personaId })?.activeBranchId || '';
    const groupContext = buildGroupChatContext();
    if (!group || !character?.avatar || !branchId || !groupContext || (sourceMessageId !== null && !sourceMessage)) {
        return null;
    }

    return {
        branchId,
        groupContext,
        personaId,
        reason,
        sourceGroupId: String(group.id || sourceGroupId || ''),
        sourceGroupRevision: getRoleplayGroupRevision(group),
        sourceMessageId,
        sourceMessageRevision: sourceMessage ? getRoleplaySourceMessageRevision(sourceMessage) : '',
    };
}

export function captureRoleplayDMRequest({ avatar = getCurrentCharAvatar(), personaId = getConversationPersonaId(), roleplayContext = '', sourceMessageId = null } = {}) {
    const sourceMessage = sourceMessageId !== null && typeof sourceMessageId !== 'undefined' ? chat[sourceMessageId] : null;
    const branchId = getConversationThreadStore(avatar, { create: false, groupId: '', personaId })?.activeBranchId || '';
    const capturedContext = String(roleplayContext || buildConversationRoleplayContext(chat, sourceMessageId)).trim();
    if (!avatar || !branchId || !capturedContext || (sourceMessageId !== null && !sourceMessage)) {
        return null;
    }

    return {
        avatar,
        branchId,
        personaId,
        roleplayContext: capturedContext,
        sourceMessageId,
        sourceMessageRevision: sourceMessage ? getRoleplaySourceMessageRevision(sourceMessage) : '',
    };
}

export async function checkGroupChatMention(messageId) {
    if (!selected_group) {
        return;
    }

    const message = chat[messageId];
    if (!message || message.role !== 'user' || !message.mes) {
        return;
    }

    const personaId = getConversationPersonaId();
    const sourceGroupId = String(selected_group || '');
    const roleplayGroup = getRoleplayGroupById(sourceGroupId);
    const members = getCurrentGroupConversationMembers({ group: roleplayGroup, requireRoleplayReactions: true });
    const memberCharacters = members.map(item => item.character).filter(Boolean);
    const mentionedMembers = members.filter(({ character }) => isCharacterMentionedInText(character, message.mes, memberCharacters));
    if (!mentionedMembers.length) {
        return;
    }

    const requests = mentionedMembers
        .map(({ character }) => ({
            character,
            request: captureGroupAsideRequest(character, { personaId, reason: 'mention', sourceGroup: roleplayGroup, sourceGroupId, sourceMessageId: messageId }),
        }))
        .filter(item => item.request);
    if (requests.length) {
        setConversationTimeout(() => {
            for (const { character, request } of requests) {
                void triggerGroupAsideDM(character, request);
            }
        }, 900);
    }
}

export async function triggerGroupAsideDM(character, options = {}) {
    const captured = options.branchId ? options : captureGroupAsideRequest(character, options);
    if (!captured || !isCapturedRoleplaySourceValid({ ...captured, avatar: character?.avatar })) {
        return false;
    }
    const { branchId, groupContext, personaId, reason, sourceGroupId, sourceMessageId } = captured;
    const groupId = String(sourceGroupId || '');
    const group = getRoleplayGroupById(groupId);
    if (!group || !character?.avatar || !group.members?.includes(character.avatar) || group.disabled_members?.includes(character.avatar)) {
        return false;
    }

    const settings = getSettings(character.avatar, { groupId, personaId });
    if (!settings.enabled || !settings.roleplay_reactions) {
        return false;
    }

    const current = getConversationActivityContext(settings, character.avatar, new Date(), { personaId });
    if (current.status === 'offline') {
        return false;
    }

    const key = getGroupAsideKey(character.avatar, group.id, personaId);
    if (groupAsideBusyKeys.has(key)) {
        return false;
    }

    const now = Date.now();
    const cooldown = reason === 'mention' ? GROUP_ASIDE_MENTION_COOLDOWN_MS : GROUP_ASIDE_COOLDOWN_MS;
    if (now - (groupAsideLastSent.get(key) || 0) < cooldown) {
        return false;
    }

    const threadStore = getConversationThreadStore(character.avatar, { create: false, groupId: '', personaId });
    if (!threadStore?.branches?.[branchId]) {
        return false;
    }
    const validateTarget = () => Boolean(
        getConversationThreadStore(character.avatar, { create: false, groupId: '', personaId })?.branches?.[branchId]
        && isCapturedRoleplaySourceValid({ ...captured, avatar: character.avatar }),
    );

    groupAsideBusyKeys.add(key);
    try {
        const userName = getConversationPersonaName(personaId, 'User');
        const characterName = character.name || 'Character';
        const reasonLine = reason === 'mention'
            ? `${userName} just mentioned or addressed you in the group chat. Send them a private aside DM about it.`
            : 'Send a private aside DM while the group chat is ongoing. React to the group if there is something worth reacting to; otherwise start a natural casual DM topic.';
        const directive = `[System directive: You are ${characterName}, currently present in the active group chat. ${reasonLine} This message goes only to ${userName} in Conversation Mode, not into the group chat. Keep it short, casual, in-character, and suitable as one or two chat bubbles. Output only your DM body, without a name prefix.\n\nRecent group chat context:\n${groupContext}]`;
        const response = await generateConversationReply(directive, settings, {
            speakerName: characterName,
            trimNames: false,
            avatar: character.avatar,
            branchId,
            groupId: null,
            personaId,
        });

        if (response?.trim() && validateTarget()) {
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

            const postedText = await withTypingParticipant(character, () => postCharacterReply(response.trim(), settings, {
                extra,
                branchId,
                groupId: null,
                personaId,
                validateTarget,
            }, character.avatar), character.avatar, { branchId, groupId: null, personaId });
            if (postedText) {
                groupAsideLastSent.set(key, Date.now());
                return true;
            }
        }
    } catch (err) {
        reportConversationGenerationError('group aside DM', err, { toast: false });
    } finally {
        groupAsideBusyKeys.delete(key);
    }

    return false;
}

export async function triggerRoleplayDM(options = {}) {
    const captured = options.branchId ? options : captureRoleplayDMRequest(options);
    if (!captured || !isCapturedRoleplaySourceValid(captured)) return false;
    const { avatar, branchId, personaId, roleplayContext } = captured;
    const character = getCharacterForAvatar(avatar);
    if (!character || !avatar) return false;

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId: '', personaId });
    if (!threadStore?.branches?.[branchId]) return false;

    const settings = getSettings(avatar, { groupId: '', personaId });
    const sheld = document.getElementById('sheld');
    if (!settings.enabled || (sheld instanceof HTMLElement && sheld.dataset.sbConversationMode === 'on')) {
        return false;
    }

    const chatText = String(roleplayContext).trim();
    if (!chatText) return false;
    const validateTarget = () => Boolean(
        getConversationThreadStore(avatar, { create: false, groupId: '', personaId })?.branches?.[branchId]
        && isCapturedRoleplaySourceValid(captured),
    );
    const directive = `[System directive: You are sending a private direct message (DM) to {{user}} to comment on the ongoing roleplay/story scene. Step out of the main scene and send a short, private, personal DM sharing your inner thoughts, a side-comment, or a private reaction to what just happened. Keep it short, casual, and completely in-character. Do not continue the roleplay scene; write a private side-message.\n\nRoleplay context:\n${chatText}]`;

    try {
        console.log(`Generating private roleplay DM from ${character.name}...`);
        const response = await generateConversationReply(directive, settings, {
            speakerName: character.name || 'Character',
            trimNames: true,
            avatar,
            branchId,
            groupId: '',
            personaId,
        });

        if (response?.trim() && validateTarget()) {
            const postedText = await postCharacterReply(response.trim(), settings, {
                extra: { conversation_mode_gossip: true, gossip_source_roleplay: true },
                branchId,
                groupId: '',
                personaId,
                validateTarget,
            }, avatar);
            return Boolean(postedText);
        }
    } catch (err) {
        reportConversationGenerationError('roleplay side DM', err, { toast: false });
    }
    return false;
}

export async function checkConversationReminders(now) {
    const store = getConversationStore();
    if (!Array.isArray(store.reminders) || !store.reminders.length) {
        return false;
    }

    const personaId = getConversationPersonaId();
    const dueReminders = store.reminders.filter(rem => {
        const retryAfter = parsePositiveInt(rem.retryAfter, 0, 0);
        return getConversationPersonaId(rem?.personaId) === personaId
            && now >= rem.triggerAt
            && !rem.fired
            && !rem.invalidAt
            && (!retryAfter || now >= retryAfter);
    });
    if (!dueReminders.length) {
        return false;
    }

    const reminder = dueReminders[0];
    const avatar = reminder.avatar;
    const groupId = reminder.groupId || '';
    const reminderPersonaId = getConversationPersonaId(reminder.personaId);
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId: reminderPersonaId });
    const branchId = resolveConversationReminderBranchId(reminder, threadStore);
    if (!branchId) {
        reminder.invalidAt = now;
        reminder.invalidReason = 'missing_branch';
        persistConversationStore();
        return false;
    }
    reminder.branchId = branchId;
    const settings = getSettings(avatar, { groupId, personaId: reminderPersonaId });

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
            groupId,
        }, avatar, { branchId, personaId: reminderPersonaId });

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

export async function conversationModeAutoMessageWorker({ signal = conversationState.autoWorkerAbortController?.signal } = {}) {
    if (isAutoWorkerAborted(signal) || getUserStatus() === 'offline') {
        return;
    }

    if (conversationState.autoWorkerBusy || conversationState.conversationReplyBusy || conversationState.sendQueueProcessing || sendQueue.length || is_send_press) {
        return;
    }

    const now = Date.now();
    const personaId = getConversationPersonaId();

    if (await checkConversationReminders(now)) {
        return;
    }
    if (isAutoWorkerAborted(signal)) {
        return;
    }

    const railItems = getConversationRailItems({ personaId });
    const lastAutoMessageTimes = new Map();
    const getTickLastAutoMessageTime = (avatar, groupId, branchId) => {
        const key = `${personaId}:${groupId || ''}:${avatar || ''}:${branchId}`;
        if (!lastAutoMessageTimes.has(key)) {
            lastAutoMessageTimes.set(key, getLastAutoMessageTime(avatar, { branchId, groupId, personaId }));
        }
        return lastAutoMessageTimes.get(key);
    };

    for (const { character, settings, groupId = '' } of railItems) {
        if (isAutoWorkerAborted(signal)) {
            return;
        }

        const avatar = character.avatar;
        const branchId = getConversationThreadStore(avatar, { create: false, groupId, personaId })?.activeBranchId || '';
        if (!branchId) {
            continue;
        }
        const lastAutoMessageAt = getTickLastAutoMessageTime(avatar, groupId, branchId);
        const elapsedSeconds = (now - lastAutoMessageAt) / 1000;
        if (elapsedSeconds < settings.cooldown) {
            continue;
        }

        if (await checkScheduledAutoMessages(avatar, settings, now, { branchId, groupId, personaId })) {
            return;
        }
        if (isAutoWorkerAborted(signal)) {
            return;
        }

        // Marinara-style proactive loop takes priority over legacy idle action.
        if (settings.proactive_messaging) {
            if (await checkProactiveMessaging(avatar, settings, now, { branchId, groupId, lastAutoMessageAt, personaId })) {
                return;
            }
        } else if (await checkIdleAutoMessage(avatar, settings, now, { branchId, groupId, personaId })) {
            return;
        }
        if (isAutoWorkerAborted(signal)) {
            return;
        }

        if (await checkMultiCharacterChime(avatar, settings, now, { branchId, groupId, personaId })) {
            return;
        }
        if (isAutoWorkerAborted(signal)) {
            return;
        }

        if (await checkAutoCharacterChat(avatar, settings, now, { branchId, groupId, personaId })) {
            return;
        }
    }
}

export async function handleAvailabilityAutoResponder(settings = getSettings(), avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return false;
    }

    if (!settings.enabled || !['offline', 'dnd'].includes(settings.availability)) {
        return false;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const userName = getConversationPersonaName(personaId, 'User');
    const offlineText = (settings.offline_message || DEFAULT_SETTINGS.offline_message)
        .replace(/{{char}}/g, charName)
        .replace(/{{user}}/g, userName);
    await appendConversationMessage(offlineText, {
        extra: {
            conversation_mode_auto_responder: true,
            availability: settings.availability,
        },
        branchId,
        groupId,
        personaId,
    }, avatar);
    return true;
}

export function handleChatChanged() {
    loadCurrentPanelSettings();
}
