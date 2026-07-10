import express from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { getSettingsVersion } from '../settings-version.js';
import { extractCharacterReplyCommandParts, normalizeConversationOutputText } from '../../public/scripts/sillybunny-conversation/generation-utils.js';
import { CONVERSATION_STORE_KEY, MAX_THREAD_MESSAGES } from '../../public/scripts/sillybunny-conversation/constants.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { abortOnRequestClose, getConfigValue } from '../util.js';

// Import from modular files
import {
    isObject,
    getRequestPersonaId,
    getRequestAvatar,
    getRequestGroupId,
    validateAvatar,
    validateConversationPayload,
    validateConversationScope,
    validateConversationStoragePart,
    validateGenerationPayload,
    validateCharacterOverride,
    validateStoreStructure,
} from './conversation-utils.js';
import {
    readUserSettingsWithStatus,
    ensureConversationStore,
    readConversationStoreForWrite,
    saveConversationStore,
    getConversationThreadKey,
    respondSaveResult,
} from './conversation-store.js';
import {
    normalizeConversationGroupRecord,
    getConversationGroups,
    createConversationGroupRecord,
    authorizeConversationGroup,
} from './conversation-groups.js';
import {
    getConversationThreadStore,
    getActiveConversationBranch,
} from './conversation-threads.js';
import {
    appendConversationMessage,
    getIncomingMessage,
    refreshBranchPreview,
    buildConversationMessageReplyReference,
    validateConversationMessageInput,
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

const normalizeGroupRecord = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);

function sendRouteError(response, error) {
    if (response.headersSent || response.destroyed) {
        return;
    }
    console.error('Conversation REST API route failed', error);
    response.status(error?.status || 500).send({ error: error?.apiError || 'conversation_request_failed' });
}

function asyncRoute(handler) {
    return (request, response) => {
        Promise.resolve(handler(request, response)).catch(error => sendRouteError(response, error));
    };
}

function readConversationStore(request, response) {
    const settingsResult = readUserSettingsWithStatus(request);
    if (!settingsResult.ok) {
        response.status(500).send({ error: 'settings_read_failed' });
        return null;
    }
    return {
        settings: settingsResult.data,
        store: ensureConversationStore(settingsResult.data, normalizeGroupRecord),
        missing: Boolean(settingsResult.missing),
    };
}

function readConversationStoreMutation(request, response) {
    const result = readConversationStoreForWrite(request, request.body?.version, normalizeGroupRecord);
    if (!result.ok) {
        response.status(result.status).send(result.body);
        return null;
    }
    return result;
}

function getConversationTarget(request, response) {
    const avatarValidation = validateAvatar(getRequestAvatar(request));
    if (!avatarValidation.valid) {
        response.status(400).send({ error: avatarValidation.error });
        return null;
    }
    const scopeValidation = validateConversationScope(getRequestGroupId(request), getRequestPersonaId(request));
    if (!scopeValidation.valid) {
        response.status(400).send({ error: scopeValidation.error });
        return null;
    }
    return {
        avatar: avatarValidation.avatar,
        groupId: scopeValidation.groupId,
        personaId: scopeValidation.personaId,
    };
}

function authorizeGroupTarget(request, response, store, target) {
    const authorization = authorizeConversationGroup(
        request,
        store,
        target.avatar,
        target.groupId,
        target.personaId,
        normalizeConversationSettings,
    );
    if (authorization.error) {
        response.status(authorization.status || 500).send({ error: authorization.error });
        return false;
    }
    if (!authorization.authorized) {
        response.status(400).send({ error: 'avatar_not_in_group' });
        return false;
    }
    return true;
}

function parseConversationThreadInput(input) {
    let parsed;
    try {
        parsed = typeof input === 'string' ? JSON.parse(input) : input;
    } catch {
        return { valid: false, error: 'invalid_messages' };
    }
    if (!Array.isArray(parsed)) {
        return { valid: false, error: 'invalid_messages' };
    }
    const payloadValidation = validateConversationPayload(parsed);
    if (!payloadValidation.valid) {
        return payloadValidation;
    }
    const messages = [];
    for (const message of parsed) {
        const validation = validateConversationMessageInput(message);
        if (!validation.valid) {
            return validation;
        }
        messages.push(validation.message);
    }
    return { valid: true, messages: messages.slice(-MAX_THREAD_MESSAGES) };
}

