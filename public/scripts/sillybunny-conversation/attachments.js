import { is_send_press, online_status } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import { MAX_REPLY_TRIGGERS } from '../conversation-commit-plan.js';
import { pageId } from '../resumable-generation.js';
import { handleAvailabilityAutoResponder } from './auto-engine.js';
import {
    AUTO_WORKER_WAIT_POLL_MS,
    AUTO_WORKER_WAIT_TIMEOUT_MS,
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
    CONVERSATION_ATTACHMENT_MAX_BYTES,
    CONVERSATION_ATTACHMENT_MAX_FILES,
    CONVERSATION_MESSAGE_SENT_EVENT,
    DEFAULT_SETTINGS,
    GROUP_MAX_CONCURRENT_SPEAKERS,
    SAFE_TOAST_OPTIONS,
    SEND_QUEUE_BATCH_MS,
    SEND_QUEUE_COALESCE_MS,
} from './constants.js';
import {
    ensureDirectConversation,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationKey,
    getConversationRecord,
    getCurrentCharAvatar,
    getCurrentCharName,
} from './context.js';
import { generateConversationReply, postCharacterReply, postMemberConversationReply, reportConversationGenerationError } from './generation.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar } from './media.js';
import { isCharacterMentionedInText } from './members.js';
import { getConversationPersonaName } from './personas.js';
import { formatConversationFileSize } from './prompt.js';
import { formatPromptText } from './shared-helpers.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { escapeHtmlText } from './render-utils.js';
import { getSettings } from './settings-store.js';
import {
    beginConversationGenerationOperation,
    conversationState,
    endConversationGenerationOperation,
    memberReplyBusyKeys,
    sendQueue,
} from './state.js';
import { consumeConversationReplyTarget } from './timeline-render.js';
import {
    appendConversationChatMessage,
    buildConversationMessageReplyReference,
    ensureConversationChatLoaded,
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationMessages,
    getImageCooldownRemainingSeconds,
    markImageGenerated,
    reloadConversationChat,
    updateLastUserActivity,
} from './conversation-store.js';
import { createConversationReplyPlan, createReplyToken } from './reply-commit-plan.js';
import { createRoundMarker, roundMayContinue, roundMemory } from './rounds.js';
import { chooseGroupSpeakers } from './speaker-selection.js';
import { getTalkativeness } from './talkativeness.js';
import { handleConversationSlashAction } from './timeline-slash-commands.js';
import { getConversationActivityContext, maybePostDelayedReplyNotice, splitChatroomMessages, withTypingParticipant } from './typing.js';
import { appendConversationMessage } from './message-writer.js';
import { notifyNotConnected } from '../sillybunny-connection-notices.js';
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

export { appendConversationMessage };

const CONVERSATION_QUEUE_RETRY = 'retry';

function buildConversationUserMessageExtra(replyTarget = null) {
    return {
        conversation_mode_user: true,
        ...(replyTarget ? { conversation_reply_to: replyTarget } : {}),
    };
}

export function getConversationPendingFiles() {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.length) {
        return [];
    }

    return Array.from(fileInput.files);
}

export function getConversationFileExtension(file) {
    const name = String(file?.name || '').toLowerCase();
    const dotIndex = name.lastIndexOf('.');
    return dotIndex >= 0 ? name.slice(dotIndex) : '';
}

export function isConversationAttachmentAllowed(file) {
    const mime = String(file?.type || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
        return true;
    }

    return CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS.includes(getConversationFileExtension(file));
}

export function warnConversationAttachment(message) {
    globalThis.toastr?.warning?.(message, '', SAFE_TOAST_OPTIONS);
}

export function getValidatedConversationPendingFiles({ notify = false } = {}) {
    const files = getConversationPendingFiles();
    if (!files.length) {
        return files;
    }

    if (files.length > CONVERSATION_ATTACHMENT_MAX_FILES) {
        if (notify) {
            warnConversationAttachment(`Attach up to ${CONVERSATION_ATTACHMENT_MAX_FILES} files per Conversation message.`);
        }
        return null;
    }

    const oversized = files.find(file => Number(file?.size || 0) > CONVERSATION_ATTACHMENT_MAX_BYTES);
    if (oversized) {
        if (notify) {
            warnConversationAttachment(`${oversized.name || 'Attachment'} is over ${formatConversationFileSize(CONVERSATION_ATTACHMENT_MAX_BYTES)}.`);
        }
        return null;
    }

    const blocked = files.find(file => !isConversationAttachmentAllowed(file));
    if (blocked) {
        if (notify) {
            warnConversationAttachment(`${blocked.name || 'Attachment'} is not a supported Conversation attachment type.`);
        }
        return null;
    }

    return files;
}

