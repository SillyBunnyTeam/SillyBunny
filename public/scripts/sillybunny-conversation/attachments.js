import { is_send_press, name1 } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import { checkMultiCharacterChime, handleAvailabilityAutoResponder } from './auto-engine.js';
import {
    AUTO_WORKER_WAIT_TIMEOUT_MS,
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
    CONVERSATION_ATTACHMENT_MAX_BYTES,
    CONVERSATION_ATTACHMENT_MAX_FILES,
    DEFAULT_SETTINGS,
    SAFE_TOAST_OPTIONS,
    SEND_QUEUE_BATCH_MS,
} from './constants.js';
import { getConversationGroupById, getConversationGroupIdForAvatar, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { generateConversationReply, postCharacterReply, postPartnerConversationReply, reportConversationGenerationError } from './generation.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getConversationPartnerAvatars } from './media.js';
import { incrementUnreadCount, isConversationActiveThread, notifyNewConversationMessage } from './notifications.js';
import { isCharacterMentionedInText } from './partners.js';
import { formatConversationFileSize, formatPromptText, scheduleConversationMemorySummary } from './prompt.js';
import { scheduleInterfaceRefresh, schedulePalsRailRender } from './render-scheduler.js';
import { getSettings } from './settings-store.js';
import { conversationState, sendQueue } from './state.js';
import {
    appendConversationThreadMessage,
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationThread,
    getImageCooldownRemainingSeconds,
    markConversationSeen,
    markImageGenerated,
    updateLastUserActivity,
} from './thread-store.js';
import { escapeHtmlText, handleConversationSlashAction } from './timeline-render.js';
import { getConversationActivityContext, maybePostDelayedReplyNotice, splitChatroomMessages, withTypingParticipant } from './typing.js';

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

        await new Promise(resolve => setTimeout(resolve, 200));
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

function getLastGroupSpeakerIndex(thread, speakerAvatar, threadAvatar) {
    for (let index = thread.length - 1; index >= 0; index--) {
        if (getConversationSpeakerAvatar(thread[index], threadAvatar) === speakerAvatar) {
            return index;
        }
    }

    return -1;
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

function chooseGroupReplyCandidate(threadAvatar, groupId, queueItem, { force = false } = {}) {
    const candidates = getGroupReplyCandidates(threadAvatar, groupId);
    if (!candidates.length) {
        return null;
    }

    const availableCandidates = force
        ? candidates
        : candidates.filter(({ character, settings }) => getConversationActivityContext(settings, character.avatar).status !== 'offline');
    const pool = availableCandidates.length ? availableCandidates : candidates;
    const candidateCharacters = pool.map(item => item.character).filter(Boolean);
    const latestUserText = [queueItem?.text, queueItem?.attachmentContext].filter(Boolean).join('\n');
    const mentioned = pool.find(({ character }) => isCharacterMentionedInText(character, latestUserText, candidateCharacters));
    if (mentioned) {
        return mentioned;
    }

    const thread = getConversationThread(threadAvatar, { groupId });
    return pool
        .map(item => ({
            ...item,
            lastSpeakerIndex: getLastGroupSpeakerIndex(thread, item.character.avatar, threadAvatar),
            tieBreaker: Math.random(),
        }))
        .sort((left, right) => left.lastSpeakerIndex - right.lastSpeakerIndex || left.tieBreaker - right.tieBreaker)[0] || null;
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

    const groupReplyCandidate = groupId
        ? chooseGroupReplyCandidate(avatar, groupId, queueItem, { force: Boolean(queueItem?.force) })
        : null;
    const replyCharacter = groupReplyCandidate?.character || getCharacterForAvatar(avatar);
    const replyAvatar = replyCharacter?.avatar || avatar;
    const replySettings = groupReplyCandidate?.settings || threadSettings;

    if (!queueItem?.force) {
        if (getConversationActivityContext(replySettings, replyAvatar).status === 'offline') {
            return;
        }

        if (!groupId && await handleAvailabilityAutoResponder(replySettings, replyAvatar, { groupId })) {
            return;
        }
    }

    const status = getConversationActivityContext(replySettings, replyAvatar).status || 'online';
    if (!queueItem?.force && (status === 'idle' || status === 'dnd')) {
        const initialDelayMs = status === 'idle'
            ? (Math.random() * 1.5 + 1.5) * 1000
            : (Math.random() * 3 + 3) * 1000;
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }

    conversationState.conversationReplyBusy = true;
    conversationState.generationActive = true;
    maybePostDelayedReplyNotice(avatar, replySettings, { groupId, statusAvatar: replyAvatar });
    scheduleInterfaceRefresh({ syncControls: false });

    try {
        const speakerName = replyCharacter?.name || (replyAvatar === avatar ? getCurrentCharName() : 'Character');
        const partnerChimePromise = !groupId && getConversationPartnerAvatars(avatar, threadSettings, { groupId, includeThreadPartners: true }).length
            ? checkMultiCharacterChime(avatar, threadSettings, Date.now(), { groupId }).catch((error) => {
                console.error('Conversation partner chime error:', error);
                return false;
            })
            : Promise.resolve(false);
        const attachmentContext = formatPromptText(queueItem?.attachmentContext, 3200);
        const systemDirective = queueItem?.force
            ? '[System directive: Generate a response/reply to the user in the Conversation Mode thread.]'
            : '[System directive: The user sent the latest DM. Reply directly to them in the Conversation Mode thread.]';
        const response = await withTypingParticipant(replyCharacter || { avatar: replyAvatar, name: speakerName }, () => generateConversationReply(
            [
                systemDirective,
                attachmentContext ? `Latest user attachment context:\n${attachmentContext}` : '',
            ].filter(Boolean).join('\n\n'),
            replySettings,
            {
                avatar: replyAvatar,
                threadAvatar: avatar,
                speakerAvatar: replyAvatar,
                speakerName,
                groupId,
            },
        ), avatar);
        if (response?.trim()) {
            if (replyAvatar === avatar) {
                await postCharacterReply(response.trim(), replySettings, {
                    extra: {
                        conversation_mode_reply: true,
                    },
                    groupId,
                }, avatar);
            } else {
                await postPartnerConversationReply(response.trim(), replyCharacter, replySettings, {
                    avatar,
                    extra: {
                        conversation_mode_reply: true,
                        partner_avatar: replyAvatar,
                    },
                    groupId,
                });
            }
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
                    role: replyAvatar === avatar ? 'character' : 'partner',
                    extra: {
                        conversation_mode_image: true,
                        image_url: imageUrl,
                        image_prompt: prompt,
                        ...(replyAvatar === avatar ? {} : { partner_avatar: replyAvatar }),
                    },
                    groupId,
                }, avatar);
            }
        }

        await partnerChimePromise;
    } catch (error) {
        reportConversationGenerationError('reply', error);
    } finally {
        conversationState.conversationReplyBusy = false;
        conversationState.generationActive = false;
        scheduleInterfaceRefresh({ syncControls: false });
    }
}

