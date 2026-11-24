import { is_send_press, online_status } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import { checkMultiCharacterChime, handleAvailabilityAutoResponder } from './auto-engine.js';
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
    GROUP_SECOND_REPLY_CHANCE,
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
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getConversationMemberAvatars } from './media.js';
import { getAllowedMemberCharacters, getConversationMemberSettings, isCharacterMentionedInText } from './members.js';
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
    updateLastUserActivity,
} from './conversation-store.js';
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

function isBroadGroupAddress(text) {
    return /\b(everyone|everybody|anyone|someone|you\s+all|you\s+guys|y['’]?all|yall|both\s+of\s+you|all\s+of\s+you)\b/i.test(String(text || ''));
}

function getImplicitGroupReplyCandidate(conversationMessages, anchorAvatar, candidates, latestUserText) {
    if (!String(latestUserText || '').trim() || isBroadGroupAddress(latestUserText)) {
        return null;
    }

    for (let index = conversationMessages.length - 1; index >= 0; index--) {
        const speakerAvatar = getConversationSpeakerAvatar(conversationMessages[index], anchorAvatar);
        const candidate = candidates.find(item => item.character.avatar === speakerAvatar);
        if (candidate) {
            return candidate;
        }
    }

    return null;
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

function addUniqueGroupReplyCandidate(candidates, candidate) {
    if (!candidate?.character?.avatar || candidates.some(item => item.character.avatar === candidate.character.avatar)) {
        return;
    }

    candidates.push(candidate);
}

function pickWeightedGroupReplyCandidate(candidates) {
    const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(0, Number(candidate.weight || 0)), 0);
    if (totalWeight <= 0) {
        return candidates[Math.floor(Math.random() * candidates.length)] || null;
    }

    let roll = Math.random() * totalWeight;
    for (const candidate of candidates) {
        roll -= Math.max(0, Number(candidate.weight || 0));
        if (roll <= 0) {
            return candidate;
        }
    }

    return candidates[candidates.length - 1] || null;
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

    // Build a cache of lastSpeakerIndex for all avatars in one pass
    const lastSpeakerIndexCache = new Map();
    for (let index = conversationMessages.length - 1; index >= 0; index--) {
        const speakerAvatar = getConversationSpeakerAvatar(conversationMessages[index], anchorAvatar);
        if (speakerAvatar && !lastSpeakerIndexCache.has(speakerAvatar)) {
            lastSpeakerIndexCache.set(speakerAvatar, index);
        }
    }

    const weightedPool = pool.map((item) => {
        const lastSpeakerIndex = lastSpeakerIndexCache.get(item.character.avatar) ?? -1;
        const messagesSinceSpeaking = lastSpeakerIndex < 0
            ? conversationMessages.length + 1
            : Math.max(1, conversationMessages.length - lastSpeakerIndex);
        return {
            ...item,
            lastSpeakerIndex,
            weight: 1 + messagesSinceSpeaking,
        };
    });
    const selected = [];
    const mentionedCandidates = weightedPool
        .filter(({ character }) => isCharacterMentionedInText(character, latestUserText, candidateCharacters))
        .slice(0, GROUP_MAX_CONCURRENT_SPEAKERS);
    for (const candidate of mentionedCandidates) {
        if (selected.length >= GROUP_MAX_CONCURRENT_SPEAKERS) {
            break;
        }
        addUniqueGroupReplyCandidate(selected, candidate);
    }

    if (!selected.length) {
        addUniqueGroupReplyCandidate(selected, getImplicitGroupReplyCandidate(conversationMessages, anchorAvatar, weightedPool, latestUserText));
    }

    const drawRandomCandidate = () => {
        const remaining = weightedPool.filter(candidate => !selected.some(item => item.character.avatar === candidate.character.avatar));
        addUniqueGroupReplyCandidate(selected, pickWeightedGroupReplyCandidate(remaining));
    };

    if (!selected.length) {
        drawRandomCandidate();
    }

    if (selected.length < GROUP_MAX_CONCURRENT_SPEAKERS && Math.random() < GROUP_SECOND_REPLY_CHANCE) {
        drawRandomCandidate();
    }

    return selected;
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

async function processConversationSpeakerReply(queueItem, { anchorAvatar, groupId, conversationSettings, replyCandidate = null, skipAvailabilityWait = false } = {}) {
    const chatId = queueItem?.chatId || '';
    const personaId = queueItem?.personaId || '';
    const replyCharacter = replyCandidate?.character || getCharacterForAvatar(anchorAvatar);
    const replyAvatar = replyCharacter?.avatar || anchorAvatar;
    const replySettings = replyCandidate?.settings || conversationSettings;
    const validateTarget = () => {
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
        },
    ), anchorAvatar, { chatId, groupId, personaId });
    if (!validateTarget()) {
        return false;
    }

    const replyExtra = {
        conversation_mode_reply: true,
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
            'the current DM conversation',
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
    if (!conversationSettings.enabled) {
        return;
    }

    const operation = beginConversationGenerationOperation();
    scheduleInterfaceRefresh({ syncControls: false });

    try {
        if (replyTarget.explicit) {
            const replyCandidate = groupId
                ? getGroupReplyCandidates(avatar, groupId, personaId).find(candidate => candidate.character.avatar === replyTarget.speakerAvatar)
                : replyTarget.speakerAvatar === avatar
                    ? { character: getCharacterForAvatar(avatar), settings: conversationSettings }
                    : getAllowedMemberCharacters(conversationSettings.multi_char_names, avatar, conversationSettings, {
                        chatId,
                        groupId,
                        includeConversationMembers: true,
                        personaId,
                    }).filter(character => character.avatar === replyTarget.speakerAvatar)
                        .map(character => ({
                            character,
                            settings: getConversationMemberSettings(character.avatar, conversationSettings, { groupId, personaId }),
                        }))[0];
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
            const replyCandidates = chooseGroupReplyCandidates(avatar, groupId, queueItem, { force: Boolean(queueItem?.force) });
            await Promise.allSettled(replyCandidates.map(replyCandidate => processGroupConversationSpeakerReply(queueItem, {
                anchorAvatar: avatar,
                groupId,
                conversationSettings,
                replyCandidate,
            }).catch((error) => {
                reportConversationGenerationError('group reply', error);
                return false;
            })));
            return;
        }

        if (!await waitForConversationSpeakerAvailability(queueItem, conversationSettings, avatar, groupId)) {
            return;
        }

        const memberChimePromise = getConversationMemberAvatars(avatar, conversationSettings, { chatId, groupId, includeConversationMembers: true, personaId }).length
            ? checkMultiCharacterChime(avatar, conversationSettings, Date.now(), { chatId, groupId, personaId }).catch((error) => {
                console.error('Conversation partner chime error:', error);
                return false;
            })
            : Promise.resolve(false);

        await processConversationSpeakerReply(queueItem, {
            anchorAvatar: avatar,
            groupId,
            conversationSettings,
            skipAvailabilityWait: true,
        });

        await memberChimePromise;
    } catch (error) {
        reportConversationGenerationError('reply', error);
    } finally {
        endConversationGenerationOperation(operation);
        scheduleInterfaceRefresh({ syncControls: false });
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
        const chatMessages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
        if (!chatMessages.some(message => message?.role === 'user')) {
            return;
        }

        sendQueue.push(createForcedConversationQueueItem({
            avatar,
            chatId,
            groupId,
            personaId,
            conversationKey: getConversationKey(avatar, groupId, { personaId }),
            createdAt: Date.now(),
        }, chatMessages));
        void processSendQueue();
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
        scheduleInterfaceRefresh({ syncControls: false });
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
        scheduleInterfaceRefresh({ syncControls: false });
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
