/**
 * The shape of the files in `conversations/`, as pure functions: what a stored file may hold, what a caller may ask
 * for, and the summary of a chat that the list shows.
 *
 * Input is parsed once, here, into values that the store can write without looking again (`parseCreateInput`,
 * `applyUpdatePatch`, `parseCharacterPatch`, `parseChatRecords`). A stored file is read leniently
 * (`normalizeStoredConversation`, `normalizeStoredCharacterState`): a field that is missing or has the wrong type
 * gets its default, so that an older or hand-edited file still opens, but a file that is not a conversation at all
 * is refused as `corrupt`.
 */

import { isChatId, isConversationId } from './conversation-paths.js';

export const CONVERSATION_VERSION = 1;
export const CHARACTER_STATE_VERSION = 1;
export const DEFAULT_CHAT_ID = 'main';

export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 8000;
export const MAX_AVATAR_NAME_LENGTH = 255;
export const MAX_GROUP_MEMBERS = 64;
export const MAX_SETTING_KEYS = 128;
export const MAX_SETTING_STRING_LENGTH = 65536;
export const MAX_REMINDERS = 500;
export const MAX_REMINDER_TEXT_LENGTH = 4096;
export const MAX_ROUTINE_TEXT_LENGTH = 65536;
export const MAX_MARKERS = 64;
export const MAX_AVATAR_IMAGE_BYTES = 5 * 1024 * 1024;
export const PREVIEW_LENGTH = 160;

export const STATUS_VALUES = Object.freeze(['online', 'idle', 'dnd', 'offline']);

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MARKER_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const REMINDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AVATAR_FILE_PATTERN = /^avatar\.(?:png|jpg|gif|webp)$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const IMAGE_TYPES = Object.freeze({
    png: { extension: 'png', contentType: 'image/png' },
    jpeg: { extension: 'jpg', contentType: 'image/jpeg' },
    gif: { extension: 'gif', contentType: 'image/gif' },
    webp: { extension: 'webp', contentType: 'image/webp' },
});

/**
 * `code` is one of `invalid_id`, `invalid_input`, `not_found`, `exists`, `corrupt`, `integrity`, `destructive` and
 * `unavailable`. `details` carries what a route may pass on to the client, such as the reason of a refused save.
 */
export class ConversationStoreError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {Record<string, unknown>} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ConversationStoreError';
        this.code = code;
        this.details = details;
    }
}

function invalid(message) {
    return new ConversationStoreError('invalid_input', message);
}

