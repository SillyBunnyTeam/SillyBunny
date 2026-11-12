import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import extract from 'png-chunks-extract';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { read as readCardMetadata, write as writeCardMetadata } from './character-card-parser.js';

/**
 * Keeps the bundled cards, sprite sets and worlds up to date in a user's data folder without overwriting what the
 * user changed.
 *
 * - A bundled item is identified by a fingerprint of what its author wrote, so using a card (favourites, tags, chats)
 *   never changes it. The manifest lists the fingerprint of each release.
 * - A file is replaced on its own only when its fingerprint is one of the earlier releases, which means that nobody
 *   edited it. A card keeps its personal fields through the replacement.
 * - A card that matches no release is `modified`. It is offered an update only while its `character_version` is lower
 *   than the version of the manifest, so the check needs no record of what was installed and the module keeps no
 *   state file. Updating it keeps the personal fields and writes a backup first.
 * - Sprites and worlds carry no version of their own, so a modified one is never offered an update. Restore replaces
 *   it with the bundled copy after a backup.
 * - Reconcile writes no backup for a card or a sprite file: it replaces only what equals an earlier release in
 *   everything that counts and keeps the personal fields. A world is backed up first, because it holds data that no
 *   fingerprint covers (its root name and the original data of an import).
 * - A file that is a link, is too large or is not a regular file counts as modified and is never read through,
 *   replaced or removed. Every path is resolved inside the folder of its type before it is read or written.
 * - Nothing here deletes a user's file except the oldest backups of an item beyond the newest few, and an item that
 *   is gone is only restored when the user asks.
 */

const DEFAULT_DEPTH_PROMPT_DEPTH = 4;
const DEFAULT_DEPTH_PROMPT_ROLE = 'system';

/** The fields of a card that its author wrote. Everything else on a card belongs to the user. */
const AUTHORED_TEXT_FIELDS = Object.freeze([
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
    'creator_notes',
    'creator',
    'character_version',
    'nickname',
]);

/** Keys of a World Info entry that say where it sits and not what it says. */
const WORLD_ENTRY_POSITION_KEYS = Object.freeze(['uid', 'displayIndex']);

/**
 * @param {Buffer | string} value
 * @returns {string} The SHA-256 as hex.
 */
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * JSON with the keys of every object in sorted order, so equal data gives equal text whatever order it was written in.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    }
    return value;
}

/**
 * A browser form sends every line break as CRLF and the editor stores them so, while a bundled card is written with LF.
 * Both are the same text, so a line break is one thing whichever way it was written.
 */
const normalizeLineBreaks = text => text.replace(/\r\n?/g, '\n');
const asText = value => (typeof value === 'string' ? normalizeLineBreaks(value) : '');
const asTextList = value => (Array.isArray(value) ? value.map(asText) : []);

