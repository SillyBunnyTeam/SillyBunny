/**
 * The migration of conversation mode storage, from one object in `settings.json` to the folders of
 * `src/conversation-store.js` (plan S2.6).
 *
 * It runs once per user, when the first route that needs the new layout asks (`ensureMigrated()`), and never at server
 * startup. The steps, in this order:
 *
 *  1. Read `settings.json` and the old object, and plan what the new files hold (`conversation-migration-plan.js`).
 *  2. Write the plan with the store's own writers, after a marker file names the folders that are about to be made.
 *  3. Read it all back and compare it with the plan.
 *  4. Write the old object to `backups/_conversation_migration/<date>/sillybunny_conversation.json`.
 *  5. Remove the moved parts from `settings.json`, in one synchronous step that checks the file did not change.
 *
 * A failure at any step removes the folders that step 2 made, restores `characters.json`, and leaves `settings.json` as
 * it was. A backup file that step 4 wrote stays. `settings.json` is the last thing written, so a crash before step 5
 * leaves the old object whole, and the marker file tells the next run which folders to remove. The whole migration is
 * synchronous, so no other request runs between the read of `settings.json` and its write in this process.
 *
 * `settings.json` is the one file that a reset, a snapshot restore and an account import replace, so it cannot be the
 * only record that the migration ran: a restored copy from before the migration would bring the old object back, and
 * the next run would write every conversation a second time. After step 5 the run writes `conversations/migration-done.json`.
 * While that file exists, no run plans or writes a conversation. A run only removes the old object again from
 * `settings.json`, after it copied the object to a backup file. The file also records that the import of the old
 * browser storage ran, which `localStorageMigrated` in `settings.json` could not guard for the same reason.
 *
 * `ensureMigrated()` is cheap to call on every read of `settings.json`: it looks at the file's status, and reads and
 * parses the file only when the status is not what it was when the user was last checked.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_FILE } from './constants.js';
import { buildLegacyThreadKey, LEGACY_STORE_KEY } from './conversation-legacy.js';
import { MIGRATED_STORE_VERSION, planMigration } from './conversation-migration-plan.js';
import { conversationIndex } from './conversation-index.js';
import { CHARACTERS_FILE_NAME, createChatId, getChatFilePath, getConversationDirectory, isConversationId } from './conversation-paths.js';
import { readChatJsonlStrict } from './chat-recovery.js';
import {
    ConversationStoreError,
    createChat,
    createConversation,
    findDirectConversation,
    listConversations,
    readCharacterState,
    readConversation,
    setConversationAvatar,
    updateCharacterState,
} from './conversation-store.js';
import { isSafeName, MAX_AVATAR_IMAGE_BYTES, sniffImageType } from './conversation-schema.js';
import { getSettingsVersion } from './settings-version.js';
import { tryWriteFileSync } from './util.js';

export const MARKER_FILE_NAME = 'migration-in-progress.json';
export const DONE_MARKER_FILE_NAME = 'migration-done.json';
export const BACKUP_FOLDER_NAME = '_conversation_migration';
export const BACKUP_FILE_NAME = 'sillybunny_conversation.json';

/** A failed migration is tried again on a later request, but not on every request. */
export const RETRY_AFTER_MS = 60_000;

const MAX_BACKUP_FOLDERS_PER_DAY = 20;
const OWN_GROUP_AVATAR_URL = /^\/user\/images\/([^/\\]+)$/;
const GROUP_FILE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const LEGACY_STORE_PARTS = Object.freeze(['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments']);

/**
 * `code` is `settings_unreadable`, `settings_changed`, `verification_failed`, `write_failed` or `unexpected`. The
 * message is for the user, and names no path.
 */
export class MigrationError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{ cause?: unknown }} [options]
     */
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'MigrationError';
        this.code = code;
    }
}

