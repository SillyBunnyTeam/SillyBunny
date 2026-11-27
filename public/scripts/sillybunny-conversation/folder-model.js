/**
 * The folders of conversation mode as pure functions, with no imports and no DOM: the shape of `conversations/folders.json`,
 * the lenient read of a stored file, and the strict parse and the application of the operations that change it.
 *
 * The server and the page both import this file. The server applies a request with it and the page applies the same
 * request to its copy before the answer arrives, so the two cannot disagree about what an operation does. A page only
 * reads the file through `/folders/get` and never writes it, so what is stored always went through `parseFolderOps()`.
 *
 * A persona has one record: `{ favoritesExpanded, folders, members }`. `members` maps a conversation id to the id of one
 * folder, so a conversation cannot be in two folders. A member whose folder is gone is dropped on every read, which is
 * how a dangling folder id reads as no folder.
 */

export const FOLDER_FILE_VERSION = 1;
export const MAX_FOLDERS_PER_PERSONA = 50;
export const MAX_FOLDER_NAME_LENGTH = 100;
export const MAX_FOLDER_COLOR_LENGTH = 64;
export const MAX_PERSONAS_IN_FILE = 1000;
export const MAX_MEMBERS_PER_PERSONA = 10_000;
export const MAX_FOLDER_OPS = 32;
export const MAX_MEMBER_IDS_PER_OP = 256;

export const FOLDER_ID_PATTERN = /^fld_\d{1,16}_[A-Za-z0-9]{8,32}$/;
// The same pattern as `CONVERSATION_ID_PATTERN` in `src/conversation-paths.js`; `tests/conversation-folder-model.test.js` compares them.
const CONVERSATION_ID_PATTERN = /^conv_\d{1,16}_[A-Za-z0-9]{4,32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const COLOR_PATTERN = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([0-9a-z.,%\s/+-]{1,48}\))$/i;
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

/**
 * `code` is `invalid_input`, `invalid_id`, `not_found` or `exists`, the codes of the store's own errors, so that the
 * store can pass them on.
 */
