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
 * | `conversion_failed` | 500, when removing a member could not convert the group; the group is as it was |
 * | `migration_failed` | 503, from every route but `/migration/status`, which says why |
 *
 * The first request of a user to any route here moves that user's conversations out of `settings.json` (see
 * `conversation-migration.js`), so every route reads the new layout. The server never does it at startup.
 */

import path from 'node:path';

import express from 'express';

import { ensureMigrated, importLegacyThreads } from '../conversation-migration.js';
import {
    addMembers,
    ConversationStoreError,
    createChat,
    createChatFromMessages,
    createConversation,
    deleteChat,
    deleteConversation,
    exportChat,
    getConversationAvatarFile,
    listConversations,
    loadChat,
    readCharacterState,
    readConversation,
    readConversationFolders,
    removeConversationAvatar,
    removeExtra,
    removeMember,
    renameChat,
    saveChat,
    setConversationAvatar,
    updateCharacterState,
    updateConversation,
    updateConversationFolders,
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
    conversion_failed: 500,
    migration_failed: 503,
});
// `settings` is for what the page starts a conversation with (`NEW_CONVERSATION_SETTINGS`); its keys and values are checked as an update's are.
const CREATE_FIELDS = ['kind', 'personaId', 'characters', 'name', 'description', 'settings'];
const CREATE_CHAT_FIELDS = ['id', 'chatId', 'name', 'activate', 'readThrough', 'records', 'chat_metadata'];
const MAX_IMAGE_TEXT_LENGTH = Math.ceil(MAX_AVATAR_IMAGE_BYTES / 3) * 4;
const IMAGE_DATA_URL_PREFIX = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

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

/** Moves the user's old conversations to the new layout on the first call, and refuses while that has failed. */
function requireNewLayout(user) {
    if (ensureMigrated(user).state === 'failed') {
        throw new ConversationStoreError('migration_failed', 'The conversations could not be moved to their new storage. /migration/status says why.');
    }
}

/**
 * Runs a handler with the request's body as a plain object, and answers its errors. The handler's return value is
 * the JSON answer, unless it answers on its own and returns undefined.
 * @param {(user: any, body: Record<string, any>, request: import('express').Request, response: import('express').Response) => unknown} handler
 * @param {{ needsNewLayout?: boolean }} [options] False for the one route that reports the migration instead of needing it.
 */
