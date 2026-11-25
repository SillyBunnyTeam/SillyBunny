import { chat, is_send_press } from '../../script.js';
import { pageId } from '../resumable-generation.js';
import { isTemporaryChat } from '../sillybunny-temporary-chat-state.js';
import { selected_group } from '../group-chats.js';
import {
    AUTO_WORKER_INTERVAL_GLOBAL_KEY,
    AUTO_WORKER_INTERVAL_MS,
    DEFAULT_SETTINGS,
    GROUP_ASIDE_COOLDOWN_MS,
    GROUP_ASIDE_MENTION_COOLDOWN_MS,
} from './constants.js';
import {
    getActiveConversationChat,
    getConversationAddress,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getCurrentCharAvatar,
    getCurrentCharName,
    getRoleplayCurrentCharacter,
    getRoleplayGroupById,
    parsePositiveInt,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { createTargetCheck } from './deletion-guards.js';
import { generateConversationReply, postCharacterReply, postMemberConversationReply, reportConversationGenerationError } from './generation.js';
import { loadCurrentPanelSettings } from './interface.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar } from './media.js';
import { appendConversationMessage } from './message-writer.js';
import {
    buildGroupChatContext,
    getConversationRailItems,
    getCurrentGroupConversationMembers,
    getGroupAsideKey,
} from './conversation-list.js';
import { isCharacterMentionedInText } from './members.js';
import { getConversationPersonaName, getUserStatus } from './personas.js';
import { claimReminderAttempt, getReminderState, getReminderToken, isReminderDue, markReminderDelivered, MAX_REMINDER_ATTEMPTS, settleFailedReminderAttempt } from './reminders.js';
import { createAutomaticReplyPlan, createAutomaticSlotToken } from './reply-commit-plan.js';
import { getReplyOriginFlags } from './reply-steps.js';
import { buildConversationRoleplayContext } from './shared-helpers.js';
import { getFollowupCount, getLastUserActivity, getSettings, setFollowupCount } from './settings-store.js';
import {
    conversationState,
    groupAsideBusyKeys,
    groupAsideLastSent,
    sendQueue,
} from './state.js';
import { clearConversationTimeouts, setConversationTimeout } from './timers.js';
import {
    ensureConversationChatLoaded,
    getConversationMessages,
    getImageCooldownRemainingSeconds,
    markImageGenerated,
    reloadConversationChat,
    resolveConversationReminderChatId,
} from './conversation-store.js';
import { getConversationActivityContext, withTypingParticipant } from './typing.js';
import { getEffectivePatienceMinutes, getTalkativeness } from './talkativeness.js';
import { createWorkerLock } from './worker-lock.js';
import { createWorkerRunner } from './worker-runner.js';
import { pickAutomaticSpeaker, planAutomaticMessage, readMessagingFirstSettings } from './worker-rules.js';

function isAutoWorkerAborted(signal) {
    return Boolean(signal?.aborted);
}

export function stopConversationAutoWorker() {
    // A copy of this module that the page loaded earlier may still run a worker of its own.
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY]?.stop?.();
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY] = null;
    conversationState.autoWorkerStarted = false;
    clearConversationTimeouts();
}

export function startConversationAutoWorker() {
    stopConversationAutoWorker();

    const runner = createWorkerRunner({
        lock: createWorkerLock(),
        tick: options => conversationModeAutoMessageWorker(options),
        intervalMs: AUTO_WORKER_INTERVAL_MS,
        windowTarget: window,
        documentTarget: document,
    });
    runner.start();
    globalThis[AUTO_WORKER_INTERVAL_GLOBAL_KEY] = runner;
    conversationState.autoWorkerStarted = true;
}

export async function maybeGenerateSpontaneousImage(settings, avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!settings.image_gen_enabled || !settings.spontaneous_selfies || getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { chatId, groupId, personaId }) > 0) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const prompt = buildCharacterImagePrompt(
        settings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
        'a spontaneous selfie in the current DM conversation',
        avatar,
    );
    const imageUrl = await generateConversationImage(prompt, settings.image_gen_negative || '', { avatar, character });
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { chatId, groupId, personaId });
        await appendConversationMessage('Snapped something for you.', {
            name: charName,
            role: 'character',
            extra: {
                conversation_mode_image: true,
                image_url: imageUrl,
                image_prompt: prompt,
            },
            chatId,
            groupId,
            personaId,
        }, avatar);
    }
}

