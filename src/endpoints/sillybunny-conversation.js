import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { SETTINGS_FILE } from '../constants.js';
import { parse as parseCharacterCard } from '../character-card-parser.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { tryWriteFileSync } from '../util.js';
import { handleChatCompletionsGenerate } from './backends/chat-completions.js';
import { handleTextCompletionsGenerate } from './backends/text-completions.js';
import {
    CONVERSATION_STORE_KEY,
    DEFAULT_BRANCH_ID,
    DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    DEFAULT_SETTINGS,
    GEECHAN_DEFAULT_PROMPT,
    GROUP_CONVERSATION_STORE_PREFIX,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MAX_THREAD_MESSAGES,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    TRANSCRIPT_MESSAGE_LIMIT,
} from '../../public/scripts/sillybunny-conversation/constants.js';
import {
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
} from '../../public/scripts/sillybunny-conversation/generation-utils.js';
import {
    getConversationAttachmentLabels,
    getConversationAttachmentSummary,
    hasConversationMessageContent,
    safeParseThread,
} from '../../public/scripts/sillybunny-conversation/thread-store-utils.js';

export const router = express.Router();

const GENERATION_BACKENDS = Object.freeze({
    CHAT: 'chat',
    TEXT: 'text',
});

function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getObject(value) {
    return isObject(value) ? value : {};
}

function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function readJsonFile(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallback;
        }

        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function getSettingsPath(request) {
    return path.join(request.user.directories.root, SETTINGS_FILE);
}

function readUserSettings(request) {
    return readJsonFile(getSettingsPath(request), {});
}

function ensureConversationStore(settings) {
    settings.extension_settings = getObject(settings.extension_settings);

    const current = getObject(settings.extension_settings[CONVERSATION_STORE_KEY]);
    const store = {
        ...current,
        version: parsePositiveInt(current.version, 1, 1),
        localStorageMigrated: Boolean(current.localStorageMigrated),
        settings: getObject(current.settings),
        characters: getObject(current.characters),
        reminders: Array.isArray(current.reminders) ? current.reminders : [],
    };

    settings.extension_settings[CONVERSATION_STORE_KEY] = store;
    return store;
}

function saveConversationStore(request, currentSettings, store, version = undefined) {
    const incomingVersion = version === undefined
        ? getSettingsVersion(currentSettings)
        : getSettingsVersion({ _version: version });
    const incomingSettings = {
        ...currentSettings,
        extension_settings: {
            ...getObject(currentSettings.extension_settings),
            [CONVERSATION_STORE_KEY]: store,
        },
        _version: incomingVersion,
    };
    const preparedSave = prepareSettingsSave(incomingSettings, currentSettings);
    if (!preparedSave.ok) {
        return {
            ok: false,
            status: 409,
            body: {
                error: 'settings_conflict',
                version: preparedSave.currentVersion,
            },
        };
    }

    tryWriteFileSync(getSettingsPath(request), JSON.stringify(preparedSave.settings, null, 4));
    return {
        ok: true,
        version: preparedSave.version,
        settings: preparedSave.settings,
        store: preparedSave.settings.extension_settings[CONVERSATION_STORE_KEY],
    };
}

function getConversationThreadKey(avatar, groupId = '') {
    const safeAvatar = String(avatar || '').trim();
    const safeGroupId = String(groupId || '').trim();
    if (!safeAvatar) {
        return '';
    }

    return safeGroupId ? `${GROUP_CONVERSATION_STORE_PREFIX}${safeGroupId}:${safeAvatar}` : safeAvatar;
}

function createConversationBranch(name = 'Main', id = DEFAULT_BRANCH_ID) {
    const now = Date.now();
    return {
        id,
        name,
        messages: [],
        preview: 'Conversation ready',
        unread: 0,
        lastActivity: now,
        followupCount: 0,
        lastAutoMessageAt: 0,
        scheduleTriggers: {},
        sessionMarkers: {},
        memorySummary: '',
        memoryMessageCount: 0,
        memoryUpdatedAt: 0,
        createdAt: now,
        updatedAt: now,
    };
}

