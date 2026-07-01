import { characters, generateRaw } from '../../script.js';
import { extractProfileResponseText } from '../extensions/in-chat-agents/llm-utils.js';
import {
    CONVERSATION_ERROR_DETAIL_MAX_LENGTH,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    SAFE_TOAST_OPTIONS,
    SCHEDULE_STATUSES,
} from './constants.js';
import { getConversationGroupById, getConversationGroupIdForAvatar, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import {
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getCharacterImageDetails } from './media.js';
import { appendConversationMessage } from './message-writer.js';
import { stripSpeakerPrefix } from './partners.js';
import { getSpeakerPrefixMatch } from './partners-utils.js';
import { getConnectionProfiles } from './personas.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt, formatPromptText } from './prompt.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { clamp, getConversationReplyMaxTokens, parseDurationToMs } from './schedule.js';
import { runtimeStatusOverrides } from './state.js';
import {
    addConversationReminder,
    buildConversationMessageReplyReference,
    getConversationThread,
    getImageCooldownRemainingSeconds,
    hasConversationMessageContent,
    markImageGenerated,
    updateConversationThreadMessage,
} from './thread-store.js';
import { splitChatroomMessages, waitForReplyDelay, withTypingParticipant } from './typing.js';

export {
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';

// SillyBunny: Conversation Mode diverges from the global connection-profile
// switch pattern. Instead of flipping the active profile via /profile around
// each generation, we issue a scoped request through ConnectionManagerRequestService
// so the global selectedProfile (and the visible dropdown) never changes.
function isAbortLikeError(error, signal = null) {
    return Boolean(
        signal?.aborted ||
        error?.name === 'AbortError' ||
        /abort|cancel/i.test(String(error?.message ?? error ?? '')),
    );
}

/**
 * SillyBunny: generate Conversation Mode text using the configured connection
 * profile WITHOUT switching the global selected profile. Resolves the profile
 * by name and routes through ConnectionManagerRequestService.sendRequest so no
 * global state is mutated. Falls back to generateRaw (the active profile) when
 * no profile is configured, the scoped request path is unavailable, or the
 * profile name cannot be resolved.
 * @param {Object} options - Same option shape as generateRaw (prompt, systemPrompt, responseLength, trimNames, signal, cacheScope).
 * @param {Object} settings - Conversation settings holding connection_profile (a profile NAME).
 * @returns {Promise<string>}
 */
export async function generateConversationRaw(options, settings) {
    const profileName = String(settings?.connection_profile || '').trim();
    const ctx = window?.SillyTavern?.getContext?.();
    const CMRS = ctx?.ConnectionManagerRequestService;

    if (profileName && CMRS) {
        const profile = getConnectionProfiles().find(candidate => candidate?.name === profileName);
        if (profile?.id) {
            const messages = [];
            if (options.systemPrompt) {
                messages.push({ role: 'system', content: options.systemPrompt });
            }
            if (Array.isArray(options.prompt)) {
                for (const message of options.prompt) {
                    if (message && typeof message === 'object') {
                        messages.push({ role: String(message.role || 'user'), content: message.content });
                    }
                }
            } else {
                messages.push({ role: 'user', content: options.prompt });
            }

            try {
                const result = await CMRS.sendRequest(profile.id, messages, options.responseLength, {
                    extractData: true,
                    includePreset: true,
                    stream: false,
                    signal: options.signal ?? null,
                });
                return typeof result === 'string' ? result : extractProfileResponseText(result);
            } catch (error) {
                if (isAbortLikeError(error, options.signal)) {
                    throw error;
                }
                console.warn(`Conversation Mode: scoped profile "${profileName}" request failed, falling back to the active profile`, error);
            }
        }
    }

    return generateRaw(options);
}

export async function generateConversationReply(directive, settings, { responseLength = null, speakerName = getCurrentCharName(), trimNames = true, avatar = getCurrentCharAvatar(), threadAvatar = avatar, speakerAvatar = avatar, groupId = getConversationGroupIdForAvatar(threadAvatar) } = {}) {
    const messages = getConversationThread(threadAvatar, { groupId });
    const resolvedResponseLength = Number.isFinite(responseLength) && responseLength > 0
        ? clamp(Math.round(responseLength), MIN_CONVERSATION_REPLY_MAX_TOKENS, MAX_CONVERSATION_REPLY_MAX_TOKENS)
        : getConversationReplyMaxTokens(settings);
    const prompt = await buildConversationPromptMessages(messages, directive, speakerName, { groupId });

    return generateConversationRaw({
        prompt,
        systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, { threadAvatar, groupId }),
        responseLength: resolvedResponseLength,
        trimNames,
        cacheScope: 'conversation-mode',
    }, settings);
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
    textarea.focus({ preventScroll: true });

    saveButton.onclick = () => {
        const value = textarea.value.trim();
        if (value && value !== message.mes) {
            updateConversationThreadMessage(avatar, messageId, value, null, { groupId });
        } else {
            scheduleTimelineRender();
        }
    };

    cancelButton.onclick = () => {
        scheduleTimelineRender();
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

function addConversationReplySpeaker(speakers, speaker) {
    const avatar = String(speaker?.avatar || '').trim();
    const name = String(speaker?.name || '').trim();
    if (!avatar || !name || speakers.some(item => item.avatar === avatar)) {
        return;
    }

    speakers.push({ avatar, name });
}

function getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId) {
    const speakers = [];
    addConversationReplySpeaker(speakers, fallbackSpeaker);

    const threadCharacter = getCharacterForAvatar(threadAvatar);
    addConversationReplySpeaker(speakers, threadCharacter || { avatar: threadAvatar, name: getCurrentCharName() });

    const group = groupId ? getConversationGroupById(groupId) : null;
    if (group?.members?.length) {
        for (const memberAvatar of group.members) {
            if (group.disabled_members?.includes(memberAvatar)) {
                continue;
            }
            const character = getCharacterForAvatar(memberAvatar);
            addConversationReplySpeaker(speakers, character);
        }
    }

    return speakers;
}

function resolveConversationReplySpeaker(messageText, fallbackSpeaker, { threadAvatar, groupId = '' } = {}) {
    const speakerMatch = groupId
        ? getSpeakerPrefixMatch(messageText, getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId))
        : null;
    const speaker = speakerMatch?.speaker || fallbackSpeaker;
    const text = speakerMatch
        ? normalizeConversationOutputText(speakerMatch.text)
        : stripSpeakerPrefix(messageText, speaker.name || fallbackSpeaker?.name || 'Character');

    return {
        speaker,
        text,
    };
}

function splitConversationGeneratedReplyMessages(rawText, fallbackSpeaker, { threadAvatar, groupId = '', splitEveryLine = false } = {}) {
    const text = String(rawText || '').trim();
    if (!text) {
        return [];
    }

    const speakers = groupId ? getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId) : [];
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (groupId && lines.length > 1 && lines.some(line => getSpeakerPrefixMatch(line, speakers))) {
        return lines.reduce((messages, line) => {
            if (!messages.length || getSpeakerPrefixMatch(line, speakers)) {
                messages.push(line);
            } else {
                messages[messages.length - 1] = `${messages[messages.length - 1]}\n${line}`;
            }
            return messages;
        }, []);
    }

    return splitEveryLine ? splitPartnerChatroomMessages(text) : splitChatroomMessages(text);
}