// Routes
router.use((request, response, next) => {
    const validation = validateConversationPayload(request.body);
    return validation.valid ? next() : response.status(400).send({ error: validation.error });
});

router.post('/info', (_request, response) => response.send(CONVERSATION_API_INFO));

router.post('/store/get', (request, response) => {
    const context = readConversationStore(request, response);
    if (!context) {
        return;
    }
    return response.send({ store: context.store, version: getSettingsVersion(context.settings), settingsMissing: context.missing });
});

router.post('/store/save', (request, response) => {
    const validation = validateStoreStructure(request.body?.store);
    if (!validation.valid) {
        return response.status(400).send({ error: validation.error, details: validation.keys });
    }

    const context = readConversationStoreMutation(request, response);
    if (!context) {
        return;
    }

    const incomingSettings = {
        extension_settings: {
            [CONVERSATION_STORE_KEY]: request.body.store,
        },
    };
    const store = ensureConversationStore(incomingSettings, normalizeGroupRecord);
    const saveResult = saveConversationStore(request, store, request.body.version);
    return respondSaveResult(response, saveResult, { store: saveResult.store || store });
});

router.post('/group/list', (request, response) => {
    const scopeValidation = validateConversationScope('', getRequestPersonaId(request));
    if (!scopeValidation.valid) {
        return response.status(400).send({ error: scopeValidation.error });
    }
    const context = readConversationStore(request, response);
    if (!context) {
        return;
    }
    return response.send({
        groups: getConversationGroups(context.store, scopeValidation.personaId, normalizeConversationSettings),
        version: getSettingsVersion(context.settings),
        settingsMissing: context.missing,
    });
});

router.post('/group/create', (request, response) => {
    const scopeValidation = validateConversationScope('', getRequestPersonaId(request));
    if (!scopeValidation.valid) {
        return response.status(400).send({ error: scopeValidation.error });
    }
    const personaId = scopeValidation.personaId;
    if (!validateConversationStoragePart(personaId, { allowColon: false }).valid) {
        return response.status(400).send({ error: 'invalid_persona_id' });
    }
    const members = request.body?.members || request.body?.memberAvatars;
    if (!Array.isArray(members) || members.some(member => !validateAvatar(member).valid)) {
        return response.status(400).send({ error: 'invalid_members' });
    }
    const normalizedMembers = members.map(member => validateAvatar(member).avatar);
    if (new Set(normalizedMembers).size !== normalizedMembers.length) {
        return response.status(400).send({ error: 'duplicate_members' });
    }
    const groupName = request.body?.name;
    const groupAvatarUrl = request.body?.avatar_url ?? request.body?.avatarUrl;
    const groupSettings = request.body?.conversation_settings ?? request.body?.settings;
    if (groupName !== undefined && (typeof groupName !== 'string' || groupName.length > 512)) {
        return response.status(400).send({ error: 'invalid_group_name' });
    }
    if (groupAvatarUrl !== undefined && (typeof groupAvatarUrl !== 'string' || groupAvatarUrl.length > 8192)) {
        return response.status(400).send({ error: 'invalid_group_avatar' });
    }
    if (groupSettings !== undefined && !isObject(groupSettings)) {
        return response.status(400).send({ error: 'invalid_group_settings' });
    }
    const group = createConversationGroupRecord(normalizedMembers, {
        name: groupName,
        avatarUrl: groupAvatarUrl,
        settings: groupSettings,
        personaId,
    }, normalizeConversationSettings);
    if (!group) {
        return response.status(400).send({ error: 'members_required' });
    }

    const context = readConversationStoreMutation(request, response);
    if (!context) {
        return;
    }
    context.store.groups.push(group);

    const saveResult = saveConversationStore(request, context.store, request.body?.version);
    return respondSaveResult(response, saveResult, { group, groups: getConversationGroups(context.store, personaId, normalizeConversationSettings) });
});

