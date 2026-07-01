import { name1 } from '../../script.js';
import { MEDIA_DISPLAY } from '../constants.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import {
    GEECHAN_DEFAULT_PROMPT,
    MEMORY_SUMMARY_INTERVAL_MESSAGES,
    MEMORY_SUMMARY_MIN_MESSAGES,
    MEMORY_SUMMARY_RECENT_MESSAGES,
    MEMORY_SUMMARY_RESPONSE_TOKENS,
    TRANSCRIPT_MESSAGE_LIMIT,
} from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationThreadStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
} from './context.js';
import { generateConversationRaw } from './generation.js';
import { getCharacterAuthorNote, getCharacterForAvatar, getConversationParticipants, getParticipantNamesForDisplay } from './media.js';
import {
    composeConversationPersonaDescription,
    getAvailabilityCopy,
    getUserPersonaStatus,
    getUserStatus,
} from './personas.js';
import { getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import {
    getConversationGroupMemorySummaries,
    getConversationMemorySummary,
    getConversationSoloMemorySummary,
    getSettings,
    saveConversationMemorySummary,
} from './settings-store.js';
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

function formatConversationReplyReference(reference) {
    if (!reference || typeof reference !== 'object') {
        return '';
    }

    const preview = formatPromptText(reference.text || reference.attachmentSummary, 600);
    if (!preview) {
        return '';
    }

    return `(replying to ${formatPromptText(reference.name || 'Speaker', 80)}: ${preview})`;
}

function getConversationSpeakerName(message) {
    if (message?.role === 'user') {
        return name1 || 'User';
    }

    return String(message?.name || 'Speaker').trim() || 'Speaker';
}

function getLastUserMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'user' && hasConversationMessageContent(messages[index])) {
            return index;
        }
    }

    return -1;
}

function getLastNonUserMessageBefore(messages, beforeIndex) {
    for (let index = beforeIndex - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'user' && message?.role !== 'system' && hasConversationMessageContent(message)) {
            return message;
        }
    }

    return null;
}

function buildConversationGroupReferenceContext(messages, { groupId = '', speakerName = getCurrentCharName() } = {}) {
    if (!groupId) {
        return '';
    }

    const recentMessages = messages
        .filter(message => hasConversationMessageContent(message) && message?.role !== 'system')
        .slice(-TRANSCRIPT_MESSAGE_LIMIT);
    const latestUserIndex = getLastUserMessageIndex(recentMessages);
    if (latestUserIndex < 0) {
        return '';
    }

    const latestUserMessage = recentMessages[latestUserIndex];
    const replyReference = latestUserMessage.extra?.conversation_reply_to;
    const lastNonUserMessage = getLastNonUserMessageBefore(recentMessages, latestUserIndex);
    const rawTargetName = replyReference?.name || (lastNonUserMessage ? getConversationSpeakerName(lastNonUserMessage) : '');
    const targetName = formatPromptText(rawTargetName, 80);
    if (!targetName) {
        return '';
    }

    const speaker = formatPromptText(speakerName || 'Character', 80);
    const latestText = formatPromptText(latestUserMessage.mes, 500);
    const targetReason = replyReference?.name
        ? `The latest user message is an explicit reply to ${targetName}.`
        : `The latest user message most likely addresses ${targetName}, the last non-user speaker before it, when it uses implicit references like you, your, that, this, or why.`;

    return [
        'Group DM reference context:',
        latestText ? `Latest user message: ${latestText}` : '',
        targetReason,
        `${speaker} should silently use this to resolve ambiguous references. If ${speaker} is not ${targetName}, do not assume every you means ${speaker}; the user may be referring to ${targetName}.`,
        'Do not mention this context or explain the reference resolution; just reply naturally.',
    ].filter(Boolean).join('\n');
}

function getConversationLocalTimeContext(now = new Date()) {
    const resolvedTimeZone = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch {
            return '';
        }
    })();
    const dateTimeLabel = (() => {
        try {
            return now.toLocaleString([], {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
            });
        } catch {
            return now.toString();
        }
    })();

    return [
        `Current device time context: ${dateTimeLabel}.`,
        resolvedTimeZone ? `Timezone: ${resolvedTimeZone}.` : '',
        'Use this as the user\'s current computer/phone time for day of week, time of day, dates, timezones, reminders, scheduling, and natural chat timing.',
    ].filter(Boolean).join(' ');
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

export async function convertImageUrlsToBase64(imageUrls, concurrency = 3) {
    const urls = Array.isArray(imageUrls) ? imageUrls : [];
    if (!urls.length) {
        return [];
    }

    const results = new Array(urls.length).fill('');
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(parsePositiveInt(concurrency, 3, 1), urls.length));
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < urls.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await convertImageUrlToBase64(urls[index]);
        }
    });

    await Promise.all(workers);
    return results;
}

