import { characters, generateRaw } from '../../script.js';
import { extractProfileResponseText } from '../extensions/in-chat-agents/llm-utils.js';
import { isAbortLikeError } from '../util/abort-error.js';
import {
    CONVERSATION_ERROR_DETAIL_MAX_LENGTH,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    SAFE_TOAST_OPTIONS,
    SCHEDULE_STATUSES,
} from './constants.js';
import { getConversationGroupById, getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import {
    buildSelfieImagePromptTemplate,
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getCharacterImageDetails } from './media.js';
import { appendConversationMessage } from './message-writer.js';
import { stripSpeakerPrefix } from './partners.js';
import { getSpeakerPrefixMatch } from './partners-utils.js';
import { getConnectionProfiles } from './personas.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt } from './prompt.js';
import { formatPromptText } from './shared-helpers.js';
import { clamp, getConversationReplyMaxTokens, getConversationRuntimeStatusKey, parseDurationToMs } from './schedule.js';
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

let activeConversationEditor = null;

export {
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';

// SillyBunny: Conversation Mode diverges from the global connection-profile
// switch pattern. Instead of flipping the active profile via /profile around
// each generation, we issue a scoped request through ConnectionManagerRequestService
// so the global selectedProfile (and the visible dropdown) never changes.
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

export async function generateConversationReply(directive, settings, { responseLength = null, speakerName = getCurrentCharName(), trimNames = true, avatar = getCurrentCharAvatar(), threadAvatar = avatar, speakerAvatar = avatar, branchId = '', groupId = getConversationGroupIdForAvatar(threadAvatar), personaId = getConversationPersonaId() } = {}) {
    const messages = getConversationThread(threadAvatar, { branchId, create: false, groupId, personaId });
    const resolvedResponseLength = Number.isFinite(responseLength) && responseLength > 0
        ? clamp(Math.round(responseLength), MIN_CONVERSATION_REPLY_MAX_TOKENS, MAX_CONVERSATION_REPLY_MAX_TOKENS)
        : getConversationReplyMaxTokens(settings);
    const prompt = await buildConversationPromptMessages(messages, directive, speakerName, { groupId, personaId });

    return generateConversationRaw({
        prompt,
        systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, { threadAvatar, branchId, groupId, personaId }),
        responseLength: resolvedResponseLength,
        trimNames,
        cacheScope: 'conversation-mode',
    }, settings);
}

export function editConversationMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const normalizedMessageId = String(messageId || '');
    const message = getConversationThread(avatar, { create: false, groupId, personaId })
        .find(item => String(item.id || '') === normalizedMessageId);
    if (!avatar || !message) {
        return;
    }

    const messageElement = Array.from(document.querySelectorAll('.sb-conversation-message'))
        .find(element => element.dataset.messageId === normalizedMessageId);
    if (!messageElement) {
        return;
    }

    const textElement = messageElement.querySelector('.sb-conversation-message-text');
    if (!textElement) {
        return;
    }

    if (activeConversationEditor?.messageElement === messageElement) {
        return;
    }

    if (activeConversationEditor && !activeConversationEditor.requestClose()) {
        return;
    }

    const originalTextElement = textElement.cloneNode(true);

    const textarea = document.createElement('textarea');
    textarea.className = 'sb-conversation-message-edit-textarea';
    textarea.value = message.mes;

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'sb-conversation-message-edit-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'menu_button sb-conversation-message-edit-control sb-conversation-message-edit-save fa-solid fa-check';
    saveButton.title = 'Save message changes';
    saveButton.setAttribute('aria-label', 'Save message changes');

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'menu_button sb-conversation-message-edit-control sb-conversation-message-edit-cancel fa-solid fa-xmark';
    cancelButton.title = 'Discard message changes';
    cancelButton.setAttribute('aria-label', 'Discard message changes');

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'menu_button sb-conversation-message-edit-control sb-conversation-message-edit-delete fa-solid fa-trash-can';
    deleteButton.title = 'Delete message';
    deleteButton.setAttribute('aria-label', 'Delete message');
    deleteButton.dataset.sbConversationAction = 'delete-message';
    deleteButton.dataset.messageId = message.id;

    buttonContainer.append(saveButton, cancelButton, deleteButton);

    textElement.textContent = '';
    textElement.append(textarea, buttonContainer);
    messageElement.classList.add('is-editing');
    messageElement.querySelector('.sb-conversation-message-actions')?.classList.remove('open');

    const closeEditor = () => {
        if (textElement.isConnected) {
            textElement.replaceWith(originalTextElement);
        }
        messageElement.classList.remove('is-editing');
        messageElement.querySelector('.sb-conversation-message-actions')?.classList.remove('open');
        if (activeConversationEditor?.messageElement === messageElement) {
            activeConversationEditor = null;
        }
    };

    // Switching editors drops whatever is in the textarea, so confirm first when it differs
    // from the stored message. Falls through when no confirm() exists (non-browser hosts).
    const requestClose = () => {
        if (textarea.value !== message.mes
            && typeof globalThis.confirm === 'function'
            && !globalThis.confirm('Discard unsaved changes to the message being edited?')) {
            return false;
        }

        closeEditor();
        return true;
    };

    activeConversationEditor = { messageElement, requestClose };

    saveButton.onclick = () => {
        const value = textarea.value;
        closeEditor();
        // A blanked textarea is not an edit: the delete control is the only way to drop a message.
        if (value.trim() && value !== message.mes) {
            updateConversationThreadMessage(avatar, message.id, value, null, { groupId, personaId });
        }
    };

    cancelButton.onclick = closeEditor;

    textarea.onkeydown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            saveButton.click();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelButton.click();
        }
    };

    textarea.focus({ preventScroll: true });
}

