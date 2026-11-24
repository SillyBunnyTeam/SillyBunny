/**
 * Routes of conversation mode storage, mounted at `/api/sillybunny-conversation`. The browser reads and writes
 * conversations through them; nothing else calls them.
 *
 * Every route is a POST with a JSON object, as the other chat routes are, except the avatar picture, which is a GET so
 * that an `<img>` can load it. Ids are checked against their patterns by the store before they reach a path, a body
 * that is not an object is refused, and an error that is not the caller's answers `500 { error: 'internal' }` with no
 * detail. Errors the caller can act on answer `{ error: <code> }`:
 *
 * | code | status |
 * | --- | --- |
 * | `invalid_id`, `invalid_input` | 400 (`invalid_input` also carries a `message`) |
 * | `not_found` | 404 |
 * | `corrupt` | 422 |
 * | `exists`, `integrity`, `destructive` | 409 (`destructive` also carries a `reason`) |
 */

import path from 'node:path';

import express from 'express';

import {
    ConversationStoreError,
    createChat,
    createConversation,
    deleteChat,
    deleteConversation,
    exportChat,
    getConversationAvatarFile,
    listConversations,
    loadChat,
    readCharacterState,
    readConversation,
    removeConversationAvatar,
    renameChat,
    saveChat,
    setConversationAvatar,
    updateCharacterState,
    updateConversation,
} from '../conversation-store.js';
import { MAX_AVATAR_IMAGE_BYTES } from '../conversation-schema.js';

export const router = express.Router();

const STATUS_BY_CODE = Object.freeze({
    invalid_id: 400,
    invalid_input: 400,
    not_found: 404,
    corrupt: 422,
    exists: 409,
    integrity: 409,
    destructive: 409,
    unavailable: 500,
});
const CREATE_FIELDS = ['kind', 'personaId', 'characters', 'name', 'description'];
const CREATE_CHAT_FIELDS = ['id', 'name', 'activate'];
const MAX_IMAGE_TEXT_LENGTH = Math.ceil(MAX_AVATAR_IMAGE_BYTES / 3) * 4;
const IMAGE_DATA_URL_PREFIX = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function invalidInput(message) {
    return new ConversationStoreError('invalid_input', message);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function answerError(response, error) {
    if (response.headersSent) {
        console.error('Conversation route failed after it had started to answer:', error);
        response.destroy();
        return;
    }
    if (error instanceof ConversationStoreError) {
        const body = { error: error.code };
        if (error.code === 'invalid_input') {
            body.message = error.message;
        }
        if (error.code === 'destructive' && typeof error.details?.reason === 'string') {
            body.reason = error.details.reason;
        }
        response.status(STATUS_BY_CODE[error.code] ?? 500).send(body);
        return;
    }
    console.error('Conversation route failed:', error);
    response.status(500).send({ error: 'internal' });
}

/**
 * Runs a handler with the request's body as a plain object, and answers its errors. The handler's return value is
 * the JSON answer, unless it answers on its own and returns undefined.
 * @param {(user: any, body: Record<string, any>, request: import('express').Request, response: import('express').Response) => unknown} handler
 */
function route(handler) {
    return async (request, response) => {
        try {
            if (!isPlainObject(request.body)) {
                throw invalidInput('The request body must be a JSON object.');
            }
            const answer = await handler(request.user, request.body, request, response);
            if (answer !== undefined && !response.headersSent) {
                response.send(answer);
            }
        } catch (error) {
            answerError(response, error);
        }
    };
}

function onlyFields(body, allowed, route) {
    for (const key of Object.keys(body)) {
        if (!allowed.includes(key)) {
            throw invalidInput(`${route} has no field "${key.slice(0, 64)}".`);
        }
    }
}

function decodeImage(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IMAGE_TEXT_LENGTH + 64) {
        throw invalidInput('image must be base64 text of a PNG, JPEG, GIF or WebP file of at most 5 MiB.');
    }
    const base64 = value.replace(IMAGE_DATA_URL_PREFIX, '');
    if (!BASE64_PATTERN.test(base64)) {
        throw invalidInput('image must be base64 text of a PNG, JPEG, GIF or WebP file of at most 5 MiB.');
    }
    return Buffer.from(base64, 'base64');
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversations

router.post('/list', route(user => listConversations(user)));

router.post('/get', route((user, body) => ({ conversation: readConversation(user, body.id) })));

router.post('/create', route((user, body) => {
    onlyFields(body, CREATE_FIELDS, 'create');
    return createConversation(user, body);
}));

router.post('/update', route((user, body) => ({ conversation: updateConversation(user, body.id, body.patch) })));

router.post('/delete', route((user, body) => {
    deleteConversation(user, body.id);
    return { ok: true };
}));

// ---------------------------------------------------------------------------------------------------------------------
// The avatar of a group

router.post('/avatar/upload', route((user, body) => ({ conversation: setConversationAvatar(user, body.id, decodeImage(body.image)) })));

router.post('/avatar/remove', route((user, body) => ({ conversation: removeConversationAvatar(user, body.id) })));

router.get('/avatar', (request, response) => {
    try {
        if (typeof request.query.id !== 'string') {
            throw invalidInput('id must be a conversation id.');
        }
        const avatar = getConversationAvatarFile(request.user, request.query.id);
        if (!avatar) {
            response.sendStatus(404);
            return;
        }
        response.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache' });
        response.sendFile(path.basename(avatar.filePath), { root: path.dirname(avatar.filePath), dotfiles: 'deny' }, (error) => {
            if (error && !response.headersSent) {
                answerError(response, error);
            }
        });
    } catch (error) {
        answerError(response, error);
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// Chats

router.post('/chat/create', route((user, body) => {
    onlyFields(body, CREATE_CHAT_FIELDS, 'chat/create');
    const { id, ...input } = body;
    return createChat(user, id, input);
}));

router.post('/chat/get', route((user, body) => ({ chat: loadChat(user, body.id, body.chatId) })));

router.post('/chat/save', route(async (user, body) => {
    const { integrity } = await saveChat(user, body.id, body.chatId, body.chat, {
        allowShrink: body.allowShrink === true,
        deferBackup: body.deferBackup === true,
        deferSequenceId: typeof body.deferSequenceId === 'string' ? body.deferSequenceId : undefined,
    });
    return { ok: true, integrity };
}));

router.post('/chat/rename', route((user, body) => ({ conversation: renameChat(user, body.id, body.chatId, body.name) })));

router.post('/chat/delete', route((user, body) => ({ conversation: deleteChat(user, body.id, body.chatId) })));

router.post('/chat/export', route((user, body, _request, response) => {
    const { fileName, data } = exportChat(user, body.id, body.chatId);
    response.attachment(fileName);
    response.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.send(data);
}));

// ---------------------------------------------------------------------------------------------------------------------
// Characters

router.post('/characters/get', route(user => readCharacterState(user)));

router.post('/characters/update', route((user, body) => ({
    avatar: body.avatar,
    state: updateCharacterState(user, body.avatar, body.patch),
})));

// ---------------------------------------------------------------------------------------------------------------------
// Migration of the old store in settings.json. The migration itself is not written yet.

router.post('/migration/status', route(() => ({ state: 'not_migrated' })));

router.post('/import-legacy', route((_user, _body, _request, response) => {
    response.status(501).send({ error: 'not_implemented' });
}));