export function updateConversationAttachmentPreview() {
    const preview = document.getElementById(CHROME_IDS.attachmentPreview);
    if (!(preview instanceof HTMLElement)) {
        return;
    }

    const files = getConversationPendingFiles();
    if (!files.length) {
        preview.hidden = true;
        preview.textContent = '';
        return;
    }

    const fileRows = files.slice(0, 4).map((file) => {
        const size = formatConversationFileSize(file.size);
        return `<span class="sb-conversation-attachment-pill"><i class="fa-solid fa-paperclip" aria-hidden="true"></i><span>${escapeHtmlText(file.name)}</span>${size ? `<small>${escapeHtmlText(size)}</small>` : ''}</span>`;
    });
    if (files.length > 4) {
        fileRows.push(`<span class="sb-conversation-attachment-pill">+${files.length - 4} more</span>`);
    }

    preview.innerHTML = `
        <div class="sb-conversation-attachment-list">${fileRows.join('')}</div>
        <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="clear-attachments" title="Clear Attachments" aria-label="Clear Attachments">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    `;
    preview.hidden = false;
}

export function clearConversationAttachmentInput() {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (fileInput instanceof HTMLInputElement) {
        fileInput.value = '';
    }
    updateConversationAttachmentPreview();
}

export function addConversationFilesToInput(files) {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement) || !files?.length) {
        return;
    }

    const transfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    const previousTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    if (!transfer || !previousTransfer) {
        return;
    }

    for (const file of Array.from(fileInput.files || [])) {
        previousTransfer.items.add(file);
        transfer.items.add(file);
    }
    for (const file of files) {
        transfer.items.add(file);
    }

    fileInput.files = transfer.files;
    if (getValidatedConversationPendingFiles({ notify: true })) {
        updateConversationAttachmentPreview();
    } else {
        fileInput.files = previousTransfer.files;
        updateConversationAttachmentPreview();
    }
}

export async function populateConversationUserAttachments(messageInput) {
    const pendingFiles = getValidatedConversationPendingFiles();
    if (!pendingFiles?.length) {
        return;
    }

    const { populateFileAttachment } = await import('./chats.js');
    await populateFileAttachment(messageInput, CHROME_IDS.fileInput);
    if (getConversationMediaAttachments(messageInput).length) {
        messageInput.extra.media_display = MEDIA_DISPLAY.LIST;
        messageInput.extra.inline_image = true;
    }
}

export async function buildConversationAttachmentPromptContext(messageInput, visibleText) {
    const summary = getConversationAttachmentSummary(messageInput);
    if (!summary) {
        return '';
    }

    const parts = [summary];
    if (getConversationFileAttachments(messageInput).length) {
        try {
            const { appendFileContent } = await import('./chats.js');
            const promptMessage = {
                ...messageInput,
                extra: { ...messageInput.extra },
            };
            const filePromptText = await appendFileContent(promptMessage, visibleText || '');
            const cleanPromptText = formatPromptText(filePromptText, 2800);
            const cleanVisibleText = formatPromptText(visibleText || '', 2800);
            if (cleanPromptText && cleanPromptText !== cleanVisibleText) {
                parts.push(`Attached file text: ${cleanPromptText}`);
            }
        } catch (error) {
            console.warn('Conversation Mode: could not read attachment text for prompt context', error);
        }
    }

    return parts.join('\n');
}

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