export function applyScheduleUpdateCommand(avatar, rawArgs, { personaId = getConversationPersonaId() } = {}) {
    const args = parseCommandArgs(rawArgs);
    const status = SCHEDULE_STATUSES.includes(args.status) ? args.status : null;
    const activity = (args.activity || '').trim();
    if (!avatar || (!status && !activity)) {
        return;
    }

    const durationMs = parseDurationToMs(args.duration) || (2 * 60 * 60 * 1000);
    runtimeStatusOverrides.set(getConversationRuntimeStatusKey(avatar, personaId), {
        status: status || 'online',
        activity: activity || 'free time',
        expiresAt: Date.now() + durationMs,
    });
}

export function extractCharacterReplyCommands(rawText, settings) {
    return extractCharacterReplyCommandParts(rawText, settings);
}

export function commitCharacterReplyCommands(commandParts, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), reminderAvatar = avatar } = {}) {
    for (const rawArgs of commandParts.scheduleUpdates) {
        applyScheduleUpdateCommand(avatar, rawArgs, { personaId });
    }

    // Always enable parsing of the reminder command from character DMs!
    for (const reminder of commandParts.reminders) {
        addConversationReminder(reminderAvatar, groupId, reminder.delay, reminder.memo, { branchId, personaId });
    }
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

function getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId, personaId) {
    const speakers = [];
    addConversationReplySpeaker(speakers, fallbackSpeaker);

    const threadCharacter = getCharacterForAvatar(threadAvatar);
    addConversationReplySpeaker(speakers, threadCharacter || { avatar: threadAvatar, name: getCurrentCharName() });

    const group = groupId ? getConversationGroupById(groupId, { personaId }) : null;
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

function resolveConversationReplySpeaker(messageText, fallbackSpeaker, { threadAvatar, groupId = '', personaId = getConversationPersonaId() } = {}) {
    const speakerMatch = groupId
        ? getSpeakerPrefixMatch(messageText, getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId, personaId))
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

function splitConversationGeneratedReplyMessages(rawText, fallbackSpeaker, { threadAvatar, groupId = '', personaId = getConversationPersonaId(), splitEveryLine = false } = {}) {
    const text = String(rawText || '').trim();
    if (!text) {
        return [];
    }

    const speakers = groupId ? getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId, personaId) : [];
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

function getGeneratedReplyReference(speakerAvatar, threadAvatar, { branchId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}) {
    const speakerId = String(speakerAvatar || '').trim();
    const messages = getConversationThread(threadAvatar, { branchId, create: false, groupId, personaId });
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

function getResolvedReplyExtra(extra, speakerAvatar, threadAvatar, { branchId = '', groupId = undefined, personaId = getConversationPersonaId(), attachReplyReference = true } = {}) {
    const resolvedExtra = { ...extra };
    if (speakerAvatar && speakerAvatar !== threadAvatar) {
        resolvedExtra.partner_avatar = speakerAvatar;
    } else {
        delete resolvedExtra.partner_avatar;
    }

    if (!attachReplyReference) {
        delete resolvedExtra.conversation_reply_to;
    } else if (!resolvedExtra.conversation_reply_to) {
        const replyReference = getGeneratedReplyReference(speakerAvatar, threadAvatar, { branchId, groupId, personaId });
        if (replyReference) {
            resolvedExtra.conversation_reply_to = replyReference;
        }
    }

    return resolvedExtra;
}

function getReplyExtraWithCommandMetadata(extra, commandParts) {
    const resolvedExtra = { ...extra };
    delete resolvedExtra.conversation_commands;
    const commandMetadata = getCharacterReplyCommandMetadata(commandParts);
    if (commandMetadata) {
        resolvedExtra.conversation_commands = commandMetadata;
    }
    return resolvedExtra;
}

function hasCharacterReplyCommandSideEffects(commandParts) {
    return Boolean(commandParts?.scheduleUpdates?.length || commandParts?.reminders?.length);
}

async function appendResolvedConversationReply(messageText, speaker, settings, { avatar, extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId(), attachReplyReference = true, validateTarget = null } = {}) {
    const speakerAvatar = speaker?.avatar || avatar;
    const speakerName = speaker?.name || 'Character';
    const role = getResolvedReplyRole(speakerAvatar, avatar);
    const resolvedInputExtra = { ...extra };
    if (!attachReplyReference) {
        delete resolvedInputExtra.conversation_reply_to;
    }
    const resolvedExtra = getResolvedReplyExtra(resolvedInputExtra, speakerAvatar, avatar, { branchId, groupId, personaId, attachReplyReference });

    return withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, async () => {
        await waitForReplyDelay(messageText, settings, speakerAvatar, { branchId, groupId, personaId });
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return null;
        }
        return appendConversationMessage(messageText, {
            name: speakerName,
            role,
            extra: resolvedExtra,
            branchId,
            groupId,
            personaId,
        }, avatar);
    }, avatar, { branchId, groupId, personaId });
}