/** @returns {number | null} The number of a version written as `2` or `2.0`, or null for anything else. */
function parseCardVersion(value) {
    const text = asText(value);
    return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

/**
 * The editor writes a depth prompt into every card it saves, empty unless the author filled it in, so an empty one
 * is the same as none.
 */
function normalizeDepthPrompt(depthPrompt) {
    if (!depthPrompt || typeof depthPrompt !== 'object' || asText(depthPrompt.prompt).trim() === '') {
        return null;
    }
    return {
        prompt: asText(depthPrompt.prompt),
        depth: Number.isFinite(Number(depthPrompt.depth)) ? Number(depthPrompt.depth) : DEFAULT_DEPTH_PROMPT_DEPTH,
        role: asText(depthPrompt.role) || DEFAULT_DEPTH_PROMPT_ROLE,
    };
}

/**
 * The editor embeds the world that a card links to as the card's character book, named after the world, and leaves
 * that copy on the card when the world is unlinked. A copy of a world is the world and not something the author wrote
 * on the card, so a book named after the linked world, or after a world of the manifest, counts as none.
 * @param {unknown} book
 * @param {unknown} linkedWorld
 * @param {string[]} worldNames The names of the worlds of the manifest, without the extension.
 */
function normalizeCharacterBook(book, linkedWorld, worldNames) {
    if (!book || typeof book !== 'object') {
        return null;
    }
    const isLinked = typeof linkedWorld === 'string' && linkedWorld !== '' && book.name === linkedWorld;
    return isLinked || worldNames.includes(book.name) ? null : book;
}

/**
 * @param {Buffer} file A card image
 * @returns {Record<string, any>} The `data` block of the card; V3 is read before V2. As the card parser does, the
 *   creator notes come from the root `creatorcomment` when the data has none.
 */
function readCardData(file) {
    const card = JSON.parse(readCardMetadata(file));
    if (!card || typeof card !== 'object') {
        return {};
    }
    const data = card.data ?? card;
    if (typeof data.creator_notes === 'undefined' && typeof card.creatorcomment !== 'undefined') {
        return { ...data, creator_notes: card.creatorcomment };
    }
    return data;
}

/** @param {Buffer} file A PNG */
function hashImageData(file) {
    const imageData = extract(new Uint8Array(file)).filter(chunk => chunk.name === 'IDAT').map(chunk => Buffer.from(chunk.data));
    return sha256(Buffer.concat(imageData));
}

/**
 * Identifies a card by what its author wrote: the text fields, the greetings, the character book and depth prompt,
 * and the image data. The favourite, talkativeness, tags, chat, date added, linked world and every extension of
 * another module are the user's and do not count, so using a card never changes its fingerprint.
 * @param {Buffer} file A card image
 * @param {object} [options]
 * @param {string[]} [options.worldNames] The names of the worlds of the manifest, without the extension.
 * @returns {string} A SHA-256 as hex
 * @throws {Error} When the file is not a card image
 */
export function fingerprintCard(file, { worldNames = [] } = {}) {
    const data = readCardData(file);
    const authored = Object.fromEntries(AUTHORED_TEXT_FIELDS.map(field => [field, asText(data[field])]));
    authored.alternate_greetings = asTextList(data.alternate_greetings);
    authored.group_only_greetings = asTextList(data.group_only_greetings);
    authored.character_book = normalizeCharacterBook(data.character_book, data.extensions?.world, worldNames);
    authored.depth_prompt = normalizeDepthPrompt(data.extensions?.depth_prompt);
    return sha256(canonicalJson({ authored, image: hashImageData(file) }));
}

/**
 * Identifies a World Info file by its entries and its root `extensions`, so renumbering or reordering the entries
 * does not change it and data the user keeps on the world does. The root `name` is the display name that the editor
 * and imports set, and `originalData` is the copy of an import kept for export; neither says anything that the
 * entries do not, so they do not count.
 * @param {Buffer} file
 * @returns {string} A SHA-256 as hex
 * @throws {Error} When the file is not JSON
 */
export function fingerprintWorld(file) {
    const { entries, extensions } = JSON.parse(file.toString('utf8'));
    const stripped = Object.values(entries ?? {}).map(entry => Object.fromEntries(
        Object.entries(entry ?? {}).filter(([key]) => !WORLD_ENTRY_POSITION_KEYS.includes(key)),
    ));
    const rootExtensions = extensions && typeof extensions === 'object' && !Array.isArray(extensions) ? extensions : {};
    return sha256(canonicalJson({ entries: stripped.map(canonicalJson).sort(), extensions: rootExtensions }));
}

/**
 * @param {Buffer} file
 * @returns {string} A SHA-256 as hex
 */
export function fingerprintSpriteFile(file) {
    return sha256(file);
}

export const MANIFEST_FILE_NAME = 'sillybunny-managed.json';

const MANIFEST_FORMAT = 1;
const ITEM_TYPES = Object.freeze({ CARD: 'character', SPRITES: 'sprites', WORLD: 'world' });
const MAX_NAME_LENGTH = 255;
const MAX_SPRITE_FILES = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The manifest is shipped with the app, so a bad one is a mistake of the build and nothing a user can cause. */
export class ManifestError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(`Managed content manifest: ${message}`);
        this.name = 'ManifestError';
    }
}

/**
 * @typedef {object} ManagedFile
 * @property {string} name
 * @property {string} sha256
 * @property {string[]} previous Hashes of earlier bundled versions of this file, newest first.
 *
 * @typedef {object} ManagedItem
 * @property {string} filename A card or world file name, or the folder of a sprite set.
 * @property {'character' | 'world' | 'sprites'} type
 * @property {number} version Raised by one whenever the bundled item changes.
 * @property {string} [fingerprint] Cards and worlds.
 * @property {string[]} [previousFingerprints] Cards and worlds; earlier bundled fingerprints, newest first.
 * @property {ManagedFile[]} [files] Sprites.
 *
 * @typedef {{ format: 1, items: ManagedItem[] }} Manifest
 */

function isSafeName(name) {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= MAX_NAME_LENGTH
        && !name.startsWith('.')
        && name === path.basename(name)
        && name === path.win32.basename(name)
        && !name.includes('\0');
}

function requireSafeName(name, what) {
    if (!isSafeName(name)) {
        throw new ManifestError(`${what} "${String(name)}" is not a plain file name.`);
    }
}

function requireHash(value, what) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        throw new ManifestError(`${what} is not a SHA-256.`);
    }
    return value;
}

function requireHashes(value, what) {
    if (!Array.isArray(value)) {
        throw new ManifestError(`${what} is not a list.`);
    }
    return value.map(hash => requireHash(hash, what));
}

function parseFiles(files, filename) {
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_SPRITE_FILES) {
        throw new ManifestError(`the sprites "${filename}" need between 1 and ${MAX_SPRITE_FILES} files.`);
    }
    const seen = new Set();
    return files.map((file) => {
        requireSafeName(file?.name, `a sprite file of "${filename}"`);
        if (seen.has(file.name)) {
            throw new ManifestError(`the sprite file "${file.name}" of "${filename}" is listed twice.`);
        }
        seen.add(file.name);
        return {
            name: file.name,
            sha256: requireHash(file.sha256, `the hash of "${file.name}"`),
            previous: requireHashes(file.previous, `the earlier hashes of "${file.name}"`),
        };
    });
}

