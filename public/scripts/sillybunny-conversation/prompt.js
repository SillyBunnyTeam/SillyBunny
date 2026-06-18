import { generateRaw, name1 } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import {
    GEECHAN_DEFAULT_PROMPT,
    MEMORY_SUMMARY_INTERVAL_MESSAGES,
    MEMORY_SUMMARY_MIN_MESSAGES,
    MEMORY_SUMMARY_RECENT_MESSAGES,
    TRANSCRIPT_MESSAGE_LIMIT,
} from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationThreadKey,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
} from './context.js';
import { getCharacterAuthorNote, getCharacterForAvatar, getConversationParticipants, getParticipantNamesForDisplay } from './media.js';
import {
    composeConversationPersonaDescription,
    getAvailabilityCopy,
    getUserPersonaStatus,
    getUserStatus,
    withConversationConnectionProfile,
} from './personas.js';
import { getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { getConversationMemorySummary, getSettings, saveConversationMemorySummary } from './settings-store.js';
import { memorySummaryBusyAvatars, memorySummaryTimers } from './state.js';
import {
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationMediaDisplay,
    getConversationMediaIndex,
    getConversationPromptMediaAttachments,
    hasConversationMessageContent,
} from './thread-store.js';

export function formatConversationFileSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function renderConversationAttachments(container, message) {
    const media = getConversationMediaAttachments(message);
    const files = getConversationFileAttachments(message);
    if (!media.length && !files.length) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sb-conversation-attachments';

    media.forEach((attachment) => {
        const figure = document.createElement('figure');
        figure.className = 'sb-conversation-media-attachment';

        const title = String(attachment.title || '').trim();
        const type = String(attachment.type || 'image');
        if (type === 'video') {
            const video = document.createElement('video');
            video.src = attachment.url;
            video.controls = true;
            video.preload = 'metadata';
            video.title = title;
            figure.appendChild(video);
        } else if (type === 'audio') {
            const audio = document.createElement('audio');
            audio.src = attachment.url;
            audio.controls = true;
            audio.preload = 'metadata';
            audio.title = title;
            figure.appendChild(audio);
        } else {
            const img = document.createElement('img');
            img.src = attachment.url;
            img.alt = title || 'Uploaded image';
            img.loading = 'lazy';
            figure.appendChild(img);
        }

        if (title) {
            const caption = document.createElement('figcaption');
            caption.textContent = title;
            figure.appendChild(caption);
        }

        wrapper.appendChild(figure);
    });

    files.forEach((file) => {
        const link = document.createElement('a');
        link.className = 'sb-conversation-file-attachment';
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = file.name || '';

        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-file-lines';
        icon.setAttribute('aria-hidden', 'true');

        const copy = document.createElement('span');
        copy.className = 'sb-conversation-file-copy';
        const name = document.createElement('span');
        name.className = 'sb-conversation-file-name';
        name.textContent = file.name || 'Attached file';
        const size = document.createElement('span');
        size.className = 'sb-conversation-file-size';
        size.textContent = formatConversationFileSize(file.size);
        copy.append(name, size);

        link.append(icon, copy);
        wrapper.appendChild(link);
    });

    container.appendChild(wrapper);
}

export function formatPromptText(value, maxLength = 1400) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

export function formatConversationTranscript(messages) {
    return messages
        .slice(-TRANSCRIPT_MESSAGE_LIMIT)
        .map(message => {
            const parts = [
                formatPromptText(message.mes, 1800),
                getConversationAttachmentSummary(message),
            ].filter(Boolean);
            return parts.length ? `${message.name || 'Speaker'}: ${parts.join(' ')}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

export async function convertImageUrlToBase64(imageUrl) {
    if (typeof imageUrl !== 'string' || !imageUrl) {
        return '';
    }
    if (imageUrl.startsWith('data:')) {
        return imageUrl;
    }

    try {
        const response = await fetch(imageUrl, { method: 'GET', cache: 'force-cache' });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: status ${response.status}`);
        }
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Conversation Mode: failed to convert image to base64', error);
        return imageUrl;
    }
}