export async function postPartnerConversationReply(rawText, partner, partnerSettings, { avatar = getCurrentCharAvatar(), extra = {}, branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), validateTarget = null } = {}) {
    if (!avatar || !partner) {
        return false;
    }

    const partnerName = partner.name || 'A friend';
    const fallbackSpeaker = { avatar: partner.avatar, name: partnerName };
    const rawMessages = splitConversationGeneratedReplyMessages(rawText, fallbackSpeaker, {
        threadAvatar: avatar,
        groupId,
        personaId,
        splitEveryLine: true,
    });
    let posted = false;
    const replyReferenceSpeakers = new Set();

    for (const rawMessage of rawMessages) {
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return posted;
        }
        const resolved = resolveConversationReplySpeaker(rawMessage, fallbackSpeaker, { threadAvatar: avatar, groupId, personaId });
        const commandParts = extractCharacterReplyCommands(resolved.text, partnerSettings);
        const messages = splitChatroomMessages(commandParts.text).map(part => normalizeConversationOutputText(part)).filter(Boolean);
        const speakerAvatar = resolved.speaker.avatar || partner.avatar;
        const replyExtra = getReplyExtraWithCommandMetadata(extra, commandParts);
        const plainReplyExtra = getReplyExtraWithCommandMetadata(extra, null);
        let commandReplyAppended = false;
        let commandSideEffectsCommitted = false;

        for (const messageText of messages) {
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const appended = await appendResolvedConversationReply(messageText, resolved.speaker, partnerSettings, { avatar, extra: commandReplyAppended ? plainReplyExtra : replyExtra, branchId, groupId, personaId, attachReplyReference, validateTarget });
            if (!appended) {
                return posted;
            }
            if (attachReplyReference) {
                replyReferenceSpeakers.add(speakerAvatar);
            }
            commandReplyAppended = true;
            posted = true;
            if (!commandSideEffectsCommitted && hasCharacterReplyCommandSideEffects(commandParts)) {
                commitCharacterReplyCommands(commandParts, speakerAvatar, { branchId, groupId, personaId, reminderAvatar: avatar });
                commandSideEffectsCommitted = true;
            }
        }

        for (const context of commandParts.selfieRequests) {
            const speakerName = resolved.speaker.name || partnerName;
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const generated = await withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, () => generateSelfieFromContext(context, partnerSettings, speakerAvatar, {
                threadAvatar: avatar,
                role: getResolvedReplyRole(speakerAvatar, avatar),
                name: speakerName,
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { branchId, groupId, personaId, attachReplyReference }),
                branchId,
                groupId,
                personaId,
                validateTarget,
            }), avatar, { branchId, groupId, personaId });
            if (generated && attachReplyReference) {
                replyReferenceSpeakers.add(speakerAvatar);
            }
            posted = posted || generated;
        }
    }

    return posted;
}