function parseItem(item) {
    requireSafeName(item?.filename, 'the filename');
    const { filename, type } = item;
    if (!Number.isInteger(item.version) || item.version < 1) {
        throw new ManifestError(`the version of "${filename}" is not a whole number above zero.`);
    }
    const base = { filename, type, version: item.version };
    switch (type) {
        case ITEM_TYPES.SPRITES:
            return { ...base, files: parseFiles(item.files, filename) };
        case ITEM_TYPES.CARD:
        case ITEM_TYPES.WORLD: {
            const extension = type === ITEM_TYPES.CARD ? '.png' : '.json';
            if (path.extname(filename).toLowerCase() !== extension) {
                throw new ManifestError(`"${filename}" is a ${type} and must end in ${extension}.`);
            }
            return {
                ...base,
                fingerprint: requireHash(item.fingerprint, `the fingerprint of "${filename}"`),
                previousFingerprints: requireHashes(item.previousFingerprints, `the earlier fingerprints of "${filename}"`),
            };
        }
        default:
            throw new ManifestError(`"${filename}" has the unknown type "${String(type)}".`);
    }
}

/**
 * Checks a manifest and returns it in its canonical shape.
 * @param {unknown} value
 * @returns {Manifest}
 * @throws {ManifestError}
 */
export function parseManifest(value) {
    if (!value || typeof value !== 'object' || value.format !== MANIFEST_FORMAT || !Array.isArray(value.items)) {
        throw new ManifestError(`expected an object of format ${MANIFEST_FORMAT} with a list of items.`);
    }
    const items = value.items.map(parseItem);
    const filenames = new Set();
    for (const { filename } of items) {
        if (filenames.has(filename)) {
            throw new ManifestError(`"${filename}" is listed twice.`);
        }
        filenames.add(filename);
    }
    return { format: MANIFEST_FORMAT, items };
}

/**
 * Reads the manifest of a bundled directory. A directory without one has nothing managed.
 * @param {string} bundledDirectory
 * @returns {Manifest}
 * @throws {ManifestError}
 */
export function readManifest(bundledDirectory) {
    const manifestPath = path.join(bundledDirectory, MANIFEST_FILE_NAME);
    if (!fs.existsSync(manifestPath)) {
        return { format: MANIFEST_FORMAT, items: [] };
    }
    try {
        return parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    } catch (error) {
        throw error instanceof ManifestError ? error : new ManifestError(`${MANIFEST_FILE_NAME} could not be read (${error.message}).`);
    }
}

/**
 * The hash that the item had, and the ones before it. An unchanged hash keeps its history, a changed one pushes the
 * old hash to the front of it.
 * @param {string | undefined} before
 * @param {string[]} history
 * @param {string} now
 * @returns {string[]}
 */
function extendHistory(before, history, now) {
    return before === undefined || before === now ? history : [before, ...history.filter(hash => hash !== before)];
}

/** @returns {string[]} The names, without the extension, of the worlds among items with a `type` and a `filename`. */
const worldNamesOf = items => items.filter(item => item.type === ITEM_TYPES.WORLD && typeof item.filename === 'string').map(item => path.parse(item.filename).name);

function buildBundledFile(bundledDirectory, filename, type, before, worldNames) {
    const file = fs.readFileSync(path.join(bundledDirectory, filename));
    const fingerprint = type === ITEM_TYPES.CARD ? fingerprintCard(file, { worldNames }) : fingerprintWorld(file);
    const previousFingerprints = extendHistory(before?.fingerprint, before?.previousFingerprints ?? [], fingerprint);
    const changed = before !== undefined && before.fingerprint !== fingerprint;
    const version = (before?.version ?? 0) + (before === undefined || changed ? 1 : 0);
    if (type === ITEM_TYPES.CARD && parseCardVersion(readCardData(file).character_version) !== version) {
        throw new ManifestError(`the card "${filename}" is version ${version}, so its character_version must be "${version}" or "${version}.0".`);
    }
    return { filename, type, version, fingerprint, previousFingerprints };
}

function buildBundledSprites(bundledDirectory, filename, before) {
    const folder = path.join(bundledDirectory, filename);
    const names = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();
    if (names.length === 0) {
        throw new ManifestError(`the sprite folder "${filename}" has no files.`);
    }
    const files = names.map((name) => {
        requireSafeName(name, `a sprite file of "${filename}"`);
        const sha256 = fingerprintSpriteFile(fs.readFileSync(path.join(folder, name)));
        const earlier = before?.files.find(file => file.name === name);
        return { name, sha256, previous: extendHistory(earlier?.sha256, earlier?.previous ?? [], sha256) };
    });
    const unchanged = before !== undefined
        && before.files.length === files.length
        && files.every(file => before.files.some(earlier => earlier.name === file.name && earlier.sha256 === file.sha256));
    return { filename, type: ITEM_TYPES.SPRITES, version: (before?.version ?? 0) + (unchanged ? 0 : 1), files };
}

/**
 * Fingerprints the bundled files of the listed items. An item that changed since the previous manifest gets the next
 * version and keeps the old fingerprint as an earlier one, which is what lets a user's untouched copy of that
 * version be updated. Run it when the bundled content changes; the result is written to the manifest as it is.
 * @param {object} options
 * @param {string} options.bundledDirectory
 * @param {{ filename: string, type: string }[]} options.entries
 * @param {Manifest | null} [options.previous]
 * @returns {Manifest}
 * @throws {ManifestError}
 */