export async function processSendQueue() {
    if (conversationState.sendQueueProcessing) {
        return;
    }

    conversationState.sendQueueProcessing = true;
    try {
        while (sendQueue.length) {
            const queueItem = sendQueue.shift();
            await processQueuedConversationReply(queueItem);
            if (sendQueue.length) {
                await new Promise(resolve => setTimeout(resolve, SEND_QUEUE_BATCH_MS));
            }
        }
    } finally {
        conversationState.sendQueueProcessing = false;
        focusConversationInput();
    }

    if (sendQueue.length) {
        void processSendQueue();
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
    if (!avatar || !settings.enabled || (!text && !pendingFiles.length)) {
        return;
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
                extra: {
                    conversation_mode_user: true,
                },
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

            appendConversationThreadMessage(avatar, messageInput, { groupId });
        } else {
            for (const messageText of splitChatroomMessages(text)) {
                appendConversationThreadMessage(avatar, {
                    role: 'user',
                    name: userName,
                    mes: messageText,
                    extra: {
                        conversation_mode_user: true,
                    },
                }, { groupId });
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

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, groupId = undefined } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    const message = appendConversationThreadMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra,
    }, { groupId: resolvedGroupId });
    const shouldNotify = !['user', 'system'].includes(role) && !isConversationActiveThread(avatar, resolvedGroupId);
    if (shouldNotify) {
        incrementUnreadCount(avatar, { groupId: resolvedGroupId });
    }
    if (!['user', 'system'].includes(role)) {
        markConversationSeen(avatar, Date.now(), { groupId: resolvedGroupId });
    }

    if (isConversationActiveThread(avatar, resolvedGroupId)) {
        scheduleInterfaceRefresh({ syncControls: false });
    } else if (conversationState.conversationWorkspaceOpen) {
        schedulePalsRailRender();
    }

    notifyNewConversationMessage(avatar, message, shouldNotify, { groupId: resolvedGroupId });
    scheduleConversationMemorySummary(avatar, { groupId: resolvedGroupId });

    return message;
}