export async function buildConversationPromptMessages(messages, directive, speakerName = getCurrentCharName()) {
    const promptMessages = [{
        role: 'user',
        content: 'Conversation transcript:',
        identifier: 'conversation-transcript-header',
    }];

    const sliceMessages = messages.slice(-TRANSCRIPT_MESSAGE_LIMIT);
    const convertedMessages = await Promise.all(sliceMessages.map(async (message, index) => {
        const parts = [
            formatPromptText(message.mes, 1800),
            getConversationAttachmentSummary(message),
        ].filter(Boolean);
        const media = getConversationPromptMediaAttachments(message);
        if (!parts.length && !media.length) {
            return null;
        }

        const role = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant';
        const textContent = parts.length ? `${message.name || 'Speaker'}: ${parts.join(' ')}` : `${message.name || 'Speaker'} sent an attachment.`;

        if (!media.length) {
            return {
                role,
                content: textContent,
                identifier: `conversation-message-${message.id || index}`,
            };
        }

        const contentParts = [
            { type: 'text', text: textContent },
        ];

        const mediaDisplay = getConversationMediaDisplay(message);
        const mediaIndex = getConversationMediaIndex(message, media);
        const mediaToInline = mediaDisplay === MEDIA_DISPLAY.GALLERY
            ? [media[mediaIndex]]
            : media;

        for (const item of mediaToInline) {
            if (item && item.url) {
                const base64Url = await convertImageUrlToBase64(item.url);
                if (base64Url) {
                    contentParts.push({
                        type: 'image_url',
                        image_url: {
                            url: base64Url,
                            detail: 'high',
                        },
                    });
                }
            }
        }

        return {
            role,
            content: contentParts,
            identifier: `conversation-message-${message.id || index}`,
        };
    }));

    convertedMessages.filter(Boolean).forEach(msg => promptMessages.push(msg));

    if (promptMessages.length === 1) {
        promptMessages.push({
            role: 'user',
            content: '(No prior DM messages.)',
            identifier: 'conversation-empty-transcript',
        });
    }

    promptMessages.push({
        role: 'user',
        content: [directive, `${speakerName}:`].filter(Boolean).join('\n\n'),
        identifier: 'conversation-reply-directive',
    });

    return promptMessages;
}

export function buildConversationMemoryPrompt(avatar, messages, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const character = getCharacterForAvatar(avatar);
    const participants = getParticipantNamesForDisplay(getConversationParticipants(avatar, getSettings(avatar, { groupId }), { groupId }));
    return [
        `Main DM: ${character?.name || 'Character'} with ${name1 || 'User'}.`,
        participants.length > 1 ? `Other possible participants: ${participants.slice(1).join(', ')}.` : '',
        'Summarize durable DM memory only: relationship tone, promises, unresolved topics, preferences, private jokes, boundaries, and emotionally important beats.',
        'Ignore filler small talk unless it changes the relationship. Keep it compact and useful for future replies.',
        '',
        formatConversationTranscript(messages.slice(-MEMORY_SUMMARY_RECENT_MESSAGES)),
    ].filter(Boolean).join('\n');
}

export async function updateConversationMemorySummary(avatar = getCurrentCharAvatar(), { force = false, groupId = getConversationGroupIdForAvatar(avatar), notify = false } = {}) {
    const memoryKey = getConversationThreadKey(avatar, groupId);
    if (!avatar || !memoryKey || memorySummaryBusyAvatars.has(memoryKey)) {
        return false;
    }

    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    const messages = Array.isArray(branch?.messages) ? branch.messages.filter(message => hasConversationMessageContent(message) && message.role !== 'system') : [];
    if (!messages.length || (!force && messages.length < MEMORY_SUMMARY_MIN_MESSAGES)) {
        if (notify) {
            toastr.info(`Memory appears after at least ${MEMORY_SUMMARY_MIN_MESSAGES} messages, or when there is enough chat to summarize.`);
        }
        return false;
    }

    const lastSummarizedCount = parsePositiveInt(branch?.memoryMessageCount, 0, 0);
    if (!force && messages.length - lastSummarizedCount < MEMORY_SUMMARY_INTERVAL_MESSAGES) {
        return false;
    }

    memorySummaryBusyAvatars.add(memoryKey);
    try {
        const previousSummary = getConversationMemorySummary(avatar, { groupId });
        const prompt = [
            previousSummary ? `Existing DM memory summary:\n${previousSummary}` : '',
            buildConversationMemoryPrompt(avatar, messages, { groupId }),
            'Return the updated memory summary in 6 concise bullets or fewer. No preamble.',
        ].filter(Boolean).join('\n\n');
        const settings = getSettings(avatar, { groupId });
        const response = await withConversationConnectionProfile(settings, () => generateRaw({
            prompt,
            systemPrompt: 'You maintain a concise private DM memory summary for realistic ongoing chat continuity.',
            responseLength: 420,
            trimNames: false,
            cacheScope: 'conversation-mode-memory',
        }));

        if (response?.trim()) {
            saveConversationMemorySummary(avatar, response.trim(), messages.length, { groupId });
            if (notify) {
                toastr.success('Conversation memory refreshed.');
            }
            return true;
        }
    } catch (error) {
        console.warn('Conversation Mode: memory summary update failed', error);
        if (notify) {
            toastr.warning('Conversation memory refresh failed. Check console for details.');
        }
    } finally {
        memorySummaryBusyAvatars.delete(memoryKey);
    }

    return false;
}

export function scheduleConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    const memoryKey = getConversationThreadKey(avatar, groupId);
    const existingTimer = memorySummaryTimers.get(memoryKey);
    if (existingTimer) {
        window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
        memorySummaryTimers.delete(memoryKey);
        void updateConversationMemorySummary(avatar, { groupId });
    }, 2500);
    memorySummaryTimers.set(memoryKey, timer);
}