function route(handler, { needsNewLayout = true } = {}) {
    return async (request, response) => {
        try {
            if (!isPlainObject(request.body)) {
                throw invalidInput('The request body must be a JSON object.');
            }
            if (needsNewLayout) {
                requireNewLayout(request.user);
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

/**
 * Whether the text is base64: letters, digits, `+` and `/`, then at most two `=`. A scan, because a regular expression
 * over megabytes of text keeps a backtrack entry per character and ran out of stack on CI (a 500 instead of a 400).
 * @param {string} text
 * @returns {boolean}
 */
function isBase64Text(text) {
    let end = text.length;
    while (end > 0 && text.length - end < 2 && text.charCodeAt(end - 1) === 0x3D) {
        end--;
    }
    if (end === 0) {
        return false;
    }
    for (let index = 0; index < end; index++) {
        const code = text.charCodeAt(index);
        const valid = (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) || (code >= 0x30 && code <= 0x39) || code === 0x2B || code === 0x2F;
        if (!valid) {
            return false;
        }
    }
    return true;
}

function decodeImage(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IMAGE_TEXT_LENGTH + 64) {
        throw invalidInput('image must be base64 text of a PNG, JPEG, GIF or WebP file of at most 5 MiB.');
    }
    const base64 = value.replace(IMAGE_DATA_URL_PREFIX, '');
    if (!isBase64Text(base64)) {
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
        requireNewLayout(request.user);
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

router.post('/chat/create', route(async (user, body) => {
    onlyFields(body, CREATE_CHAT_FIELDS, 'chat/create');
    // `id` names the conversation. A chat id from the client lets the browser list a new chat before the server answers;
    // the store checks it like every other id and refuses one that exists. A conversation id is never taken from the client.
    const { id, chatId, records, chat_metadata: chatMetadata, ...input } = body;
    const chat = chatId === undefined ? input : { ...input, id: chatId };
    if (records === undefined && chatMetadata === undefined) {
        return createChat(user, id, chat);
    }
    // A chat that starts with messages is the first save of that chat, so the answer carries the slug that its next save needs.
    return createChatFromMessages(user, id, { ...chat, messages: records ?? [], chatMetadata });
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
// Members and extras

/**
 * `{ id, characters }`: avatar file names of cards that exist. On a group they join it and read the history as it is;
 * on a direct conversation they start a new group with its character, and the direct conversation stays as it is.
 * Answers `{ conversation, created }`, where `conversation` is the group.
 */
router.post('/members/add', route((user, body) => {
    onlyFields(body, ['id', 'characters'], 'members/add');
    return addMembers(user, body.id, body.characters);
}));

/**
 * `{ id, avatar }`. The past messages stay. Answers `{ conversation, converted: false }` while the group keeps two
 * members or more. Removing the second-to-last member converts the group into the direct conversation of the member that
 * is left and answers `{ conversation, converted: true, removedId }`, where `conversation` is the direct conversation to
 * show and `removedId` the deleted group. `conversion_failed` (500) means that the group is as it was.
 */
router.post('/members/remove', route((user, body) => {
    onlyFields(body, ['id', 'avatar'], 'members/remove');
    return removeMember(user, body.id, body.avatar);
}));

/** `{ id, avatar }` on a direct conversation. There is no route to add an extra. Answers `{ conversation }`. */
router.post('/extras/remove', route((user, body) => {
    onlyFields(body, ['id', 'avatar'], 'extras/remove');
    return removeExtra(user, body.id, body.avatar);
}));

// ---------------------------------------------------------------------------------------------------------------------
// Characters

router.post('/characters/get', route(user => readCharacterState(user)));

router.post('/characters/update', route((user, body) => ({
    avatar: body.avatar,
    state: updateCharacterState(user, body.avatar, body.patch),
})));

// ---------------------------------------------------------------------------------------------------------------------
// Folders

/** The folders of every persona: `{ version, personas: { <personaId>: { favoritesExpanded?, folders, members } } }`. */
router.post('/folders/get', route(user => readConversationFolders(user)));

/**
 * `{ personaId, ops }`: one to 32 operations on the folders of that persona (`createFolder`, `updateFolder`, `moveFolder`,
 * `deleteFolder`, `setMembers`, `setFavoritesExpanded`, see `public/scripts/sillybunny-conversation/folder-model.js`),
 * applied in order and all or nothing. Answers `{ personaId, folders }`, the persona's record after the change.
 */
router.post('/folders/update', route((user, body) => {
    onlyFields(body, ['personaId', 'ops'], 'folders/update');
    return { personaId: body.personaId, folders: updateConversationFolders(user, body.personaId, body.ops) };
}));

// ---------------------------------------------------------------------------------------------------------------------
// Migration of the old store in settings.json

/**
 * The state of the move from `settings.json`, after running it if this is the first request of the user:
 * `nothing_to_migrate`, `migrated` (with a `report` of counts when this server run did it), or `failed` (with `error`,
 * and `retryAfterMs`, the time before another request tries again). `settings.json` is unchanged while it is `failed`.
 */
router.post('/migration/status', route(user => {
    const state = ensureMigrated(user);
    if (state.state === 'failed') {
        return { state: 'failed', error: { code: state.code, message: state.message }, retryAfterMs: Math.max(0, state.retryAt - Date.now()) };
    }
    return state;
}, { needsNewLayout: false }));

/**
 * The browser's one-time move of the very old `localStorage` data: `{ personaId, characters: { <avatar>: <thread> } }`.
 * Answers `{ state: 'imported', conversations, chats, messages }`, or `{ state: 'already_imported' }` after the first time.
 */
router.post('/import-legacy', route((user, body) => {
    onlyFields(body, ['personaId', 'characters'], 'import-legacy');
    return importLegacyThreads(user, body);
}));
