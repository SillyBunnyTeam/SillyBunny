/**
 * Conversation Mode REST API - Generation and Prompt Building
 *
 * Functions for building prompts, managing generation requests, and extracting responses.
 */

import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { parse as parseCharacterCard } from '../character-card-parser.js';
import { handleChatCompletionsGenerate } from './backends/chat-completions.js';
import { handleTextCompletionsGenerate } from './backends/text-completions.js';
import {
    GEECHAN_DEFAULT_PROMPT,
    DEFAULT_SETTINGS,
    TRANSCRIPT_MESSAGE_LIMIT,
    DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
} from '../../public/scripts/sillybunny-conversation/constants.js';
import {
    getConversationAttachmentSummary,
    getConversationMediaDisplay,
    getConversationMediaIndex,
    getConversationPromptMediaAttachments,
} from '../../public/scripts/sillybunny-conversation/thread-store-utils.js';
import {
    buildConversationGroupReferenceContext,
    compileGeechanPrompt,
    formatPromptText,
    getGroundedDialogueRulesPrompt,
} from '../../public/scripts/sillybunny-conversation/shared-helpers.js';
import { getObject, clamp, parsePositiveInt, isObject } from './conversation-utils.js';
import { convertImageUrlsToBase64 } from './conversation-utils.js';
import { getConversationThreadStore } from './conversation-threads.js';
import { getGroupConversationSettings } from './conversation-groups.js';

const GENERATION_BACKENDS = Object.freeze({
    CHAT: 'chat',
    TEXT: 'text',
});

/**
 * Normalize character data from card or override
 */
export function normalizeCharacterData(rawCharacter, avatar = '') {
    const raw = getObject(rawCharacter);
    const data = getObject(raw.data);
    const extensions = getObject(data.extensions || raw.extensions);
    const fallbackName = path.parse(String(avatar || '')).name || 'Character';
    return {
        name: data.name || raw.name || fallbackName,
        description: data.description || raw.description || '',
        personality: data.personality || raw.personality || '',
        scenario: data.scenario || raw.scenario || '',
        first_mes: data.first_mes || raw.first_mes || '',
        mes_example: data.mes_example || raw.mes_example || '',
        creator_notes: data.creator_notes || raw.creator_notes || raw.creatorcomment || '',
        extensions,
    };
}

/**
 * Load character data from request body or disk
 */
export async function getCharacterData(request, avatar) {
    if (isObject(request.body?.character)) {
        return normalizeCharacterData(request.body.character, avatar);
    }

    try {
        const avatarFile = sanitize(path.basename(avatar));
        const avatarPath = path.join(request.user.directories.characters, avatarFile);
        if (path.extname(avatarFile).toLowerCase() !== '.png' || !fs.existsSync(avatarPath)) {
            return normalizeCharacterData({}, avatar);
        }

        const cardText = await parseCharacterCard(avatarPath, 'png');
        return normalizeCharacterData(JSON.parse(cardText), avatar);
    } catch (error) {
        console.warn('Conversation REST API: failed to read character card', error);
        return normalizeCharacterData({}, avatar);
    }
}

/**
 * Build system time context string
 */
export function getConversationSystemTimeContext(now = new Date()) {
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
        `Current system time context: ${dateTimeLabel}.`,
        resolvedTimeZone ? `Timezone: ${resolvedTimeZone}.` : '',
        'Use this as the current server/device time for day of week, time of day, dates, timezones, reminders, scheduling, and natural chat timing.',
    ].filter(Boolean).join(' ');
}

/**
 * Extract text from content (string or multimodal array)
 */
export function getContentText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return String(content || '');
    }

    return content
        .map(part => typeof part === 'string' ? part : part?.text || '')
        .filter(Boolean)
        .join('\n');
}

/**
 * Build conversation prompt messages (async for image conversion)
 */