export function buildConversationSystemPrompt(settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, groupId = getConversationGroupIdForAvatar(threadAvatar) } = {}) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const userName = name1 || 'User';
    const threadSettings = threadAvatar === avatar ? settings : getSettings(threadAvatar, { groupId });
    const threadCharacter = threadAvatar !== avatar ? getCharacterForAvatar(threadAvatar) : null;
    const fields = [
        threadCharacter
            ? `You are ${charName} in a private group direct-message conversation with ${userName} and ${threadCharacter.name || 'another character'}.`
            : `You are ${charName} in a private direct-message conversation with ${userName}.`,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
        'Formatting: write plain chat text. Do not wrap words or phrases in double quotation marks or smart quotes for emphasis. If sending multiple chat bubbles, put each bubble on its own line.',
    ];

    let compiledPrompt = settings.geechan_chatroom_prompt || GEECHAN_DEFAULT_PROMPT;
    compiledPrompt = compiledPrompt.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
    compiledPrompt = compiledPrompt.replace(/\{\{trim\}\}/g, '');
    if (settings.custom_instructions && settings.custom_instructions.trim()) {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, (match, p1) => {
            return p1.replace(/\{\{getvar::player-instructions\}\}/gi, settings.custom_instructions);
        });
    } else {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, '');
    }
    compiledPrompt = compiledPrompt
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{user\}\}/g, userName);
    fields.push(compiledPrompt.trim());

    if (character?.description) {
        fields.push(`Character description:\n${formatPromptText(character.description, 2400)}`);
    }
    if (character?.personality) {
        fields.push(`Personality:\n${formatPromptText(character.personality, 1600)}`);
    }
    if (character?.scenario) {
        fields.push(`Background context:\n${formatPromptText(character.scenario, 1200)}`);
    }
    const authorNote = settings.authors_note || getCharacterAuthorNote(avatar);
    if (authorNote) {
        fields.push(`Conversation author's note:\n${authorNote.replace('{{char}}', charName).replace('{{user}}', userName)}`);
    }
    if (settings.lorebook_override) {
        fields.push(`Conversation lorebook focus: ${settings.lorebook_override}. Prefer this lore/context over roleplay scene continuity.`);
    }

    const userAvailability = getAvailabilityCopy(getUserStatus());
    const userPersonaStatus = getUserPersonaStatus();
    fields.push(userPersonaStatus
        ? `User presence: ${userName} is ${userAvailability.label.toLowerCase()}. Their Conversation status: ${userPersonaStatus}.`
        : `User presence: ${userName} is ${userAvailability.label.toLowerCase()}.`);
    const personaContext = composeConversationPersonaDescription(user_avatar).trim() || String(power_user?.persona_description ?? '').trim();
    if (personaContext) {
        fields.push(`User persona and active Scenario Notes:\n${formatPromptText(personaContext, 2600)}`);
    }

    const partners = getConversationParticipants(threadAvatar, threadSettings, { groupId }).filter(participant => participant?.avatar && participant.avatar !== avatar);
    if (partners.length) {
        fields.push(`Group DM participants who may chime in: ${getParticipantNamesForDisplay(partners).join(', ')}. Treat them as independent people in the chat. Do not speak for them unless specifically generating their message.`);
    }

    const memorySummary = getConversationMemorySummary(threadAvatar, { groupId });
    if (memorySummary) {
        fields.push(`Long-term DM memory summary:\n${memorySummary}`);
    }

    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        const current = getCurrentActivityFromSchedule(schedule, avatar);
        const now = new Date();
        const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        fields.push(`Current life context: It is ${timeLabel} for ${charName}, who is currently ${current.activity} (status: ${current.status}). Let this naturally color your availability, mood, and what you mention. Stay in this moment of your day.`);
    }

    const commandHints = [];
    if (settings.selfie_command_enabled) {
        commandHints.push('To send a selfie or photo, embed [selfie] (optionally [selfie: context="what the photo shows"]) anywhere in your reply. It is stripped from the visible message and turned into a real image.');
    }
    if (settings.schedule_command_enabled) {
        commandHints.push('To change what you are doing right now, embed [schedule_update: status="online|idle|dnd|offline", activity="short description", duration="1h30m"]. Use this when your situation shifts (you got off work, went to sleep, etc.).');
    }
    commandHints.push('To schedule a reminder for the user at their request, embed [reminder: delay_or_time | memo] anywhere in your reply. delay_or_time can be durations (e.g. "2h", "15m", "30s") or explicit clock times (e.g. "14:30"). memo is what you are reminding them about (e.g. "wash the dishes"). This command is stripped from the visible message.');
    if (commandHints.length) {
        fields.push(`Available commands (use sparingly and only when natural):\n${commandHints.join('\n')}`);
    }

    return fields.join('\n\n');
}