export async function buildConversationPromptMessages(messages, directive, speakerName = getCurrentCharName(), { groupId = '' } = {}) {
    const promptMessages = [{
        role: 'user',
        content: 'Conversation transcript:',
        identifier: 'conversation-transcript-header',
    }];

    const sliceMessages = messages.slice(-TRANSCRIPT_MESSAGE_LIMIT);
    const convertedMessages = await Promise.all(sliceMessages.map(async (message, index) => {
        const parts = [
            formatConversationReplyReference(message.extra?.conversation_reply_to),
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

        const base64Urls = await convertImageUrlsToBase64(mediaToInline.map(item => item?.url).filter(Boolean));
        for (const base64Url of base64Urls) {
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

    const groupReferenceContext = buildConversationGroupReferenceContext(messages, { groupId, speakerName });
    if (groupReferenceContext) {
        promptMessages.push({
            role: 'system',
            content: groupReferenceContext,
            identifier: 'conversation-group-reference-context',
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

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    const lastSummarizedCount = parsePositiveInt(threadStore?.memoryMessageCount ?? branch?.memoryMessageCount, 0, 0);
    if (!force && messages.length - lastSummarizedCount < MEMORY_SUMMARY_INTERVAL_MESSAGES) {
        return false;
    }

    memorySummaryBusyAvatars.add(memoryKey);
    try {
        const previousSummary = getConversationMemorySummary(avatar, { groupId });
        const prompt = [
            previousSummary ? `Existing DM memory summary:\n${previousSummary}` : '',
            buildConversationMemoryPrompt(avatar, messages, { groupId }),
            'Return the updated memory summary in concise bullets. No preamble.',
        ].filter(Boolean).join('\n\n');
        const settings = getSettings(avatar, { groupId });
        const response = await generateConversationRaw({
            prompt,
            systemPrompt: 'You maintain a concise private DM memory summary for realistic ongoing chat continuity.',
            responseLength: MEMORY_SUMMARY_RESPONSE_TOKENS,
            trimNames: false,
            cacheScope: 'conversation-mode-memory',
        }, settings);

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
    const partners = getConversationParticipants(threadAvatar, threadSettings, { groupId }).filter(participant => participant?.avatar && participant.avatar !== avatar);
    const partnerNames = getParticipantNamesForDisplay(partners);
    let conversationOpening = `You are ${charName} in a private direct-message conversation with ${userName}.`;
    if (groupId) {
        conversationOpening = `You are ${charName} in a private group direct-message conversation with ${[userName, ...partnerNames].join(', ')}. You are one equal participant in this group DM and should reply only as ${charName}.`;
    } else if (threadCharacter) {
        conversationOpening = `You are ${charName} in a private group direct-message conversation with ${userName} and ${threadCharacter.name || 'another character'}.`;
    }
    const fields = [
        conversationOpening,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
        'Formatting: write plain chat text. Do not start with a speaker/name label. Do not wrap words or phrases in double quotation marks or smart quotes for emphasis. If sending multiple chat bubbles, put each bubble on its own line.',
    ];
    const now = new Date();
    fields.push(getConversationLocalTimeContext(now));

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

    if (partners.length) {
        fields.push(`${groupId ? 'Other group DM participants' : 'Group DM participants who may chime in'}: ${partnerNames.join(', ')}. Treat them as independent people in the chat. Do not speak for them unless specifically generating their message.`);
    }

    const memorySummary = getConversationMemorySummary(threadAvatar, { groupId });
    if (memorySummary) {
        fields.push(`Long-term DM memory summary:\n${memorySummary}`);
    }
    if (settings.include_related_memory && groupId) {
        const soloMemory = getConversationSoloMemorySummary(avatar);
        if (soloMemory?.summary) {
            fields.push(`Relevant solo DM memory for ${charName}:\n${formatPromptText(soloMemory.summary, 1200)}\nUse this as remembered private context for ${charName}, but do not reveal private solo DM details unless they naturally belong in this group Conversation.`);
        }
    } else if (settings.include_related_memory) {
        const groupMemories = getConversationGroupMemorySummaries(avatar, { max: 4 });
        if (groupMemories.length) {
            const formattedMemories = groupMemories
                .map(item => `- ${item.groupName || `Group ${item.groupId}`}: ${formatPromptText(item.summary, 900)}`)
                .join('\n');
            fields.push(`Relevant group Conversation memories for ${charName}:\n${formattedMemories}\nUse these as remembered context from group DMs, but keep this solo DM private and do not act as if other group participants are present.`);
        }
    }

    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        const current = getCurrentActivityFromSchedule(schedule, avatar, now);
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
