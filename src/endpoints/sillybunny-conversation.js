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
    validateGenerationPayload,
    validateCharacterOverride,
    validateStoreStructure,
    MAX_CONVERSATION_MESSAGE_TEXT_LENGTH,
    MAX_CONVERSATION_STORE_BYTES,
    MAX_CONVERSATION_STORE_ENTRIES,
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
    canonicalizeConversationGroupThread,
    getConversationThreadStore,
    getActiveConversationBranch,
} from './conversation-threads.js';
import {
    appendConversationMessage,
    getIncomingMessage,
    refreshBranchPreview,
    buildConversationMessageReplyReference,
    hasConversationMessageId,
    validateConversationMessageInput,
} from './conversation-messages.js';
import {
    getCharacterData,
    getConversationGroupParticipantNames,
    getConversationSettings,
    normalizeConversationSettings,
    getDefaultDirective,
    buildConversationPromptMessages,
    buildConversationSystemPrompt,
    buildGenerationRequestBody,
    runBackendGeneration,
    extractGeneratedText,
    getSafeConversationGenerationStatus,
} from './conversation-generation.js';

const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const MESSAGE_SEND_RATE_LIMIT = getConfigValue('rateLimiting.conversationMessageSendPoints', 20, 'number');
const MESSAGE_SEND_RATE_DURATION = getConfigValue('rateLimiting.conversationMessageSendDuration', 60, 'number');

const messageSendPoints = MESSAGE_SEND_RATE_LIMIT > 0 ? MESSAGE_SEND_RATE_LIMIT : Number.MAX_SAFE_INTEGER;
const messageSendUserLimiter = new RateLimiterMemory({
    points: messageSendPoints,
    duration: MESSAGE_SEND_RATE_DURATION,
});
const messageSendIpLimiter = new RateLimiterMemory({
    points: messageSendPoints === Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER
        : Math.min(Number.MAX_SAFE_INTEGER, messageSendPoints * 5),
    duration: MESSAGE_SEND_RATE_DURATION,
});

const MAX_GENERATED_COMMANDS = 32;
const MAX_GENERATED_COMMAND_LENGTH = 4096;
const STORE_SAVE_PAYLOAD_VALIDATED = Symbol('conversationStoreSavePayloadValidated');

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
                file: 'public/scripts/sillybunny-conversation/attachments.js',
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

async function consumeMessageSendLimit(response, limiter, key) {
    try {
        await limiter.consume(key);
        return true;
    } catch (rateLimitError) {
        retryAfter(response, rateLimitError);
        response.status(429).send({
            error: 'rate_limit_exceeded',
            message: 'Too many message send requests. Please wait before trying again.',
        });
        return false;
    }
}

function getBoundedConversationCommands(commandParts) {
    const boundStrings = values => (Array.isArray(values) ? values : [])
        .slice(0, MAX_GENERATED_COMMANDS)
        .map(value => String(value || '').slice(0, MAX_GENERATED_COMMAND_LENGTH));
    return {
        selfieRequests: boundStrings(commandParts.selfieRequests),
        scheduleUpdates: boundStrings(commandParts.scheduleUpdates),
        reminders: (Array.isArray(commandParts.reminders) ? commandParts.reminders : [])
            .slice(0, MAX_GENERATED_COMMANDS)
            .map(reminder => ({
                delay: String(reminder?.delay || '').slice(0, MAX_GENERATED_COMMAND_LENGTH),
                memo: String(reminder?.memo || '').slice(0, MAX_GENERATED_COMMAND_LENGTH),
            })),
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
        return null;
    }
    if (!authorization.authorized) {
        response.status(400).send({ error: 'avatar_not_in_group' });
        return null;
    }
    return authorization;
}

function getConversationStorageTarget(store, target, authorization) {
    if (!target.groupId || !authorization?.group) {
        return target;
    }
    const canonical = canonicalizeConversationGroupThread(
        store,
        authorization.group,
        target.groupId,
        target.personaId,
    );
    return canonical?.avatar ? { ...target, avatar: canonical.avatar } : target;
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
    const messageIds = new Set();
    for (const message of parsed) {
        const validation = validateConversationMessageInput(message);
        if (!validation.valid) {
            return validation;
        }
        if (messageIds.has(validation.message.id)) {
            return { valid: false, error: 'duplicate_message_id' };
        }
        messageIds.add(validation.message.id);
        messages.push(validation.message);
    }
    return { valid: true, messages: messages.slice(-MAX_THREAD_MESSAGES) };
}

// Routes
router.post('/store/save', (request, response, next) => {
    if (!isObject(request.body)) {
        return next();
    }
    let validation = validateConversationPayload({ ...request.body, store: null });
    if (validation.valid) {
        validation = validateConversationPayload(request.body.store, {
            maxPayloadBytes: MAX_CONVERSATION_STORE_BYTES,
            maxEntries: MAX_CONVERSATION_STORE_ENTRIES,
        });
    }
    if (!validation.valid) {
        return response.status(400).send({ error: validation.error });
    }
    request[STORE_SAVE_PAYLOAD_VALIDATED] = true;
    return next();
});

