import { characters, generateRaw } from '../../script.js';
import { extractProfileResponseText } from '../extensions/in-chat-agents/llm-utils.js';
import { registerGenerationCommitPlan, settleGenerationCommit } from '../resumable-generation.js';
import { isAbortLikeError } from '../util/abort-error.js';
import { extractProviderMessage } from '../sillybunny-provider-message.js';
import {
    CONVERSATION_ERROR_DETAIL_MAX_LENGTH,
    SAFE_TOAST_OPTIONS,
    SCHEDULE_STATUSES,
} from './constants.js';
import { getConversationGroupById, getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import {
    buildSelfieImagePromptTemplate,
    extractCharacterReplyCommandParts,
    hasCharacterReplyCommandSideEffects,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';
import { generationTargets } from './deletion-guards.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getCharacterImageDetails } from './media.js';
import { appendConversationMessage } from './message-writer.js';
import { stripSpeakerPrefix } from './members.js';
import { addCharacterReaction } from './reaction-model.js';
import { buildReplySteps, collectReplyReactions } from './reply-steps.js';
import { confirmConversationAction } from './dialogs.js';
import { getConnectionProfiles } from './personas.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt } from './prompt.js';
import { getActiveApiResponseLength, getProfileResponseLength } from './response-length.js';
import { formatPromptText } from './shared-helpers.js';
import { loadRelatedMemoryChats } from './settings-store.js';
import { getConversationRuntimeStatusKey, parseDurationToMs } from './schedule.js';
import { runtimeStatusOverrides } from './state.js';
import {
    addConversationReminder,
    buildConversationMessageReplyReference,
    ensureConversationChatLoaded,
    getConversationMessages,
    getImageCooldownRemainingSeconds,
    hasConversationMessageContent,
    markImageGenerated,
    updateConversationChatMessage,
    updateConversationChatMessageReactions,
} from './conversation-store.js';
import { waitForReplyDelay, withTypingParticipant } from './typing.js';
import { getConversationWorldInfo } from './world-info.js';

let activeConversationEditor = null;

export {
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';
export { splitMemberChatroomMessages } from './reply-steps.js';

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
 * @param {Object} options - Same option shape as generateRaw (prompt, systemPrompt, responseLength, trimNames, signal, cacheScope), and `commit`.
 * `commit` is `{ createPlan(route), state }` for a reply that the server may write into the chat when this page is gone:
 * `createPlan('profile' | 'raw')` makes the commit plan of the request that the route sends, and `state` is set to what the
 * server answered when the page claimed the reply (`claimed`, `committed`, `unknown`, `missing`), or stays null.
 * A plan is used by one request, so the fallback to the active API asks for a new one.
 * @param {Object} settings - Conversation settings holding connection_profile (a profile NAME).
 * @returns {Promise<string>}
 */
export async function generateConversationRaw(options, settings) {
    const profileName = String(settings?.connection_profile || '').trim();
    const ctx = window?.SillyTavern?.getContext?.();
    const CMRS = ctx?.ConnectionManagerRequestService;
    const commit = options.commit ?? null;

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
                // A request that names no length asks for the length of the preset of the profile, which is the length
                // that a normal chat with that profile asks for.
                const profileResponseLength = options.responseLength > 0 ? options.responseLength : await getProfileResponseLength(profile);
                if (commit) {
                    registerGenerationCommitPlan(options.signal, commit.createPlan('profile'));
                }
                const result = await CMRS.sendRequest(profile.id, messages, profileResponseLength, {
                    extractData: true,
                    includePreset: true,
                    stream: false,
                    signal: options.signal ?? null,
                });
                if (commit) {
                    commit.state = await settleGenerationCommit(options.signal);
                }
                return typeof result === 'string' ? result : extractProfileResponseText(result);
            } catch (error) {
                if (isAbortLikeError(error, options.signal)) {
                    throw error;
                }
                console.warn(`Conversation Mode: scoped profile "${profileName}" request failed, falling back to the active profile`, error);
            }
        }
    }

    options = {
        ...options,
        responseLength: await getActiveApiResponseLength(options.responseLength),
        commit: commit ? { plan: commit.createPlan('raw'), state: null } : null,
    };

    const reply = await generateRaw(options);
    if (commit) {
        commit.state = options.commit.state;
    }
    return reply;
}