export function buildManifest({ bundledDirectory, entries, previous = null }) {
    const worldNames = worldNamesOf(entries);
    const items = entries.map(({ filename, type }) => {
        requireSafeName(filename, 'the filename');
        const before = previous?.items.find(item => item.filename === filename && item.type === type);
        try {
            return type === ITEM_TYPES.SPRITES
                ? buildBundledSprites(bundledDirectory, filename, before)
                : buildBundledFile(bundledDirectory, filename, type, before, worldNames);
        } catch (error) {
            throw error instanceof ManifestError ? error : new ManifestError(`"${filename}" could not be fingerprinted (${error.message}).`);
        }
    });
    return parseManifest({ format: MANIFEST_FORMAT, items });
}

export const MANAGED_STATUS = Object.freeze({
    CURRENT: 'current',
    UPDATED: 'updated',
    MODIFIED: 'modified',
    DELETED: 'deleted',
    NOT_INSTALLED: 'not-installed',
});

/** What a caller can be told about a refused operation. The codes are stable; the message is for the log. */
export class ManagedContentError extends Error {
    /**
     * @param {'unknown_item' | 'already_current' | 'not_applicable' | 'unsafe_target' | 'bundled_missing' | 'backup_failed' | 'write_failed'} code
     * @param {string} message
     * @param {unknown} [cause]
     */
    constructor(code, message, cause = undefined) {
        super(message, { cause });
        this.name = 'ManagedContentError';
        this.code = code;
    }
}

const MAX_USER_FILE_BYTES = 32 * 1024 * 1024;
const BACKUP_FOLDER = 'managed';
const MAX_BACKUP_NAME_ATTEMPTS = 100;
/**
 * Backups are a safety net for the last few mistaken updates or restores of an item, not an archive. Five undoes a
 * wrong Update, the Restore that corrected it and the one before, and keeps `backups/managed` from growing for ever.
 */
const MAX_BACKUPS_PER_ITEM = 5;
const BACKUP_STAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';

/**
 * Joins names onto a folder and refuses a result that is outside it or is the folder itself. Manifest names are
 * checked when the manifest is read; this holds again at the point where a path is built.
 * @param {string} base
 * @param {...string} parts
 * @returns {string}
 * @throws {ManagedContentError} `unsafe_target`
 */
export function resolveInside(base, ...parts) {
    const target = path.join(base, ...parts);
    assertInside(base, target);
    return target;
}

function assertInside(base, target) {
    const relative = path.relative(path.resolve(base), path.resolve(target));
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ManagedContentError('unsafe_target', `${target} is not inside ${base}.`);
    }
}

/**
 * Writes a file atomically, only inside the folder it belongs to.
 * @param {string} root The folder the target must be in.
 * @param {string} target
 * @param {Buffer} buffer
 * @param {(target: string) => void} setPermissions
 * @throws {ManagedContentError} `unsafe_target` or `write_failed`
 */
export function writeInside(root, target, buffer, setPermissions) {
    assertInside(root, target);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeFileAtomicSync(target, buffer);
        setPermissions(target);
    } catch (error) {
        throw new ManagedContentError('write_failed', `${target} could not be written.`, error);
    }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The backups of one item in a folder, oldest first. A backup of the item is named after it, then the stamp, a number
 * when several were made in the same moment, and its extension; nothing else in the folder is one.
 * @param {string} folder
 * @param {{ base: string, extension: string, kind: 'file' | 'folder' }} item
 * @returns {{ name: string, stamp: string, number: number }[]}
 */
function listBackups(folder, { base, extension, kind }) {
    const pattern = new RegExp(`^${escapeRegExp(base)}-(${BACKUP_STAMP_PATTERN})(?:-(\\d+))?${escapeRegExp(extension)}$`);
    return fs.readdirSync(folder, { withFileTypes: true })
        .filter(entry => (kind === 'folder' ? entry.isDirectory() : entry.isFile()))
        .flatMap((entry) => {
            const match = pattern.exec(entry.name);
            return match ? [{ name: entry.name, stamp: match[1], number: Number(match[2] ?? 1) }] : [];
        })
        // Stamps are ISO times, so they sort as text; the number is compared as a number, since 10 sorts before 9 as text.
        .sort((a, b) => (a.stamp === b.stamp ? a.number - b.number : (a.stamp < b.stamp ? -1 : 1)));
}

/**
 * The number for the next backup made in a moment. It follows the highest one that exists, so a number freed by
 * removing the oldest backup is not reused: a reused number would sort as the oldest and be removed at once.
 */
function nextBackupNumber(folder, item, stamp) {
    return Math.max(0, ...listBackups(folder, item).filter(backup => backup.stamp === stamp).map(backup => backup.number)) + 1;
}

/**
 * Removes the oldest backups of one item beyond {@link MAX_BACKUPS_PER_ITEM}.
 * @param {string} folder
 * @param {{ base: string, extension: string, kind: 'file' | 'folder' }} item
 */
function pruneBackups(folder, item) {
    const backups = listBackups(folder, item);
    for (const { name } of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS_PER_ITEM))) {
        fs.rmSync(path.join(folder, name), { recursive: true });
    }
}

/** Root-level card fields that belong to the user. Mirrored ones (favourite, talkativeness, tags) live in `data`. */
const PERSONAL_ROOT_FIELDS = Object.freeze(['chat', 'create_date']);

const AUTHORED_DATA_FIELDS = Object.freeze([...AUTHORED_TEXT_FIELDS, 'alternate_greetings', 'group_only_greetings', 'character_book']);