router.use((request, response, next) => {
    const validation = request[STORE_SAVE_PAYLOAD_VALIDATED]
        ? { valid: true }
        : validateConversationPayload(request.body);
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

router.post('/store/save', asyncRoute(async (request, response) => {
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
    const saveResult = await saveConversationStore(request, store, request.body.version);
    return respondSaveResult(response, saveResult, { store: saveResult.store || store });
}));

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

router.post('/group/create', asyncRoute(async (request, response) => {
    const scopeValidation = validateConversationScope('', getRequestPersonaId(request));
    if (!scopeValidation.valid) {
        return response.status(400).send({ error: scopeValidation.error });
    }
    const personaId = scopeValidation.personaId;
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

    const saveResult = await saveConversationStore(request, context.store, request.body?.version);
    return respondSaveResult(response, saveResult, { group, groups: getConversationGroups(context.store, personaId, normalizeConversationSettings) });
}));

router.post('/thread/get', asyncRoute(async (request, response) => {
    const target = getConversationTarget(request, response);
    if (!target) {
        return;
    }

    if (request.body?.create !== undefined && typeof request.body.create !== 'boolean') {
        return response.status(400).send({ error: 'invalid_create' });
    }
    const create = request.body?.create === true;
    const context = create
        ? readConversationStoreMutation(request, response)
        : readConversationStore(request, response);
    if (!context) {
        return;
    }
    const authorization = authorizeGroupTarget(request, response, context.store, target);
    if (!authorization) {
        return;
    }
    const storageTarget = getConversationStorageTarget(context.store, target, authorization);
    const thread = getConversationThreadStore(context.store, storageTarget.avatar, storageTarget.groupId, {
        create,
        personaId: storageTarget.personaId,
    });
    const branch = thread
        ? getActiveConversationBranch(context.store, storageTarget.avatar, storageTarget.groupId, { create: false, personaId: storageTarget.personaId })
        : null;
    if (create) {
        const saveResult = await saveConversationStore(request, context.store, request.body.version);
        if (!saveResult.ok) {
            return response.status(saveResult.status || 500).send(saveResult.body || { error: 'save_failed' });
        }
        const savedThread = getConversationThreadStore(saveResult.store, storageTarget.avatar, storageTarget.groupId, {
            create: false,
            personaId: storageTarget.personaId,
        });
        const savedBranch = savedThread
            ? getActiveConversationBranch(saveResult.store, storageTarget.avatar, storageTarget.groupId, { create: false, personaId: storageTarget.personaId })
            : null;
        return response.send({
            threadKey: getConversationThreadKey(storageTarget.avatar, storageTarget.groupId, storageTarget.personaId),
            thread: savedThread,
            branch: savedBranch,
            messages: savedBranch?.messages || [],
            version: saveResult.version,
            settingsMissing: context.missing,
        });
    }
    return response.send({
        threadKey: getConversationThreadKey(storageTarget.avatar, storageTarget.groupId, storageTarget.personaId),
        thread,
        branch,
        messages: branch?.messages || [],
        version: getSettingsVersion(context.settings),
        settingsMissing: context.missing,
    });
}));

router.post('/thread/save', asyncRoute(async (request, response) => {
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
    if (!context) {
        return;
    }
    const authorization = authorizeGroupTarget(request, response, context.store, target);
    if (!authorization) {
        return;
    }
    const storageTarget = getConversationStorageTarget(context.store, target, authorization);
    const branch = getActiveConversationBranch(context.store, storageTarget.avatar, storageTarget.groupId, {
        create: true,
        personaId: storageTarget.personaId,
    });
    branch.messages = parsedMessages.messages;
    refreshBranchPreview(branch);

    const saveResult = await saveConversationStore(request, context.store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(storageTarget.avatar, storageTarget.groupId, storageTarget.personaId),
        branch,
        messages: branch.messages,
    });
}));

router.post('/message/append', asyncRoute(async (request, response) => {
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
    if (!context) {
        return;
    }
    const authorization = authorizeGroupTarget(request, response, context.store, target);
    if (!authorization) {
        return;
    }
    const storageTarget = getConversationStorageTarget(context.store, target, authorization);
    if (hasConversationMessageId(context.store, storageTarget.avatar, incomingMessage.id, {
        groupId: storageTarget.groupId,
        personaId: storageTarget.personaId,
    })) {
        return response.status(400).send({ error: 'duplicate_message_id' });
    }
    const message = appendConversationMessage(context.store, storageTarget.avatar, incomingMessage, {
        groupId: storageTarget.groupId,
        personaId: storageTarget.personaId,
        fallback: { role: request.body?.role || 'user', name: fallbackName.trim() },
    });
    if (!message) {
        return response.status(400).send({ error: 'message_required' });
    }

    const branch = getActiveConversationBranch(context.store, storageTarget.avatar, storageTarget.groupId, {
        create: false,
        personaId: storageTarget.personaId,
    });
    const saveResult = await saveConversationStore(request, context.store, request.body.version);
    return respondSaveResult(response, saveResult, {
        threadKey: getConversationThreadKey(storageTarget.avatar, storageTarget.groupId, storageTarget.personaId),
        message,
        branch,
        messages: branch?.messages || [],
    });
}));

router.post('/message/send', asyncRoute(async (request, response) => {
    const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
    if (!await consumeMessageSendLimit(response, messageSendIpLimiter, ip)) {
        return;
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
    if (!context) {
        return;
    }
    const groupAuthorization = authorizeGroupTarget(request, response, context.store, target);
    if (!groupAuthorization) {
        return;
    }
    const storageTarget = getConversationStorageTarget(context.store, target, groupAuthorization);
    if (hasConversationMessageId(context.store, storageTarget.avatar, incomingMessage.id, {
        groupId: storageTarget.groupId,
        personaId: storageTarget.personaId,
    })) {
        return response.status(400).send({ error: 'duplicate_message_id' });
    }

    const userHandle = String(
        request.user?.profile?.handle
        || request.user?.handle
        || request.user?.profile?.name
        || request.user?.directories?.root
        || 'unknown-user',
    );
    if (!await consumeMessageSendLimit(response, messageSendUserLimiter, userHandle)) {
        return;
    }

    const cancellationController = new AbortController();
    const cancellation = abortOnRequestClose(request, cancellationController, response);
    if (request.aborted || request.readableAborted || response.destroyed) {
        cancellation.abort('pre-generation');
    }
    const userMessage = appendConversationMessage(context.store, storageTarget.avatar, { ...incomingMessage, role: 'user' }, {
        groupId: storageTarget.groupId,
        personaId: storageTarget.personaId,
        fallback: { role: 'user', name: userName },
    });
    if (!userMessage) {
        cancellation.cleanup();
        return response.status(400).send({ error: 'message_required' });
    }

    try {
        const settings = getConversationSettings(
            request,
            context.store,
            storageTarget.avatar,
            storageTarget.groupId,
            request.body.settings,
            { personaId: storageTarget.personaId },
        );
        const character = await getCharacterData(request, target.avatar);
        const participantNames = await getConversationGroupParticipantNames(request, groupAuthorization.group, {
            avatar: target.avatar,
            character,
        });
        const branch = getActiveConversationBranch(context.store, storageTarget.avatar, storageTarget.groupId, {
            create: true,
            personaId: storageTarget.personaId,
        });
        const directive = getDefaultDirective(request.body);
        const promptMessages = await buildConversationPromptMessages(branch.messages, directive, character.name || 'Character', {
            groupId: target.groupId,
            userName,
            signal: cancellationController.signal,
            userDirectories: request.user.directories,
        });
        const systemPrompt = buildConversationSystemPrompt({
            settings,
            character,
            userName,
            groupId: target.groupId,
            branch,
            participantNames,
        });
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

            return response.status(getSafeConversationGenerationStatus(error.status)).send({
                error: 'generation_failed',
                detail: sanitizedDetail,
            });
        }

        const rawReplyText = extractGeneratedText(generationResponse);
        if (rawReplyText.length > MAX_CONVERSATION_MESSAGE_TEXT_LENGTH) {
            return response.status(502).send({
                error: 'generation_too_large',
                detail: 'Model response exceeded the Conversation message limit',
            });
        }
        const commandParts = extractCharacterReplyCommandParts(rawReplyText, settings);
        const conversationCommands = getBoundedConversationCommands(commandParts);
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
        const replyMessage = appendConversationMessage(context.store, storageTarget.avatar, {
            role: 'character',
            name: character.name || 'Character',
            mes: replyText,
            extra: {
                ...(userReplyReference ? { conversation_reply_to: userReplyReference } : {}),
                conversation_commands: conversationCommands,
            },
        }, {
            groupId: storageTarget.groupId,
            personaId: storageTarget.personaId,
            fallback: { role: 'character', name: character.name || 'Character' },
        });
        if (!replyMessage) {
            const error = new Error('Failed to append generated reply');
            error.apiError = 'invalid_generation_message';
            throw error;
        }

        const saveResult = await saveConversationStore(request, context.store, request.body.version);
        if (!saveResult.ok) {
            return response.status(saveResult.status).send(saveResult.body);
        }
        const savedBranch = getActiveConversationBranch(saveResult.store, storageTarget.avatar, storageTarget.groupId, {
            create: false,
            personaId: storageTarget.personaId,
        });
        return response.send({
            threadKey: getConversationThreadKey(storageTarget.avatar, storageTarget.groupId, storageTarget.personaId),
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