export function getLastAutoMessageTime(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getActiveConversationChat(avatar, { chatId, groupId, personaId })?.lastAutoMessageAt, 0, 0);
}

export function setLastAutoMessageTime(avatar, timestamp = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (address) {
        conversationData.patchConversation(address.conversationId, { chats: { [address.chatId]: { lastAutoMessageAt: timestamp } } });
    }
}

/**
 * The checks that an automatic message runs before it writes, each time it is called: its conversation and chat still
 * exist, unless the user asked for the message the chat has a message from the user, and the user is not Invisible.
 * The conversation is read again each time, because a model can take minutes to answer and the conversation or the chat
 * can be deleted meanwhile. Null when the message cannot be written now.
 * @returns {{ address: { conversationId: string, chatId: string }, check: () => boolean }|null}
 */
function createAutomaticTargetCheck(avatar, { chatId = '', groupId = '', personaId = getConversationPersonaId() } = {}, { needsUserMessage = true } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (!address) {
        return null;
    }
    const exists = createTargetCheck(id => conversationData.get(id), address, { needsUserMessage });
    const check = () => exists() && getUserStatus() !== 'offline';
    return check() ? { address, check } : null;
}

/** Whether the chat holds a message of this reply, written by this page, another page, or the server. */
function hasMessageOfReply(avatar, token, { chatId, groupId, personaId }) {
    return getConversationMessages(avatar, { chatId, create: false, groupId, personaId }).some(message => message?.extra?.reply_token === token);
}

/**
 * Sends one automatic message of a character: a check-in to the user, members talking to each other, or a reminder.
 * The reply is asked for with a commit plan, so that the server writes it into the chat when this page is closed before
 * the model has answered, and a page that opens the chat later lands it (`reply-finalizer.js`).
 *
 * `onStart` writes the bookkeeping that tells the next tick that this message is on its way. It runs after the
 * checks and before the request, because a page that is closed during the request writes nothing afterwards, and a
 * message that the server writes later would otherwise be sent again by the next page.
 * The token names the message, so that a second attempt at it, on this page or another, is refused when the chat has it.
 *
 * @param {object} message
 * @param {'auto'|'auto_chat'|'reminder'} message.origin
 * @param {string} message.anchorAvatar The avatar that names the conversation.
 * @param {{ avatar: string, name: string }} message.speaker
 * @param {string} message.directive
 * @param {string} message.token
 * @param {boolean} [message.needsUserMessage] False for a reminder, which the user asked for; every other automatic message waits for the user to have written in the chat.
 * @param {() => boolean} [message.isStillWanted] False when the message is no longer wanted, for instance a reminder that was cancelled.
 * @param {() => void} [message.onStart]
 * @param {boolean} [message.spontaneousImage] Whether a picture may follow the message, when the conversation allows them.
 * @returns {Promise<'posted'|'committed'|'already-sent'|'failed'|'not-started'>} `not-started` leaves no trace: nothing was asked of the model.
 */