router.post('/thread/get', (request, response) => {
    const target = getConversationTarget(request, response);
    if (!target) {
        return;
    }

    const context = readConversationStore(request, response);
    if (!context || !authorizeGroupTarget(request, response, context.store, target)) {
        return;
    }
    const thread = getConversationThreadStore(context.store, target.avatar, target.groupId, {
        create: Boolean(request.body?.create),
        personaId: target.personaId,
    });
    const branch = thread ? getActiveConversationBranch(context.store, target.avatar, target.groupId, { create: false, personaId: target.personaId }) : null;
    return response.send({
        threadKey: getConversationThreadKey(target.avatar, target.groupId, target.personaId),
        thread,
        branch,
        messages: branch?.messages || [],
        version: getSettingsVersion(context.settings),
        settingsMissing: context.missing,
    });
});

router.post('/thread/save', (request, response) => {
    const target = getConversationTarget(request, response);
    if (!target) {
        return;
    }
    if (!Array.isArray(request.body?.messages) && typeof request.body?.messages !== 'string') {
        return response.status(400).send({ error: 'messages_required' });
    }
    const parsedMessages = parseConversationThreadInput(request.body.messages);
    if (!parsedMessages.valid) {
        return response.status(400).send({ error: parsedMessages.error });
    }

    const context = readConversationStoreMutation(request, response);
    if (!context || !authorizeGroupTarget(request, response, context.store, target)) {
        return;
    }
    const branch = getActiveConversationBranch(context.store, target.avatar, target.groupId, { create: true, personaId: target.personaId });
    branch.messages = parsedMessages.messages;
    refreshBranchPreview(branch);

    const saveResult = saveConversationStore(request, context.store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(target.avatar, target.groupId, target.personaId),
        branch,
        messages: branch.messages,
    });
});

router.post('/message/append', (request, response) => {
    const target = getConversationTarget(request, response);
    if (!target) {
        return;
    }
    const incomingMessage = getIncomingMessage(request.body);
    const messageValidation = validateConversationMessageInput(incomingMessage);
    if (!messageValidation.valid) {
        return response.status(400).send({ error: messageValidation.error });
    }
    const fallbackName = request.body?.name ?? request.body?.userName ?? 'User';
    if (typeof fallbackName !== 'string' || !fallbackName.trim() || fallbackName.length > 512) {
        return response.status(400).send({ error: 'invalid_message_name' });
    }

    const context = readConversationStoreMutation(request, response);
    if (!context || !authorizeGroupTarget(request, response, context.store, target)) {
        return;
    }
    const message = appendConversationMessage(context.store, target.avatar, incomingMessage, {
        groupId: target.groupId,
        personaId: target.personaId,
        fallback: { role: request.body?.role || 'user', name: fallbackName.trim() },
    });
    if (!message) {
        return response.status(400).send({ error: 'message_required' });
    }

    const branch = getActiveConversationBranch(context.store, target.avatar, target.groupId, { create: false, personaId: target.personaId });
    const saveResult = saveConversationStore(request, context.store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(target.avatar, target.groupId, target.personaId),
        message,
        branch,
        messages: branch?.messages || [],
    });
});

