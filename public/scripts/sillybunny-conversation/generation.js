import { characters, generateRaw } from '../../script.js';
import { appendConversationMessage } from './attachments.js';
import {
    CONVERSATION_ERROR_DETAIL_MAX_LENGTH,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    SAFE_TOAST_OPTIONS,
    SCHEDULE_STATUSES,
} from './constants.js';
import { getConversationGroupIdForAvatar, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import {
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getCharacterImageDetails } from './media.js';
import { stripSpeakerPrefix } from './partners.js';
import { withConversationConnectionProfile } from './personas.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt, formatPromptText } from './prompt.js';
import { clamp, getConversationReplyMaxTokens, parseDurationToMs } from './schedule.js';
import { runtimeStatusOverrides } from './state.js';
import {
    addConversationReminder,
    getConversationThread,
    getImageCooldownRemainingSeconds,
    markImageGenerated,
    updateConversationThreadMessage,
} from './thread-store.js';
import { renderConversationTimeline } from './timeline-render.js';
import { splitChatroomMessages, waitForReplyDelay, withTypingParticipant } from './typing.js';

export {
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';

export async function generateConversationReply(directive, settings, { responseLength = null, speakerName = getCurrentCharName(), trimNames = true, avatar = getCurrentCharAvatar(), threadAvatar = avatar, speakerAvatar = avatar, groupId = getConversationGroupIdForAvatar(threadAvatar) } = {}) {
    const messages = getConversationThread(threadAvatar, { groupId });
    const resolvedResponseLength = Number.isFinite(responseLength) && responseLength > 0
        ? clamp(Math.round(responseLength), MIN_CONVERSATION_REPLY_MAX_TOKENS, MAX_CONVERSATION_REPLY_MAX_TOKENS)
        : getConversationReplyMaxTokens(settings);
    const prompt = await buildConversationPromptMessages(messages, directive, speakerName);

    return withConversationConnectionProfile(settings, () => generateRaw({
        prompt,
        systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, { threadAvatar, groupId }),
        responseLength: resolvedResponseLength,
        trimNames,
        cacheScope: 'conversation-mode',
    }));
}

export function editConversationMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const message = getConversationThread(avatar, { groupId }).find(item => item.id === messageId);
    if (!avatar || !message) {
        return;
    }

    const messageElement = document.querySelector(`.sb-conversation-message[data-message-id="${messageId}"]`);
    if (!messageElement) {
        return;
    }

    const textElement = messageElement.querySelector('.sb-conversation-message-text');
    if (!textElement) {
        return;
    }

    // If an editor is already open in this element, do nothing.
    if (textElement.querySelector('.sb-conversation-message-edit-textarea')) {
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'sb-conversation-message-edit-textarea';
    textarea.value = message.mes;

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'sb-conversation-message-edit-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'menu_button sb-conversation-message-edit-save';
    saveButton.textContent = 'Save';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'menu_button sb-conversation-message-edit-cancel';
    cancelButton.textContent = 'Cancel';

    buttonContainer.append(saveButton, cancelButton);

    textElement.textContent = '';
    textElement.append(textarea, buttonContainer);
    textarea.focus();

    saveButton.onclick = () => {
        const value = textarea.value.trim();
        if (value && value !== message.mes) {
            updateConversationThreadMessage(avatar, messageId, value, null, { groupId });
        } else {
            renderConversationTimeline();
        }
    };

    cancelButton.onclick = () => {
        renderConversationTimeline();
    };

    textarea.onkeydown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            saveButton.click();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelButton.click();
        }
    };
}

export function applyScheduleUpdateCommand(avatar, rawArgs) {
    const args = parseCommandArgs(rawArgs);
    const status = SCHEDULE_STATUSES.includes(args.status) ? args.status : null;
    const activity = (args.activity || '').trim();
    if (!avatar || (!status && !activity)) {
        return;
    }

    const durationMs = parseDurationToMs(args.duration) || (2 * 60 * 60 * 1000);
    runtimeStatusOverrides.set(avatar, {
        status: status || 'online',
        activity: activity || 'free time',
        expiresAt: Date.now() + durationMs,
    });
}

export function extractCharacterReplyCommands(rawText, settings, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar), reminderAvatar = avatar } = {}) {
    const commandParts = extractCharacterReplyCommandParts(rawText, settings);
    for (const rawArgs of commandParts.scheduleUpdates) {
        applyScheduleUpdateCommand(avatar, rawArgs);
    }

    // Always enable parsing of the reminder command from character DMs!
    for (const reminder of commandParts.reminders) {
        addConversationReminder(reminderAvatar, groupId, reminder.delay, reminder.memo);
    }

    return { text: commandParts.text, selfieRequests: commandParts.selfieRequests };
}

export function getConversationErrorDetail(error) {
    let detail = '';
    if (typeof error === 'string') {
        detail = error;
    } else if (error?.message) {
        detail = error.message;
    } else if (error?.response) {
        detail = error.response;
    } else if (error?.error?.message) {
        detail = error.error.message;
    } else if (error?.error) {
        detail = error.error;
    } else if (error) {
        try {
            detail = JSON.stringify(error);
        } catch {
            detail = String(error);
        }
    }

    return String(detail || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CONVERSATION_ERROR_DETAIL_MAX_LENGTH);
}