export async function sendAutomaticMessage({ origin, anchorAvatar, speaker, groupId = '', personaId = getConversationPersonaId(), chatId, directive, token, settings, needsUserMessage = true, isStillWanted = () => true, onStart = () => {}, spontaneousImage = false, reminderId = '', extra = {} }) {
    const character = getCharacterForAvatar(speaker.avatar);
    if (conversationState.autoWorkerBusy || conversationState.conversationReplyBusy || is_send_press || !character || !getCharacterForAvatar(anchorAvatar)) {
        return 'not-started';
    }

    // The flag is set before the first wait, so that a reply to the user does not start in between; it keeps the reply of the user behind this message.
    conversationState.autoWorkerBusy = true;
    try {
        const target = createAutomaticTargetCheck(anchorAvatar, { chatId, groupId, personaId }, { needsUserMessage });
        if (!target) {
            return 'not-started';
        }
        const scope = { chatId, groupId, personaId };
        const validateTarget = () => target.check() && isStillWanted();

        // The chat is read for the prompt and written to with the reply. It also lands a reply that the server wrote into it while no page was open.
        try {
            await ensureConversationChatLoaded(anchorAvatar, scope);
        } catch {
            return 'not-started';
        }
        if (!target.check()) {
            return 'not-started';
        }
        if (hasMessageOfReply(anchorAvatar, token, scope)) {
            return 'already-sent';
        }
        if (!validateTarget()) {
            return 'not-started';
        }

        onStart();
        const commit = {
            createPlan: route => createAutomaticReplyPlan({
                address: target.address,
                speaker: { avatar: speaker.avatar, name: speaker.name },
                anchorAvatar,
                origin,
                route,
                messages: getConversationMessages(anchorAvatar, { ...scope, create: false }),
                token,
                pageId,
                now: Date.now(),
                reminderId,
            }),
            state: null,
        };
        const response = await generateConversationReply(directive, settings, {
            speakerName: speaker.name,
            trimNames: speaker.avatar === anchorAvatar,
            avatar: anchorAvatar,
            anchorAvatar,
            speakerAvatar: speaker.avatar,
            ...scope,
            commit,
        });

        if (commit.state === 'committed') {
            // The server wrote the reply while this page waited. Reading the chat again lands it as bubbles, which this page must not write a second time.
            await reloadConversationChat(anchorAvatar, scope);
            return 'committed';
        }
        const text = response?.trim();
        if (!text || !validateTarget()) {
            return 'failed';
        }
        if (hasMessageOfReply(anchorAvatar, token, scope)) {
            return 'already-sent';
        }

        const bubbleExtra = { ...getReplyOriginFlags(origin, reminderId), ...extra, reply_token: token };
        const isAnchor = speaker.avatar === anchorAvatar;
        const posted = isAnchor
            ? await withTypingParticipant(character, () => postCharacterReply(text, settings, { extra: bubbleExtra, ...scope, validateTarget }, anchorAvatar), anchorAvatar, scope)
            : await postMemberConversationReply(text, character, settings, { avatar: anchorAvatar, extra: { ...bubbleExtra, member_avatar: speaker.avatar }, ...scope, validateTarget });
        if (!posted) {
            return 'failed';
        }
        if (spontaneousImage && isAnchor && validateTarget()) {
            await maybeGenerateSpontaneousImage(settings, anchorAvatar, scope);
        }
        return 'posted';
    } catch (error) {
        reportConversationGenerationError(origin === 'reminder' ? 'reminder' : origin === 'auto_chat' ? 'character-to-character chat' : 'auto-message', error, { level: 'warning', toast: origin !== 'auto_chat' });
        return 'failed';
    } finally {
        conversationState.autoWorkerBusy = false;
    }
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

function buildMemberTalkDirective(speaker, target, activity, status) {
    return `[System directive: You are ${speaker.name}, speaking autonomously in a private group DM. Aim this message at ${target.name}, not the user, unless the user is directly relevant. You are currently ${activity} (status: ${status}). This is character-to-character ambient chat, so continue the casual conversation or start a friendly new topic with one short, natural message. Other people may reply later. Output only your message body, without a name prefix.]`;
}

/**
 * The characters that may send an automatic message in a conversation, with what the rules need to know of each:
 * the card's talkativeness and the status now. A direct conversation has its character only; extras do not speak.
 */
function getAutomaticMembers({ character, groupId, group }, view, personaId, now) {
    const avatars = groupId
        ? (group?.members ?? view.characters).filter(avatar => avatar && !group?.disabled_members?.includes(avatar))
        : [character.avatar];
    return avatars.flatMap((avatar) => {
        const card = getCharacterForAvatar(avatar);
        if (!card?.avatar) {
            return [];
        }
        const context = getConversationActivityContext(getSettings(avatar, { groupId, personaId }), avatar, new Date(now), { personaId });
        return [{ avatar, name: card.name || 'Character', talkativeness: getTalkativeness(avatar), status: context.status || 'online', activity: context.activity || 'free time' }];
    });
}

/**
 * Messaging first, the one switch of a conversation: after the patience of the speaker has passed with no word from the
 * user, a character writes first, and in a group, once that went unanswered, the members talk to each other. With the
 * switch off nothing here runs. At most `max_followups` messages follow the last message of the user.
 * @returns {Promise<boolean>} Whether a message was sent.
 */
export async function checkMessagingFirst(item, now, { personaId = getConversationPersonaId() } = {}) {
    const { character, settings, groupId = '' } = item;
    const { enabled, maxFollowups } = readMessagingFirstSettings(settings);
    if (!enabled) {
        return false;
    }

    const anchorAvatar = character.avatar;
    const view = getConversationRecord(anchorAvatar, { groupId, personaId });
    const chatId = view?.activeChatId || '';
    // A chat with no message from the user gets none, whether it is new or was emptied.
    const target = chatId ? createAutomaticTargetCheck(anchorAvatar, { chatId, groupId, personaId }) : null;
    if (!target) {
        return false;
    }

    const scope = { chatId, groupId, personaId };
    const sentCount = getFollowupCount(anchorAvatar, scope);
    const lastUserActivity = getLastUserActivity(anchorAvatar, now, scope);
    const lastAutoMessageAt = getLastAutoMessageTime(anchorAvatar, scope);
    const userStatus = getUserStatus();
    const isGroup = Boolean(groupId);
    const state = {
        now,
        lastUserActivity,
        lastAutoMessageAt,
        sentCount,
        maxFollowups,
        lastMessageRole: view.chats.find(entry => entry.id === chatId)?.lastMessageRole || '',
        userStatus,
        isGroup,
    };
    const dueMembers = getAutomaticMembers(item, view, personaId, now)
        .filter(member => (!isGroup || member.talkativeness > 0) && planAutomaticMessage({ ...state, patienceMinutes: getEffectivePatienceMinutes(view, member.avatar), speakerStatus: member.status }));
    if (!dueMembers.length) {
        return false;
    }

    // Who spoke last is read from the chat.
    try {
        await ensureConversationChatLoaded(anchorAvatar, scope);
    } catch {
        return false;
    }
    const speaker = pickAutomaticSpeaker({ members: dueMembers, messages: getConversationMessages(anchorAvatar, { ...scope, create: false }), anchorAvatar, isGroup });
    if (!speaker) {
        return false;
    }

    const { kind } = planAutomaticMessage({ ...state, patienceMinutes: getEffectivePatienceMinutes(view, speaker.avatar), speakerStatus: speaker.status });
    const others = getAutomaticMembers(item, view, personaId, now).filter(member => member.avatar !== speaker.avatar);
    const aimsAtMember = kind === 'member_talk' && others.length > 0;
    const directive = aimsAtMember
        ? buildMemberTalkDirective(speaker, others[Math.floor(Math.random() * others.length)], speaker.activity, speaker.status)
        : buildProactiveDirective(speaker.activity, speaker.status, new Date(now));
    const outcome = await sendAutomaticMessage({
        origin: aimsAtMember ? 'auto_chat' : 'auto',
        anchorAvatar,
        speaker,
        groupId,
        personaId,
        chatId,
        directive,
        settings: getSettings(speaker.avatar, { groupId, personaId }),
        token: createAutomaticSlotToken({ conversationId: view.id, chatId, lastUserActivity, sentCount }),
        spontaneousImage: !aimsAtMember,
        onStart: () => {
            setFollowupCount(anchorAvatar, sentCount + 1, scope);
            setLastAutoMessageTime(anchorAvatar, now, scope);
        },
    });
    return outcome === 'posted' || outcome === 'committed';
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
    const chatId = getConversationRecord(character?.avatar, { groupId: '', personaId })?.activeChatId || '';
    const groupContext = buildGroupChatContext();
    if (!group || !character?.avatar || !chatId || !groupContext || (sourceMessageId !== null && !sourceMessage)) {
        return null;
    }

    return {
        chatId,
        groupContext,
        personaId,
        reason,
        sourceGroupId: String(group.id || sourceGroupId || ''),
        sourceGroupRevision: getRoleplayGroupRevision(group),
        sourceMessageId,
        sourceMessageRevision: sourceMessage ? getRoleplaySourceMessageRevision(sourceMessage) : '',
    };
}

export function captureRoleplayAsideRequest({ avatar = getCurrentCharAvatar(), personaId = getConversationPersonaId(), roleplayContext = '', sourceMessageId = null } = {}) {
    // A temporary chat is never kept, so the character does not react to it in the Conversation store.
    if (isTemporaryChat()) {
        return null;
    }
    const sourceMessage = sourceMessageId !== null && typeof sourceMessageId !== 'undefined' ? chat[sourceMessageId] : null;
    const chatId = getConversationRecord(avatar, { groupId: '', personaId })?.activeChatId || '';
    const capturedContext = String(roleplayContext || buildConversationRoleplayContext(chat, sourceMessageId)).trim();
    if (!avatar || !chatId || !capturedContext || (sourceMessageId !== null && !sourceMessage)) {
        return null;
    }

    return {
        avatar,
        chatId,
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
                void triggerGroupAside(character, request);
            }
        }, 900);
    }
}