export async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, role = 'character', name = '', extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId(), force = false, notify = false, validateTarget = null } = {}) {
    const resolvedSettings = settings || {};
    if (!avatar) {
        return false;
    }
    if (typeof validateTarget === 'function' && !validateTarget()) {
        return false;
    }

    const cooldownRemaining = getImageCooldownRemainingSeconds(avatar, resolvedSettings, Date.now(), { branchId, groupId, personaId });
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
        }, resolvedSettings);
    } catch (error) {
        console.warn('Conversation Mode: selfie prompt generation failed', error);
    }

    const scene = context || 'a casual selfie in the current moment';
    imagePrompt = buildCharacterImagePrompt(
        buildSelfieImagePromptTemplate(formatPromptText(imagePrompt, 600), resolvedSettings.selfie_prompt, scene),
        scene,
        avatar,
    );

    const imageUrl = await generateConversationImage(imagePrompt, resolvedSettings.image_gen_negative || '', { avatar, character, notify });
    if (imageUrl && (typeof validateTarget !== 'function' || validateTarget())) {
        const caption = await generateSelfieCaption(scene, resolvedSettings, avatar, imagePrompt);
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return false;
        }
        markImageGenerated(avatar, Date.now(), { branchId, groupId, personaId });
        await appendConversationMessage(caption, {
            name,
            role,
            extra: { ...extra, conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
            branchId,
            groupId,
            personaId,
        }, threadAvatar);
        return true;
    }

    return false;
}

async function generateSelfieCaption(context, settings, avatar, imagePrompt) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName() || 'Character';
    const captionPrompt = [
        `Character name: ${charName}.`,
        character?.description ? `Description: ${formatPromptText(character.description, 900)}` : '',
        character?.personality ? `Personality: ${formatPromptText(character.personality, 700)}` : '',
        context ? `Selfie context: ${formatPromptText(context, 400)}` : 'Selfie context: a casual selfie in the current moment.',
        imagePrompt ? `Generated image prompt: ${formatPromptText(imagePrompt, 600)}` : '',
        'Write one short in-character chat message to accompany this selfie. Keep it natural, under 25 words, and output only the message text.',
    ].filter(Boolean).join('\n');

    try {
        const rawCaption = await generateConversationRaw({
            prompt: captionPrompt,
            systemPrompt: 'You write only a short in-character chat caption. No speaker labels, no stage directions, no preamble.',
            responseLength: 80,
            trimNames: false,
        }, settings || {});
        const caption = normalizeConversationOutputText(stripSpeakerPrefix(formatPromptText(rawCaption, 240), charName));
        if (caption) {
            return caption;
        }
    } catch (error) {
        console.warn('Conversation Mode: selfie caption generation failed', error);
    }

    return 'Here, I took this for you.';
}

export async function postCharacterReply(rawText, settings, { extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId(), validateTarget = null } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return '';
    }
    const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
    const speakerName = character?.name || getCurrentCharName();
    const fallbackSpeaker = { avatar, name: speakerName };
    const rawMessages = splitConversationGeneratedReplyMessages(rawText, fallbackSpeaker, {
        threadAvatar: avatar,
        groupId,
        personaId,
    });
    const postedText = [];
    const replyReferenceSpeakers = new Set();

    for (const rawMessage of rawMessages) {
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return postedText.join('\n');
        }
        const resolved = resolveConversationReplySpeaker(rawMessage, fallbackSpeaker, { threadAvatar: avatar, groupId, personaId });
        const commandParts = extractCharacterReplyCommands(resolved.text, settings);
        const speakerAvatar = resolved.speaker.avatar || avatar;
        const replyExtra = getReplyExtraWithCommandMetadata(extra, commandParts);
        const plainReplyExtra = getReplyExtraWithCommandMetadata(extra, null);
        let commandReplyAppended = false;
        let commandSideEffectsCommitted = false;

        if (commandParts.text) {
            for (const messageText of splitChatroomMessages(commandParts.text)) {
                const cleanMessageText = normalizeConversationOutputText(messageText);
                if (!cleanMessageText) {
                    continue;
                }

                const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
                const appended = await appendResolvedConversationReply(cleanMessageText, resolved.speaker, settings, { avatar, extra: commandReplyAppended ? plainReplyExtra : replyExtra, branchId, groupId, personaId, attachReplyReference, validateTarget });
                if (!appended) {
                    return postedText.join('\n');
                }
                if (attachReplyReference) {
                    replyReferenceSpeakers.add(speakerAvatar);
                }
                commandReplyAppended = true;
                postedText.push(cleanMessageText);
                if (!commandSideEffectsCommitted && hasCharacterReplyCommandSideEffects(commandParts)) {
                    commitCharacterReplyCommands(commandParts, speakerAvatar, { branchId, groupId, personaId, reminderAvatar: avatar });
                    commandSideEffectsCommitted = true;
                }
            }
        }

        for (const context of commandParts.selfieRequests) {
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const generated = await generateSelfieFromContext(context, settings, speakerAvatar, {
                threadAvatar: avatar,
                role: getResolvedReplyRole(speakerAvatar, avatar),
                name: resolved.speaker.name || '',
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { branchId, groupId, personaId, attachReplyReference }),
                branchId,
                groupId,
                personaId,
                validateTarget,
            });
            if (generated && attachReplyReference) {
                replyReferenceSpeakers.add(speakerAvatar);
            }
        }
    }

    return postedText.join('\n');
}