export function reportConversationGenerationError(context, error, { toast = true, level = 'error' } = {}) {
    const detail = getConversationErrorDetail(error);
    const label = context ? `Conversation ${context}` : 'Conversation generation';
    const log = level === 'warning' ? console.warn : console.error;
    log(`${label} failed${detail ? `: ${detail}` : ''}`, error);

    if (!toast) {
        return;
    }

    const message = `${label} failed${detail ? `: ${detail}` : '. Check the browser console for details.'}`;
    if (level === 'warning') {
        globalThis.toastr?.warning?.(message, '', SAFE_TOAST_OPTIONS);
    } else {
        globalThis.toastr?.error?.(message, '', SAFE_TOAST_OPTIONS);
    }
}

export function splitPartnerChatroomMessages(text) {
    const messages = String(text || '')
        .split(/\n+/)
        .map(part => normalizeConversationOutputText(part))
        .filter(Boolean);
    return messages.length ? messages : splitChatroomMessages(text).map(part => normalizeConversationOutputText(part)).filter(Boolean);
}

export async function postPartnerConversationReply(rawText, partner, partnerSettings, { avatar = getCurrentCharAvatar(), extra = {}, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar || !partner) {
        return false;
    }

    const partnerName = partner.name || 'A friend';
    const { text, selfieRequests } = extractCharacterReplyCommands(stripSpeakerPrefix(rawText, partnerName), partnerSettings, partner.avatar, { groupId, reminderAvatar: avatar });
    const messages = splitPartnerChatroomMessages(text);

    if (messages.length) {
        await withTypingParticipant(partner, async () => {
            for (const messageText of messages) {
                await waitForReplyDelay(messageText, partnerSettings, partner.avatar);
                await appendConversationMessage(messageText, {
                    name: partnerName,
                    role: 'partner',
                    extra,
                    groupId,
                }, avatar);
            }
        }, avatar);
    }

    for (const context of selfieRequests) {
        await withTypingParticipant(partner, () => generateSelfieFromContext(context, partnerSettings, partner.avatar, {
            threadAvatar: avatar,
            role: 'partner',
            name: partnerName,
            extra: { ...extra, partner_avatar: partner.avatar },
            groupId,
        }), avatar);
    }

    return Boolean(messages.length || selfieRequests.length);
}

export async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, role = 'character', name = '', extra = {}, groupId = undefined } = {}) {
    if (!settings.image_gen_enabled || !avatar || getImageCooldownRemainingSeconds(avatar, settings, Date.now(), { groupId }) > 0) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || 'Character';
    const appearance = getCharacterImageDetails(avatar);
    const metaPrompt = [
        'You are an image prompt generator. Write a concise, detailed image generation prompt for a selfie photo.',
        `Character name: ${charName}.`,
        appearance ? `Appearance: ${appearance}` : '',
        context ? `Photo context: ${context}` : 'Photo context: a casual selfie in the current moment.',
        'Include appearance, clothing, expression and selfie pose, setting/background, and lighting. Output ONLY the prompt text, nothing else.',
    ].filter(Boolean).join('\n');

    let imagePrompt = '';
    try {
        imagePrompt = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt: metaPrompt,
            systemPrompt: 'You output only a raw image generation prompt with no preamble.',
            responseLength: 200,
            trimNames: false,
            cacheScope: 'conversation-mode-selfie',
        }));
    } catch (error) {
        console.warn('Conversation Mode: selfie prompt generation failed', error);
    }

    imagePrompt = buildCharacterImagePrompt(
        formatPromptText(imagePrompt, 600) || settings.selfie_prompt || 'raw photo, selfie of {{char}}',
        context || 'a casual selfie in the current moment',
        avatar,
    );

    const imageUrl = await generateConversationImage(imagePrompt, settings.image_gen_negative || '');
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { groupId });
        await appendConversationMessage('Sending you a selfie.', {
            name,
            role,
            extra: { ...extra, conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
            groupId,
        }, threadAvatar);
    }
}

export async function postCharacterReply(rawText, settings, { extra = {}, groupId = undefined } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return '';
    }
    const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
    const speakerName = character?.name || getCurrentCharName();
    const { text, selfieRequests } = extractCharacterReplyCommands(stripSpeakerPrefix(rawText, speakerName), settings, avatar, { groupId });

    if (text) {
        for (const messageText of splitChatroomMessages(text)) {
            const cleanMessageText = normalizeConversationOutputText(messageText);
            if (!cleanMessageText) {
                continue;
            }

            await withTypingParticipant(character || { avatar, name: speakerName }, async () => {
                await waitForReplyDelay(cleanMessageText, settings, avatar);
                await appendConversationMessage(cleanMessageText, {
                    name: speakerName,
                    role: 'character',
                    extra,
                    groupId,
                }, avatar);
            }, avatar);
        }
    }

    for (const context of selfieRequests) {
        await generateSelfieFromContext(context, settings, avatar, {
            role: 'character',
            name: (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar)?.name || '',
            extra,
            groupId,
        });
    }

    return text;
}