export async function triggerGroupAside(character, options = {}) {
    const captured = options.chatId ? options : captureGroupAsideRequest(character, options);
    if (!captured || !isCapturedRoleplaySourceValid({ ...captured, avatar: character?.avatar })) {
        return false;
    }
    const { chatId, groupContext, personaId, reason, sourceGroupId, sourceMessageId } = captured;
    const groupId = String(sourceGroupId || '');
    const group = getRoleplayGroupById(groupId);
    if (!group || !character?.avatar || !group.members?.includes(character.avatar) || group.disabled_members?.includes(character.avatar)) {
        return false;
    }

    const settings = getSettings(character.avatar, { groupId, personaId });
    if (!settings.roleplay_reactions) {
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

    const conversationRecord = getConversationRecord(character.avatar, { groupId: '', personaId });
    if (!conversationRecord?.chats?.some(entry => entry.id === chatId)) {
        return false;
    }
    const validateTarget = () => Boolean(
        getConversationRecord(character.avatar, { groupId: '', personaId })?.chats?.some(entry => entry.id === chatId)
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
            chatId,
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
                chatId,
                groupId: null,
                personaId,
                validateTarget,
            }, character.avatar), character.avatar, { chatId, groupId: null, personaId });
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

export async function triggerRoleplayAside(options = {}) {
    const captured = options.chatId ? options : captureRoleplayAsideRequest(options);
    if (!captured || !isCapturedRoleplaySourceValid(captured)) return false;
    const { avatar, chatId, personaId, roleplayContext } = captured;
    const character = getCharacterForAvatar(avatar);
    if (!character || !avatar) return false;

    const conversationRecord = getConversationRecord(avatar, { groupId: '', personaId });
    if (!conversationRecord?.chats?.some(entry => entry.id === chatId)) return false;

    const settings = getSettings(avatar, { groupId: '', personaId });
    const sheld = document.getElementById('sheld');
    if (sheld instanceof HTMLElement && sheld.dataset.sbConversationMode === 'on') {
        return false;
    }

    const chatText = String(roleplayContext).trim();
    if (!chatText) return false;
    const validateTarget = () => Boolean(
        getConversationRecord(avatar, { groupId: '', personaId })?.chats?.some(entry => entry.id === chatId)
        && isCapturedRoleplaySourceValid(captured),
    );
    const directive = `[System directive: You are sending a private direct message (DM) to {{user}} to comment on the ongoing roleplay/story scene. Step out of the main scene and send a short, private, personal DM sharing your inner thoughts, a side-comment, or a private reaction to what just happened. Keep it short, casual, and completely in-character. Do not continue the roleplay scene; write a private side-message.\n\nRoleplay context:\n${chatText}]`;

    try {
        const response = await generateConversationReply(directive, settings, {
            speakerName: character.name || 'Character',
            trimNames: true,
            avatar,
            chatId,
            groupId: '',
            personaId,
        });

        if (response?.trim() && validateTarget()) {
            const postedText = await postCharacterReply(response.trim(), settings, {
                extra: { conversation_mode_gossip: true, gossip_source_roleplay: true },
                chatId,
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

/** A reminder that used every attempt but was never marked, because the page closed during the last one, is given up. */
function giveUpExhaustedReminders(now) {
    for (const view of conversationData.list({ personaId: getConversationPersonaId() })) {
        for (const reminder of view.reminders) {
            if (getReminderState(reminder) === 'scheduled' && (reminder.attempts ?? 0) >= MAX_REMINDER_ATTEMPTS && now >= (reminder.retryAfter ?? 0)) {
                conversationData.patchReminder(view.id, reminder.id, { skippedAt: now });
            }
        }
    }
}

/**
 * Delivers the first reminder that is due. A reminder is tried at most `MAX_REMINDER_ATTEMPTS` times; the attempt is
 * written before its request starts, and a reminder that the server wrote while no page was open is marked delivered by
 * the page that lands it (`reply-finalizer.js`), so that the next page does not send it again.
 * @returns {Promise<boolean>} Whether a reminder was delivered.
 */
export async function checkConversationReminders(now) {
    giveUpExhaustedReminders(now);
    const personaId = getConversationPersonaId();
    const due = conversationData.list({ personaId })
        .flatMap(view => view.reminders.filter(reminder => isReminderDue(reminder, now)).map(reminder => ({ view, reminder })))
        .sort((first, second) => first.reminder.triggerAt - second.reminder.triggerAt);
    if (!due.length) {
        return false;
    }

    const { view, reminder } = due[0];
    const anchorAvatar = reminder.avatar;
    const groupId = view.kind === 'group' ? view.id : '';
    const chatId = resolveConversationReminderChatId(reminder, view);
    if (!chatId) {
        conversationData.patchReminder(view.id, reminder.id, { invalidAt: now });
        return false;
    }

    const stored = () => conversationData.get(view.id)?.reminders.find(item => item.id === reminder.id);
    const outcome = await sendAutomaticMessage({
        origin: 'reminder',
        anchorAvatar,
        speaker: { avatar: anchorAvatar, name: getCharacterForAvatar(anchorAvatar)?.name || 'Character' },
        groupId,
        personaId,
        chatId,
        settings: getSettings(anchorAvatar, { groupId, personaId }),
        directive: `[System directive: This is a scheduled reminder. Send a DM to the user reminding them about: "${reminder.text}". Do not mention system/bracketed code, just say it naturally in-character as a DM ping.]`,
        token: getReminderToken(reminder),
        reminderId: reminder.id,
        needsUserMessage: false,
        extra: { reminder_text: reminder.text },
        isStillWanted: () => Boolean(stored()) && !stored().fired,
        onStart: () => conversationData.patchReminder(view.id, reminder.id, { chatId, ...claimReminderAttempt(reminder, now) }),
    });

    if (outcome === 'not-started') {
        return false;
    }
    if (outcome === 'failed') {
        const current = stored();
        if (current) {
            conversationData.patchReminder(view.id, reminder.id, settleFailedReminderAttempt(current, Date.now()));
        }
        return false;
    }
    conversationData.patchReminder(view.id, reminder.id, markReminderDelivered(Date.now()));
    return true;
}

/**
 * One tick of the worker: the due reminder first, then each conversation that has messaging first on. The first message
 * that is sent ends the tick. The runner (`worker-runner.js`) calls it in the one tab that leads and never twice at once.
 */
export async function conversationModeAutoMessageWorker({ signal } = {}) {
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

    for (const item of getConversationRailItems({ personaId })) {
        if (isAutoWorkerAborted(signal)) {
            return;
        }
        if (await checkMessagingFirst(item, now, { personaId })) {
            return;
        }
    }
}

export async function handleAvailabilityAutoResponder(settings = getSettings(), avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return false;
    }

    if (!['offline', 'dnd'].includes(settings.availability)) {
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
        chatId,
        groupId,
        personaId,
    }, avatar);
    return true;
}

export function handleChatChanged() {
    loadCurrentPanelSettings();
}
