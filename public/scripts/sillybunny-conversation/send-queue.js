/**
 * The send queue: the replies that characters write to what the user sent, one item after another. The composer
 * (`attachments.js`) fills it, and so do the event stream and the round resumer, on pages that never open the workspace,
 * which is why it does not live with the composer.
 */

import { is_send_press } from '../../script.js';
import { MAX_REPLY_TRIGGERS } from '../conversation-commit-plan.js';
import { pageId } from '../resumable-generation.js';
import { handleAvailabilityAutoResponder } from './auto-engine.js';
import {
    AUTO_WORKER_WAIT_POLL_MS,
    AUTO_WORKER_WAIT_TIMEOUT_MS,
    CHROME_IDS,
    DEFAULT_SETTINGS,
    GROUP_MAX_CONCURRENT_SPEAKERS,
    SEND_QUEUE_BATCH_MS,
    SEND_QUEUE_COALESCE_MS,
} from './constants.js';
import {
    getConversationGroupById,
    getConversationPersonaId,
    getConversationKey,
    getConversationRecord,
    getCurrentCharName,
} from './context.js';
import { generateConversationReply, postCharacterReply, postMemberConversationReply, reportConversationGenerationError } from './generation.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar } from './media.js';
import { isCharacterMentionedInText } from './members.js';
import { formatPromptText } from './shared-helpers.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { getSettings } from './settings-store.js';
import {
    beginConversationGenerationOperation,
    conversationState,
    endConversationGenerationOperation,
    memberReplyBusyKeys,
    sendQueue,
} from './state.js';
import {
    buildConversationMessageReplyReference,
    ensureConversationChatLoaded,
    getConversationMessages,
    getImageCooldownRemainingSeconds,
    markImageGenerated,
    reloadConversationChat,
} from './conversation-store.js';
import { createConversationReplyPlan, createReplyToken } from './reply-commit-plan.js';
import { createRoundMarker, roundMayContinue, roundMemory } from './rounds.js';
import { chooseGroupSpeakers } from './speaker-selection.js';
import { getTalkativeness } from './talkativeness.js';
import { getConversationActivityContext, maybePostDelayedReplyNotice, withTypingParticipant } from './typing.js';
import { appendConversationMessage } from './message-writer.js';
import {
    coalesceConversationQueueItems,
    createConversationMessageRevisionEntries,
    createConversationQueueItem,
    createConversationQueueReplyTarget,
    createForcedConversationQueueItem,
    getLastConversationQueueUserMessage,
    requeueConversationQueueItem,
    resolveConversationQueueReplyTarget,
    resolveConversationQueueTriggerMessages,
} from './send-queue-utils.js';

const CONVERSATION_QUEUE_RETRY = 'retry';

export function focusConversationInput() {
    const input = document.getElementById(CHROME_IDS.input);
    if (input instanceof HTMLTextAreaElement && !input.disabled) {
        input.focus({ preventScroll: true });
    }
}

export async function waitForAutoWorker() {
    const startTime = Date.now();

    while (conversationState.autoWorkerBusy) {
        if (Date.now() - startTime >= AUTO_WORKER_WAIT_TIMEOUT_MS) {
            console.warn('Conversation Mode auto worker wait timed out; continuing queued reply.');
            break;
        }

        await new Promise(resolve => setTimeout(resolve, AUTO_WORKER_WAIT_POLL_MS));
    }
}

export async function waitForRoleplayGeneration() {
    const startTime = Date.now();
    while (is_send_press && Date.now() - startTime < AUTO_WORKER_WAIT_TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, AUTO_WORKER_WAIT_POLL_MS));
    }
    return !is_send_press;
}

function getConversationSpeakerAvatar(message, anchorAvatar) {
    if (!message || ['user', 'system'].includes(message.role || '')) {
        return '';
    }

    return message.role === 'member'
        ? String(message.extra?.member_avatar || '')
        : String(anchorAvatar || '');
}

