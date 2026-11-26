import { is_send_press, online_status } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import {
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
    CONVERSATION_ATTACHMENT_MAX_BYTES,
    CONVERSATION_ATTACHMENT_MAX_FILES,
    CONVERSATION_MESSAGE_SENT_EVENT,
    SAFE_TOAST_OPTIONS,
} from './constants.js';
import {
    ensureDirectConversation,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationKey,
    getConversationRecord,
    getCurrentCharAvatar,
} from './context.js';
import { getConversationPersonaName } from './personas.js';
import { formatConversationFileSize } from './prompt.js';
import { formatPromptText } from './shared-helpers.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { escapeHtmlText } from './render-utils.js';
import { getSettings } from './settings-store.js';
import { conversationState, sendQueue } from './state.js';
import { consumeConversationReplyTarget } from './timeline-render.js';
import {
    appendConversationChatMessage,
    ensureConversationChatLoaded,
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationMessages,
    updateLastUserActivity,
} from './conversation-store.js';
import { handleConversationSlashAction } from './timeline-slash-commands.js';
import { splitChatroomMessages } from './typing.js';
import { notifyNotConnected } from '../sillybunny-connection-notices.js';
import { processSendQueue, queueForcedConversationReply } from './send-queue.js';
import { createConversationMessageRevisionEntries, createConversationQueueItem, createConversationQueueReplyTarget } from './send-queue-utils.js';

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

/** Replaces the files that the composer holds with these. */
export function setConversationPendingFiles(files) {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement)) {
        return;
    }
    if (!files.length) {
        clearConversationAttachmentInput();
        return;
    }

    const transfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    if (!transfer) {
        return;
    }
    for (const file of files) {
        transfer.items.add(file);
    }
    fileInput.files = transfer.files;
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