function getResolvedReplyRole(speakerAvatar, threadAvatar) {
    return speakerAvatar && speakerAvatar !== threadAvatar ? 'partner' : 'character';
}

function getConversationGeneratedMessageSpeakerId(message, threadAvatar) {
    if (message?.role === 'user') {
        return 'user';
    }
    if (message?.role === 'partner') {
        return String(message.extra?.partner_avatar || '').trim();
    }
    if (message?.role === 'character') {
        return String(threadAvatar || '').trim();
    }

    return '';
}

function getGeneratedReplyReference(speakerAvatar, threadAvatar, { groupId = undefined } = {}) {
    const speakerId = String(speakerAvatar || '').trim();
    const messages = getConversationThread(threadAvatar, { groupId });
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.role === 'system' || !hasConversationMessageContent(message)) {
            continue;
        }

        const messageSpeakerId = getConversationGeneratedMessageSpeakerId(message, threadAvatar);
        if (speakerId && messageSpeakerId && speakerId === messageSpeakerId) {
            // Stop at a previous message from the same speaker. Follow-up messages
            // should not keep replying to the same older user/partner message.
            break;
        }

        const reference = buildConversationMessageReplyReference(message);
        if (reference) {
            return reference;
        }
    }

    return null;
}

function getResolvedReplyExtra(extra, speakerAvatar, threadAvatar, { groupId = undefined, attachReplyReference = true } = {}) {
    const resolvedExtra = { ...extra };
    if (speakerAvatar && speakerAvatar !== threadAvatar) {
        resolvedExtra.partner_avatar = speakerAvatar;
    } else {
        delete resolvedExtra.partner_avatar;
    }

    if (attachReplyReference && !resolvedExtra.conversation_reply_to) {
        const replyReference = getGeneratedReplyReference(speakerAvatar, threadAvatar, { groupId });
        if (replyReference) {
            resolvedExtra.conversation_reply_to = replyReference;
        }
    }

    return resolvedExtra;
}

async function appendResolvedConversationReply(messageText, speaker, settings, { avatar, extra = {}, groupId = undefined, attachReplyReference = true } = {}) {
    const speakerAvatar = speaker?.avatar || avatar;
    const speakerName = speaker?.name || 'Character';
    const role = getResolvedReplyRole(speakerAvatar, avatar);
    const resolvedExtra = getResolvedReplyExtra(extra, speakerAvatar, avatar, { groupId, attachReplyReference });

    await withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, async () => {
        await waitForReplyDelay(messageText, settings, speakerAvatar, { groupId });
        await appendConversationMessage(messageText, {
            name: speakerName,
            role,
            extra: resolvedExtra,
            groupId,
        }, avatar);
    }, avatar, { groupId });
}

