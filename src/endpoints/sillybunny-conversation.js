import express from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { getSettingsVersion } from '../settings-version.js';
import { extractCharacterReplyCommandParts, normalizeConversationOutputText } from '../../public/scripts/sillybunny-conversation/generation-utils.js';
import { safeParseThread } from '../../public/scripts/sillybunny-conversation/thread-store-utils.js';
import { CONVERSATION_STORE_KEY, MAX_THREAD_MESSAGES } from '../../public/scripts/sillybunny-conversation/constants.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { getConfigValue } from '../util.js';

// Import from modular files
import {
    getObject,
    getRequestPersonaId,
    getRequestAvatar,
    getRequestGroupId,
    validateAvatar,
    validateGenerationPayload,
    validateCharacterOverride,
    validateStoreStructure,
    isAvatarInGroup,
} from './conversation-utils.js';
import {
    readUserSettings,
    readUserSettingsWithStatus,
    ensureConversationStore,
    saveConversationStore,
    getConversationThreadKey,
    respondSaveResult,
} from './conversation-store.js';
import {
    normalizeConversationGroupRecord,
    getConversationGroups,
    createConversationGroupRecord,
} from './conversation-groups.js';
import {
    getConversationThreadStore,
    getActiveConversationBranch,
} from './conversation-threads.js';
import {
    createConversationMessage,
    appendConversationMessage,
    getIncomingMessage,
    refreshBranchPreview,
    buildConversationMessageReplyReference,
} from './conversation-messages.js';
import {
    getCharacterData,
    getConversationSettings,
    normalizeConversationSettings,
    getDefaultDirective,
    buildConversationPromptMessages,
    buildConversationSystemPrompt,
    buildGenerationRequestBody,
    runBackendGeneration,
    extractGeneratedText,
} from './conversation-generation.js';

const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const MESSAGE_SEND_RATE_LIMIT = getConfigValue('rateLimiting.conversationMessageSendPoints', 20, 'number');
const MESSAGE_SEND_RATE_DURATION = getConfigValue('rateLimiting.conversationMessageSendDuration', 60, 'number');

const messageSendLimiter = new RateLimiterMemory({
    points: MESSAGE_SEND_RATE_LIMIT > 0 ? MESSAGE_SEND_RATE_LIMIT : Number.MAX_SAFE_INTEGER,
    duration: MESSAGE_SEND_RATE_DURATION,
});

export const router = express.Router();

const CONVERSATION_API_BASE_PATH = '/api/sillybunny-conversation';
const CONVERSATION_API_ALIAS_BASE_PATHS = ['/api/sillybunny/conversation'];
const CONVERSATION_API_INFO = {
    feature: 'Conversation Mode',
    primaryPath: {
        type: 'browser-client',
        summary: 'The running app drives live Conversation Mode from browser-side JavaScript, not this REST router.',
        flow: [
            {
                step: 'submit',
                file: 'public/scripts/sillybunny-conversation/attachments.js',
                function: 'submitConversationInput',
            },
            {
                step: 'store-thread-message',
                file: 'public/scripts/sillybunny-conversation/thread-store.js',
                function: 'appendConversationThreadMessage',
            },
            {
                step: 'queue-reply',
                file: 'public/scripts/sillybunny-conversation/send-queue.js',
                function: 'processSendQueue',
            },
            {
                step: 'generate-reply',
                file: 'public/scripts/sillybunny-conversation/generation.js',
                function: 'generateConversationRaw',
            },
        ],
        usesRestApiAsPrimaryDriver: false,
    },
    restPath: {
        type: 'json-rest',
        summary: 'The REST API can be driven by JSON clients, but it is not the primary in-app Conversation Mode driver.',
        curlDriven: true,
        basePath: CONVERSATION_API_BASE_PATH,
        aliasBasePaths: CONVERSATION_API_ALIAS_BASE_PATHS,
        endpoints: [
            { method: 'POST', path: '/info', purpose: 'Describe Conversation Mode REST capabilities and caveats.' },
            { method: 'POST', path: '/store/get', purpose: 'Read the Conversation Mode store.' },
            { method: 'POST', path: '/store/save', purpose: 'Replace the Conversation Mode store.' },
            { method: 'POST', path: '/group/list', purpose: 'List Conversation-owned group DMs for a persona.' },
            { method: 'POST', path: '/group/create', purpose: 'Create a Conversation-owned group DM.' },
            { method: 'POST', path: '/thread/get', purpose: 'Read a solo or group DM thread.' },
            { method: 'POST', path: '/thread/save', purpose: 'Replace a solo or group DM thread.' },
            { method: 'POST', path: '/message/append', purpose: 'Append one message without generating a reply.' },
            { method: 'POST', path: '/message/send', purpose: 'Append a user message, generate a reply, and persist both.' },
        ],
    },
    caveats: [
        'Browser-only automation is not run by the REST API: idle followups, scheduled messages, proactive messages, partner chimes, group aside DMs, and reminder timers.',
        'Bracket commands are extracted into reply metadata by /message/send, but REST does not run image generation, schedule edits, or reminder side effects.',
        'REST callers must provide the backend generation payload shape used by the existing completion endpoints.',
    ],
};