function getGroupReplyCandidates(anchorAvatar, groupId, personaId) {
    const group = getConversationGroupById(groupId, { personaId });
    if (!group?.members?.length) {
        return [];
    }

    return group.members
        .filter(avatar => avatar && !group.disabled_members?.includes(avatar))
        .map((avatar) => {
            const character = getCharacterForAvatar(avatar);
            return character?.avatar
                ? { character, settings: getSettings(character.avatar, { groupId, personaId }) }
                : null;
        })
        .filter(Boolean);
}

function getGroupReplyBusyKey(anchorAvatar, groupId, replyAvatar) {
    return ['group-reply', groupId || '', anchorAvatar || '', replyAvatar || ''].join(':');
}

function chooseGroupReplyCandidates(anchorAvatar, groupId, queueItem, { force = false } = {}) {
    const candidates = getGroupReplyCandidates(anchorAvatar, groupId, queueItem?.personaId);
    if (!candidates.length) {
        return [];
    }

    const availableCandidates = force
        ? candidates
        : candidates.filter(({ character, settings }) => getConversationActivityContext(settings, character.avatar, new Date(), { personaId: queueItem?.personaId }).status !== 'offline');
    const pool = availableCandidates.length ? availableCandidates : candidates;
    const candidateCharacters = pool.map(item => item.character).filter(Boolean);
    const latestUserText = [queueItem?.text, queueItem?.attachmentContext].filter(Boolean).join('\n');
    const conversationMessages = getConversationMessages(anchorAvatar, {
        chatId: queueItem?.chatId,
        create: false,
        groupId,
        personaId: queueItem?.personaId,
    });

    return chooseGroupSpeakers({
        members: pool.map(({ character }) => ({
            avatar: character.avatar,
            talkativeness: getTalkativeness(character.avatar),
            mentioned: isCharacterMentionedInText(character, latestUserText, candidateCharacters),
        })),
        speakers: conversationMessages.map(message => getConversationSpeakerAvatar(message, anchorAvatar)),
        latestUserText,
    }).map(speaker => pool.find(({ character }) => character.avatar === speaker.avatar));
}

async function waitForConversationSpeakerAvailability(queueItem, settings, avatar, groupId) {
    const personaId = queueItem?.personaId || getConversationPersonaId();
    if (!queueItem?.force) {
        if (getConversationActivityContext(settings, avatar, new Date(), { personaId }).status === 'offline') {
            return false;
        }

        if (!groupId && await handleAvailabilityAutoResponder(settings, avatar, {
            chatId: queueItem?.chatId,
            groupId,
            personaId: queueItem?.personaId,
        })) {
            return false;
        }
    }

    const status = getConversationActivityContext(settings, avatar, new Date(), { personaId }).status || 'online';
    if (!queueItem?.force && (status === 'idle' || status === 'dnd')) {
        const initialDelayMs = status === 'idle'
            ? (Math.random() * 1.5 + 1.5) * 1000
            : (Math.random() * 3 + 3) * 1000;
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }

    return true;
}