export async function postPartnerConversationReply(rawText, partner, partnerSettings, { avatar = getCurrentCharAvatar(), extra = {}, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar || !partner) {
        return false;
    }

    const partnerName = partner.name || 'A friend';
    const fallbackSpeaker = { avatar: partner.avatar, name: partnerName };
    const rawMessages = splitConversationGeneratedReplyMessages(rawText, fallbackSpeaker, {
        threadAvatar: avatar,
        groupId,
        splitEveryLine: true,
    });
    let posted = false;

    for (const rawMessage of rawMessages) {
        const resolved = resolveConversationReplySpeaker(rawMessage, fallbackSpeaker, { threadAvatar: avatar, groupId });
        const { text, selfieRequests } = extractCharacterReplyCommands(resolved.text, partnerSettings, resolved.speaker.avatar, { groupId, reminderAvatar: avatar });
        const messages = splitChatroomMessages(text).map(part => normalizeConversationOutputText(part)).filter(Boolean);

        let attachReplyReference = true;
        for (const messageText of messages) {
            await appendResolvedConversationReply(messageText, resolved.speaker, partnerSettings, { avatar, extra, groupId, attachReplyReference });
            attachReplyReference = false;
            posted = true;
        }

        for (const context of selfieRequests) {
            const speakerAvatar = resolved.speaker.avatar || partner.avatar;
            const speakerName = resolved.speaker.name || partnerName;
            await withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, () => generateSelfieFromContext(context, partnerSettings, speakerAvatar, {
                threadAvatar: avatar,
                role: getResolvedReplyRole(speakerAvatar, avatar),
                name: speakerName,
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { groupId }),
                groupId,
            }), avatar, { groupId });
            posted = true;
        }
    }

    return posted;
}

export async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, role = 'character', name = '', extra = {}, groupId = undefined, force = false, notify = false } = {}) {
    const resolvedSettings = settings || {};
    if (!avatar) {
        return false;
    }

    const cooldownRemaining = getImageCooldownRemainingSeconds(avatar, resolvedSettings, Date.now(), { groupId });
    if (!force && (!resolvedSettings.image_gen_enabled || cooldownRemaining > 0)) {
        return false;
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
        imagePrompt = await generateConversationRaw({
            prompt: metaPrompt,
            systemPrompt: 'You output only a raw image generation prompt with no preamble.',
            responseLength: 200,
            trimNames: false,
            cacheScope: 'conversation-mode-selfie',
        }, resolvedSettings);
    } catch (error) {
        console.warn('Conversation Mode: selfie prompt generation failed', error);
    }

    imagePrompt = buildCharacterImagePrompt(
        formatPromptText(imagePrompt, 600) || resolvedSettings.selfie_prompt || 'raw photo, selfie of {{char}}',
        context || 'a casual selfie in the current moment',
        avatar,
    );

    const imageUrl = await generateConversationImage(imagePrompt, resolvedSettings.image_gen_negative || '', { notify });
    if (imageUrl) {
        markImageGenerated(avatar, Date.now(), { groupId });
        await appendConversationMessage('Sending you a selfie.', {
            name,
            role,
            extra: { ...extra, conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
            groupId,
        }, threadAvatar);
        return true;
    }

    return false;
}

export async function postCharacterReply(rawText, settings, { extra = {}, groupId = undefined } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return '';
    }
    const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
    const speakerName = character?.name || getCurrentCharName();
    const fallbackSpeaker = { avatar, name: speakerName };
    const rawMessages = splitConversationGeneratedReplyMessages(rawText, fallbackSpeaker, {
        threadAvatar: avatar,
        groupId,
    });
    const postedText = [];

    for (const rawMessage of rawMessages) {
        const resolved = resolveConversationReplySpeaker(rawMessage, fallbackSpeaker, { threadAvatar: avatar, groupId });
        const { text, selfieRequests } = extractCharacterReplyCommands(resolved.text, settings, resolved.speaker.avatar, { groupId });

        if (text) {
            let attachReplyReference = true;
            for (const messageText of splitChatroomMessages(text)) {
                const cleanMessageText = normalizeConversationOutputText(messageText);
                if (!cleanMessageText) {
                    continue;
                }

                await appendResolvedConversationReply(cleanMessageText, resolved.speaker, settings, { avatar, extra, groupId, attachReplyReference });
                attachReplyReference = false;
                postedText.push(cleanMessageText);
            }
        }

        for (const context of selfieRequests) {
            const speakerAvatar = resolved.speaker.avatar || avatar;
            await generateSelfieFromContext(context, settings, speakerAvatar, {
                threadAvatar: avatar,
                role: getResolvedReplyRole(speakerAvatar, avatar),
                name: resolved.speaker.name || '',
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { groupId }),
                groupId,
            });
        }
    }

    return postedText.join('\n');
}