// Routes
router.post('/info', (_request, response) => response.send(CONVERSATION_API_INFO));

router.post('/store/get', (request, response) => {
    const settings = readUserSettings(request);
    const store = ensureConversationStore(settings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));
    return response.send({ store, version: getSettingsVersion(settings) });
});

router.post('/store/save', (request, response) => {
    const validation = validateStoreStructure(request.body?.store);
    if (!validation.valid) {
        return response.status(400).send({ error: validation.error, details: validation.keys });
    }

    const settingsResult = readUserSettingsWithStatus(request);
    if (!settingsResult.ok) {
        return response.status(500).send({ error: 'settings_read_failed', detail: settingsResult.error });
    }

    const currentSettings = settingsResult.data;
    const incomingSettings = { ...currentSettings };
    incomingSettings.extension_settings = {
        ...getObject(currentSettings.extension_settings),
        [CONVERSATION_STORE_KEY]: request.body.store,
    };
    const store = ensureConversationStore(incomingSettings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));
    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    return respondSaveResult(response, saveResult, { store: saveResult.store || store });
});

router.post('/group/list', (request, response) => {
    const settings = readUserSettings(request);
    const store = ensureConversationStore(settings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));
    return response.send({ groups: getConversationGroups(store, getRequestPersonaId(request), normalizeConversationSettings), version: getSettingsVersion(settings) });
});

router.post('/group/create', (request, response) => {
    const personaId = getRequestPersonaId(request);
    const members = request.body?.members || request.body?.memberAvatars;
    const group = createConversationGroupRecord(members, {
        name: request.body?.name,
        avatarUrl: request.body?.avatar_url || request.body?.avatarUrl,
        settings: request.body?.conversation_settings || request.body?.settings,
        personaId,
    }, normalizeConversationSettings);
    if (!group) {
        return response.status(400).send({ error: 'members_required' });
    }

    const currentSettings = readUserSettings(request);
    const store = ensureConversationStore(currentSettings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));
    store.groups.push(group);

    const saveResult = saveConversationStore(request, currentSettings, store, request.body?.version);
    return respondSaveResult(response, saveResult, { group, groups: getConversationGroups(store, personaId, normalizeConversationSettings) });
});

router.post('/thread/get', (request, response) => {
    const avatar = getRequestAvatar(request);
    if (!avatar) {
        return response.status(400).send({ error: 'avatar_required' });
    }

    const groupId = getRequestGroupId(request);
    const personaId = getRequestPersonaId(request);
    const settings = readUserSettings(request);
    const store = ensureConversationStore(settings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));
    const thread = getConversationThreadStore(store, avatar, groupId, { create: Boolean(request.body?.create), personaId });
    const branch = thread ? getActiveConversationBranch(store, avatar, groupId, { create: false, personaId }) : null;
    return response.send({
        threadKey: getConversationThreadKey(avatar, groupId, personaId),
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
    const personaId = getRequestPersonaId(request);
    const currentSettings = readUserSettings(request);
    const store = ensureConversationStore(currentSettings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));
    const branch = getActiveConversationBranch(store, avatar, groupId, { create: true, personaId });
    branch.messages = safeParseThread(request.body.messages).slice(-MAX_THREAD_MESSAGES);
    refreshBranchPreview(branch);

    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(avatar, groupId, personaId),
        branch,
        messages: branch.messages,
    });
});

router.post('/message/append', (request, response) => {
    const avatarValidation = validateAvatar(getRequestAvatar(request));
    if (!avatarValidation.valid) {
        return response.status(400).send({ error: avatarValidation.error });
    }
    const avatar = avatarValidation.avatar;

    const groupId = getRequestGroupId(request);
    const personaId = getRequestPersonaId(request);
    const currentSettings = readUserSettings(request);
    const store = ensureConversationStore(currentSettings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));

    // Verify group membership if appending to a group thread
    if (groupId && !isAvatarInGroup(avatar, groupId, store)) {
        return response.status(400).send({ error: 'avatar_not_in_group' });
    }

    const message = appendConversationMessage(store, avatar, getIncomingMessage(request.body), {
        groupId,
        personaId,
        fallback: { role: request.body?.role || 'user', name: request.body?.name || request.body?.userName || 'User' },
    });
    if (!message) {
        return response.status(400).send({ error: 'message_required' });
    }

    const branch = getActiveConversationBranch(store, avatar, groupId, { create: false, personaId });
    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(avatar, groupId, personaId),
        message,
        branch,
        messages: branch?.messages || [],
    });
});