router.post('/message/send', asyncRoute(async (request, response) => {
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

    const target = getConversationTarget(request, response);
    if (!target) {
        return;
    }

    const generationValidation = validateGenerationPayload(request.body?.generation);
    if (!generationValidation.valid) {
        return response.status(400).send({ error: generationValidation.error });
    }

    const characterValidation = validateCharacterOverride(request.body?.character);
    if (!characterValidation.valid) {
        return response.status(400).send({ error: characterValidation.error });
    }

    const incomingMessage = getIncomingMessage(request.body, 'user');
    const messageValidation = validateConversationMessageInput(incomingMessage, { requiredRole: 'user' });
    if (!messageValidation.valid) {
        return response.status(400).send({ error: messageValidation.error });
    }

    const requestedUserName = request.body?.userName ?? request.body?.user_name ?? request.body?.name ?? 'User';
    if (typeof requestedUserName !== 'string' || !requestedUserName.trim() || requestedUserName.length > 512) {
        return response.status(400).send({ error: 'invalid_user_name' });
    }
    const userName = requestedUserName.trim();
    if (request.body?.directive !== undefined && (typeof request.body.directive !== 'string' || request.body.directive.length > 256 * 1024)) {
        return response.status(400).send({ error: 'invalid_directive' });
    }
    if (request.body?.settings !== undefined && !isObject(request.body.settings)) {
        return response.status(400).send({ error: 'invalid_settings' });
    }

    const context = readConversationStoreMutation(request, response);
    if (!context || !authorizeGroupTarget(request, response, context.store, target)) {
        return;
    }

    const cancellationController = new AbortController();
    const cancellation = abortOnRequestClose(request, cancellationController, response);
    if (request.aborted || request.readableAborted || response.destroyed) {
        cancellation.abort('pre-generation');
    }
    const userMessage = appendConversationMessage(context.store, target.avatar, { ...incomingMessage, role: 'user' }, {
        groupId: target.groupId,
        personaId: target.personaId,
        fallback: { role: 'user', name: userName },
    });
    if (!userMessage) {
        cancellation.cleanup();
        return response.status(400).send({ error: 'message_required' });
    }

    try {
        const settings = getConversationSettings(request, context.store, target.avatar, target.groupId, request.body.settings, { personaId: target.personaId });
        const character = await getCharacterData(request, target.avatar);
        const branch = getActiveConversationBranch(context.store, target.avatar, target.groupId, { create: true, personaId: target.personaId });
        const directive = getDefaultDirective(request.body);
        const promptMessages = await buildConversationPromptMessages(branch.messages, directive, character.name || 'Character', {
            groupId: target.groupId,
            userName,
            signal: cancellationController.signal,
        });
        const systemPrompt = buildConversationSystemPrompt({ settings, character, userName, groupId: target.groupId, branch });
        const { backend, payload } = buildGenerationRequestBody(
            request.body.generation,
            systemPrompt,
            promptMessages,
            settings.reply_max_tokens,
        );

        let generationResponse;
        try {
            generationResponse = await runBackendGeneration(request, backend, payload, { signal: cancellationController.signal });
        } catch (error) {
            if (cancellationController.signal.aborted && response.destroyed) {
                return;
            }
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
            return response.status(502).send({
                error: 'empty_generation',
                detail: 'Model returned empty response',
            });
        }
        if (cancellationController.signal.aborted) {
            return;
        }

        const userReplyReference = buildConversationMessageReplyReference(userMessage);
        const replyMessage = appendConversationMessage(context.store, target.avatar, {
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
            groupId: target.groupId,
            personaId: target.personaId,
            fallback: { role: 'character', name: character.name || 'Character' },
        });
        if (!replyMessage) {
            const error = new Error('Failed to append generated reply');
            error.apiError = 'invalid_generation_message';
            throw error;
        }

        const saveResult = saveConversationStore(request, context.store, request.body.version);
        if (!saveResult.ok) {
            return response.status(saveResult.status).send(saveResult.body);
        }
        const savedBranch = getActiveConversationBranch(saveResult.store, target.avatar, target.groupId, { create: false, personaId: target.personaId });
        return response.send({
            threadKey: getConversationThreadKey(target.avatar, target.groupId, target.personaId),
            userMessage,
            replyMessage,
            branch: savedBranch,
            messages: savedBranch?.messages || [],
            generation: request.body.includeGeneration ? generationResponse : undefined,
            prompt: request.body.includePrompt ? { systemPrompt, messages: promptMessages } : undefined,
            version: saveResult.version,
        });
    } finally {
        cancellation.cleanup();
    }
}));