async function processConversationSpeakerReply(queueItem, { anchorAvatar, groupId, conversationSettings, replyCandidate = null, skipAvailabilityWait = false, round = [], roundStarted = Date.now() } = {}) {
    const chatId = queueItem?.chatId || '';
    const personaId = queueItem?.personaId || '';
    const replyCharacter = replyCandidate?.character || getCharacterForAvatar(anchorAvatar);
    const replyAvatar = replyCharacter?.avatar || anchorAvatar;
    const replySettings = replyCandidate?.settings || conversationSettings;
    const validateTarget = () => {
        // A member that left the group while its reply was being written does not speak: its reply is discarded.
        if (groupId && !getConversationGroupById(groupId, { personaId })?.members?.includes(replyAvatar)) {
            return false;
        }
        const messages = getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId });
        if (resolveConversationQueueTriggerMessages(queueItem, messages) === null) {
            return false;
        }
        const replyTarget = resolveConversationQueueReplyTarget(queueItem, messages, anchorAvatar);
        return !replyTarget.explicit || replyTarget.valid;
    };
    if (!skipAvailabilityWait && !await waitForConversationSpeakerAvailability(queueItem, replySettings, replyAvatar, groupId)) {
        return false;
    }
    if (!validateTarget()) {
        return false;
    }

    maybePostDelayedReplyNotice(anchorAvatar, replySettings, { chatId, groupId, personaId, statusAvatar: replyAvatar });

    const speakerName = replyCharacter?.name || (replyAvatar === anchorAvatar ? getCurrentCharName() : 'Character');
    // The server writes this reply into the chat if this page is gone before the reply is. The token names the reply on
    // every bubble that this page writes itself, so that a late commit of the server after a failed claim is refused.
    const token = createReplyToken();
    const commit = {
        createPlan: route => createConversationReplyPlan({
            address: { conversationId: queueItem.conversationKey, chatId },
            queueItem,
            speaker: { avatar: replyAvatar, name: speakerName },
            anchorAvatar,
            route,
            messages: getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId }),
            round,
            token,
            pageId,
            now: Date.now(),
            roundStarted,
        }),
        state: null,
    };
    // The last bubble of a reply that is not the last of its round names the members still to speak, so that a page that
    // opens the chat after this one closed can carry the round on (`findRoundToResume()`).
    const roundMarker = round.length ? createRoundMarker({ remaining: round, started: roundStarted, triggers: queueItem.messageIds.slice(-MAX_REPLY_TRIGGERS) }) : null;
    const attachmentContext = formatPromptText(queueItem?.attachmentContext, 3200);
    const systemDirective = queueItem?.force
        ? '[System directive: Generate a response/reply to the user in the Conversation Mode thread.]'
        : '[System directive: The user sent the latest DM(s). Reply directly to them in the Conversation Mode thread.]';
    const response = await withTypingParticipant(replyCharacter || { avatar: replyAvatar, name: speakerName }, () => generateConversationReply(
        [
            systemDirective,
            attachmentContext ? `Latest user attachment context:\n${attachmentContext}` : '',
        ].filter(Boolean).join('\n\n'),
        replySettings,
        {
            avatar: replyAvatar,
            anchorAvatar,
            speakerAvatar: replyAvatar,
            speakerName,
            chatId,
            groupId,
            personaId,
            commit,
        },
    ), anchorAvatar, { chatId, groupId, personaId });
    if (commit.state === 'committed') {
        // The server wrote the reply while this page waited, and it could not be taken back. It is a pending message in
        // the chat now: reading the chat again lands it as bubbles, which this page must not write a second time.
        await reloadConversationChat(anchorAvatar, { chatId, groupId, personaId });
        return true;
    }
    if (!validateTarget()) {
        return false;
    }

    const replyExtra = {
        conversation_mode_reply: true,
        reply_token: token,
        ...(queueItem.replyReference ? { conversation_reply_to: queueItem.replyReference } : {}),
    };
    // The characters of a reply may react to the last message of the user that it answers.
    const triggerMessage = getLastConversationQueueUserMessage(queueItem, getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId }));
    const reactionTarget = triggerMessage?.id ? { messageId: triggerMessage.id } : null;
    let posted = false;
    if (response?.trim()) {
        if (replyAvatar === anchorAvatar) {
            const postedText = await postCharacterReply(response.trim(), replySettings, {
                extra: {
                    ...replyExtra,
                },
                chatId,
                groupId,
                personaId,
                validateTarget,
                roundMarker,
                reactionTarget,
            }, anchorAvatar);
            posted = Boolean(postedText);
        } else {
            posted = await postMemberConversationReply(response.trim(), replyCharacter, replySettings, {
                avatar: anchorAvatar,
                chatId,
                extra: {
                    ...replyExtra,
                    member_avatar: replyAvatar,
                },
                groupId,
                personaId,
                validateTarget,
                roundMarker,
                reactionTarget,
            });
        }
    }

    const imageKeywords = /\b(send\s*pic|selfie|photo|image|picture|show\s*me)\b/i;
    const wantsImage = replySettings.image_gen_enabled
        && (replySettings.spontaneous_selfies || imageKeywords.test(queueItem.text || ''));
    if (wantsImage && getImageCooldownRemainingSeconds(replyAvatar, replySettings, Date.now(), { chatId, groupId, personaId }) === 0) {
        if (!validateTarget()) {
            return posted;
        }
        const prompt = buildCharacterImagePrompt(
            replySettings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
            'the current conversation',
            replyAvatar,
        );
        const imageUrl = await generateConversationImage(prompt, replySettings.image_gen_negative || '', { avatar: replyAvatar, character: replyCharacter });
        if (imageUrl && validateTarget()) {
            markImageGenerated(replyAvatar, Date.now(), { chatId, groupId, personaId });
            await appendConversationMessage('Here, I can show you.', {
                name: speakerName,
                role: replyAvatar === anchorAvatar ? 'character' : 'member',
                extra: {
                    conversation_mode_image: true,
                    image_url: imageUrl,
                    image_prompt: prompt,
                    reply_token: token,
                    ...(replyAvatar === anchorAvatar ? {} : { member_avatar: replyAvatar }),
                },
                chatId,
                groupId,
                personaId,
            }, anchorAvatar);
            posted = true;
        }
    }

    return posted;
}