/**
 * Asks the model for the next message of a conversation. The request is tracked by the chat it is for, so that deleting
 * that chat or its conversation stops it; a reply that was stopped, or that came back after its target was deleted,
 * answers an empty text, and the caller writes nothing. `commit` is the handle of `generateConversationRaw()`: with it
 * the server writes the reply when this page is gone, and `commit.state` tells the caller whether it did.
 */
export async function generateConversationReply(directive, settings, { speakerName = getCurrentCharName(), trimNames = true, avatar = getCurrentCharAvatar(), anchorAvatar = avatar, speakerAvatar = avatar, chatId = '', groupId = getConversationGroupIdForAvatar(anchorAvatar), personaId = getConversationPersonaId(), commit = null } = {}) {
    // The transcript is read from the chat, and a related memory comes from the chats of other conversations.
    const address = await ensureConversationChatLoaded(anchorAvatar, { chatId, groupId, personaId });
    const tracked = generationTargets.begin(address);
    try {
        if (settings?.include_related_memory) {
            await loadRelatedMemoryChats(speakerAvatar, { groupId, personaId });
        }
        const messages = getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId });
        const worldInfo = await getConversationWorldInfo(messages, settings, { avatar: speakerAvatar, personaId });
        const prompt = await buildConversationPromptMessages(messages, directive, speakerName, { groupId, personaId, worldInfo });

        const reply = await generateConversationRaw({
            prompt,
            systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, { anchorAvatar, chatId, groupId, personaId, worldInfo }),
            trimNames,
            cacheScope: 'conversation-mode',
            signal: tracked.signal,
            commit,
        }, settings);
        return tracked.signal.aborted ? '' : reply;
    } catch (error) {
        if (tracked.signal.aborted) {
            return '';
        }
        throw error;
    } finally {
        tracked.end();
    }
}