router.post('/message/send', async (request, response) => {
    // Rate limiting
    try {
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await messageSendLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints >= messageSendLimiter.points) {
            retryAfter(response, rateLimit);
            return response.status(429).send({
                error: 'rate_limit_exceeded',
                message: 'Too many message send requests. Please wait before trying again.',
            });
        }

        await messageSendLimiter.consume(ip);
    } catch (rateLimitError) {
        retryAfter(response, rateLimitError);
        return response.status(429).send({
            error: 'rate_limit_exceeded',
            message: 'Too many message send requests. Please wait before trying again.',
        });
    }

    // Validate required fields
    const avatarValidation = validateAvatar(getRequestAvatar(request));
    if (!avatarValidation.valid) {
        return response.status(400).send({ error: avatarValidation.error });
    }
    const avatar = avatarValidation.avatar;

    const generationValidation = validateGenerationPayload(request.body?.generation);
    if (!generationValidation.valid) {
        return response.status(400).send({ error: generationValidation.error });
    }

    const characterValidation = validateCharacterOverride(request.body?.character);
    if (!characterValidation.valid) {
        return response.status(400).send({ error: characterValidation.error });
    }

    const groupId = getRequestGroupId(request);
    const personaId = getRequestPersonaId(request);
    const userName = String(request.body?.userName || request.body?.user_name || request.body?.name || 'User');

    // Read settings and check for corruption
    const settingsResult = readUserSettingsWithStatus(request);
    if (!settingsResult.ok) {
        return response.status(500).send({ error: 'settings_read_failed', detail: settingsResult.error });
    }

    let currentSettings = settingsResult.data;
    let store = ensureConversationStore(currentSettings, (g) => normalizeConversationGroupRecord(g, normalizeConversationSettings));

    // Verify group membership if sending to a group thread
    if (groupId && !isAvatarInGroup(avatar, groupId, store)) {
        return response.status(400).send({ error: 'avatar_not_in_group' });
    }

    // Create user message in memory (don't persist yet)
    const userMessage = createConversationMessage(getIncomingMessage(request.body, 'user'), {
        role: 'user',
        name: userName,
    });
    if (!userMessage) {
        return response.status(400).send({ error: 'message_required' });
    }

    // Generate the reply
    const settings = getConversationSettings(request, store, avatar, groupId, request.body.settings, { personaId });
    const character = await getCharacterData(request, avatar);
    const branch = getActiveConversationBranch(store, avatar, groupId, { create: true, personaId });

    // Temporarily add user message to build prompt
    branch.messages.push(userMessage);

    const directive = getDefaultDirective(request.body);
    const promptMessages = await buildConversationPromptMessages(branch.messages, directive, character.name || 'Character', { groupId, userName });
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
        // Remove temporary user message since generation failed
        branch.messages.pop();

        // Sanitize error to avoid leaking API keys or upstream details
        const sanitizedDetail = typeof error.body === 'object' && error.body
            ? { error: error.body.error || 'unknown', message: error.body.message }
            : String(error.message || 'generation failed').slice(0, 500);

        return response.status(error.status || 502).send({
            error: 'generation_failed',
            detail: sanitizedDetail,
        });
    }

    const rawReplyText = extractGeneratedText(generationResponse);
    const commandParts = extractCharacterReplyCommandParts(rawReplyText, settings);
    const replyText = normalizeConversationOutputText(commandParts.text);
    if (!replyText) {
        // Remove temporary user message
        branch.messages.pop();

        return response.status(502).send({
            error: 'empty_generation',
            detail: 'Model returned empty response',
        });
    }

    // Create reply message
    const userReplyReference = buildConversationMessageReplyReference(userMessage);
    const replyMessage = createConversationMessage({
        role: 'character',
        name: character.name || 'Character',
        mes: replyText,
        extra: {
            ...(userReplyReference ? { conversation_reply_to: userReplyReference } : {}),
            conversation_commands: {
                selfieRequests: commandParts.selfieRequests,
                scheduleUpdates: commandParts.scheduleUpdates,
                reminders: commandParts.reminders,
            },
        },
    }, {
        role: 'character',
        name: character.name || 'Character',
    });

    // Add reply message to branch
    branch.messages.push(replyMessage);
    refreshBranchPreview(branch);

    // Now atomically save both messages
    const saveResult = saveConversationStore(request, currentSettings, store, request.body.version);
    if (!saveResult.ok) {
        return response.status(saveResult.status).send(saveResult.body);
    }

    return response.send({
        threadKey: getConversationThreadKey(avatar, groupId, personaId),
        userMessage,
        replyMessage,
        branch: getActiveConversationBranch(saveResult.store, avatar, groupId, { create: false, personaId }),
        messages: branch.messages,
        generation: request.body.includeGeneration ? generationResponse : undefined,
        prompt: request.body.includePrompt ? { systemPrompt, messages: promptMessages } : undefined,
        version: saveResult.version,
    });
});

// Register alias base paths
for (const aliasPath of CONVERSATION_API_ALIAS_BASE_PATHS) {
    router.use(aliasPath, router);
}