export async function submitConversationInput() {
    if (online_status === 'no_connection') {
        notifyNotConnected();
        return;
    }
    if (is_send_press || conversationState.conversationUploadActive) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const text = input.value.trim();
    const pendingFiles = getValidatedConversationPendingFiles({ notify: true });
    if (!pendingFiles) {
        return;
    }
    if (!avatar) {
        return;
    }

    // Writing to a character that has no conversation with this persona yet starts one.
    let conversationRecord = getConversationRecord(avatar, { groupId, personaId });
    if (!conversationRecord && !groupId && (text || pendingFiles.length)) {
        try {
            conversationRecord = await ensureDirectConversation(avatar, { personaId });
        } catch (error) {
            console.error('Conversation Mode: the conversation could not be made', error);
            return;
        }
    }
    const chatId = conversationRecord?.activeChatId || '';
    if (!await ensureConversationChatLoaded(avatar, { chatId, groupId, personaId })) {
        return;
    }
    const settings = getSettings(avatar, { groupId, personaId });

    if (!text && !pendingFiles.length) {
        queueForcedConversationReply(avatar, { chatId, groupId, personaId });
        return;
    }

    if (text.startsWith('/') && !pendingFiles.length) {
        const handled = await handleConversationSlashAction(text, { avatar, chatId, settings, groupId, personaId });
        if (handled) {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            clearConversationAttachmentInput();
            return;
        }
    }

    conversationState.conversationUploadActive = true;
    const sendButton = document.getElementById(CHROME_IDS.send);
    if (sendButton instanceof HTMLButtonElement) {
        sendButton.disabled = true;
    }

    try {
        const userName = getConversationPersonaName(personaId, 'You');
        const hasAttachments = pendingFiles.length > 0;
        const attachmentContextParts = [];
        const messageIds = [];
        const triggerMessages = [];

        if (hasAttachments) {
            const messageInput = {
                role: 'user',
                name: userName,
                mes: text,
                extra: buildConversationUserMessageExtra(),
            };
            await populateConversationUserAttachments(messageInput);
            const attachmentContext = await buildConversationAttachmentPromptContext(messageInput, text);
            if (attachmentContext) {
                attachmentContextParts.push(attachmentContext);
            }
            if (!String(messageInput.mes || '').trim() && !getConversationMediaAttachments(messageInput).length && !getConversationFileAttachments(messageInput).length) {
                toastr.warning('No attachments were added. Try a different file.');
                return;
            }

            const replyTarget = consumeConversationReplyTarget(avatar, { chatId, groupId, personaId });
            if (replyTarget) {
                messageInput.extra.conversation_reply_to = replyTarget;
            }
            const message = appendConversationChatMessage(avatar, messageInput, { chatId, create: false, groupId, personaId });
            if (message?.id) {
                messageIds.push(message.id);
                triggerMessages.push(message);
            }
        } else {
            const replyTarget = consumeConversationReplyTarget(avatar, { chatId, groupId, personaId });
            let includeReplyTarget = true;
            for (const messageText of splitChatroomMessages(text)) {
                const message = appendConversationChatMessage(avatar, {
                    role: 'user',
                    name: userName,
                    mes: messageText,
                    extra: buildConversationUserMessageExtra(includeReplyTarget ? replyTarget : null),
                }, { chatId, create: false, groupId, personaId });
                if (message?.id) {
                    messageIds.push(message.id);
                    triggerMessages.push(message);
                }
                includeReplyTarget = false;
            }
        }

        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        clearConversationAttachmentInput();
        updateLastUserActivity(avatar, { chatId, groupId, personaId });
        scheduleInterfaceRefresh();
        // Conversation mode has no MESSAGE_SENT, so Home hears about the first message here (Getting Started, step 4).
        window.dispatchEvent(new CustomEvent(CONVERSATION_MESSAGE_SENT_EVENT));

        const queuedText = text || attachmentContextParts.join('\n') || 'Sent an attachment.';
        const chatMessages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
        sendQueue.push(createConversationQueueItem({
            avatar,
            chatId,
            groupId,
            messageIds,
            messageRevisions: createConversationMessageRevisionEntries(triggerMessages),
            personaId,
            replyTarget: createConversationQueueReplyTarget(triggerMessages, chatMessages),
            conversationKey: getConversationKey(avatar, groupId, { personaId }),
            text: queuedText,
            attachmentContext: attachmentContextParts.join('\n'),
            createdAt: Date.now(),
        }));
        void processSendQueue();
    } finally {
        conversationState.conversationUploadActive = false;
        scheduleInterfaceRefresh();
    }
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