export async function editConversationMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const normalizedMessageId = String(messageId || '');
    const message = getConversationMessages(avatar, { create: false, groupId, personaId })
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

    if (activeConversationEditor && !(await activeConversationEditor.requestClose())) {
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
    // libadwaita inline editor: text pill buttons (suggested Save, flat Cancel, flat destructive
    // Delete). DOM order stays save, cancel, delete; CSS places Delete at the start.
    saveButton.className = 'sb-conversation-message-edit-control sb-conversation-message-edit-save';
    saveButton.textContent = 'Save';
    saveButton.title = 'Save Message Changes (Ctrl+Enter)';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'sb-conversation-message-edit-control sb-conversation-message-edit-cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.title = 'Discard Message Changes (Esc)';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'sb-conversation-message-edit-control sb-conversation-message-edit-delete';
    deleteButton.title = 'Delete Message';
    deleteButton.setAttribute('aria-label', 'Delete Message');
    const deleteIcon = document.createElement('i');
    deleteIcon.className = 'fa-solid fa-trash-can';
    deleteIcon.setAttribute('aria-hidden', 'true');
    deleteButton.append(deleteIcon);
    deleteButton.dataset.sbConversationAction = 'delete-message';
    deleteButton.dataset.messageId = message.id;

    buttonContainer.append(saveButton, cancelButton, deleteButton);

    textElement.textContent = '';
    textElement.append(textarea, buttonContainer);
    messageElement.classList.add('is-editing');
    messageElement.querySelector('.sb-conversation-message-actions')?.classList.remove('open');
    messageElement.querySelector('.sb-conversation-mobile-menu-trigger')?.setAttribute('aria-expanded', 'false');

    const closeEditor = () => {
        if (textElement.isConnected) {
            textElement.replaceWith(originalTextElement);
        }
        messageElement.classList.remove('is-editing');
        messageElement.querySelector('.sb-conversation-message-actions')?.classList.remove('open');
        messageElement.querySelector('.sb-conversation-mobile-menu-trigger')?.setAttribute('aria-expanded', 'false');
        if (activeConversationEditor?.messageElement === messageElement) {
            activeConversationEditor = null;
        }
    };

    // Switching editors drops whatever is in the textarea, so confirm first when it differs
    // from the stored message.
    const requestClose = async () => {
        if (textarea.value !== message.mes && !(await confirmConversationAction({
            title: 'Discard Unsaved Changes?',
            text: 'The message being edited has changes that have not been saved',
            confirmLabel: 'Discard',
        }))) {
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
            updateConversationChatMessage(avatar, message.id, value, null, { groupId, personaId });
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

/**
 * @param {object} [options]
 * @param {string} [options.reminderIdPrefix] Makes the id of each reminder `<prefix>_<n>`, so that two pages that land the same reply add each reminder once.
 */
export function commitCharacterReplyCommands(commandParts, avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), reminderAvatar = avatar, reminderIdPrefix = '' } = {}) {
    for (const rawArgs of commandParts.scheduleUpdates) {
        applyScheduleUpdateCommand(avatar, rawArgs, { personaId });
    }

    // Always enable parsing of the reminder command from character DMs!
    commandParts.reminders.forEach((reminder, index) => {
        addConversationReminder(reminderAvatar, groupId, reminder.delay, reminder.memo, { chatId, personaId, ...(reminderIdPrefix ? { id: `${reminderIdPrefix}_${index}` } : {}) });
    });
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

    // Streaming failures throw the raw JSON body, which is unreadable in a toast.
    const text = String(detail || '');
    const providerMessage = /^\s*[{[]/.test(text) ? extractProviderMessage(text) : '';

    return (providerMessage || text)
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

function addConversationReplySpeaker(speakers, speaker) {
    const avatar = String(speaker?.avatar || '').trim();
    const name = String(speaker?.name || '').trim();
    if (!avatar || !name || speakers.some(item => item.avatar === avatar)) {
        return;
    }

    speakers.push({ avatar, name });
}

export function getConversationReplySpeakers(anchorAvatar, fallbackSpeaker, groupId, personaId) {
    const speakers = [];
    addConversationReplySpeaker(speakers, fallbackSpeaker);

    const conversationCharacter = getCharacterForAvatar(anchorAvatar);
    addConversationReplySpeaker(speakers, conversationCharacter || { avatar: anchorAvatar, name: getCurrentCharName() });

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

function getResolvedReplyRole(speakerAvatar, anchorAvatar) {
    return speakerAvatar && speakerAvatar !== anchorAvatar ? 'member' : 'character';
}

function getConversationGeneratedMessageSpeakerId(message, anchorAvatar) {
    if (message?.role === 'user') {
        return 'user';
    }
    if (message?.role === 'member') {
        return String(message.extra?.member_avatar || '').trim();
    }
    if (message?.role === 'character') {
        return String(anchorAvatar || '').trim();
    }

    return '';
}

function getGeneratedReplyReference(speakerAvatar, anchorAvatar, { chatId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}) {
    const speakerId = String(speakerAvatar || '').trim();
    const messages = getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId });
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.role === 'system' || !hasConversationMessageContent(message)) {
            continue;
        }

        const messageSpeakerId = getConversationGeneratedMessageSpeakerId(message, anchorAvatar);
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

function getResolvedReplyExtra(extra, speakerAvatar, anchorAvatar, { chatId = '', groupId = undefined, personaId = getConversationPersonaId(), attachReplyReference = true } = {}) {
    const resolvedExtra = { ...extra };
    if (speakerAvatar && speakerAvatar !== anchorAvatar) {
        resolvedExtra.member_avatar = speakerAvatar;
    } else {
        delete resolvedExtra.member_avatar;
    }

    if (!attachReplyReference) {
        delete resolvedExtra.conversation_reply_to;
    } else if (!resolvedExtra.conversation_reply_to) {
        const replyReference = getGeneratedReplyReference(speakerAvatar, anchorAvatar, { chatId, groupId, personaId });
        if (replyReference) {
            resolvedExtra.conversation_reply_to = replyReference;
        }
    }

    return resolvedExtra;
}

function getReplyExtraWithCommandMetadata(extra, commandMetadata) {
    const resolvedExtra = { ...extra };
    delete resolvedExtra.conversation_commands;
    if (commandMetadata) {
        resolvedExtra.conversation_commands = commandMetadata;
    }
    return resolvedExtra;
}

/**
 * Writes the reaction of each speaker of a reply to the message of the user that the reply answers. A function that
 * takes a speaker's turn: it writes that speaker's reaction the first time, so that a speaker with several groups reacts
 * once, and it writes none when characters may not react or the reply answers no message (an automatic message).
 * @param {import('./reply-steps.js').ReplyGroup[]} groups
 * @param {Record<string, any>} settings
 * @param {{ messageId: string }|null|undefined} reactionTarget
 * @param {{ avatar: string, chatId: string, groupId: string|undefined, personaId: string }} scope
 * @returns {(speakerAvatar: string) => void}
 */
function createReactionWriter(groups, settings, reactionTarget, { avatar, chatId, groupId, personaId }) {
    if (!settings?.characters_react || !reactionTarget?.messageId) {
        return () => {};
    }
    const pending = new Map(collectReplyReactions(groups).map(({ speakerAvatar, emoji }) => [speakerAvatar, emoji]));
    return (speakerAvatar) => {
        const emoji = pending.get(speakerAvatar);
        if (!emoji) {
            return;
        }
        pending.delete(speakerAvatar);
        updateConversationChatMessageReactions(avatar, reactionTarget.messageId, entries => addCharacterReaction(entries, emoji, speakerAvatar), { chatId, groupId, personaId });
    };
}

/** The index of the last group that has a bubble: the bubble that carries the marker of a round. */
function getLastBubbleGroupIndex(groups) {
    for (let index = groups.length - 1; index >= 0; index--) {
        if (groups[index].bubbles.length) {
            return index;
        }
    }
    return -1;
}

async function appendResolvedConversationReply(messageText, speaker, settings, { avatar, extra = {}, chatId = '', groupId = undefined, personaId = getConversationPersonaId(), attachReplyReference = true, validateTarget = null } = {}) {
    const speakerAvatar = speaker?.avatar || avatar;
    const speakerName = speaker?.name || 'Character';
    const role = getResolvedReplyRole(speakerAvatar, avatar);
    const resolvedInputExtra = { ...extra };
    if (!attachReplyReference) {
        delete resolvedInputExtra.conversation_reply_to;
    }
    const resolvedExtra = getResolvedReplyExtra(resolvedInputExtra, speakerAvatar, avatar, { chatId, groupId, personaId, attachReplyReference });

    return withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, async () => {
        await waitForReplyDelay(messageText, settings, speakerAvatar, { chatId, groupId, personaId });
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return null;
        }
        return appendConversationMessage(messageText, {
            name: speakerName,
            role,
            extra: resolvedExtra,
            chatId,
            groupId,
            personaId,
        }, avatar);
    }, avatar, { chatId, groupId, personaId });
}

/**
 * @param {object} [options]
 * @param {{ messageId: string }|null} [options.reactionTarget] The message of the user that the reply answers, which its characters may react to. An automatic message answers none.
 */
export async function postMemberConversationReply(rawText, member, memberSettings, { avatar = getCurrentCharAvatar(), extra = {}, chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), validateTarget = null, roundMarker = null, reactionTarget = null } = {}) {
    if (!avatar || !member) {
        return false;
    }

    const memberName = member.name || 'A friend';
    const fallbackSpeaker = { avatar: member.avatar, name: memberName };
    const groups = buildReplySteps(rawText, {
        speaker: fallbackSpeaker,
        mode: 'member',
        speakers: groupId ? getConversationReplySpeakers(avatar, fallbackSpeaker, groupId, personaId) : [],
        settings: memberSettings,
    });
    let posted = false;
    const replyReferenceSpeakers = new Set();
    const lastBubbleGroup = getLastBubbleGroupIndex(groups);
    const writeReaction = createReactionWriter(groups, memberSettings, reactionTarget, { avatar, chatId, groupId, personaId });

    for (const [groupIndex, group] of groups.entries()) {
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return posted;
        }
        const { speaker, speakerAvatar, commandParts } = group;
        writeReaction(speakerAvatar);
        const replyExtra = getReplyExtraWithCommandMetadata(extra, group.commandMetadata);
        const plainReplyExtra = getReplyExtraWithCommandMetadata(extra, null);
        let commandReplyAppended = false;
        let commandSideEffectsCommitted = false;

        for (const [bubbleIndex, messageText] of group.bubbles.entries()) {
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const isLastBubble = roundMarker && groupIndex === lastBubbleGroup && bubbleIndex === group.bubbles.length - 1;
            const bubbleExtra = { ...(commandReplyAppended ? plainReplyExtra : replyExtra), ...(isLastBubble ? { conversation_round: roundMarker } : {}) };
            const appended = await appendResolvedConversationReply(messageText, speaker, memberSettings, { avatar, extra: bubbleExtra, chatId, groupId, personaId, attachReplyReference, validateTarget });
            if (!appended) {
                return posted;
            }
            if (attachReplyReference) {
                replyReferenceSpeakers.add(speakerAvatar);
            }
            commandReplyAppended = true;
            posted = true;
            if (!commandSideEffectsCommitted && hasCharacterReplyCommandSideEffects(commandParts)) {
                commitCharacterReplyCommands(commandParts, speakerAvatar, { chatId, groupId, personaId, reminderAvatar: avatar });
                commandSideEffectsCommitted = true;
            }
        }

        for (const context of commandParts.selfieRequests) {
            const speakerName = speaker.name || memberName;
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const generated = await withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, () => generateSelfieFromContext(context, memberSettings, speakerAvatar, {
                anchorAvatar: avatar,
                role: getResolvedReplyRole(speakerAvatar, avatar),
                name: speakerName,
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { chatId, groupId, personaId, attachReplyReference }),
                chatId,
                groupId,
                personaId,
                validateTarget,
            }), avatar, { chatId, groupId, personaId });
            if (generated && attachReplyReference) {
                replyReferenceSpeakers.add(speakerAvatar);
            }
            posted = posted || generated;
        }
    }

    return posted;
}