export class FolderInputError extends Error {
    /**
     * @param {'invalid_input'|'invalid_id'|'not_found'|'exists'} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'FolderInputError';
        this.code = code;
    }
}

function invalid(message) {
    return new FolderInputError('invalid_input', message);
}

/**
 * @typedef {{ id: string, name: string, color: string, expanded: boolean }} Folder
 * @typedef {{ favoritesExpanded: boolean, folders: Folder[], members: Record<string, string> }} FolderRecord
 * @typedef {{ version: number, personas: Record<string, Partial<FolderRecord>> }} FolderFile
 */

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function isFolderId(value) {
    return typeof value === 'string' && FOLDER_ID_PATTERN.test(value);
}

export function isConversationIdLike(value) {
    return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

export function isFolderColor(value) {
    return typeof value === 'string' && (value === '' || (value.length <= MAX_FOLDER_COLOR_LENGTH && COLOR_PATTERN.test(value)));
}

function isFolderName(value) {
    return typeof value === 'string'
        && value === value.trim()
        && value.length >= 1
        && value.length <= MAX_FOLDER_NAME_LENGTH
        && !CONTROL_CHARACTERS.test(value);
}

export function emptyFolderRecord() {
    return { favoritesExpanded: true, folders: [], members: {} };
}

/** @param {FolderRecord} record */
export function isEmptyFolderRecord(record) {
    return record.folders.length === 0 && record.favoritesExpanded !== false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a stored file

function readFolder(entry) {
    if (!isPlainObject(entry) || !isFolderId(entry.id) || typeof entry.name !== 'string') {
        return null;
    }
    const name = entry.name.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, MAX_FOLDER_NAME_LENGTH).trim();
    if (!name) {
        return null;
    }
    return { id: entry.id, name, color: isFolderColor(entry.color) ? entry.color : '', expanded: entry.expanded !== false };
}

/**
 * The lenient read of one persona's stored record: what does not fit is dropped and the rest is kept, so that an older
 * or hand-edited file still opens. Never throws.
 * @param {unknown} raw
 * @returns {FolderRecord}
 */
export function normalizeFolderRecord(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const folders = [];
    const seen = new Set();
    for (const entry of Array.isArray(source.folders) ? source.folders : []) {
        const folder = readFolder(entry);
        if (folder && !seen.has(folder.id) && folders.length < MAX_FOLDERS_PER_PERSONA) {
            seen.add(folder.id);
            folders.push(folder);
        }
    }
    const members = Object.create(null);
    let count = 0;
    for (const [conversationId, folderId] of Object.entries(isPlainObject(source.members) ? source.members : {})) {
        if (count < MAX_MEMBERS_PER_PERSONA && isConversationIdLike(conversationId) && typeof folderId === 'string' && seen.has(folderId)) {
            members[conversationId] = folderId;
            count++;
        }
    }
    return { favoritesExpanded: source.favoritesExpanded !== false, folders, members: { ...members } };
}

function isSafeKey(key) {
    return typeof key === 'string' && key.length > 0 && !RESERVED_KEYS.has(key);
}

/** The stored form of a record: `favoritesExpanded` only while it is false. */
function toStoredRecord(record) {
    return { ...(record.favoritesExpanded === false ? { favoritesExpanded: false } : {}), folders: record.folders, members: record.members };
}

/**
 * The lenient read of a stored `folders.json`. A persona that has neither a folder nor a closed Favorites is left out.
 * Never throws.
 * @param {unknown} raw The parsed file, or null for a missing one.
 * @param {{ isPersonaKey?: (key: string) => boolean }} [options] The store passes `isSafeName`.
 * @returns {FolderFile}
 */
export function normalizeFolderFile(raw, { isPersonaKey = isSafeKey } = {}) {
    const personas = Object.create(null);
    let count = 0;
    for (const [key, entry] of Object.entries(isPlainObject(raw) && isPlainObject(raw.personas) ? raw.personas : {})) {
        if (count >= MAX_PERSONAS_IN_FILE || !isSafeKey(key) || !isPersonaKey(key)) {
            continue;
        }
        const record = normalizeFolderRecord(entry);
        if (!isEmptyFolderRecord(record)) {
            personas[key] = toStoredRecord(record);
            count++;
        }
    }
    return { version: FOLDER_FILE_VERSION, personas: { ...personas } };
}

/**
 * @param {FolderFile} file
 * @param {string} personaId
 * @returns {FolderRecord} A copy; a persona with no entry has the empty record.
 */
export function getPersonaFolders(file, personaId) {
    return Object.hasOwn(file.personas, personaId) ? normalizeFolderRecord(file.personas[personaId]) : emptyFolderRecord();
}

/**
 * @param {FolderFile} file
 * @param {string} personaId
 * @param {FolderRecord} record The record that replaces the persona's entry; an empty one removes the entry.
 * @returns {FolderFile}
 */
export function withPersonaFolders(file, personaId, record) {
    const personas = { ...file.personas };
    if (isEmptyFolderRecord(record)) {
        delete personas[personaId];
    } else {
        if (!Object.hasOwn(personas, personaId) && Object.keys(personas).length >= MAX_PERSONAS_IN_FILE) {
            throw invalid(`Folders can be kept for at most ${MAX_PERSONAS_IN_FILE} personas.`);
        }
        personas[personaId] = toStoredRecord(record);
    }
    return { version: FOLDER_FILE_VERSION, personas };
}

/** @returns {string} The id of the folder of a conversation, or an empty string. */
export function folderIdOf(record, conversationId) {
    return Object.hasOwn(record.members, conversationId) ? record.members[conversationId] : '';
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing a request

const OP_FIELDS = Object.freeze({
    createFolder: ['id', 'name', 'color', 'expanded'],
    updateFolder: ['id', 'name', 'color', 'expanded'],
    moveFolder: ['id', 'to'],
    deleteFolder: ['id'],
    setMembers: ['ids', 'folderId'],
    setFavoritesExpanded: ['expanded'],
});

function parseFolderIdField(value, field) {
    if (!isFolderId(value)) {
        throw new FolderInputError('invalid_id', `${field} is not a folder id.`);
    }
    return value;
}

function parseName(value, field) {
    const name = typeof value === 'string' ? value.trim() : value;
    if (!isFolderName(name)) {
        throw invalid(`${field} must be one line of 1 to ${MAX_FOLDER_NAME_LENGTH} characters.`);
    }
    return name;
}

function parseColor(value, field) {
    if (!isFolderColor(value)) {
        throw invalid(`${field} must be empty or a hex, rgb or hsl colour.`);
    }
    return value;
}

function parseBoolean(value, field) {
    if (typeof value !== 'boolean') {
        throw invalid(`${field} must be true or false.`);
    }
    return value;
}

function parseOp(input, index) {
    const field = `ops[${index}]`;
    if (!isPlainObject(input) || typeof input.op !== 'string' || !Object.hasOwn(OP_FIELDS, input.op)) {
        throw invalid(`${field} is not an operation.`);
    }
    const allowed = OP_FIELDS[input.op];
    for (const key of Object.keys(input)) {
        if (key !== 'op' && !allowed.includes(key)) {
            throw invalid(`${field} has no field "${key.slice(0, 64)}".`);
        }
    }
    switch (input.op) {
        case 'createFolder':
            return {
                op: 'createFolder',
                id: parseFolderIdField(input.id, `${field}.id`),
                name: parseName(input.name, `${field}.name`),
                color: input.color === undefined ? '' : parseColor(input.color, `${field}.color`),
                expanded: input.expanded === undefined ? true : parseBoolean(input.expanded, `${field}.expanded`),
            };
        case 'updateFolder': {
            const change = { op: 'updateFolder', id: parseFolderIdField(input.id, `${field}.id`) };
            if (input.name !== undefined) {
                change.name = parseName(input.name, `${field}.name`);
            }
            if (input.color !== undefined) {
                change.color = parseColor(input.color, `${field}.color`);
            }
            if (input.expanded !== undefined) {
                change.expanded = parseBoolean(input.expanded, `${field}.expanded`);
            }
            if (Object.keys(change).length === 2) {
                throw invalid(`${field} changes nothing.`);
            }
            return change;
        }
        case 'moveFolder':
            if (!Number.isSafeInteger(input.to) || input.to < 0 || input.to >= MAX_FOLDERS_PER_PERSONA) {
                throw invalid(`${field}.to must be a place from 0 to ${MAX_FOLDERS_PER_PERSONA - 1}.`);
            }
            return { op: 'moveFolder', id: parseFolderIdField(input.id, `${field}.id`), to: input.to };
        case 'deleteFolder':
            return { op: 'deleteFolder', id: parseFolderIdField(input.id, `${field}.id`) };
        case 'setMembers': {
            if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > MAX_MEMBER_IDS_PER_OP) {
                throw invalid(`${field}.ids must be a list of 1 to ${MAX_MEMBER_IDS_PER_OP} conversation ids.`);
            }
            if (!input.ids.every(isConversationIdLike)) {
                throw new FolderInputError('invalid_id', `${field}.ids holds a value that is not a conversation id.`);
            }
            if (new Set(input.ids).size !== input.ids.length) {
                throw invalid(`${field}.ids names one conversation twice.`);
            }
            if (input.folderId !== null && input.folderId === undefined) {
                throw invalid(`${field}.folderId must be a folder id or null.`);
            }
            return {
                op: 'setMembers',
                ids: [...input.ids],
                folderId: input.folderId === null ? null : parseFolderIdField(input.folderId, `${field}.folderId`),
            };
        }
        default:
            return { op: 'setFavoritesExpanded', expanded: parseBoolean(input.expanded, `${field}.expanded`) };
    }
}

/**
 * The strict parse of the operations of a request.
 * @param {unknown} input
 * @returns {object[]} Operations that `applyFolderOps()` can run without looking at their shape again.
 * @throws {FolderInputError}
 */
export function parseFolderOps(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_FOLDER_OPS) {
        throw invalid(`ops must be a list of 1 to ${MAX_FOLDER_OPS} operations.`);
    }
    return input.map(parseOp);
}

// ---------------------------------------------------------------------------------------------------------------------
// Applying them

function findFolder(record, id) {
    const folder = record.folders.find(candidate => candidate.id === id);
    if (!folder) {
        throw new FolderInputError('not_found', 'The folder does not exist.');
    }
    return folder;
}

function applyOne(record, op) {
    switch (op.op) {
        case 'createFolder': {
            if (record.folders.some(folder => folder.id === op.id)) {
                throw new FolderInputError('exists', 'A folder with this id exists already.');
            }
            if (record.folders.length >= MAX_FOLDERS_PER_PERSONA) {
                throw invalid(`A persona can have at most ${MAX_FOLDERS_PER_PERSONA} folders.`);
            }
            return { ...record, folders: [...record.folders, { id: op.id, name: op.name, color: op.color, expanded: op.expanded }] };
        }
        case 'updateFolder': {
            findFolder(record, op.id);
            const change = { ...op };
            delete change.op;
            delete change.id;
            return { ...record, folders: record.folders.map(folder => (folder.id === op.id ? { ...folder, ...change } : folder)) };
        }
        case 'moveFolder': {
            const folder = findFolder(record, op.id);
            if (op.to >= record.folders.length) {
                throw invalid('The place is past the last folder.');
            }
            const rest = record.folders.filter(candidate => candidate !== folder);
            rest.splice(op.to, 0, folder);
            return { ...record, folders: rest };
        }
        case 'deleteFolder': {
            findFolder(record, op.id);
            const members = Object.fromEntries(Object.entries(record.members).filter(([, folderId]) => folderId !== op.id));
            return { ...record, folders: record.folders.filter(folder => folder.id !== op.id), members };
        }
        case 'setMembers': {
            if (op.folderId !== null) {
                findFolder(record, op.folderId);
            }
            const members = { ...record.members };
            for (const id of op.ids) {
                if (op.folderId === null) {
                    delete members[id];
                } else {
                    members[id] = op.folderId;
                }
            }
            if (Object.keys(members).length > MAX_MEMBERS_PER_PERSONA) {
                throw invalid(`A persona can file at most ${MAX_MEMBERS_PER_PERSONA} conversations.`);
            }
            return { ...record, members };
        }
        default:
            return { ...record, favoritesExpanded: op.expanded };
    }
}

/**
 * Applies parsed operations in order to a copy of a record. One that cannot apply throws and nothing is returned, so a
 * request is all or nothing.
 * @param {FolderRecord} record
 * @param {object[]} ops The result of `parseFolderOps()`.
 * @returns {FolderRecord}
 * @throws {FolderInputError} `not_found`, `exists` or `invalid_input`.
 */
export function applyFolderOps(record, ops) {
    return ops.reduce(applyOne, { favoritesExpanded: record.favoritesExpanded, folders: record.folders.map(folder => ({ ...folder })), members: { ...record.members } });
}

// ---------------------------------------------------------------------------------------------------------------------
// What the store does to a whole file when a conversation or a persona goes away

/**
 * @param {FolderFile} file
 * @param {string} conversationId
 * @returns {FolderFile} The same object when no persona had the conversation.
 */
export function withoutConversation(file, conversationId) {
    let next = file;
    for (const personaId of Object.keys(file.personas)) {
        const record = getPersonaFolders(file, personaId);
        if (Object.hasOwn(record.members, conversationId)) {
            const members = { ...record.members };
            delete members[conversationId];
            next = withPersonaFolders(next, personaId, { ...record, members });
        }
    }
    return next;
}

/**
 * @param {FolderFile} file
 * @param {string} personaId
 * @returns {FolderFile} The same object when the persona had no entry.
 */
export function withoutPersona(file, personaId) {
    if (!Object.hasOwn(file.personas, personaId)) {
        return file;
    }
    const personas = { ...file.personas };
    delete personas[personaId];
    return { version: FOLDER_FILE_VERSION, personas };
}

/**
 * The membership of a group that was converted into a direct conversation. A new direct conversation takes the folder of
 * the group, as it takes its favourite; one that existed keeps its own folder. Either way the group's entry goes.
 * @param {FolderFile} file
 * @param {string} personaId
 * @param {string} groupId
 * @param {string} newDirectId The id of the direct conversation when the conversion made it, else an empty string.
 * @returns {FolderFile} The same object when nothing changed.
 */
export function withConvertedGroup(file, personaId, groupId, newDirectId) {
    const record = getPersonaFolders(file, personaId);
    if (!Object.hasOwn(record.members, groupId)) {
        return file;
    }
    const { [groupId]: folderId, ...members } = record.members;
    return withPersonaFolders(file, personaId, { ...record, members: newDirectId ? { ...members, [newDirectId]: folderId } : members });
}