async function processGroupConversationSpeakerReply(queueItem, options) {
    const replyAvatar = options?.replyCandidate?.character?.avatar;
    const busyKey = getGroupReplyBusyKey(options?.anchorAvatar, options?.groupId, replyAvatar);
    if (!replyAvatar || memberReplyBusyKeys.has(busyKey)) {
        return false;
    }

    memberReplyBusyKeys.add(busyKey);
    try {
        return await processConversationSpeakerReply(queueItem, options);
    } finally {
        memberReplyBusyKeys.delete(busyKey);
    }
}

/** The members that a page that opened the chat carries a round on with: the ones still to speak that are in the group and available. */
function getResumedRoundCandidates(anchorAvatar, groupId, queueItem) {
    const candidates = getGroupReplyCandidates(anchorAvatar, groupId, queueItem.personaId);
    return queueItem.round.remaining
        .map(avatar => candidates.find(candidate => candidate.character.avatar === avatar))
        .filter(candidate => candidate && (queueItem.force || getConversationActivityContext(candidate.settings, candidate.character.avatar, new Date(), { personaId: queueItem.personaId }).status !== 'offline'))
        .slice(0, GROUP_MAX_CONCURRENT_SPEAKERS);
}

/**
 * The members of a group answer one message one after another, so that each reads the reply before its own. Each reply
 * lists the members still to speak in its commit plan, which is what lets the server and the next page that opens the
 * chat carry the round on. The reply that is being written when the user sends a message is allowed to finish; the
 * members that have not started are dropped (`roundMayContinue()`), and the new message starts a round of its own.
 */
async function runGroupRound(queueItem, { anchorAvatar, groupId, conversationSettings, replyCandidates }) {
    const { chatId, personaId } = queueItem;
    const roundStarted = queueItem.round?.started ?? Date.now();
    // This page runs the round, so it never carries it on again from a marker that it reads in the chat.
    roundMemory.note(roundStarted);
    for (const [index, replyCandidate] of replyCandidates.entries()) {
        if (index > 0 && !roundMayContinue({ queueItem, messages: getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId }), queue: sendQueue })) {
            return;
        }
        // A member that left the group since the round was planned is skipped, which is not a reason to stop.
        if (!getConversationGroupById(groupId, { personaId })?.members?.includes(replyCandidate.character.avatar)) {
            continue;
        }
        try {
            await processGroupConversationSpeakerReply(queueItem, {
                anchorAvatar,
                groupId,
                conversationSettings,
                replyCandidate,
                round: replyCandidates.slice(index + 1).map(candidate => candidate.character.avatar),
                roundStarted,
            });
        } catch (error) {
            reportConversationGenerationError('group reply', error);
        }
    }
}