/**
 * @typedef {{ kind: 'missing' } | { kind: 'unsafe' } | { kind: 'file', buffer: Buffer }} UserFile
 *
 * @typedef {object} ManagedStatus
 * @property {string} filename
 * @property {string} type
 * @property {number} version The bundled version.
 * @property {string} status One of {@link MANAGED_STATUS}.
 * @property {boolean} updateAvailable Whether the user should be offered an update.
 * @property {number | null} [installedVersion] Cards only: the `character_version` of the user's card.
 */

/** @returns {UserFile} A file in the user's data folder, read only when it is a plain file of a sane size. */
function readUserFile(filePath) {
    let stats;
    try {
        stats = fs.lstatSync(filePath);
    } catch (error) {
        return error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' };
    }
    if (!stats.isFile() || stats.size > MAX_USER_FILE_BYTES) {
        return { kind: 'unsafe' };
    }
    try {
        return { kind: 'file', buffer: fs.readFileSync(filePath) };
    } catch {
        return { kind: 'unsafe' };
    }
}

function classifyFingerprint(item, fingerprint) {
    if (fingerprint === item.fingerprint) {
        return MANAGED_STATUS.CURRENT;
    }
    return item.previousFingerprints.includes(fingerprint) ? MANAGED_STATUS.UPDATED : MANAGED_STATUS.MODIFIED;
}

function parseInstalledVersion(file) {
    return parseCardVersion(readCardData(file).character_version);
}

/** @returns {{ status: string, installedVersion: number | null, unsafe: boolean }} */
function inspectCard(item, file, worldNames) {
    if (file.kind !== 'file') {
        return { status: MANAGED_STATUS.MODIFIED, installedVersion: null, unsafe: true };
    }
    try {
        return {
            status: classifyFingerprint(item, fingerprintCard(file.buffer, { worldNames })),
            installedVersion: parseInstalledVersion(file.buffer),
            unsafe: false,
        };
    } catch {
        return { status: MANAGED_STATUS.MODIFIED, installedVersion: null, unsafe: false };
    }
}

function inspectWorld(item, file) {
    if (file.kind !== 'file') {
        return { status: MANAGED_STATUS.MODIFIED };
    }
    try {
        return { status: classifyFingerprint(item, fingerprintWorld(file.buffer)) };
    } catch {
        return { status: MANAGED_STATUS.MODIFIED };
    }
}

/**
 * What a sprite file of the user's is compared to the bundled one.
 * @returns {'missing' | 'current' | 'earlier' | 'modified' | 'unsafe'}
 */
function compareSpriteFile(entry, file) {
    if (file.kind === 'missing') {
        return 'missing';
    }
    if (file.kind === 'unsafe') {
        return 'unsafe';
    }
    const hash = fingerprintSpriteFile(file.buffer);
    if (hash === entry.sha256) {
        return 'current';
    }
    return entry.previous.includes(hash) ? 'earlier' : 'modified';
}

function aggregateSpriteStates(states) {
    if (states.some(state => state === 'modified' || state === 'unsafe')) {
        return MANAGED_STATUS.MODIFIED;
    }
    return states.every(state => state === 'current') ? MANAGED_STATUS.CURRENT : MANAGED_STATUS.UPDATED;
}

/**
 * Lays the bundled card over the user's: every authored field comes from the bundled card, and the personal fields
 * and the extensions of other modules stay as the user has them.
 * @param {Buffer} bundledFile
 * @param {Buffer | null} userFile The user's card, or null when it cannot be read.
 * @returns {Buffer}
 */
function mergeCardFiles(bundledFile, userFile) {
    const bundled = JSON.parse(readCardMetadata(bundledFile));
    const merged = structuredClone(bundled);
    merged.data ??= {};
    merged.data.extensions ??= {};
    let imageSource = bundledFile;

    let user = null;
    if (userFile) {
        try {
            user = JSON.parse(readCardMetadata(userFile));
            if (hashImageData(userFile) === hashImageData(bundledFile)) {
                imageSource = userFile;
            }
        } catch {
            user = null;
        }
    }

    if (user) {
        const userData = user.data ?? {};
        for (const field of PERSONAL_ROOT_FIELDS) {
            if (user[field] !== undefined) {
                merged[field] = user[field];
            }
        }
        if (userData.tags !== undefined) {
            merged.data.tags = userData.tags;
        }
        for (const [key, value] of Object.entries(userData)) {
            if (!(key in merged.data) && !AUTHORED_DATA_FIELDS.includes(key)) {
                merged.data[key] = value;
            }
        }
        const bundledDepthPrompt = bundled.data?.extensions?.depth_prompt;
        merged.data.extensions = { ...merged.data.extensions, ...userData.extensions };
        if (bundledDepthPrompt === undefined) {
            delete merged.data.extensions.depth_prompt;
        } else {
            merged.data.extensions.depth_prompt = bundledDepthPrompt;
        }
    }

    return writeCardMetadata(imageSource, JSON.stringify(merged));
}