export async function buildConversationPromptMessages(messages, directive, speakerName, { groupId = '', userName = 'User' } = {}) {
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

        // Build multimodal content with images
        const contentParts = [
            { type: 'text', text: textContent },
        ];

        const mediaDisplay = getConversationMediaDisplay(message);
        const mediaIndex = getConversationMediaIndex(message, media);
        // MEDIA_DISPLAY.GALLERY means show one image; otherwise show all
        const mediaToInline = mediaDisplay === 'gallery'
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

    promptMessages.push(...convertedMessages.filter(Boolean));

    if (promptMessages.length === 1) {
        promptMessages.push({
            role: 'user',
            content: '(No prior DM messages.)',
            identifier: 'conversation-empty-transcript',
        });
    }

    const groupReferenceContext = buildConversationGroupReferenceContext(messages, { groupId, speakerName, userName });
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

/**
 * Build conversation system prompt
 */
export function buildConversationSystemPrompt({ settings, character, userName, groupId, branch }) {
    const charName = character.name || 'Character';
    const fields = [
        groupId
            ? `You are ${charName} in a private group direct-message conversation with ${userName}. You are one equal participant in this group DM and should reply only as ${charName}.`
            : `You are ${charName} in a private direct-message conversation with ${userName}.`,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
        'Formatting: write plain chat text. Do not start with a speaker/name label. Do not wrap words or phrases in double quotation marks or smart quotes for emphasis. If sending multiple chat bubbles, put each bubble on its own line.',
        getConversationSystemTimeContext(),
        compileGeechanPrompt(settings, charName, userName, GEECHAN_DEFAULT_PROMPT),
    ];

    const groundedRules = getGroundedDialogueRulesPrompt(settings);
    if (groundedRules) {
        fields.push(groundedRules);
    }

    if (character.description) {
        fields.push(`Character description:\n${formatPromptText(character.description, 2400)}`);
    }
    if (character.personality) {
        fields.push(`Personality:\n${formatPromptText(character.personality, 1600)}`);
    }
    if (character.scenario) {
        fields.push(`Background context:\n${formatPromptText(character.scenario, 1200)}`);
    }

    const authorNote = settings.authors_note || character.creator_notes;
    if (authorNote) {
        fields.push(`Conversation author's note:\n${String(authorNote).replace('{{char}}', charName).replace('{{user}}', userName)}`);
    }
    if (settings.lorebook_override) {
        fields.push(`Conversation lorebook focus: ${settings.lorebook_override}. Prefer this lore/context over roleplay scene continuity.`);
    }
    if (branch?.memorySummary) {
        fields.push(`Long-term DM memory summary:\n${branch.memorySummary}`);
    }

    const commandHints = [];
    if (settings.selfie_command_enabled) {
        commandHints.push('To send a selfie or photo, embed [selfie] (optionally [selfie: context="what the photo shows"]) anywhere in your reply. It is stripped from the visible message and turned into a real image.');
    }
    if (settings.schedule_command_enabled) {
        commandHints.push('To change what you are doing right now, embed [schedule_update: status="online|idle|dnd|offline", activity="short description", duration="1h30m"]. Use this when your situation shifts.');
    }
    commandHints.push('To schedule a reminder for the user at their request, embed [reminder: delay_or_time | memo] anywhere in your reply. This command is stripped from the visible message.');
    fields.push(`Available commands (use sparingly and only when natural):\n${commandHints.join('\n')}`);

    return fields.filter(Boolean).join('\n\n');
}

/**
 * Get default directive if not provided
 */
export function getDefaultDirective(body) {
    return String(body.directive || body.promptDirective || '[System directive: The user sent the latest DM(s). Reply directly to them in the Conversation Mode thread. Output only your message body, without a name prefix.]');
}

/**
 * Normalize conversation settings with defaults and clamping
 */
export function normalizeConversationSettings(settings = {}) {
    const normalized = { ...DEFAULT_SETTINGS, ...getObject(settings) };
    normalized.reply_max_tokens = clamp(
        parsePositiveInt(normalized.reply_max_tokens, DEFAULT_CONVERSATION_REPLY_MAX_TOKENS, MIN_CONVERSATION_REPLY_MAX_TOKENS),
        MIN_CONVERSATION_REPLY_MAX_TOKENS,
        MAX_CONVERSATION_REPLY_MAX_TOKENS,
    );
    if (normalized.reply_max_tokens === 1024) {
        normalized.reply_max_tokens = DEFAULT_CONVERSATION_REPLY_MAX_TOKENS;
    }
    normalized.selfie_command_enabled = Boolean(normalized.selfie_command_enabled);
    normalized.schedule_command_enabled = Boolean(normalized.schedule_command_enabled);
    normalized.grounded_dialogue_rules_enabled = Boolean(normalized.grounded_dialogue_rules_enabled);
    normalized.grounded_dialogue_rules = typeof normalized.grounded_dialogue_rules === 'string'
        ? normalized.grounded_dialogue_rules
        : DEFAULT_SETTINGS.grounded_dialogue_rules;
    return normalized;
}

/**
 * Get conversation settings with cascade: global -> group -> thread -> overrides
 */
export function getConversationSettings(request, store, avatar, groupId, overrides = {}, { personaId = '' } = {}) {
    const threadStore = getConversationThreadStore(store, avatar, groupId, { create: false, personaId });
    return normalizeConversationSettings({
        ...DEFAULT_SETTINGS,
        ...getObject(store.settings),
        ...(groupId ? { multi_char: true, auto_character_chat: true } : {}),
        ...getGroupConversationSettings(request, store, groupId, personaId, normalizeConversationSettings),
        ...getObject(threadStore?.settings),
        ...getObject(overrides),
    });
}

/**
 * Normalize generation backend type
 */
export function normalizeGenerationBackend(value) {
    const backend = String(value || '').toLowerCase().replace(/[_ ]/g, '-');
    if (['text', 'text-completion', 'text-completions'].includes(backend)) {
        return GENERATION_BACKENDS.TEXT;
    }
    return GENERATION_BACKENDS.CHAT;
}

/**
 * Get generation payload (deep clone to avoid mutation)
 */
export function getGenerationPayload(generation) {
    const source = getObject(generation?.payload || generation?.body || generation);
    // Deep clone to avoid mutating caller's data
    const payload = JSON.parse(JSON.stringify(source));
    delete payload.backend;
    delete payload.body;
    delete payload.payload;
    return payload;
}

/**
 * Build text prompt from system + messages (for text-completion backends)
 */
export function buildTextPrompt(systemPrompt, promptMessages) {
    const transcript = promptMessages
        .map(message => `${message.role.toUpperCase()}: ${getContentText(message.content)}`)
        .join('\n\n');
    return `${systemPrompt}\n\n${transcript}`.trim();
}

/**
 * Build generation request body
 */
export function buildGenerationRequestBody(generation, systemPrompt, promptMessages, responseLength) {
    const backend = normalizeGenerationBackend(generation?.backend || generation?.type);
    const payload = getGenerationPayload(generation);
    payload.stream = false;

    if (backend === GENERATION_BACKENDS.TEXT) {
        payload.prompt = buildTextPrompt(systemPrompt, promptMessages);
    } else {
        payload.messages = [
            { role: 'system', content: systemPrompt, identifier: 'conversation-system-prompt' },
            ...promptMessages,
        ];
    }

    if (payload.max_tokens === undefined && payload.max_completion_tokens === undefined) {
        payload.max_tokens = responseLength;
    }

    return { backend, payload };
}

/**
 * Create a capturing response mock for backend generation
 */
export function createCapturingResponse() {
    let statusCode = 200;
    let payload;
    let headersSent = false;
    let writableEnded = false;
    const headers = {};
    const chunks = [];

    return {
        get statusCode() {
            return statusCode;
        },
        get body() {
            return payload;
        },
        get headers() {
            return headers;
        },
        get headersSent() {
            return headersSent;
        },
        get writableEnded() {
            return writableEnded;
        },
        get destroyed() {
            return writableEnded;
        },
        status(code) {
            statusCode = code;
            return this;
        },
        setHeader(name, value) {
            headers[String(name).toLowerCase()] = value;
            return this;
        },
        getHeader(name) {
            return headers[String(name).toLowerCase()];
        },
        writeHead(code, nextHeaders = {}) {
            statusCode = code;
            Object.assign(headers, nextHeaders);
            headersSent = true;
            return this;
        },
        write(chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
            headersSent = true;
            return true;
        },
        send(data) {
            payload = data;
            headersSent = true;
            writableEnded = true;
            return this;
        },
        json(data) {
            return this.send(data);
        },
        sendStatus(code) {
            statusCode = code;
            payload = { error: true };
            headersSent = true;
            writableEnded = true;
            return this;
        },
        end(data = undefined) {
            if (data !== undefined) {
                chunks.push(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
            }
            if (payload === undefined && chunks.length) {
                payload = chunks.join('');
            }
            headersSent = true;
            writableEnded = true;
            return this;
        },
    };
}

/**
 * Run backend generation with error handling
 */
export async function runBackendGeneration(request, backend, payload) {
    if (!Object.keys(payload).length) {
        const error = new Error('generation payload is required');
        error.status = 400;
        throw error;
    }

    // Create a safe minimal request clone instead of Object.create(request)
    // to avoid breaking instanceof checks and own-property enumeration
    const generationRequest = {
        user: request.user,
        headers: request.headers,
        app: request.app,
        body: payload,
    };
    const capture = createCapturingResponse();
    if (backend === GENERATION_BACKENDS.TEXT) {
        await handleTextCompletionsGenerate(generationRequest, capture);
    } else {
        await handleChatCompletionsGenerate(generationRequest, capture);
    }

    const body = capture.body;
    if (capture.statusCode >= 400 || body?.error) {
        const error = new Error('conversation generation failed');
        error.status = capture.statusCode >= 400 ? capture.statusCode : 502;
        error.body = body;
        throw error;
    }

    return body;
}

/**
 * Extract generated text from various response formats
 */
export function extractGeneratedText(generationResponse) {
    if (typeof generationResponse === 'string') {
        return generationResponse;
    }

    const firstChoice = generationResponse?.choices?.[0];
    return String(
        firstChoice?.message?.content
        ?? firstChoice?.text
        ?? generationResponse?.content
        ?? generationResponse?.response
        ?? generationResponse?.text
        ?? '',
    );
}