export async function processQueuedConversationReply(queueItem) {
    const avatar = queueItem?.avatar;
    if (!avatar) {
        return;
    }
    if (is_send_press) {
        return CONVERSATION_QUEUE_RETRY;
    }

    const groupId = queueItem?.groupId || '';
    const personaId = queueItem?.personaId || getConversationPersonaId();
    const chatId = queueItem?.chatId || '';
    const conversationKey = getConversationKey(avatar, groupId, { personaId });
    if (!conversationKey || queueItem?.conversationKey !== conversationKey) {
        return;
    }
    const conversationRecord = getConversationRecord(avatar, { groupId, personaId });
    if (!chatId || !conversationRecord?.chats.some(entry => entry.id === chatId)) {
        return;
    }
    if (!await ensureConversationChatLoaded(avatar, { chatId, groupId, personaId })) {
        return;
    }
    const chatMessages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
    const triggerMessages = resolveConversationQueueTriggerMessages(queueItem, chatMessages);
    if (!triggerMessages) {
        return;
    }

    await waitForAutoWorker();

    if (is_send_press) {
        return CONVERSATION_QUEUE_RETRY;
    }

    const currentChatMessages = getConversationMessages(avatar, {
        chatId,
        create: false,
        groupId,
        personaId,
    });
    const currentTriggerMessages = resolveConversationQueueTriggerMessages(queueItem, currentChatMessages);
    if (!currentTriggerMessages) {
        return;
    }
    const triggeringUserMessage = getLastConversationQueueUserMessage(queueItem, currentChatMessages);
    queueItem.replyReference = buildConversationMessageReplyReference(triggeringUserMessage);
    const replyTarget = resolveConversationQueueReplyTarget(queueItem, currentChatMessages, avatar);
    if (replyTarget.explicit && !replyTarget.valid) {
        return;
    }

    const conversationSettings = getSettings(avatar, { groupId, personaId });

    const operation = beginConversationGenerationOperation();
    scheduleInterfaceRefresh();

    try {
        // A reply to the message of an extra of a direct conversation is a message to the character: extras do not speak.
        if (replyTarget.explicit && (groupId || replyTarget.speakerAvatar === avatar)) {
            const replyCandidate = groupId
                ? getGroupReplyCandidates(avatar, groupId, personaId).find(candidate => candidate.character.avatar === replyTarget.speakerAvatar)
                : { character: getCharacterForAvatar(avatar), settings: conversationSettings };
            if (!replyCandidate?.character?.avatar) {
                return;
            }

            if (groupId) {
                await processGroupConversationSpeakerReply(queueItem, { anchorAvatar: avatar, groupId, conversationSettings, replyCandidate });
            } else {
                await processConversationSpeakerReply(queueItem, { anchorAvatar: avatar, groupId, conversationSettings, replyCandidate });
            }
            return;
        }

        if (groupId) {
            const replyCandidates = queueItem.round
                ? getResumedRoundCandidates(avatar, groupId, queueItem)
                : chooseGroupReplyCandidates(avatar, groupId, queueItem, { force: Boolean(queueItem?.force) });
            await runGroupRound(queueItem, { anchorAvatar: avatar, groupId, conversationSettings, replyCandidates });
            return;
        }

        if (!await waitForConversationSpeakerAvailability(queueItem, conversationSettings, avatar, groupId)) {
            return;
        }

        await processConversationSpeakerReply(queueItem, {
            anchorAvatar: avatar,
            groupId,
            conversationSettings,
            skipAvailabilityWait: true,
        });
    } catch (error) {
        reportConversationGenerationError('reply', error);
    } finally {
        endConversationGenerationOperation(operation);
        scheduleInterfaceRefresh();
    }
}

async function collectConversationQueueItem(firstItem) {
    return coalesceConversationQueueItems(firstItem, sendQueue, {
        windowMs: SEND_QUEUE_COALESCE_MS,
    });
}