/**
 * @typedef {{ profile: { handle: string }, directories: Record<string, string> }} MigrationUser
 * @typedef {{ state: 'nothing_to_migrate' } | { state: 'migrated', report?: object } | { state: 'failed', code: string, message: string, retryAt: number }} MigrationState
 */

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the user's data

function getSettingsPath(user) {
    return path.join(user.directories.root, SETTINGS_FILE);
}

/** @returns {string|null} The text of `settings.json`, or null when the user has none. */
function readSettingsText(settingsPath) {
    try {
        return fs.readFileSync(settingsPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw new MigrationError('settings_unreadable', 'settings.json could not be read.', { cause: error });
    }
}

function parseSettings(text) {
    try {
        const settings = JSON.parse(text);
        if (isObject(settings)) {
            return settings;
        }
    } catch {
        // Reported below.
    }
    throw new MigrationError('settings_unreadable', 'settings.json is not a JSON object.');
}

function listNames(directory) {
    try {
        return new Set(fs.readdirSync(directory));
    } catch {
        return new Set();
    }
}

function parsePinnedChats(settings) {
    try {
        const pins = JSON.parse(settings.accountStorage?.pinnedChats ?? '{}');
        return isObject(pins) ? pins : {};
    } catch {
        return {};
    }
}

function readRoleplayGroup(user, groupId) {
    if (!GROUP_FILE_ID.test(groupId)) {
        return null;
    }
    try {
        const group = JSON.parse(fs.readFileSync(path.join(user.directories.groups, `${groupId}.json`), 'utf8'));
        const names = list => (Array.isArray(list) ? list.filter(item => typeof item === 'string') : []);
        return isObject(group) ? { id: groupId, name: typeof group.name === 'string' ? group.name : '', members: names(group.members), disabled_members: names(group.disabled_members) } : null;
    } catch {
        return null;
    }
}

/** What the plan needs to know about the rest of the user's data, read once. */
function readInputs(user, settings, now) {
    const characterFiles = listNames(user.directories.characters);
    const personaFiles = listNames(user.directories.avatars);
    const personas = isObject(settings.power_user?.personas) ? settings.power_user.personas : {};
    return {
        activePersona: typeof settings.user_avatar === 'string' ? settings.user_avatar : '',
        characterExists: avatar => characterFiles.has(avatar),
        personaExists: personaId => Object.hasOwn(personas, personaId) || personaFiles.has(personaId),
        readRoleplayGroup: groupId => readRoleplayGroup(user, groupId),
        pinnedChats: parsePinnedChats(settings),
        now,
    };
}

function hasLegacyContent(legacy) {
    return LEGACY_STORE_PARTS.some((part) => {
        const value = legacy[part];
        return Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0;
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// The marker: what an interrupted run leaves, so that the next run can remove it.

function getMarkerPath(user) {
    return path.join(user.directories.conversations, MARKER_FILE_NAME);
}

function readMarker(user) {
    try {
        const marker = JSON.parse(fs.readFileSync(getMarkerPath(user), 'utf8'));
        const ids = Array.isArray(marker?.conversationIds) ? marker.conversationIds.filter(isConversationId) : [];
        return { conversationIds: ids, charactersBefore: typeof marker?.charactersBefore === 'string' ? marker.charactersBefore : null };
    } catch {
        return null;
    }
}

function getCharactersPath(user) {
    return path.join(user.directories.conversations, 'characters.json');
}

/** @returns {{ conversationIds: string[], charactersBefore: string|null }} What was written to the marker. */
function writeMarker(user, conversationIds) {
    const charactersPath = getCharactersPath(user);
    const marker = { conversationIds, charactersBefore: fs.existsSync(charactersPath) ? fs.readFileSync(charactersPath, 'utf8') : null };
    fs.mkdirSync(user.directories.conversations, { recursive: true });
    tryWriteFileSync(getMarkerPath(user), JSON.stringify(marker), 'utf8', { durable: true });
    return marker;
}

// ---------------------------------------------------------------------------------------------------------------------
// The done marker: what a finished migration leaves, so that no later run moves the conversations again.

const DONE_MARKER_VERSION = 1;

/**
 * @typedef {object} DoneMarker
 * @property {number} version
 * @property {number} migratedAt Milliseconds since the epoch.
 * @property {string} backupFile The backup of the old object, relative to `backups/`. Empty for a user who was migrated
 * before the marker existed, and for a user who only imported the old browser storage.
 * @property {boolean} localStorageImported Whether the import of the old browser storage ran.
 */

function getDoneMarkerPath(user) {
    return path.join(user.directories.conversations, DONE_MARKER_FILE_NAME);
}

/**
 * The presence of the file is what stops a second migration, so a file that cannot be read or parsed still counts as a
 * marker, with nothing recorded in it.
 * @returns {DoneMarker|null} Null when the user has no marker.
 */
function readDoneMarker(user) {
    let parsed = {};
    try {
        const value = JSON.parse(fs.readFileSync(getDoneMarkerPath(user), 'utf8'));
        parsed = isObject(value) ? value : {};
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return null;
        }
    }
    return {
        version: DONE_MARKER_VERSION,
        migratedAt: Number.isFinite(parsed.migratedAt) ? parsed.migratedAt : 0,
        backupFile: typeof parsed.backupFile === 'string' ? parsed.backupFile : '',
        localStorageImported: parsed.localStorageImported === true,
    };
}

/**
 * Writes the marker with the fields of `changes` over what it holds now. Atomic, like every other file of the store.
 * @param {Partial<DoneMarker>} changes
 */
function writeDoneMarker(user, changes) {
    const marker = { ...(readDoneMarker(user) ?? { version: DONE_MARKER_VERSION, migratedAt: 0, backupFile: '', localStorageImported: false }), ...changes, version: DONE_MARKER_VERSION };
    fs.mkdirSync(user.directories.conversations, { recursive: true });
    tryWriteFileSync(getDoneMarkerPath(user), JSON.stringify(marker, null, 4), 'utf8', { durable: true });
}

/**
 * The marker is written after the work that it vouches for is complete, so a failure here must not undo that work. A
 * user with folders and a migrated `settings.json` and no marker gets it on the next run.
 * @param {Partial<DoneMarker>} changes
 * @returns {boolean} Whether the marker was written.
 */
function tryWriteDoneMarker(user, changes) {
    try {
        writeDoneMarker(user, changes);
        return true;
    } catch (error) {
        console.error('The conversation migration could not write its marker file. The next request writes it again:', error);
        return false;
    }
}

/** Whether the conversations folder holds what a migration writes: a conversation folder or `characters.json`. */
function hasMigratedStore(user) {
    try {
        return fs.readdirSync(user.directories.conversations, { withFileTypes: true }).some(entry => (
            (entry.isDirectory() && isConversationId(entry.name)) || (entry.isFile() && entry.name === CHARACTERS_FILE_NAME)
        ));
    } catch {
        return false;
    }
}

/** Whether the old object holds anything that the new store replaced: a part with content, or the version of the old store. */
function carriesLegacyStore(legacy) {
    return hasLegacyContent(legacy) || (Number.isFinite(legacy.version) && legacy.version < MIGRATED_STORE_VERSION);
}

/**
 * For a user whose migration is over: removes the old object from `settings.json` when it is there again (a snapshot
 * restore, a reset to an older file, an account import), after it copied the object to a backup file. Plans and writes
 * no conversation. The conversations do not depend on `settings.json` any more, so a file that cannot be read, and a
 * trim that fails, leave the user migrated; a failed trim is tried again later (`trimFailed`).
 * @returns {{ state: 'migrated', trimmed?: { backupFile: string, settingsVersion: number }, trimFailed?: true }}
 */
function checkMigratedUser(user, now) {
    try {
        fs.rmSync(getMarkerPath(user), { force: true });
    } catch (error) {
        console.error('The conversation migration could not remove the marker of a run that was stopped:', error);
    }

    const settingsPath = getSettingsPath(user);
    let initialText;
    let settings;
    try {
        initialText = readSettingsText(settingsPath);
        settings = initialText === null ? null : parseSettings(initialText);
    } catch {
        return { state: 'migrated' };
    }
    const legacy = settings?.extension_settings?.[LEGACY_STORE_KEY];
    if (!isObject(legacy) || !carriesLegacyStore(legacy)) {
        return { state: 'migrated' };
    }

    try {
        const backupFile = writeBackup(user, legacy, null, now);
        // The mode-wide settings stay as the restored file has them: the values that the migration derived from the conversations are in the store's own files.
        const globalSettings = isObject(legacy.settings) ? legacy.settings : {};
        const settingsVersion = writeTrimmedSettings(user, { settingsPath, initialText, settings, legacy, globalSettings, pins: { changed: false } });
        return { state: 'migrated', trimmed: { backupFile, settingsVersion } };
    } catch (error) {
        console.error('The old conversation data is in settings.json again and could not be removed:', error);
        return { state: 'migrated', trimFailed: true };
    }
}

/**
 * Removes a folder that a run made. It goes with `fs.rmSync()` and not with `deleteConversation()`: the migration
 * saves no chat through `trySaveChat()`, so there is no recovery state to forget, and the store's delete would create
 * the recovery folder. Never throws.
 */
function removeConversationFolder(user, id) {
    try {
        const directory = getConversationDirectory(user.directories, id);
        fs.rmSync(directory, { recursive: true, force: true });
        conversationIndex.deleteFolder(path.join(directory, 'chats'));
    } catch (error) {
        console.error('The conversation migration could not remove a folder that it made:', error);
    }
}

/** Removes the folders that a run made and restores `characters.json`, as the marker says. Never throws. */
function undoWrites(user, marker) {
    marker.conversationIds.forEach(id => removeConversationFolder(user, id));
    try {
        if (marker.charactersBefore === null) {
            fs.rmSync(getCharactersPath(user), { force: true });
        } else {
            fs.writeFileSync(getCharactersPath(user), marker.charactersBefore);
        }
        fs.rmSync(getMarkerPath(user), { force: true });
    } catch (error) {
        console.error('The conversation migration could not restore characters.json:', error);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing and checking the plan

function copyGroupAvatar(user, id, avatarUrl) {
    const fileName = OWN_GROUP_AVATAR_URL.exec(avatarUrl)?.[1];
    if (!fileName || !isSafeName(fileName)) {
        return false;
    }
    try {
        const filePath = path.join(user.directories.userImages, fileName);
        if (fs.statSync(filePath).size > MAX_AVATAR_IMAGE_BYTES) {
            return false;
        }
        const data = fs.readFileSync(filePath);
        if (!sniffImageType(data)) {
            return false;
        }
        setConversationAvatar(user, id, data);
        return true;
    } catch {
        return false;
    }
}

/**
 * Step 2: writes the plan with the store's writers.
 * @param {MigrationUser} user
 * @param {{ conversations: object[], characterState: Record<string, object> }} plan
 * @returns {{ avatarsNotCopied: number }}
 */
export function writePlan(user, plan) {
    let avatarsNotCopied = 0;
    for (const { id, input, groupAvatarUrl } of plan.conversations) {
        createConversation(user, input);
        if (groupAvatarUrl && !copyGroupAvatar(user, id, groupAvatarUrl)) {
            avatarsNotCopied++;
        }
    }
    for (const [avatar, state] of Object.entries(plan.characterState)) {
        updateCharacterState(user, avatar, state);
    }
    return { avatarsNotCopied };
}

/** One digest over the fields of a message that must survive the round trip, so that a matching count cannot hide changed text. */
function digestOfMessages(messages) {
    return sha256(JSON.stringify(messages.map(message => [message.id, message.role, message.name, message.mes, message.created_at, message.send_date, message.extra])));
}

function verifyChats(user, { id, input }, problems) {
    for (const planned of input.chats) {
        const result = readChatJsonlStrict(getChatFilePath(user.directories, id, planned.id));
        if (result.status !== 'ok') {
            problems.push('a chat file cannot be read');
            continue;
        }
        const expected = planned.records.slice(1);
        const actual = result.records.slice(1);
        if (actual.length !== expected.length || digestOfMessages(actual) !== digestOfMessages(expected)) {
            problems.push('a chat differs from the source in message count, order or content');
        }
    }
}

/**
 * Step 3: reads what was written back through the store, and compares it with the plan: conversations, chats, messages and
 * their content, and the character state.
 * @returns {string[]} What does not match. Empty when everything does.
 */
export function verifyWrittenPlan(user, plan) {
    const problems = [];
    const byId = new Map(listConversations(user).conversations.map(conversation => [conversation.id, conversation]));
    for (const planned of plan.conversations) {
        const found = byId.get(planned.id);
        const { input } = planned;
        if (!found) {
            problems.push('a conversation is missing');
            continue;
        }
        const sameShape = found.kind === input.kind
            && found.personaId === input.personaId
            && found.activeChatId === input.activeChatId
            && JSON.stringify(found.characters) === JSON.stringify(input.characters)
            && JSON.stringify(found.extras) === JSON.stringify(input.extras)
            && JSON.stringify(found.chats.map(chat => chat.id)) === JSON.stringify(input.chats.map(chat => chat.id))
            && found.reminders.length === input.reminders.length;
        if (!sameShape) {
            problems.push('a conversation differs from the plan');
        }
        const expectedMessages = input.chats.reduce((sum, chat) => sum + chat.records.length - 1, 0);
        if (found.messageCount !== expectedMessages) {
            problems.push(`message count: expected ${expectedMessages}, found ${found.messageCount}`);
        }
        verifyChats(user, planned, problems);
    }
    if (JSON.stringify(readCharacterState(user).characters) !== JSON.stringify(plan.characterState)) {
        problems.push('the character state differs from the plan');
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// The backup and settings.json

/**
 * Writes text to a new file. A file of that name with the same content counts as written; one with other content is
 * never replaced.
 * @returns {boolean} Whether the file now holds the text.
 */
function writeBackupFile(filePath, text) {
    try {
        tryWriteFileSync(filePath, text, 'utf8', { expectedFileAbsent: true, durable: true });
        return true;
    } catch (error) {
        if (error?.code === 'ESTALE' || error?.code === 'EEXIST') {
            return fs.readFileSync(filePath, 'utf8') === text;
        }
        throw error;
    }
}

/**
 * @returns {string} The path of the backup file, relative to the user's `backups/` folder.
 */
function writeBackup(user, legacy, pinsText, now) {
    const text = JSON.stringify(legacy, null, 4);
    const date = new Date(now).toISOString().slice(0, 10);
    for (let attempt = 1; attempt <= MAX_BACKUP_FOLDERS_PER_DAY; attempt++) {
        const folder = path.join(BACKUP_FOLDER_NAME, attempt === 1 ? date : `${date}-${attempt}`);
        const filePath = path.join(user.directories.backups, folder, BACKUP_FILE_NAME);
        if (writeBackupFile(filePath, text)) {
            if (pinsText !== null) {
                writeBackupFile(path.join(user.directories.backups, folder, 'pinnedChats.json'), pinsText);
            }
            return path.join(folder, BACKUP_FILE_NAME);
        }
    }
    throw new MigrationError('write_failed', 'The backup file could not be written.');
}

/**
 * Replaces `settings.json` with the trimmed object, if the file is still what the plan was made from. The caller does
 * not return to the event loop between the read of the file and this write, so no settings save from a page can land in
 * between in this process. The text is compared anyway, so that a second process that writes the same file is noticed.
 * The `_version` goes up by one, as it does for a save from a page, so that a page that still holds the old object
 * (and its old version) is refused with a conflict instead of writing the old conversations back.
 */
function writeTrimmedSettings(user, { settingsPath, initialText, settings, legacy, globalSettings, pins }) {
    if (readSettingsText(settingsPath) !== initialText) {
        throw new MigrationError('settings_changed', 'settings.json changed while the conversations were being moved.');
    }
    const kept = { ...legacy };
    for (const part of LEGACY_STORE_PARTS) {
        delete kept[part];
    }
    const next = structuredClone(settings);
    next.extension_settings[LEGACY_STORE_KEY] = { ...kept, version: MIGRATED_STORE_VERSION, settings: globalSettings };
    if (pins.changed) {
        next.accountStorage.pinnedChats = JSON.stringify(pins.pins);
    }
    next._version = getSettingsVersion(settings) + 1;
    try {
        tryWriteFileSync(settingsPath, JSON.stringify(next, null, 4));
    } catch (error) {
        throw new MigrationError('write_failed', 'settings.json could not be written.', { cause: error });
    }
    return next._version;
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Migrates the conversations of one user, if there is anything to migrate. Synchronous. For a user whose migration is
 * over (the done marker exists) it moves nothing, and only removes the old object from `settings.json` if that is back.
 * @param {MigrationUser} user
 * @param {{ now?: number }} [options]
 * @returns {MigrationState | { state: 'migrated', trimmed?: { backupFile: string, settingsVersion: number }, trimFailed?: true }}
 * `trimmed` and `trimFailed` say what a user with a marker needed; `report` is only there for a run that moved conversations.
 * @throws {MigrationError} When any step fails. `settings.json` is as it was, and the folders that the run made are removed.
 */
export function runMigration(user, { now = Date.now() } = {}) {
    if (readDoneMarker(user)) {
        return checkMigratedUser(user, now);
    }

    const settingsPath = getSettingsPath(user);
    const initialText = readSettingsText(settingsPath);
    if (initialText === null) {
        return { state: 'nothing_to_migrate' };
    }
    const settings = parseSettings(initialText);
    const legacy = settings.extension_settings?.[LEGACY_STORE_KEY];
    if (!isObject(legacy)) {
        return { state: 'nothing_to_migrate' };
    }

    const leftover = readMarker(user);
    if (Number(legacy.version) >= MIGRATED_STORE_VERSION) {
        // A run that finished its last step and was stopped before it removed its marker, or one from before the done
        // marker existed. Its folders and the version of settings.json say that the migration ran.
        if (hasMigratedStore(user)) {
            tryWriteDoneMarker(user, { migratedAt: now, backupFile: '', localStorageImported: legacy.localStorageMigrated === true });
        }
        fs.rmSync(getMarkerPath(user), { force: true });
        return { state: 'migrated' };
    }
    if (leftover) {
        undoWrites(user, leftover);
    }
    if (!hasLegacyContent(legacy)) {
        return { state: 'nothing_to_migrate' };
    }

    const plan = planMigration(legacy, readInputs(user, settings, now));
    const marker = writeMarker(user, plan.conversations.map(item => item.id));

    try {
        const { avatarsNotCopied } = writePlan(user, plan);
        const problems = verifyWrittenPlan(user, plan);
        if (problems.length > 0) {
            throw new MigrationError('verification_failed', `What was written does not match the source: ${[...new Set(problems)].join('; ')}.`);
        }
        // The pins are in settings.json outside the old object, and the migration re-keys them, so their old text goes into the backup too.
        const backupFile = writeBackup(user, legacy, plan.pins.changed ? String(settings.accountStorage?.pinnedChats ?? '{}') : null, now);
        const settingsVersion = writeTrimmedSettings(user, { settingsPath, initialText, settings, legacy, globalSettings: plan.globalSettings, pins: plan.pins });
        tryWriteDoneMarker(user, { migratedAt: now, backupFile, localStorageImported: legacy.localStorageMigrated === true });
        fs.rmSync(getMarkerPath(user), { force: true });
        return { state: 'migrated', report: { ...plan.report, avatarsNotCopied, backupFile, settingsVersion } };
    } catch (error) {
        undoWrites(user, marker);
        throw error;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Once per user

/**
 * What `ensureMigrated()` knows about each user, by the path of the user's folder. `signature` is the status of
 * `settings.json` when the user was last checked, and `recheckAt` is when a state that cannot be trusted any longer
 * (a failed run, a trim that failed) is checked again whatever the file's status is.
 * @type {Map<string, { state: MigrationState, signature: string|null, recheckAt: number }>}
 */
const states = new Map();

function toFailure(error, now) {
    const known = error instanceof MigrationError;
    return {
        state: 'failed',
        code: known ? error.code : 'unexpected',
        message: known ? error.message : 'The migration failed unexpectedly. The server log has the details.',
        retryAt: now + RETRY_AFTER_MS,
    };
}

/**
 * The inode, the size and the modification time (to the nanosecond) of `settings.json`. A save, a snapshot restore and
 * a reset each write a new file, so each changes at least one of the three. It costs one `stat`.
 * @returns {string|null} Null when the status cannot be read, which never equals another answer.
 */
function getSettingsSignature(user) {
    try {
        const stats = fs.statSync(getSettingsPath(user), { bigint: true });
        return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
    } catch (error) {
        return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : null;
    }
}

/**
 * Migrates the user's conversations the first time it is asked, and answers the same state afterwards, so it can be
 * called on every request and on every read of `settings.json`. While the status of `settings.json` is what it was at
 * the last check, the answer comes from memory after one `stat`. When the status changed, the user is checked again,
 * because the new file can be an older one: for a user with nothing to migrate it can hold an old store, and for a
 * migrated user it can hold the old object again, which `runMigration()` then removes.
 *
 * A failed migration is remembered for `RETRY_AFTER_MS`, then tried again, so that a fault that was fixed in the
 * meantime (a full disk, a locked file) does not need a restart, and a fault that is not fixed does not repeat the
 * work on every request. A trim of the old object that failed is remembered the same way, and does not fail the user.
 * @param {MigrationUser} user
 * @returns {MigrationState}
 */
export function ensureMigrated(user) {
    const key = path.resolve(user.directories.root);
    const known = states.get(key);
    const now = Date.now();
    let signature = getSettingsSignature(user);
    if (known && now < known.recheckAt && (known.state.state === 'failed' || (signature !== null && signature === known.signature))) {
        return known.state;
    }

    let state;
    let recheckAt = Number.POSITIVE_INFINITY;
    try {
        const { trimmed, trimFailed, ...outcome } = runMigration(user, { now });
        if (outcome.report) {
            console.info(`The conversations of "${user.profile.handle}" were moved out of settings.json: ${outcome.report.migrated.conversations} conversations, ${outcome.report.migrated.chats} chats, ${outcome.report.migrated.messages} messages. The old data is in backups/${BACKUP_FOLDER_NAME}.`);
        }
        if (trimmed) {
            console.info(`The old conversation data was in settings.json of "${user.profile.handle}" again and was removed. A copy is in backups/${trimmed.backupFile}.`);
        }
        if (outcome.report || trimmed) {
            signature = getSettingsSignature(user);
        }
        if (trimFailed) {
            recheckAt = now + RETRY_AFTER_MS;
        }
        // Answer the object that the user was given before, so that the report of this server run stays with it.
        state = outcome.state === 'migrated' && !outcome.report && known?.state.state === 'migrated' ? known.state : outcome;
    } catch (error) {
        console.error(`The conversation migration of "${user.profile.handle}" failed, and settings.json was not changed:`, error);
        state = toFailure(error, now);
        recheckAt = state.retryAt;
    }
    states.set(key, { state, signature, recheckAt });
    return state;
}

// ---------------------------------------------------------------------------------------------------------------------
// The one-time import of the very old browser storage

function unusedChatId(conversation) {
    const used = new Set(conversation.chats.map(chat => chat.id));
    for (;;) {
        const id = createChatId();
        if (!used.has(id)) {
            return id;
        }
    }
}

/**
 * Takes the threads that the browser built from its old `localStorage` keys, and writes them as conversations. They
 * have the shape of a thread of the old store, so they go through the same plan; a character that already has a
 * conversation with this persona gets the imported chats added to it. Runs once: `localStorageMigrated` in
 * `settings.json` and `localStorageImported` in the done marker are set when it is done, and a second call changes
 * nothing. The marker is the record that survives a reset and a restored older `settings.json`.
 * @param {MigrationUser} user
 * @param {{ personaId?: unknown, characters?: unknown }} body `characters` maps an avatar file name to a thread.
 * @param {{ now?: number }} [options]
 * @returns {{ state: 'imported', conversations: number, chats: number, messages: number } | { state: 'already_imported' }}
 */
export function importLegacyThreads(user, body, { now = Date.now() } = {}) {
    if (!isSafeName(body.personaId) || !isObject(body.characters)) {
        throw new ConversationStoreError('invalid_input', 'personaId must be a persona file name, and characters an object of threads.');
    }
    // The marker is read first: it is the record that a reset or a restored older `settings.json` cannot take away.
    const marker = readDoneMarker(user);
    if (marker?.localStorageImported === true) {
        return { state: 'already_imported' };
    }
    const settingsPath = getSettingsPath(user);
    const initialText = readSettingsText(settingsPath);
    if (initialText === null) {
        throw new ConversationStoreError('invalid_input', 'There are no settings to import into.');
    }
    const settings = parseSettings(initialText);
    const legacy = isObject(settings.extension_settings?.[LEGACY_STORE_KEY]) ? settings.extension_settings[LEGACY_STORE_KEY] : {};
    if (legacy.localStorageMigrated === true) {
        return { state: 'already_imported' };
    }

    const characters = {};
    for (const [avatar, thread] of Object.entries(body.characters)) {
        const key = isSafeName(avatar) && isObject(thread) ? buildLegacyThreadKey(avatar, '', body.personaId) : '';
        if (key) {
            characters[key] = thread;
        }
    }
    const plan = planMigration({ version: 1, characters }, { ...readInputs(user, settings, now), pinnedChats: {} });

    const made = [];
    try {
        for (const { id, input } of plan.conversations) {
            const existing = input.kind === 'direct' ? findDirectConversation(user, input.personaId, input.characters[0]) : null;
            if (!existing) {
                createConversation(user, input);
                made.push(id);
                continue;
            }
            for (const chat of input.chats) {
                createChat(user, existing.id, { ...chat, id: unusedChatId(readConversation(user, existing.id)) });
            }
        }
        for (const [avatar, state] of Object.entries(plan.characterState)) {
            if (!readCharacterState(user).characters[avatar]) {
                updateCharacterState(user, avatar, state);
            }
        }
        const next = structuredClone(settings);
        next.extension_settings ??= {};
        next.extension_settings[LEGACY_STORE_KEY] = { ...legacy, localStorageMigrated: true };
        next._version = getSettingsVersion(settings) + 1;
        if (readSettingsText(settingsPath) !== initialText) {
            throw new MigrationError('settings_changed', 'settings.json changed while the threads were being imported.');
        }
        tryWriteFileSync(settingsPath, JSON.stringify(next, null, 4));
    } catch (error) {
        made.forEach(id => removeConversationFolder(user, id));
        throw error;
    }
    // After the settings write, and without undoing the import if it fails: the flag in settings.json still guards it then.
    // A user with no marker gets one here, because this is the first thing that the new store holds for the user.
    tryWriteDoneMarker(user, marker ? { localStorageImported: true } : { migratedAt: now, localStorageImported: true });
    return { state: 'imported', conversations: plan.report.migrated.conversations, chats: plan.report.migrated.chats, messages: plan.report.migrated.messages };
}
