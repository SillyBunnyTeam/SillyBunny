import { is_send_press, name1 } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import { checkMultiCharacterChime, handleAvailabilityAutoResponder } from './auto-engine.js';
import {
    AUTO_WORKER_WAIT_POLL_MS,
    AUTO_WORKER_WAIT_TIMEOUT_MS,
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
    CONVERSATION_ATTACHMENT_MAX_BYTES,
    CONVERSATION_ATTACHMENT_MAX_FILES,
    DEFAULT_SETTINGS,
    GROUP_MAX_CONCURRENT_SPEAKERS,
    GROUP_SECOND_REPLY_CHANCE,
    SAFE_TOAST_OPTIONS,
    SEND_QUEUE_BATCH_MS,
    SEND_QUEUE_COALESCE_MS,
} from './constants.js';
import { getConversationGroupById, getConversationGroupIdForAvatar, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { generateConversationReply, postCharacterReply, postPartnerConversationReply, reportConversationGenerationError } from './generation.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getConversationPartnerAvatars } from './media.js';
import { isCharacterMentionedInText } from './partners.js';
import { formatConversationFileSize, formatPromptText } from './prompt.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { escapeHtmlText } from './render-utils.js';
import { getSettings, saveSettings } from './settings-store.js';
import { conversationState, partnerReplyBusyKeys, sendQueue } from './state.js';
import { consumeConversationReplyTarget } from './timeline-render.js';
import {
    appendConversationThreadMessage,
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationThread,
    getImageCooldownRemainingSeconds,
    markImageGenerated,
    updateLastUserActivity,
} from './thread-store.js';
import { handleConversationSlashAction } from './timeline-slash-commands.js';
import { getConversationActivityContext, maybePostDelayedReplyNotice, splitChatroomMessages, withTypingParticipant } from './typing.js';
import { appendConversationMessage } from './message-writer.js';
import { coalesceConversationQueueItems } from './send-queue-utils.js';

export { appendConversationMessage };

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
        <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="clear-attachments" title="Clear attachments" aria-label="Clear attachments">
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

function getConversationSpeakerAvatar(message, threadAvatar) {
    if (!message || ['user', 'system'].includes(message.role || '')) {
        return '';
    }

    return message.role === 'partner'
        ? String(message.extra?.partner_avatar || '')
        : String(threadAvatar || '');
}

function isBroadGroupAddress(text) {
    return /\b(everyone|everybody|anyone|someone|you\s+all|you\s+guys|y['’]?all|yall|both\s+of\s+you|all\s+of\s+you)\b/i.test(String(text || ''));
}

function getImplicitGroupReplyCandidate(thread, threadAvatar, candidates, latestUserText) {
    if (!String(latestUserText || '').trim() || isBroadGroupAddress(latestUserText)) {
        return null;
    }

    for (let index = thread.length - 1; index >= 0; index--) {
        const speakerAvatar = getConversationSpeakerAvatar(thread[index], threadAvatar);
        const candidate = candidates.find(item => item.character.avatar === speakerAvatar);
        if (candidate) {
            return candidate;
        }
    }

    return null;
}

function getGroupReplyCandidates(threadAvatar, groupId) {
    const group = getConversationGroupById(groupId);
    if (!group?.members?.length) {
        return [];
    }

    return group.members
        .filter(avatar => avatar && !group.disabled_members?.includes(avatar))
        .map((avatar) => {
            const character = getCharacterForAvatar(avatar);
            return character?.avatar
                ? { character, settings: getSettings(character.avatar, { groupId }) }
                : null;
        })
        .filter(Boolean);
}

function getGroupReplyBusyKey(threadAvatar, groupId, replyAvatar) {
    return ['group-reply', groupId || '', threadAvatar || '', replyAvatar || ''].join(':');
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

function chooseGroupReplyCandidates(threadAvatar, groupId, queueItem, { force = false } = {}) {
    const candidates = getGroupReplyCandidates(threadAvatar, groupId);
    if (!candidates.length) {
        return [];
    }

    const availableCandidates = force
        ? candidates
        : candidates.filter(({ character, settings }) => getConversationActivityContext(settings, character.avatar).status !== 'offline');
    const pool = availableCandidates.length ? availableCandidates : candidates;
    const candidateCharacters = pool.map(item => item.character).filter(Boolean);
    const latestUserText = [queueItem?.text, queueItem?.attachmentContext].filter(Boolean).join('\n');
    const thread = getConversationThread(threadAvatar, { groupId });

    // Build a cache of lastSpeakerIndex for all avatars in one pass
    const lastSpeakerIndexCache = new Map();
    for (let index = thread.length - 1; index >= 0; index--) {
        const speakerAvatar = getConversationSpeakerAvatar(thread[index], threadAvatar);
        if (speakerAvatar && !lastSpeakerIndexCache.has(speakerAvatar)) {
            lastSpeakerIndexCache.set(speakerAvatar, index);
        }
    }

    const weightedPool = pool.map((item) => {
        const lastSpeakerIndex = lastSpeakerIndexCache.get(item.character.avatar) ?? -1;
        const messagesSinceSpeaking = lastSpeakerIndex < 0
            ? thread.length + 1
            : Math.max(1, thread.length - lastSpeakerIndex);
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
    mentionedCandidates.forEach(candidate => addUniqueGroupReplyCandidate(selected, candidate));

    if (!selected.length) {
        addUniqueGroupReplyCandidate(selected, getImplicitGroupReplyCandidate(thread, threadAvatar, weightedPool, latestUserText));
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
    if (!queueItem?.force) {
        if (getConversationActivityContext(settings, avatar).status === 'offline') {
            return false;
        }

        if (!groupId && await handleAvailabilityAutoResponder(settings, avatar, { groupId })) {
            return false;
        }
    }

    const status = getConversationActivityContext(settings, avatar).status || 'online';
    if (!queueItem?.force && (status === 'idle' || status === 'dnd')) {
        const initialDelayMs = status === 'idle'
            ? (Math.random() * 1.5 + 1.5) * 1000
            : (Math.random() * 3 + 3) * 1000;
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }

    return true;
}

async function processConversationSpeakerReply(queueItem, { threadAvatar, groupId, threadSettings, replyCandidate = null, skipAvailabilityWait = false } = {}) {
    const replyCharacter = replyCandidate?.character || getCharacterForAvatar(threadAvatar);
    const replyAvatar = replyCharacter?.avatar || threadAvatar;
    const replySettings = replyCandidate?.settings || threadSettings;
    if (!skipAvailabilityWait && !await waitForConversationSpeakerAvailability(queueItem, replySettings, replyAvatar, groupId)) {
        return false;
    }

    maybePostDelayedReplyNotice(threadAvatar, replySettings, { groupId, statusAvatar: replyAvatar });

    const speakerName = replyCharacter?.name || (replyAvatar === threadAvatar ? getCurrentCharName() : 'Character');
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
            threadAvatar,
            speakerAvatar: replyAvatar,
            speakerName,
            groupId,
        },
    ), threadAvatar, { groupId });
    let posted = false;
    if (response?.trim()) {
        if (replyAvatar === threadAvatar) {
            await postCharacterReply(response.trim(), replySettings, {
                extra: {
                    conversation_mode_reply: true,
                },
                groupId,
            }, threadAvatar);
        } else {
            await postPartnerConversationReply(response.trim(), replyCharacter, replySettings, {
                avatar: threadAvatar,
                extra: {
                    conversation_mode_reply: true,
                    partner_avatar: replyAvatar,
                },
                groupId,
            });
        }
        posted = true;
    }

    const imageKeywords = /\b(send\s*pic|selfie|photo|image|picture|show\s*me)\b/i;
    const wantsImage = replySettings.image_gen_enabled
        && (replySettings.spontaneous_selfies || imageKeywords.test(queueItem.text || ''));
    if (wantsImage && getImageCooldownRemainingSeconds(replyAvatar, replySettings, Date.now(), { groupId }) === 0) {
        const prompt = buildCharacterImagePrompt(
            replySettings.image_gen_prompt_template || DEFAULT_SETTINGS.image_gen_prompt_template,
            'the current DM conversation',
            replyAvatar,
        );
        const imageUrl = await generateConversationImage(prompt, replySettings.image_gen_negative || '');
        if (imageUrl) {
            markImageGenerated(replyAvatar, Date.now(), { groupId });
            await appendConversationMessage('Here, I can show you.', {
                name: speakerName,
                role: replyAvatar === threadAvatar ? 'character' : 'partner',
                extra: {
                    conversation_mode_image: true,
                    image_url: imageUrl,
                    image_prompt: prompt,
                    ...(replyAvatar === threadAvatar ? {} : { partner_avatar: replyAvatar }),
                },
                groupId,
            }, threadAvatar);
            posted = true;
        }
    }

    return posted;
}

async function processGroupConversationSpeakerReply(queueItem, options) {
    const replyAvatar = options?.replyCandidate?.character?.avatar;
    const busyKey = getGroupReplyBusyKey(options?.threadAvatar, options?.groupId, replyAvatar);
    if (!replyAvatar || partnerReplyBusyKeys.has(busyKey)) {
        return false;
    }

    partnerReplyBusyKeys.add(busyKey);
    try {
        return await processConversationSpeakerReply(queueItem, options);
    } finally {
        partnerReplyBusyKeys.delete(busyKey);
    }
}

export async function processQueuedConversationReply(queueItem) {
    const avatar = queueItem?.avatar;
    if (!avatar || is_send_press) {
        return;
    }

    const groupId = queueItem?.groupId ?? getConversationGroupIdForAvatar(avatar);

    await waitForAutoWorker();

    const threadSettings = getSettings(avatar, { groupId });
    if (!threadSettings.enabled) {
        return;
    }

    conversationState.conversationReplyBusy = true;
    conversationState.generationActive = true;
    scheduleInterfaceRefresh({ syncControls: false });

    try {
        if (groupId) {
            const replyCandidates = chooseGroupReplyCandidates(avatar, groupId, queueItem, { force: Boolean(queueItem?.force) });
            await Promise.allSettled(replyCandidates.map(replyCandidate => processGroupConversationSpeakerReply(queueItem, {
                threadAvatar: avatar,
                groupId,
                threadSettings,
                replyCandidate,
            }).catch((error) => {
                reportConversationGenerationError('group reply', error);
                return false;
            })));
            return;
        }

        if (!await waitForConversationSpeakerAvailability(queueItem, threadSettings, avatar, groupId)) {
            return;
        }

        const partnerChimePromise = getConversationPartnerAvatars(avatar, threadSettings, { groupId, includeThreadPartners: true }).length
            ? checkMultiCharacterChime(avatar, threadSettings, Date.now(), { groupId }).catch((error) => {
                console.error('Conversation partner chime error:', error);
                return false;
            })
            : Promise.resolve(false);

        await processConversationSpeakerReply(queueItem, {
            threadAvatar: avatar,
            groupId,
            threadSettings,
            skipAvailabilityWait: true,
        });

        await partnerChimePromise;
    } catch (error) {
        reportConversationGenerationError('reply', error);
    } finally {
        conversationState.conversationReplyBusy = false;
        conversationState.generationActive = false;
        scheduleInterfaceRefresh({ syncControls: false });
    }
}

async function collectConversationQueueItem(firstItem) {
    return coalesceConversationQueueItems(firstItem, sendQueue, {
        windowMs: SEND_QUEUE_COALESCE_MS,
    });
}

export async function processSendQueue() {
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
                await processQueuedConversationReply(queueItem);
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
    if (is_send_press || conversationState.conversationUploadActive) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId });
    const text = input.value.trim();
    const pendingFiles = getValidatedConversationPendingFiles({ notify: true });
    if (!pendingFiles) {
        return;
    }
    if (!avatar || (!text && !pendingFiles.length)) {
        return;
    }

    if (!settings.enabled) {
        settings.enabled = true;
        saveSettings(avatar, settings, { groupId });
    }

    if (text.startsWith('/') && !pendingFiles.length) {
        const handled = await handleConversationSlashAction(text, { avatar, settings, groupId });
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
        const userName = name1 || 'You';
        const hasAttachments = pendingFiles.length > 0;
        const attachmentContextParts = [];

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

            const replyTarget = consumeConversationReplyTarget(avatar, { groupId });
            if (replyTarget) {
                messageInput.extra.conversation_reply_to = replyTarget;
            }
            appendConversationThreadMessage(avatar, messageInput, { groupId });
        } else {
            const replyTarget = consumeConversationReplyTarget(avatar, { groupId });
            let includeReplyTarget = true;
            for (const messageText of splitChatroomMessages(text)) {
                appendConversationThreadMessage(avatar, {
                    role: 'user',
                    name: userName,
                    mes: messageText,
                    extra: buildConversationUserMessageExtra(includeReplyTarget ? replyTarget : null),
                }, { groupId });
                includeReplyTarget = false;
            }
        }

        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        clearConversationAttachmentInput();
        updateLastUserActivity(avatar, { groupId });
        scheduleInterfaceRefresh({ syncControls: false });

        const queuedText = text || attachmentContextParts.join('\n') || 'Sent an attachment.';
        sendQueue.push({
            avatar,
            groupId,
            text: queuedText,
            attachmentContext: attachmentContextParts.join('\n'),
            createdAt: Date.now(),
        });
        void processSendQueue();
    } finally {
        conversationState.conversationUploadActive = false;
        if (sendButton instanceof HTMLButtonElement) {
            sendButton.disabled = false;
        }
    }
}