export async function processSendQueue({ processItem = processQueuedConversationReply, waitForRoleplay = waitForRoleplayGeneration } = {}) {
    if (conversationState.sendQueueProcessing) {
        conversationState.sendQueueNeedsProcessing = true;
        return;
    }

    conversationState.sendQueueProcessing = true;
    try {
        do {
            conversationState.sendQueueNeedsProcessing = false;
            while (sendQueue.length) {
                const queueItem = await collectConversationQueueItem(sendQueue.shift());
                if (!queueItem) {
                    continue;
                }
                const result = await processItem(queueItem);
                if (result !== CONVERSATION_QUEUE_RETRY) {
                    queueItem.onProcessed?.();
                }
                if (result === CONVERSATION_QUEUE_RETRY) {
                    requeueConversationQueueItem(sendQueue, queueItem);
                    if (!await waitForRoleplay()) {
                        conversationState.sendQueueNeedsProcessing = false;
                        setTimeout(() => void processSendQueue(), AUTO_WORKER_WAIT_POLL_MS);
                        break;
                    }
                    continue;
                }
                if (sendQueue.length) {
                    await new Promise(resolve => setTimeout(resolve, SEND_QUEUE_BATCH_MS));
                }
            }
        } while (conversationState.sendQueueNeedsProcessing && sendQueue.length);
    } finally {
        conversationState.sendQueueNeedsProcessing = false;
        conversationState.sendQueueProcessing = false;
        focusConversationInput();
    }
}

/**
 * Puts a reply in the send queue and waits for the queue to process it.
 * @param {object} queueItem
 * @returns {Promise<void>} Resolves once the reply is done, whether or not it wrote anything.
 */
export function enqueueConversationReply(queueItem) {
    return new Promise((resolve) => {
        queueItem.onProcessed = resolve;
        sendQueue.push(queueItem);
        void processSendQueue();
    });
}

/**
 * Asks the conversation to answer the last message of the user again: the composer sends this when it is empty, and a
 * reply that a server restart lost is offered again through it.
 * @param {string} avatar The avatar that names the conversation.
 * @param {object} target
 * @param {string} target.chatId
 * @param {string} [target.groupId]
 * @param {string} target.personaId
 * @param {{ remaining: string[], started: number }|null} [target.round] The members of a group that answer, in this order, instead of the ones that are chosen.
 * @returns {boolean} False when the user has written nothing in the chat that a reply could answer.
 */
export function queueForcedConversationReply(avatar, { chatId, groupId = '', personaId, round = null }) {
    const chatMessages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
    if (!chatMessages.some(message => message?.role === 'user')) {
        return false;
    }

    sendQueue.push(createForcedConversationQueueItem({
        avatar,
        chatId,
        groupId,
        personaId,
        conversationKey: getConversationKey(avatar, groupId, { personaId }),
        createdAt: Date.now(),
        ...(round ? { round } : {}),
    }, chatMessages));
    void processSendQueue();
    return true;
}

if (typeof window !== 'undefined') {
    window.addEventListener('sb:queue-conversation-reply', (event) => {
        const detail = event?.detail || {};
        const avatar = String(detail.avatar || '').trim();
        const text = String(detail.text || '').trim();
        if (!avatar || !text) {
            return;
        }

        const createdAt = Number(detail.createdAt);
        const personaId = String(detail.personaId || getConversationPersonaId()).trim();
        const groupId = detail.groupId || '';
        const conversationRecord = getConversationRecord(avatar, { groupId, personaId });
        const chatId = String(detail.chatId || conversationRecord?.activeChatId || '').trim();
        if (!chatId) {
            return;
        }
        const messageIds = Array.isArray(detail.messageIds) ? detail.messageIds.filter(Boolean) : [];
        const messages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
        const triggerMessages = messageIds.map(messageId => messages.find(message => message?.id === messageId)).filter(Boolean);
        sendQueue.push(createConversationQueueItem({
            avatar,
            chatId,
            groupId,
            messageIds,
            messageRevisions: createConversationMessageRevisionEntries(triggerMessages),
            personaId,
            replyTarget: createConversationQueueReplyTarget(triggerMessages, messages),
            conversationKey: getConversationKey(avatar, groupId, { personaId }),
            text,
            attachmentContext: String(detail.attachmentContext || '').trim(),
            createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
            force: Boolean(detail.force),
        }));
        void processSendQueue();
    });
}