// ---------------------------------------------------------------------------------------------------------------------
// Values

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function isCounter(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

/** A name of a character, a persona or a file: one line of text that cannot be read as a path or as a prototype key. */
export function isSafeName(value) {
    return typeof value === 'string'
        && value.trim() === value
        && value.length > 0
        && value.length <= MAX_AVATAR_NAME_LENGTH
        && !CONTROL_CHARACTERS.test(value)
        && !/[\\/]/.test(value)
        && value !== '.'
        && value !== '..'
        && !RESERVED_KEYS.has(value);
}

function parseSafeName(value, field) {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (!isSafeName(trimmed)) {
        throw invalid(`${field} is not a valid name.`);
    }
    return trimmed;
}

function parseText(value, field, maxLength) {
    if (typeof value !== 'string' || value.length > maxLength || value.includes('\u0000')) {
        throw invalid(`${field} must be text of at most ${maxLength} characters.`);
    }
    return value;
}

function parseTitle(value, field, maxLength) {
    return parseText(value, field, maxLength).trim();
}

function parseTimestamp(value, field) {
    if (!isTimestamp(value)) {
        throw invalid(`${field} must be a time in milliseconds.`);
    }
    return value;
}

function parseCounter(value, field) {
    if (!isCounter(value)) {
        throw invalid(`${field} must be a whole number of at least 0.`);
    }
    return value;
}

function parseBoolean(value, field) {
    if (typeof value !== 'boolean') {
        throw invalid(`${field} must be true or false.`);
    }
    return value;
}

function parseKnownKeys(value, allowed, field) {
    if (!isPlainObject(value)) {
        throw invalid(`${field} must be an object.`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw invalid(`${field} has no field "${key.slice(0, 64)}".`);
        }
    }
    return value;
}

function parseNameList(value, field, { min = 0, max = MAX_GROUP_MEMBERS } = {}) {
    if (!Array.isArray(value)) {
        throw invalid(`${field} must be a list.`);
    }
    const names = value.map(item => parseSafeName(item, field));
    if (new Set(names).size !== names.length) {
        throw invalid(`${field} names one entry twice.`);
    }
    if (names.length < min || names.length > max) {
        throw invalid(`${field} must hold between ${min} and ${max} entries.`);
    }
    return names;
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings, markers and reminders

function parseSettings(value, field = 'settings') {
    if (!isPlainObject(value)) {
        throw invalid(`${field} must be an object.`);
    }
    const settings = {};
    for (const [key, item] of Object.entries(value)) {
        if (!SETTING_KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
            throw invalid(`${field} has a key that is not a setting name.`);
        }
        const isPrimitive = typeof item === 'boolean'
            || (typeof item === 'number' && Number.isFinite(item))
            || (typeof item === 'string' && item.length <= MAX_SETTING_STRING_LENGTH && !item.includes('\u0000'));
        if (!isPrimitive) {
            throw invalid(`${field}.${key} must be true or false, a number, or text of at most ${MAX_SETTING_STRING_LENGTH} characters.`);
        }
        settings[key] = item;
    }
    if (Object.keys(settings).length > MAX_SETTING_KEYS) {
        throw invalid(`${field} holds more than ${MAX_SETTING_KEYS} settings.`);
    }
    return settings;
}

function parseMarkers(value, field) {
    if (!isPlainObject(value)) {
        throw invalid(`${field} must be an object.`);
    }
    const markers = {};
    for (const [key, item] of Object.entries(value)) {
        if (!MARKER_KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
            throw invalid(`${field} has a key that is not a marker name.`);
        }
        const isPrimitive = typeof item === 'boolean'
            || (typeof item === 'number' && Number.isFinite(item))
            || (typeof item === 'string' && item.length <= 256 && !item.includes('\u0000'));
        if (!isPrimitive) {
            throw invalid(`${field}.${key} must be true or false, a number, or short text.`);
        }
        markers[key] = item;
    }
    if (Object.keys(markers).length > MAX_MARKERS) {
        throw invalid(`${field} holds more than ${MAX_MARKERS} markers.`);
    }
    return markers;
}

const REMINDER_TIME_FIELDS = ['triggerAt', 'createdAt', 'firedAt', 'retryAfter', 'lastAttemptAt', 'invalidAt', 'skippedAt'];
export const REMINDER_FIELDS = ['id', 'avatar', 'chatId', 'text', 'fired', 'attempts', ...REMINDER_TIME_FIELDS];

function parseReminder(value, field) {
    parseKnownKeys(value, REMINDER_FIELDS, field);
    const reminder = {};
    if (typeof value.id !== 'string' || !REMINDER_ID_PATTERN.test(value.id)) {
        throw invalid(`${field}.id is not a reminder id.`);
    }
    reminder.id = value.id;
    if (value.avatar !== undefined) {
        reminder.avatar = parseSafeName(value.avatar, `${field}.avatar`);
    }
    if (value.chatId !== undefined) {
        if (value.chatId !== '' && !isChatId(value.chatId)) {
            throw invalid(`${field}.chatId is not a chat id.`);
        }
        reminder.chatId = value.chatId;
    }
    if (value.text !== undefined) {
        reminder.text = parseText(value.text, `${field}.text`, MAX_REMINDER_TEXT_LENGTH);
    }
    if (value.fired !== undefined) {
        reminder.fired = parseBoolean(value.fired, `${field}.fired`);
    }
    if (value.attempts !== undefined) {
        reminder.attempts = parseCounter(value.attempts, `${field}.attempts`);
    }
    for (const key of REMINDER_TIME_FIELDS) {
        if (value[key] !== undefined) {
            reminder[key] = parseTimestamp(value[key], `${field}.${key}`);
        }
    }
    return reminder;
}

function parseReminders(value, field = 'reminders') {
    if (!Array.isArray(value) || value.length > MAX_REMINDERS) {
        throw invalid(`${field} must be a list of at most ${MAX_REMINDERS} reminders.`);
    }
    const reminders = value.map((item, index) => parseReminder(item, `${field}[${index}]`));
    if (new Set(reminders.map(reminder => reminder.id)).size !== reminders.length) {
        throw invalid(`${field} names one reminder twice.`);
    }
    return reminders;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chat records

/**
 * @param {unknown} records `[header, ...messages]`.
 * @returns {object[]} The same records, after the check that `trySaveChat()` makes and that every row is an object.
 */
export function parseChatRecords(records) {
    if (!Array.isArray(records) || records.length === 0 || !records.every(isPlainObject) || !isPlainObject(records[0].chat_metadata)) {
        throw invalid('A chat must be a list of objects that starts with a header that has chat_metadata.');
    }
    return records;
}

const MEMORY_FIELDS = ['memory_summary', 'memory_message_count', 'memory_updated_at'];

/**
 * @param {unknown} value The `chat_metadata` of a chat that is created with its first messages: `{ sb_conversation }`
 * holding the memory summary of the chat it was branched from, or nothing.
 * @returns {object} The `chat_metadata` of the new header. No other key reaches the header: the slug is the server's.
 */
export function parseNewChatMetadata(value) {
    if (value === undefined) {
        return {};
    }
    parseKnownKeys(value, ['sb_conversation'], 'chat_metadata');
    if (value.sb_conversation === undefined) {
        return {};
    }
    const memory = parseKnownKeys(value.sb_conversation, MEMORY_FIELDS, 'chat_metadata.sb_conversation');
    const parsed = {};
    if (memory.memory_summary !== undefined) {
        parsed.memory_summary = parseText(memory.memory_summary, 'chat_metadata.sb_conversation.memory_summary', MAX_SETTING_STRING_LENGTH);
    }
    for (const key of ['memory_message_count', 'memory_updated_at']) {
        if (memory[key] !== undefined) {
            parsed[key] = parseCounter(memory[key], `chat_metadata.sb_conversation.${key}`);
        }
    }
    return { sb_conversation: parsed };
}

/**
 * @param {unknown} messages The rows of a chat without its header.
 * @returns {object[]} The same rows. A row that is a header, or carries `chat_metadata`, is refused: the header is the server's to write.
 */
export function parseNewChatMessages(messages) {
    if (!Array.isArray(messages) || !messages.every(isPlainObject)) {
        throw invalid('records must be a list of messages.');
    }
    if (messages.some(message => Object.hasOwn(message, 'chat_metadata'))) {
        throw invalid('records holds messages only, with no header.');
    }
    return messages;
}

const CHAT_STATE_FIELDS = ['name', 'readThrough', 'followupCount', 'lastAutoMessageAt', 'lastActivity', 'sessionMarkers'];

function parseReadThrough(value, field) {
    if (typeof value !== 'string' || value.length > 256 || CONTROL_CHARACTERS.test(value)) {
        throw invalid(`${field} must be a message id.`);
    }
    return value;
}

function parseChatStatePatch(value, field) {
    parseKnownKeys(value, CHAT_STATE_FIELDS, field);
    const patch = {};
    if (value.name !== undefined) {
        patch.name = parseTitle(value.name, `${field}.name`, MAX_NAME_LENGTH);
    }
    if (value.readThrough !== undefined) {
        patch.readThrough = parseReadThrough(value.readThrough, `${field}.readThrough`);
    }
    for (const key of ['followupCount', 'lastAutoMessageAt', 'lastActivity']) {
        if (value[key] !== undefined) {
            patch[key] = parseCounter(value[key], `${field}.${key}`);
        }
    }
    if (value.sessionMarkers !== undefined) {
        patch.sessionMarkers = parseMarkers(value.sessionMarkers, `${field}.sessionMarkers`);
    }
    return patch;
}

function newChatEntry(patch, { id, createdAt }) {
    return {
        id,
        name: '',
        createdAt,
        readThrough: '',
        followupCount: 0,
        lastAutoMessageAt: 0,
        lastActivity: 0,
        sessionMarkers: {},
        ...patch,
    };
}

/**
 * The input of `createChat()` and the `chats` of `createConversation()`.
 * @returns {{ entry: object, records: object[]|null }} The list entry, and the records to write, or null for a blank chat.
 */
export function parseChatInput(input, { now, field = 'chat' } = {}) {
    parseKnownKeys(input, ['id', 'createdAt', 'records', 'legacyId', ...CHAT_STATE_FIELDS], field);
    if (input.id !== undefined && !isChatId(input.id)) {
        throw invalid(`${field}.id is not a chat id.`);
    }
    const patch = parseChatStatePatch(Object.fromEntries(Object.entries(input).filter(([key]) => CHAT_STATE_FIELDS.includes(key))), field);
    const createdAt = input.createdAt === undefined ? now : parseTimestamp(input.createdAt, `${field}.createdAt`);
    const entry = newChatEntry(patch, { id: input.id ?? '', createdAt });
    if (input.legacyId !== undefined) {
        entry.legacyId = parseText(input.legacyId, `${field}.legacyId`, 256);
    }
    return { entry, records: input.records === undefined ? null : parseChatRecords(input.records) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversation: create

const CREATE_FIELDS = [
    'kind', 'personaId', 'characters', 'name', 'description', 'id', 'createdAt', 'updatedAt', 'favorite', 'settings',
    'extras', 'reminders', 'legacyKey', 'activeChatId', 'chats',
];

/**
 * @param {unknown} input What the caller asked to create.
 * @param {{ now: number }} context
 * @returns {{ id: string, kind: 'direct'|'group', personaId: string, characters: string[], extras: string[], name: string, description: string, favorite: boolean, settings: Record<string, any>, reminders: object[], legacyKey: string, createdAt: number, updatedAt: number, activeChatId: string, chats: { entry: object, records: object[]|null }[] }} id is empty when the store is to choose it.
 */
export function parseCreateInput(input, { now }) {
    parseKnownKeys(input, CREATE_FIELDS, 'conversation');
    if (input.id !== undefined && !isConversationId(input.id)) {
        throw new ConversationStoreError('invalid_id', 'conversation.id is not a conversation id.');
    }
    if (input.kind !== 'direct' && input.kind !== 'group') {
        throw invalid('conversation.kind must be "direct" or "group".');
    }
    const characters = parseNameList(input.characters, 'conversation.characters', input.kind === 'direct' ? { min: 1, max: 1 } : { min: 2 });
    const chatInputs = input.chats === undefined ? [{ id: DEFAULT_CHAT_ID }] : input.chats;
    if (!Array.isArray(chatInputs) || chatInputs.length === 0) {
        throw invalid('conversation.chats must be a list of at least one chat.');
    }
    const chats = chatInputs.map((item, index) => {
        const parsed = parseChatInput(item, { now, field: `conversation.chats[${index}]` });
        if (!parsed.entry.id) {
            throw invalid(`conversation.chats[${index}].id is needed.`);
        }
        return parsed;
    });
    if (new Set(chats.map(({ entry }) => entry.id)).size !== chats.length) {
        throw invalid('conversation.chats names one chat twice.');
    }
    const activeChatId = input.activeChatId === undefined ? chats[0].entry.id : input.activeChatId;
    if (!chats.some(({ entry }) => entry.id === activeChatId)) {
        throw invalid('conversation.activeChatId is not one of the chats.');
    }
    const extras = input.extras === undefined ? [] : parseNameList(input.extras, 'conversation.extras');
    return {
        id: input.id ?? '',
        kind: input.kind,
        personaId: parseSafeName(input.personaId, 'conversation.personaId'),
        characters,
        extras,
        name: input.name === undefined ? '' : parseTitle(input.name, 'conversation.name', MAX_NAME_LENGTH),
        description: input.description === undefined ? '' : parseText(input.description, 'conversation.description', MAX_DESCRIPTION_LENGTH),
        favorite: input.favorite === undefined ? false : parseBoolean(input.favorite, 'conversation.favorite'),
        settings: input.settings === undefined ? {} : parseSettings(input.settings, 'conversation.settings'),
        reminders: input.reminders === undefined ? [] : parseReminders(input.reminders, 'conversation.reminders'),
        legacyKey: input.legacyKey === undefined ? '' : parseText(input.legacyKey, 'conversation.legacyKey', 1024),
        createdAt: input.createdAt === undefined ? now : parseTimestamp(input.createdAt, 'conversation.createdAt'),
        updatedAt: input.updatedAt === undefined ? (input.createdAt ?? now) : parseTimestamp(input.updatedAt, 'conversation.updatedAt'),
        activeChatId,
        chats,
    };
}

/**
 * The stored form of a parsed create input. Chat records are written to their own files, not into this object.
 */
export function buildConversation(spec, id) {
    return {
        version: CONVERSATION_VERSION,
        id,
        kind: spec.kind,
        personaId: spec.personaId,
        characters: spec.characters,
        extras: spec.extras,
        name: spec.name,
        description: spec.description,
        avatar: '',
        favorite: spec.favorite,
        settings: spec.settings,
        activeChatId: spec.activeChatId,
        chats: spec.chats.map(({ entry }) => entry),
        reminders: spec.reminders,
        createdAt: spec.createdAt,
        updatedAt: spec.updatedAt,
        legacyKey: spec.legacyKey,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversation: update

const UPDATE_FIELDS = ['name', 'description', 'favorite', 'activeChatId', 'settings', 'extras', 'characters', 'reminders', 'chats'];

/**
 * @param {Record<string, any>} current The stored conversation.
 * @param {unknown} patch What the caller asks to change.
 * @param {{ now: number }} context
 * @returns {Record<string, any>} The conversation with the patch applied. The same object when nothing changed.
 */
export function applyUpdatePatch(current, patch, { now }) {
    parseKnownKeys(patch, UPDATE_FIELDS, 'patch');
    const next = { ...current };

    if (patch.name !== undefined) {
        next.name = parseTitle(patch.name, 'patch.name', MAX_NAME_LENGTH);
    }
    if (patch.description !== undefined) {
        next.description = parseText(patch.description, 'patch.description', MAX_DESCRIPTION_LENGTH);
    }
    if (patch.favorite !== undefined) {
        next.favorite = parseBoolean(patch.favorite, 'patch.favorite');
    }
    if (patch.activeChatId !== undefined) {
        if (!current.chats.some(chat => chat.id === patch.activeChatId)) {
            throw invalid('patch.activeChatId is not one of the chats.');
        }
        next.activeChatId = patch.activeChatId;
    }
    if (patch.settings !== undefined) {
        next.settings = applySettingsPatch(current.settings, patch.settings);
    }
    if (patch.characters !== undefined) {
        if (current.kind === 'direct') {
            throw invalid('The character of a direct conversation cannot change.');
        }
        next.characters = parseNameList(patch.characters, 'patch.characters', { min: 2 });
    }
    if (patch.extras !== undefined) {
        const extras = parseNameList(patch.extras, 'patch.extras');
        if (!extras.every(extra => current.extras.includes(extra))) {
            throw invalid('Extras can be removed but not added.');
        }
        next.extras = extras;
    }
    if (patch.reminders !== undefined) {
        next.reminders = parseReminders(patch.reminders, 'patch.reminders');
    }
    if (patch.chats !== undefined) {
        next.chats = applyChatStatePatches(current.chats, patch.chats);
    }

    if (JSON.stringify(next) === JSON.stringify(current)) {
        return current;
    }
    next.updatedAt = Math.max(now, current.updatedAt);
    return next;
}

function applySettingsPatch(currentSettings, patch) {
    if (!isPlainObject(patch)) {
        throw invalid('patch.settings must be an object.');
    }
    const settings = { ...currentSettings };
    const additions = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            if (!SETTING_KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
                throw invalid('patch.settings has a key that is not a setting name.');
            }
            delete settings[key];
        } else {
            additions[key] = value;
        }
    }
    Object.assign(settings, parseSettings(additions, 'patch.settings'));
    if (Object.keys(settings).length > MAX_SETTING_KEYS) {
        throw invalid(`patch.settings leaves more than ${MAX_SETTING_KEYS} settings.`);
    }
    return settings;
}

function applyChatStatePatches(currentChats, patches) {
    if (!isPlainObject(patches)) {
        throw invalid('patch.chats must be an object of chat ids.');
    }
    const ids = Object.keys(patches);
    for (const id of ids) {
        if (!isChatId(id) || !currentChats.some(chat => chat.id === id)) {
            throw invalid('patch.chats names a chat that is not one of the chats.');
        }
    }
    const parsed = Object.fromEntries(ids.map(id => [id, parseChatStatePatch(patches[id], `patch.chats.${id}`)]));
    return currentChats.map(chat => (Object.hasOwn(parsed, chat.id) ? { ...chat, ...parsed[chat.id] } : chat));
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversation: read

function readName(value, fallback = '') {
    return typeof value === 'string' && value.length <= MAX_NAME_LENGTH && !value.includes('\u0000') ? value : fallback;
}

function readCounter(value) {
    return isCounter(value) ? value : 0;
}

function readNames(value, { max = MAX_GROUP_MEMBERS } = {}) {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.filter(isSafeName))].slice(0, max);
}

export function readSettings(value) {
    if (!isPlainObject(value)) {
        return {};
    }
    const settings = {};
    for (const [key, item] of Object.entries(value)) {
        try {
            Object.assign(settings, parseSettings({ [key]: item }));
        } catch {
            // A setting that is not valid is dropped, as the rest of the file is still good.
        }
    }
    return settings;
}

export function readMarkers(value) {
    if (!isPlainObject(value)) {
        return {};
    }
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
        try {
            parseMarkers({ [key]: item }, 'markers');
            return true;
        } catch {
            return false;
        }
    }));
}

function readChatEntry(value, createdAtFallback) {
    if (!isPlainObject(value) || !isChatId(value.id)) {
        return null;
    }
    const entry = newChatEntry({}, { id: value.id, createdAt: isTimestamp(value.createdAt) ? value.createdAt : createdAtFallback });
    entry.name = readName(value.name);
    entry.readThrough = typeof value.readThrough === 'string' && value.readThrough.length <= 256 ? value.readThrough : '';
    entry.followupCount = readCounter(value.followupCount);
    entry.lastAutoMessageAt = readCounter(value.lastAutoMessageAt);
    entry.lastActivity = readCounter(value.lastActivity);
    entry.sessionMarkers = readMarkers(value.sessionMarkers);
    if (typeof value.legacyId === 'string' && value.legacyId.length <= 256) {
        entry.legacyId = value.legacyId;
    }
    return entry;
}

export function readReminders(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const reminders = [];
    for (const item of value.slice(0, MAX_REMINDERS)) {
        try {
            reminders.push(parseReminder(item, 'reminder'));
        } catch {
            // A reminder that is not valid is dropped, as the rest of the file is still good.
        }
    }
    return reminders;
}

/**
 * @param {unknown} raw The parsed `conversation.json`.
 * @param {string} expectedId The name of the folder that the file was read from.
 * @returns {Record<string, any>}
 * @throws {ConversationStoreError} `corrupt` for a file that is not the conversation of that folder.
 */
export function normalizeStoredConversation(raw, expectedId) {
    if (!isPlainObject(raw) || raw.id !== expectedId || (raw.kind !== 'direct' && raw.kind !== 'group')) {
        throw new ConversationStoreError('corrupt', 'conversation.json does not describe this conversation.');
    }
    const createdAt = isTimestamp(raw.createdAt) ? raw.createdAt : 0;
    const seen = new Set();
    const chats = (Array.isArray(raw.chats) ? raw.chats : [])
        .map(item => readChatEntry(item, createdAt))
        .filter(entry => entry && !seen.has(entry.id) && seen.add(entry.id));
    return {
        ...raw,
        version: CONVERSATION_VERSION,
        id: raw.id,
        kind: raw.kind,
        personaId: typeof raw.personaId === 'string' ? raw.personaId : '',
        characters: readNames(raw.characters),
        extras: readNames(raw.extras),
        name: readName(raw.name),
        description: typeof raw.description === 'string' && raw.description.length <= MAX_DESCRIPTION_LENGTH ? raw.description : '',
        avatar: typeof raw.avatar === 'string' && AVATAR_FILE_PATTERN.test(raw.avatar) ? raw.avatar : '',
        favorite: raw.favorite === true,
        settings: readSettings(raw.settings),
        activeChatId: chats.some(entry => entry.id === raw.activeChatId) ? raw.activeChatId : (chats[0]?.id ?? ''),
        chats,
        reminders: readReminders(raw.reminders),
        createdAt,
        updatedAt: isTimestamp(raw.updatedAt) ? raw.updatedAt : createdAt,
        legacyKey: typeof raw.legacyKey === 'string' && raw.legacyKey.length <= 1024 ? raw.legacyKey : '',
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Characters

const ROUTINE_FIELDS = ['enabled', 'text', 'generatedAt'];
const CHARACTER_FIELDS = ['routine', 'statusOverride'];

function parseRoutinePatch(value) {
    parseKnownKeys(value, ROUTINE_FIELDS, 'patch.routine');
    const routine = {};
    if (value.enabled !== undefined) {
        routine.enabled = parseBoolean(value.enabled, 'patch.routine.enabled');
    }
    if (value.text !== undefined) {
        routine.text = parseText(value.text, 'patch.routine.text', MAX_ROUTINE_TEXT_LENGTH);
    }
    if (value.generatedAt !== undefined) {
        routine.generatedAt = parseTimestamp(value.generatedAt, 'patch.routine.generatedAt');
    }
    return routine;
}

/**
 * @param {unknown} avatar
 * @returns {string} The avatar file name that keys `characters.json`.
 */
export function parseCharacterAvatar(avatar) {
    return parseSafeName(avatar, 'avatar');
}

/**
 * @param {unknown} personaId
 * @returns {string} The persona's avatar file name, which keys a persona's folders in `folders.json`.
 * @throws {ConversationStoreError} `invalid_id` for a value that cannot be a persona's file name.
 */
export function parsePersonaId(personaId) {
    if (!isSafeName(personaId)) {
        throw new ConversationStoreError('invalid_id', 'personaId is not a persona id.');
    }
    return personaId;
}

/**
 * @param {unknown} avatars The characters to add to a conversation, as avatar file names.
 * @returns {string[]} At least one name, none twice, none that reads as a path.
 */
export function parseMemberAvatars(avatars) {
    return parseNameList(avatars, 'characters', { min: 1 });
}

/**
 * @param {Record<string, any>} current The stored state of one character.
 * @param {unknown} patch `routine` merges field by field, `statusOverride` replaces; null clears either.
 * @returns {Record<string, any>} The new state of the character, without the fields that are cleared.
 */
export function applyCharacterPatch(current, patch) {
    parseKnownKeys(patch, CHARACTER_FIELDS, 'patch');
    const next = { ...current };
    if (patch.routine === null) {
        delete next.routine;
    } else if (patch.routine !== undefined) {
        next.routine = { ...current.routine, ...parseRoutinePatch(patch.routine) };
    }
    if (patch.statusOverride === null) {
        delete next.statusOverride;
    } else if (patch.statusOverride !== undefined) {
        if (!STATUS_VALUES.includes(patch.statusOverride)) {
            throw invalid(`patch.statusOverride must be one of ${STATUS_VALUES.join(', ')}.`);
        }
        next.statusOverride = patch.statusOverride;
    }
    return next;
}

/**
 * @param {unknown} raw The parsed `characters.json`.
 * @returns {{ version: number, characters: Record<string, Record<string, any>> }}
 */
export function normalizeStoredCharacterState(raw) {
    const characters = Object.create(null);
    const stored = isPlainObject(raw) && isPlainObject(raw.characters) ? raw.characters : {};
    for (const [avatar, entry] of Object.entries(stored)) {
        if (!isSafeName(avatar) || !isPlainObject(entry)) {
            continue;
        }
        const state = {};
        if (isPlainObject(entry.routine)) {
            const routine = {};
            if (typeof entry.routine.enabled === 'boolean') {
                routine.enabled = entry.routine.enabled;
            }
            if (typeof entry.routine.text === 'string' && entry.routine.text.length <= MAX_ROUTINE_TEXT_LENGTH) {
                routine.text = entry.routine.text;
            }
            if (isTimestamp(entry.routine.generatedAt)) {
                routine.generatedAt = entry.routine.generatedAt;
            }
            state.routine = routine;
        }
        if (STATUS_VALUES.includes(entry.statusOverride)) {
            state.statusOverride = entry.statusOverride;
        }
        if (Object.keys(state).length > 0) {
            characters[avatar] = state;
        }
    }
    return { version: CHARACTER_STATE_VERSION, characters: { ...characters } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Avatar image and chat summary

/**
 * The type of an image from its first bytes. The name and the type that a client sends are not looked at.
 * @param {unknown} data
 * @returns {{ extension: string, contentType: string }|null} Null for anything that is not a PNG, JPEG, GIF or WebP file.
 */
export function sniffImageType(data) {
    if (!Buffer.isBuffer(data) || data.length < 12) {
        return null;
    }
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return IMAGE_TYPES.png;
    }
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return IMAGE_TYPES.jpeg;
    }
    const signature = data.subarray(0, 6).toString('latin1');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
        return IMAGE_TYPES.gif;
    }
    if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
        return IMAGE_TYPES.webp;
    }
    return null;
}

export function getAvatarContentType(fileName) {
    return Object.values(IMAGE_TYPES).find(type => `avatar.${type.extension}` === fileName)?.contentType ?? null;
}

export const AVATAR_FILE_NAMES = Object.freeze(Object.values(IMAGE_TYPES).map(type => `avatar.${type.extension}`));

function isUserLine(record) {
    return record.is_user === true || record.role === 'user';
}

function isSystemLine(record) {
    return record.is_system === true || record.role === 'system';
}

function getLineTime(record) {
    if (isTimestamp(record.created_at)) {
        return record.created_at;
    }
    const parsed = typeof record.send_date === 'string' ? Date.parse(record.send_date) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function toPreview(text) {
    // `[^<>]` ends a tag at the next "<": with `[^>]` every lone "<" scanned to the end of the text, so the time grew with its square.
    return String(text ?? '').replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
}

function getLineRole(record) {
    if (isUserLine(record)) {
        return 'user';
    }
    if (isSystemLine(record)) {
        return 'system';
    }
    return record.role === 'member' ? 'member' : 'character';
}

/**
 * What the list shows for one chat. The unread count is the messages after the one that `readThrough` names, from
 * anyone but the user and not system notes. An empty marker means that nothing was read; a marker that names no
 * message counts nothing, so that a deleted message never makes a phantom badge. `lastMessageRole` is `user`,
 * `system`, `member` or `character` (empty for an empty chat), and `hasUserMessage` is whether the user wrote any
 * message; the automatic worker decides from them without reading the chat.
 * @param {object[]} records `[header, ...messages]`.
 * @param {string} readThrough The id of the last message that the user has seen.
 * @returns {{ messageCount: number, lastMessageAt: number, preview: string, unread: number, lastMessageRole: string, hasUserMessage: boolean }}
 */
export function summarizeChatRecords(records, readThrough) {
    const messages = records.slice(1);
    const last = messages[messages.length - 1];
    let firstUnread = 0;
    if (readThrough) {
        const readIndex = messages.findIndex(record => record.id === readThrough);
        firstUnread = readIndex < 0 ? messages.length : readIndex + 1;
    }
    return {
        messageCount: messages.length,
        lastMessageAt: last ? getLineTime(last) : 0,
        preview: last ? toPreview(last.mes) : '',
        unread: messages.slice(firstUnread).filter(record => !isUserLine(record) && !isSystemLine(record)).length,
        lastMessageRole: last ? getLineRole(last) : '',
        hasUserMessage: messages.some(isUserLine),
    };
}