/**
 * @param {object} options
 * @param {string} options.bundledDirectory Where the manifest and the bundled files are.
 * @param {{ root: string, characters: string, worlds: string, backups: string, thumbnailsAvatar?: string, thumbnailsAvatarMobile?: string }} options.directories The user's data folders.
 * @param {() => Date} [options.now]
 * @param {(target: string) => void} [options.setPermissions] Called on every file written.
 * @param {(filename: string) => void} [options.invalidateThumbnail] Removes the cached thumbnails of a card. It is
 *   called after a card file is written, and at the start for a card whose thumbnails are older than the file. A
 *   hook that throws is logged and changes nothing else. Without it, thumbnails are not touched; the thumbnail
 *   module is not imported here because it reads the configuration when it loads.
 * @param {() => ManagedItem[]} [options.readItems] Where the items come from. Tests give items that the manifest
 *   check would refuse, to show that the paths are guarded again where they are built.
 */
export function createManagedContent({
    bundledDirectory,
    directories,
    now = () => new Date(),
    setPermissions = () => {},
    readItems = () => readManifest(bundledDirectory).items,
    invalidateThumbnail,
}) {
    function loadItems() {
        try {
            return readItems();
        } catch (error) {
            console.warn(error.message);
            return [];
        }
    }

    function isLogged(filename) {
        const logPath = path.join(directories.root, 'content.log');
        try {
            return fs.readFileSync(logPath, 'utf8').split('\n').some(line => line.trim() === filename);
        } catch {
            return false;
        }
    }

    const folderOf = item => (item.type === ITEM_TYPES.WORLD ? directories.worlds : directories.characters);
    const userPath = (item, ...parts) => resolveInside(folderOf(item), item.filename, ...parts);

    function absentStatus(item) {
        return isLogged(item.filename) ? MANAGED_STATUS.DELETED : MANAGED_STATUS.NOT_INSTALLED;
    }

    /**
     * Reads the state of a sprite folder: its files compared one by one. A folder that is not there has every file
     * missing.
     * @returns {{ folder: 'missing' | 'unsafe' | 'directory', states: { entry: ManagedFile, state: string }[] }}
     */
    function readSpriteStates(item) {
        const folderPath = userPath(item);
        let stats;
        try {
            stats = fs.lstatSync(folderPath);
        } catch (error) {
            const missing = error.code === 'ENOENT';
            return { folder: missing ? 'missing' : 'unsafe', states: missing ? item.files.map(entry => ({ entry, state: 'missing' })) : [] };
        }
        if (!stats.isDirectory()) {
            return { folder: 'unsafe', states: [] };
        }
        return { folder: 'directory', states: item.files.map(entry => ({ entry, state: compareSpriteFile(entry, readUserFile(userPath(item, entry.name))) })) };
    }

    /**
     * @param {ManagedItem} item
     * @param {string[]} worldNames The names of the worlds of the manifest, without the extension.
     * @returns {{ status: string, installedVersion?: number | null, unsafe?: boolean }}
     */
    function inspect(item, worldNames) {
        try {
            if (item.type === ITEM_TYPES.SPRITES) {
                const { folder, states } = readSpriteStates(item);
                if (folder === 'unsafe') {
                    return { status: MANAGED_STATUS.MODIFIED, unsafe: true };
                }
                return { status: folder === 'missing' ? absentStatus(item) : aggregateSpriteStates(states.map(({ state }) => state)) };
            }
            const file = readUserFile(userPath(item));
            if (file.kind === 'missing') {
                return { status: absentStatus(item) };
            }
            return item.type === ITEM_TYPES.CARD ? inspectCard(item, file, worldNames) : inspectWorld(item, file);
        } catch (error) {
            if (error instanceof ManagedContentError && error.code === 'unsafe_target') {
                return { status: MANAGED_STATUS.MODIFIED, unsafe: true };
            }
            throw error;
        }
    }

    function describe(item, worldNames) {
        const { status, installedVersion, unsafe } = inspect(item, worldNames);
        // A card that cannot be read through is never offered an update, because applying it is refused.
        const behind = item.type === ITEM_TYPES.CARD && status === MANAGED_STATUS.MODIFIED && !unsafe && (installedVersion ?? 0) < item.version;
        return {
            filename: item.filename,
            type: item.type,
            version: item.version,
            status,
            updateAvailable: status === MANAGED_STATUS.UPDATED || behind,
            ...(item.type === ITEM_TYPES.CARD ? { installedVersion } : {}),
        };
    }

    function readBundled(...parts) {
        try {
            return fs.readFileSync(path.join(bundledDirectory, ...parts));
        } catch (error) {
            throw new ManagedContentError('bundled_missing', `The bundled file ${parts.join('/')} could not be read.`, error);
        }
    }

    const writeManaged = (item, target, buffer) => writeInside(folderOf(item), target, buffer, setPermissions);

    /** Copies files of the user into `backups/managed` under a name that ends in the time, without replacing a backup. */
    function createBackups() {
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        const root = path.join(directories.backups, BACKUP_FOLDER);

        function copyUnique(source, directory, name, extension, firstNumber = 1) {
            for (let attempt = firstNumber; attempt < firstNumber + MAX_BACKUP_NAME_ATTEMPTS; attempt++) {
                const target = resolveInside(directory, `${name}${attempt === 1 ? '' : `-${attempt}`}${extension}`);
                try {
                    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
                    return path.basename(target);
                } catch (error) {
                    if (error.code !== 'EEXIST') {
                        throw error;
                    }
                }
            }
            throw new Error(`No free backup name for ${name}.`);
        }

        /** The backup has been made; failing to remove old ones must not undo that. */
        function prune(description, options) {
            try {
                pruneBackups(root, options);
            } catch (error) {
                console.warn(`Old backups of ${description} could not be removed`, error);
            }
        }

        return {
            /** @returns {string} The name of the backup file. */
            file(source, filename) {
                const { name, ext } = path.parse(filename);
                const base = sanitize(name) || 'item';
                let backup;
                try {
                    fs.mkdirSync(root, { recursive: true });
                    const firstNumber = nextBackupNumber(root, { base, extension: ext, kind: 'file' }, stamp);
                    backup = copyUnique(source, root, `${base}-${stamp}`, ext, firstNumber);
                } catch (error) {
                    throw new ManagedContentError('backup_failed', `${filename} could not be backed up.`, error);
                }
                prune(filename, { base, extension: ext, kind: 'file' });
                return backup;
            },
            /** @returns {string} The name of the folder that holds the backups of the set. */
            spriteFile(source, folderName, fileName) {
                const base = sanitize(folderName) || 'sprites';
                const folder = `${base}-${stamp}`;
                try {
                    fs.mkdirSync(resolveInside(root, folder), { recursive: true });
                    const { name, ext } = path.parse(fileName);
                    copyUnique(source, path.join(root, folder), sanitize(name) || 'file', ext);
                } catch (error) {
                    throw new ManagedContentError('backup_failed', `${folderName}/${fileName} could not be backed up.`, error);
                }
                prune(folderName, { base, extension: '', kind: 'folder' });
                return folder;
            },
        };
    }

    /**
     * Writes the bundled file in place of the user's, after keeping the user's as a backup.
     * @param {ManagedItem} item
     * @param {ReturnType<typeof createBackups> | null} backups
     * @param {(bundled: Buffer, user: Buffer | null) => Buffer} [build] Makes the file to write; the bundled file by default.
     * @returns {string | null} The name of the backup, when the user had a file.
     */
    function replaceFile(item, backups, build = bundled => bundled) {
        const target = userPath(item);
        const user = readUserFile(target);
        if (user.kind === 'unsafe') {
            throw new ManagedContentError('unsafe_target', `${item.filename} is not a plain file.`);
        }
        const content = build(readBundled(item.filename), user.kind === 'file' ? user.buffer : null);
        const backup = backups && user.kind === 'file' ? backups.file(target, item.filename) : null;
        writeManaged(item, target, content);
        if (item.type === ITEM_TYPES.CARD) {
            dropThumbnails(item.filename);
        }
        return backup;
    }

    /** The thumbnail route never checks a cached file against the card, so a card that was written must lose its own. */
    function dropThumbnails(filename) {
        try {
            invalidateThumbnail?.(filename);
        } catch (error) {
            console.warn(`The cached thumbnails of managed content ${filename} could not be dropped`, error);
        }
    }

    /**
     * Drops the thumbnails that are older than the card file, which is how a card that an earlier version replaced
     * still shows its old picture. The same comparison as the thumbnail module makes when it generates one.
     * @param {ManagedItem[]} items
     * @param {Set<string>} written The cards that were just written, whose thumbnails are already dropped.
     */
    function dropStaleThumbnails(items, written) {
        if (!invalidateThumbnail) {
            return;
        }
        for (const item of items) {
            if (item.type !== ITEM_TYPES.CARD || written.has(item.filename)) {
                continue;
            }
            try {
                const card = fs.lstatSync(userPath(item));
                const stale = card.isFile() && [directories.thumbnailsAvatar, directories.thumbnailsAvatarMobile].some((folder) => {
                    try {
                        return folder && card.mtimeMs > fs.statSync(path.join(folder, item.filename)).ctimeMs;
                    } catch {
                        return false;
                    }
                });
                if (stale) {
                    dropThumbnails(item.filename);
                }
            } catch {
                // A card that is not there or not a plain file has no thumbnail worth dropping.
            }
        }
    }

    /**
     * Adds the sprite files that are missing and replaces those of an earlier release; with `replaceAll`, every file
     * that is not the bundled one, which is what a restore does. A file the user changed is left alone otherwise.
     */
    function updateSprites(item, backups, { replaceAll = false } = {}) {
        const { folder, states } = readSpriteStates(item);
        if (folder === 'unsafe' || (replaceAll && states.some(({ state }) => state === 'unsafe'))) {
            throw new ManagedContentError('unsafe_target', `${item.filename} is not a plain folder of files.`);
        }
        let backup = null;
        for (const { entry, state } of states) {
            const replace = state === 'missing' || state === 'earlier' || (replaceAll && state === 'modified');
            if (!replace) {
                continue;
            }
            const bundled = readBundled(item.filename, entry.name);
            const target = userPath(item, entry.name);
            if (backups && state !== 'missing') {
                backup = backups.spriteFile(target, item.filename, entry.name);
            }
            writeManaged(item, target, bundled);
        }
        return backup;
    }

    function bringUp(item, backups) {
        switch (item.type) {
            case ITEM_TYPES.CARD: return replaceFile(item, backups, mergeCardFiles);
            case ITEM_TYPES.WORLD: return replaceFile(item, backups);
            default: return updateSprites(item, backups);
        }
    }

    /** Whether `reconcile` has something to do for the item: sprites are updated file by file, even beside an edited one. */
    function needsUpdate(item, worldNames) {
        if (item.type !== ITEM_TYPES.SPRITES) {
            return inspect(item, worldNames).status === MANAGED_STATUS.UPDATED;
        }
        const { folder, states } = readSpriteStates(item);
        return folder === 'directory' && states.some(({ state }) => state === 'missing' || state === 'earlier');
    }

    /** @returns {{ item: ManagedItem, worldNames: string[] }} */
    function findItem(filename) {
        const items = loadItems();
        const item = typeof filename === 'string' ? items.find(candidate => candidate.filename === filename) : undefined;
        if (!item) {
            throw new ManagedContentError('unknown_item', 'That item is not managed.');
        }
        return { item, worldNames: worldNamesOf(items) };
    }

    /**
     * The identity of a file for a cache: its kind, size, inode and both times, or why there is none. The inode and the
     * change time are there because an atomic write puts a new inode in place, and a copy that keeps modification times
     * (`cp -p`, `rsync -t`, a restored backup) cannot keep the change time.
     */
    function describeFile(target) {
        try {
            const stats = fs.lstatSync(target);
            const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
            return `${kind}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
        } catch (error) {
            return error?.code === 'ENOENT' ? 'absent' : `error:${error?.code ?? 'unknown'}`;
        }
    }

    return {
        /**
         * A text that changes whenever the files `status` reads change, made from what the file system says about them,
         * so a caller can keep the last status until it differs. It reads the manifest but no file of the user.
         * @returns {string}
         */
        stateSignature() {
            let items;
            try {
                items = readItems();
            } catch {
                items = [];
            }
            const describePath = (item, ...parts) => {
                try {
                    return describeFile(userPath(item, ...parts));
                } catch {
                    return 'unsafe';
                }
            };
            const parts = [describeFile(path.join(bundledDirectory, MANIFEST_FILE_NAME)), describeFile(path.join(directories.root, 'content.log'))];
            for (const item of items) {
                if (item.type !== ITEM_TYPES.SPRITES) {
                    parts.push(describePath(item));
                    continue;
                }
                // The folder itself changes when a file nobody manages is added to it, so only its kind counts.
                parts.push(describePath(item).split(':')[0]);
                item.files.forEach(entry => parts.push(describePath(item, entry.name)));
            }
            return parts.join('|');
        },

        /** @returns {ManagedStatus[]} */
        status() {
            const items = loadItems();
            const worldNames = worldNamesOf(items);
            return items.map(item => describe(item, worldNames));
        },

        /**
         * Brings every item that nobody edited up to date. An item that is modified, deleted or not installed is left
         * as it is. A world is backed up before it is replaced; see the rules above. One item that fails does not
         * stop the others.
         * @returns {string[]} The filenames that were updated.
         */
        reconcile() {
            const updated = [];
            const items = loadItems();
            const worldNames = worldNamesOf(items);
            for (const item of items) {
                try {
                    if (!needsUpdate(item, worldNames)) {
                        continue;
                    }
                    bringUp(item, item.type === ITEM_TYPES.WORLD ? createBackups() : null);
                    updated.push(item.filename);
                    console.info(`Managed content ${item.filename} updated to version ${item.version}`);
                } catch (error) {
                    console.warn(`Failed to update managed content ${item.filename}`, error);
                }
            }
            dropStaleThumbnails(items, new Set(updated));
            return updated;
        },

        /**
         * Updates one item and keeps the user's file as a backup first. A card the user edited is updated with its
         * personal fields kept. A sprite set or world the user edited is not applicable: only restore replaces it.
         * @param {string} filename
         * @returns {{ backup: string | null }} The name of the backup, when the user had a file.
         * @throws {ManagedContentError}
         */
        apply(filename) {
            const { item, worldNames } = findItem(filename);
            const { status } = inspect(item, worldNames);
            if (status === MANAGED_STATUS.CURRENT) {
                throw new ManagedContentError('already_current', `${filename} is already up to date.`);
            }
            const editedCard = status === MANAGED_STATUS.MODIFIED && item.type === ITEM_TYPES.CARD;
            if (status !== MANAGED_STATUS.UPDATED && !editedCard) {
                throw new ManagedContentError('not_applicable', `${filename} cannot be updated; it is ${status}.`);
            }
            return { backup: bringUp(item, createBackups()) };
        },

        /**
         * Puts the bundled copy of an item back, whole. What the user has there is kept as a backup first.
         * @param {string} filename
         * @returns {{ backup: string | null }} The name of the backup, when the user had a file.
         * @throws {ManagedContentError}
         */
        restore(filename) {
            const { item, worldNames } = findItem(filename);
            if (inspect(item, worldNames).status === MANAGED_STATUS.CURRENT) {
                throw new ManagedContentError('already_current', `${filename} is already up to date.`);
            }
            const backups = createBackups();
            return { backup: item.type === ITEM_TYPES.SPRITES ? updateSprites(item, backups, { replaceAll: true }) : replaceFile(item, backups) };
        },
    };
}

/**
 * Updates the managed content of one user that nobody edited. It runs in the seeding pass of every start, so a
 * failure is logged and never stops the start.
 * @param {Parameters<typeof createManagedContent>[0]} options
 * @returns {string[]} The filenames that were updated.
 */
export function reconcileManagedContent(options) {
    try {
        return createManagedContent(options).reconcile();
    } catch (error) {
        console.warn('Failed to reconcile managed content', error);
        return [];
    }
}