/**
 * @param {object} [options]
 * @param {string} [options.messageId] The id of the picture message. A reply that two pages land names it, and no picture is made when the chat holds a message with that id already.
 */
export async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar(), { anchorAvatar = avatar, role = 'character', name = '', extra = {}, chatId = '', groupId = undefined, personaId = getConversationPersonaId(), force = false, notify = false, validateTarget = null, messageId = '' } = {}) {
    const resolvedSettings = settings || {};
    if (!avatar) {
        return false;
    }
    if (typeof validateTarget === 'function' && !validateTarget()) {
        return false;
    }
    if (messageId && getConversationMessages(anchorAvatar, { chatId, create: false, groupId, personaId }).some(message => message.id === messageId)) {
        return false;
    }

    const cooldownRemaining = getImageCooldownRemainingSeconds(avatar, resolvedSettings, Date.now(), { chatId, groupId, personaId });
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
        buildSelfieImagePromptTemplate(formatPromptText(imagePrompt, 600), resolvedSettings.image_gen_prompt_template, scene),
        scene,
        avatar,
    );

    const imageUrl = await generateConversationImage(imagePrompt, resolvedSettings.image_gen_negative || '', { avatar, character, notify });
    if (imageUrl && (typeof validateTarget !== 'function' || validateTarget())) {
        const caption = await generateSelfieCaption(scene, resolvedSettings, avatar, imagePrompt);
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return false;
        }
        markImageGenerated(avatar, Date.now(), { chatId, groupId, personaId });
        await appendConversationMessage(caption, {
            name,
            role,
            extra: { ...extra, conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
            chatId,
            groupId,
            personaId,
            id: messageId,
        }, anchorAvatar);
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

/**
 * @param {object} [options]
 * @param {{ messageId: string }|null} [options.reactionTarget] The message of the user that the reply answers, which its characters may react to. An automatic message answers none.
 */
export async function postCharacterReply(rawText, settings, { extra = {}, chatId = '', groupId = undefined, personaId = getConversationPersonaId(), validateTarget = null, roundMarker = null, reactionTarget = null } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return '';
    }
    const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
    const speakerName = character?.name || getCurrentCharName();
    const fallbackSpeaker = { avatar, name: speakerName };
    const groups = buildReplySteps(rawText, {
        speaker: fallbackSpeaker,
        mode: 'character',
        speakers: groupId ? getConversationReplySpeakers(avatar, fallbackSpeaker, groupId, personaId) : [],
        settings,
    });
    const postedText = [];
    const replyReferenceSpeakers = new Set();
    const lastBubbleGroup = getLastBubbleGroupIndex(groups);
    const writeReaction = createReactionWriter(groups, settings, reactionTarget, { avatar, chatId, groupId, personaId });

    for (const [groupIndex, group] of groups.entries()) {
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return postedText.join('\n');
        }
        const { speaker, speakerAvatar, commandParts } = group;
        writeReaction(speakerAvatar);
        const replyExtra = getReplyExtraWithCommandMetadata(extra, group.commandMetadata);
        const plainReplyExtra = getReplyExtraWithCommandMetadata(extra, null);
        let commandReplyAppended = false;
        let commandSideEffectsCommitted = false;

        for (const [bubbleIndex, messageText] of group.bubbles.entries()) {
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const isLastBubble = roundMarker && groupIndex === lastBubbleGroup && bubbleIndex === group.bubbles.length - 1;
            const bubbleExtra = { ...(commandReplyAppended ? plainReplyExtra : replyExtra), ...(isLastBubble ? { conversation_round: roundMarker } : {}) };
            const appended = await appendResolvedConversationReply(messageText, speaker, settings, { avatar, extra: bubbleExtra, chatId, groupId, personaId, attachReplyReference, validateTarget });
            if (!appended) {
                return postedText.join('\n');
            }
            if (attachReplyReference) {
                replyReferenceSpeakers.add(speakerAvatar);
            }
            commandReplyAppended = true;
            postedText.push(messageText);
            if (!commandSideEffectsCommitted && hasCharacterReplyCommandSideEffects(commandParts)) {
                commitCharacterReplyCommands(commandParts, speakerAvatar, { chatId, groupId, personaId, reminderAvatar: avatar });
                commandSideEffectsCommitted = true;
            }
        }

        for (const context of commandParts.selfieRequests) {
            const attachReplyReference = !replyReferenceSpeakers.has(speakerAvatar);
            const generated = await generateSelfieFromContext(context, settings, speakerAvatar, {
                anchorAvatar: avatar,
                role: getResolvedReplyRole(speakerAvatar, avatar),
                name: speaker.name || '',
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { chatId, groupId, personaId, attachReplyReference }),
                chatId,
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