function normalizeConversationBranch(branch, id = DEFAULT_BRANCH_ID) {
    const now = Date.now();
    const target = isObject(branch)
        ? branch
        : createConversationBranch(id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation', id);

    target.id = target.id || id;
    target.name = target.name || (id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation');
    target.messages = safeParseThread(target.messages).slice(-MAX_THREAD_MESSAGES);
    target.preview = typeof target.preview === 'string' ? target.preview : 'Conversation ready';
    target.unread = parsePositiveInt(target.unread, 0, 0);
    target.lastActivity = parsePositiveInt(target.lastActivity, now, 0);
    target.followupCount = parsePositiveInt(target.followupCount, 0, 0);
    target.lastAutoMessageAt = parsePositiveInt(target.lastAutoMessageAt, 0, 0);
    target.scheduleTriggers = getObject(target.scheduleTriggers);
    target.sessionMarkers = getObject(target.sessionMarkers);
    target.memorySummary = typeof target.memorySummary === 'string' ? target.memorySummary : '';
    target.memoryMessageCount = parsePositiveInt(target.memoryMessageCount, 0, 0);
    target.memoryUpdatedAt = parsePositiveInt(target.memoryUpdatedAt, 0, 0);
    target.createdAt = parsePositiveInt(target.createdAt, now, 0);
    target.updatedAt = parsePositiveInt(target.updatedAt, target.createdAt, 0);
    return target;
}

function getConversationThreadStore(store, avatar, groupId = '', { create = true } = {}) {
    const threadKey = getConversationThreadKey(avatar, groupId);
    if (!threadKey) {
        return null;
    }

    store.characters = getObject(store.characters);
    if (!store.characters[threadKey]) {
        if (!create) {
            return null;
        }

        store.characters[threadKey] = {
            settings: { ...DEFAULT_SETTINGS },
            schedule: null,
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
            },
        };
    }

    const threadStore = store.characters[threadKey];
    threadStore.settings = getObject(threadStore.settings);
    threadStore.branches = getObject(threadStore.branches);
    threadStore.activeBranchId = threadStore.activeBranchId || DEFAULT_BRANCH_ID;
    if (!threadStore.branches[threadStore.activeBranchId]) {
        threadStore.branches[threadStore.activeBranchId] = createConversationBranch(
            threadStore.activeBranchId === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation',
            threadStore.activeBranchId,
        );
    }
    threadStore.branches[threadStore.activeBranchId] = normalizeConversationBranch(
        threadStore.branches[threadStore.activeBranchId],
        threadStore.activeBranchId,
    );
    threadStore.threadAvatar = avatar;
    threadStore.groupId = groupId || '';
    return threadStore;
}

function getActiveConversationBranch(store, avatar, groupId = '', { create = true } = {}) {
    const threadStore = getConversationThreadStore(store, avatar, groupId, { create });
    if (!threadStore) {
        return null;
    }

    const branchId = threadStore.activeBranchId || DEFAULT_BRANCH_ID;
    threadStore.branches[branchId] = normalizeConversationBranch(threadStore.branches[branchId], branchId);
    return threadStore.branches[branchId];
}

function stripPreviewText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getConversationMessagePreviewText(message) {
    return stripPreviewText(message?.mes) || stripPreviewText(getConversationAttachmentLabels(message).join(', '));
}

function refreshBranchPreview(branch) {
    const lastMessage = branch.messages[branch.messages.length - 1];
    branch.preview = getConversationMessagePreviewText(lastMessage) || 'Conversation ready';
    branch.updatedAt = Date.now();
}

function createConversationMessage(input = {}, fallback = {}) {
    const source = getObject(input);
    const createdAt = parsePositiveInt(source.created_at, Date.now(), 0);
    return {
        id: source.id || `${createdAt}-${Math.random().toString(36).slice(2)}`,
        role: source.role || fallback.role || 'user',
        name: source.name || fallback.name || 'User',
        mes: String(source.mes ?? source.text ?? fallback.mes ?? ''),
        send_date: source.send_date || new Date(createdAt).toISOString(),
        created_at: createdAt,
        extra: getObject(source.extra),
    };
}

function appendConversationMessage(store, avatar, messageInput, { groupId = '', fallback = {} } = {}) {
    const branch = getActiveConversationBranch(store, avatar, groupId, { create: true });
    if (!branch) {
        return null;
    }

    const message = createConversationMessage(messageInput, fallback);
    if (!hasConversationMessageContent(message)) {
        return null;
    }

    branch.messages.push(message);
    if (branch.messages.length > MAX_THREAD_MESSAGES) {
        branch.messages.splice(0, branch.messages.length - MAX_THREAD_MESSAGES);
    }
    if (message.role === 'user') {
        branch.lastActivity = Date.now();
        branch.followupCount = 0;
    }
    refreshBranchPreview(branch);
    return message;
}

function getRequestAvatar(request) {
    return String(request.body?.avatar || request.body?.threadAvatar || '').trim();
}

function getRequestGroupId(request) {
    return String(request.body?.groupId || request.body?.group || '').trim();
}

function respondSaveResult(response, saveResult, successBody) {
    if (!saveResult.ok) {
        return response.status(saveResult.status).send(saveResult.body);
    }

    return response.send({
        ...successBody,
        version: saveResult.version,
    });
}

function getIncomingMessage(body, fallbackRole = 'user') {
    const message = isObject(body.message) ? body.message : {};
    return {
        ...message,
        role: message.role || body.role || fallbackRole,
        name: message.name || body.name,
        mes: message.mes ?? message.text ?? body.mes ?? body.text ?? '',
        extra: getObject(message.extra || body.extra),
    };
}

function getGroupConversationSettings(request, groupId) {
    if (!groupId || !request.user.directories.groups) {
        return {};
    }

    const groupPath = path.join(request.user.directories.groups, sanitize(`${groupId}.json`));
    const group = readJsonFile(groupPath, null);
    return getObject(group?.conversation_settings);
}

function normalizeConversationSettings(settings = {}) {
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
    return normalized;
}

function getConversationSettings(request, store, avatar, groupId, overrides = {}) {
    const threadStore = getConversationThreadStore(store, avatar, groupId, { create: false });
    return normalizeConversationSettings({
        ...DEFAULT_SETTINGS,
        ...(groupId ? { multi_char: true, auto_character_chat: true } : {}),
        ...getGroupConversationSettings(request, groupId),
        ...getObject(threadStore?.settings),
        ...getObject(store.settings),
        ...getObject(overrides),
    });
}

function normalizeCharacterData(rawCharacter, avatar = '') {
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

async function getCharacterData(request, avatar) {
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

function formatPromptText(value, maxLength = 1400) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function getContentText(content) {
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

function buildConversationPromptMessages(messages, directive, speakerName) {
    const promptMessages = [{
        role: 'user',
        content: 'Conversation transcript:',
        identifier: 'conversation-transcript-header',
    }];
    const convertedMessages = messages.slice(-TRANSCRIPT_MESSAGE_LIMIT)
        .map((message, index) => {
            const parts = [
                formatPromptText(message.mes, 1800),
                getConversationAttachmentSummary(message),
            ].filter(Boolean);
            if (!parts.length) {
                return null;
            }

            return {
                role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
                content: `${message.name || 'Speaker'}: ${parts.join(' ')}`,
                identifier: `conversation-message-${message.id || index}`,
            };
        })
        .filter(Boolean);

    promptMessages.push(...convertedMessages);
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

function compileGeechanPrompt(settings, charName, userName) {
    let compiledPrompt = settings.geechan_chatroom_prompt || GEECHAN_DEFAULT_PROMPT;
    compiledPrompt = compiledPrompt.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
    compiledPrompt = compiledPrompt.replace(/\{\{trim\}\}/g, '');
    if (settings.custom_instructions && settings.custom_instructions.trim()) {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, (match, block) => {
            return block.replace(/\{\{getvar::player-instructions\}\}/gi, settings.custom_instructions);
        });
    } else {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, '');
    }

    return compiledPrompt
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{user\}\}/g, userName)
        .trim();
}

function buildConversationSystemPrompt({ settings, character, userName, groupId, branch }) {
    const charName = character.name || 'Character';
    const fields = [
        groupId
            ? `You are ${charName} in a private group direct-message conversation with ${userName}. You are one equal participant in this group DM and should reply only as ${charName}.`
            : `You are ${charName} in a private direct-message conversation with ${userName}.`,
        'This Conversation Mode transcript is separate from the roleplay/story chat. Do not continue roleplay scenes unless the user explicitly asks about them.',
        'Formatting: write plain chat text. Do not wrap words or phrases in double quotation marks or smart quotes for emphasis. If sending multiple chat bubbles, put each bubble on its own line.',
        compileGeechanPrompt(settings, charName, userName),
    ];

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

function getDefaultDirective(body) {
    return String(body.directive || body.promptDirective || '[System directive: The user sent the latest DM(s). Reply directly to them in the Conversation Mode thread. Output only your message body, without a name prefix.]');
}

function normalizeGenerationBackend(value) {
    const backend = String(value || '').toLowerCase().replace(/[_ ]/g, '-');
    if (['text', 'text-completion', 'text-completions'].includes(backend)) {
        return GENERATION_BACKENDS.TEXT;
    }
    return GENERATION_BACKENDS.CHAT;
}

function getGenerationPayload(generation) {
    const source = getObject(generation?.payload || generation?.body || generation);
    const payload = { ...source };
    delete payload.backend;
    delete payload.body;
    delete payload.payload;
    return payload;
}

function buildTextPrompt(systemPrompt, promptMessages) {
    const transcript = promptMessages
        .map(message => `${message.role.toUpperCase()}: ${getContentText(message.content)}`)
        .join('\n\n');
    return `${systemPrompt}\n\n${transcript}`.trim();
}

function buildGenerationRequestBody(generation, systemPrompt, promptMessages, responseLength) {
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

function createCapturingResponse() {
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

async function runBackendGeneration(request, backend, payload) {
    if (!Object.keys(payload).length) {
        const error = new Error('generation payload is required');
        error.status = 400;
        throw error;
    }

    const generationRequest = Object.create(request);
    generationRequest.body = payload;
    generationRequest.user = request.user;
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

function extractGeneratedText(generationResponse) {
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

router.post('/store/get', (request, response) => {
    const settings = readUserSettings(request);
    const store = ensureConversationStore(settings);
    return response.send({ store, version: getSettingsVersion(settings) });
});

router.post('/store/save', (request, response) => {
    if (!isObject(request.body?.store)) {
        return response.status(400).send({ error: 'invalid_store' });
    }

    const currentSettings = readUserSettings(request);
    const incomingSettings = { ...currentSettings };
    incomingSettings.extension_settings = {
        ...getObject(currentSettings.extension_settings),
        [CONVERSATION_STORE_KEY]: request.body.store,
    };
    const store = ensureConversationStore(incomingSettings);
    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    return respondSaveResult(response, saveResult, { store: saveResult.store || store });
});

router.post('/thread/get', (request, response) => {
    const avatar = getRequestAvatar(request);
    if (!avatar) {
        return response.status(400).send({ error: 'avatar_required' });
    }

    const groupId = getRequestGroupId(request);
    const settings = readUserSettings(request);
    const store = ensureConversationStore(settings);
    const thread = getConversationThreadStore(store, avatar, groupId, { create: Boolean(request.body?.create) });
    const branch = thread ? getActiveConversationBranch(store, avatar, groupId, { create: false }) : null;
    return response.send({
        threadKey: getConversationThreadKey(avatar, groupId),
        thread,
        branch,
        messages: branch?.messages || [],
        version: getSettingsVersion(settings),
    });
});

router.post('/thread/save', (request, response) => {
    const avatar = getRequestAvatar(request);
    if (!avatar) {
        return response.status(400).send({ error: 'avatar_required' });
    }
    if (!Array.isArray(request.body?.messages) && typeof request.body?.messages !== 'string') {
        return response.status(400).send({ error: 'messages_required' });
    }

    const groupId = getRequestGroupId(request);
    const currentSettings = readUserSettings(request);
    const store = ensureConversationStore(currentSettings);
    const branch = getActiveConversationBranch(store, avatar, groupId, { create: true });
    branch.messages = safeParseThread(request.body.messages).slice(-MAX_THREAD_MESSAGES);
    refreshBranchPreview(branch);

    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(avatar, groupId),
        branch,
        messages: branch.messages,
    });
});

router.post('/message/append', (request, response) => {
    const avatar = getRequestAvatar(request);
    if (!avatar) {
        return response.status(400).send({ error: 'avatar_required' });
    }

    const groupId = getRequestGroupId(request);
    const currentSettings = readUserSettings(request);
    const store = ensureConversationStore(currentSettings);
    const message = appendConversationMessage(store, avatar, getIncomingMessage(request.body), {
        groupId,
        fallback: { role: request.body?.role || 'user', name: request.body?.name || request.body?.userName || 'User' },
    });
    if (!message) {
        return response.status(400).send({ error: 'message_required' });
    }

    const branch = getActiveConversationBranch(store, avatar, groupId, { create: false });
    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(avatar, groupId),
        message,
        branch,
        messages: branch?.messages || [],
    });
});

router.post('/message/send', async (request, response) => {
    const avatar = getRequestAvatar(request);
    if (!avatar) {
        return response.status(400).send({ error: 'avatar_required' });
    }
    if (!isObject(request.body?.generation)) {
        return response.status(400).send({ error: 'generation_required' });
    }

    const groupId = getRequestGroupId(request);
    const userName = String(request.body?.userName || request.body?.user_name || request.body?.name || 'User');
    let currentSettings = readUserSettings(request);
    let store = ensureConversationStore(currentSettings);
    const userMessage = appendConversationMessage(store, avatar, getIncomingMessage(request.body, 'user'), {
        groupId,
        fallback: { role: 'user', name: userName },
    });
    if (!userMessage) {
        return response.status(400).send({ error: 'message_required' });
    }

    let saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    if (!saveResult.ok) {
        return response.status(saveResult.status).send(saveResult.body);
    }

    currentSettings = saveResult.settings;
    store = saveResult.store;

    const settings = getConversationSettings(request, store, avatar, groupId, request.body.settings);
    const character = await getCharacterData(request, avatar);
    const branch = getActiveConversationBranch(store, avatar, groupId, { create: false });
    const directive = getDefaultDirective(request.body);
    const promptMessages = buildConversationPromptMessages(branch?.messages || [], directive, character.name || 'Character');
    const systemPrompt = buildConversationSystemPrompt({ settings, character, userName, groupId, branch });
    const { backend, payload } = buildGenerationRequestBody(
        request.body.generation,
        systemPrompt,
        promptMessages,
        settings.reply_max_tokens,
    );

    let generationResponse;
    try {
        generationResponse = await runBackendGeneration(request, backend, payload);
    } catch (error) {
        return response.status(error.status || 502).send({
            error: 'generation_failed',
            detail: error.body || error.message,
            userMessage,
            version: saveResult.version,
        });
    }

    const rawReplyText = extractGeneratedText(generationResponse);
    const commandParts = extractCharacterReplyCommandParts(rawReplyText, settings);
    const replyText = normalizeConversationOutputText(commandParts.text);
    if (!replyText) {
        return response.status(502).send({
            error: 'empty_generation',
            generation: generationResponse,
            userMessage,
            version: saveResult.version,
        });
    }

    const replyMessage = appendConversationMessage(store, avatar, {
        role: 'character',
        name: character.name || 'Character',
        mes: replyText,
        extra: {
            conversation_commands: {
                selfieRequests: commandParts.selfieRequests,
                scheduleUpdates: commandParts.scheduleUpdates,
                reminders: commandParts.reminders,
            },
        },
    }, {
        groupId,
        fallback: { role: 'character', name: character.name || 'Character' },
    });
    const finalBranch = getActiveConversationBranch(store, avatar, groupId, { create: false });
    saveResult = saveConversationStore(request, currentSettings, store);
    if (!saveResult.ok) {
        return response.status(saveResult.status).send(saveResult.body);
    }

    return response.send({
        threadKey: getConversationThreadKey(avatar, groupId),
        userMessage,
        replyMessage,
        branch: finalBranch,
        messages: finalBranch?.messages || [],
        generation: request.body.includeGeneration ? generationResponse : undefined,
        prompt: request.body.includePrompt ? { systemPrompt, messages: promptMessages } : undefined,
        version: saveResult.version,
    });
});
