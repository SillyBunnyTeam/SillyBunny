import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import bytes from 'bytes';

import { SETTINGS_FILE } from '../constants.js';
import { ensureMigrated } from '../conversation-migration.js'; // SillyBunny: conversation storage
import { getSettingsVersion, isUnchangedSettingsSave, prepareSettingsSave } from '../settings-version.js';
import {
    getConfigValue,
    generateTimestamp,
    removeOldBackups,
    tryWriteFileSync,
    formatBytes,
    color,
} from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const ENABLE_REQUEST_COMPRESSION = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');
const REQUEST_COMPRESSION_MIN = bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb'));
const REQUEST_COMPRESSION_MAX = bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb'));
const REQUEST_COMPRESSION_TIMEOUT = Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number'));
const isBackupLoggingEnabled = !!getConfigValue('backups.chat.logging', false, 'boolean');

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

function logBackupEvent(action, details = {}) {
    if (!isBackupLoggingEnabled) {
        return;
    }

    const fields = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
    console.info(color.cyan(`[Backup] ${action}${fields ? ` ${fields}` : ''}`));
}

function getSettingsBackupSizeDetails(sourceFile) {
    const sizeBytes = fs.statSync(sourceFile).size;
    return {
        bytes: sizeBytes,
        size: formatBytes(sizeBytes),
    };
}

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
export function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => {
            logBackupEvent('settings-autosave-fired', { handle });
            backupUserSettings(handle, true);
        }, AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        logBackupEvent('settings-autosave-requested', { handle });
        functionToCall();
    }
}

// SillyBunny: /api/settings/get used to read and parse every preset, theme and template file on each page
// load. Directory listings are checked on each call so added and deleted files show up immediately, while
// each file's contents are reused as long as its (mtimeMs, size) is unchanged.

const SETTINGS_RESPONSE_CACHE_MAX = 16;
const DIRECTORY_CACHE_MAX = 512;
const SINGLE_FILE_CACHE_MAX = 256;

const STATIC_SETTINGS_SIGNATURE = JSON.stringify([
    ENABLE_EXTENSIONS,
    ENABLE_EXTENSIONS_AUTO_UPDATE,
    ENABLE_ACCOUNTS,
    ENABLE_REQUEST_COMPRESSION,
    REQUEST_COMPRESSION_MIN || 0,
    REQUEST_COMPRESSION_MAX || 0,
    REQUEST_COMPRESSION_TIMEOUT || 0,
]);

/**
 * @typedef {'text' | 'json-validate' | 'json-parse'} FileReadMode
 * text keeps the raw text; json-validate keeps the raw text of valid JSON; json-parse keeps the parsed value.
 */

/**
 * @typedef {object} CachedFile
 * @property {number} mtimeMs mtime when the file was read
 * @property {number} size Size when the file was read
 * @property {boolean} valid False when the contents failed to parse
 * @property {any} value Raw text or parsed JSON
 * @property {number} generation Changes whenever the cached contents change
 */

/** @type {Map<string, Map<string, CachedFile>>} Directory cache key -> file name -> entry */
const directoryFileCache = new Map();
/** @type {Map<string, CachedFile>} Single files, keyed by path */
const singleFileCache = new Map();
/** @type {Map<string, { etag: string, body: string }>} Last /get response body per user root */
const settingsResponseCache = new Map();
let fileCacheGeneration = 0;

/**
 * Inserts into a bounded Map with oldest-entry eviction.
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} maxSize
 */
function setBoundedMapEntry(map, key, value, maxSize) {
    map.delete(key);
    map.set(key, value);
    if (map.size > maxSize) {
        map.delete(map.keys().next().value);
    }
}

/**
 * Normalizes a weak or strong ETag for RFC 9110 weak comparison.
 * @param {string} tag
 * @returns {string}
 */
function normalizeWeakEtag(tag) {
    const trimmed = tag.trim();
    return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
}

/**
 * Checks whether an If-None-Match header matches the given ETag.
 * @param {string|string[]|undefined} headerValue
 * @param {string} etag
 * @returns {boolean}
 */
function matchesIfNoneMatch(headerValue, etag) {
    const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
    if (typeof raw !== 'string' || !raw.trim()) {
        return false;
    }

    const target = normalizeWeakEtag(etag);
    return raw.split(',').some(part => {
        const trimmed = part.trim();
        return trimmed === '*' || normalizeWeakEtag(trimmed) === target;
    });
}

/**
 * Returns the cached contents of a file, reading it only when its (mtimeMs, size) changed.
 * @param {Map<string, CachedFile>} cache Cache holding the entry
 * @param {string} key Cache key
 * @param {string} filePath Path to the file
 * @param {fs.Stats} stat File stat
 * @param {FileReadMode} mode How to keep the contents
 * @param {number} [maxCacheSize] Optional cache capacity bound
 * @returns {CachedFile|null} Entry, or null when the file could not be read
 */
function getCachedFile(cache, key, filePath, stat, mode, maxCacheSize = 0) {
    const cached = cache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached;
    }

    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        cache.delete(key);
        return null;
    }

    /** @type {CachedFile} */
    const entry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        valid: true,
        value: raw,
        generation: ++fileCacheGeneration,
    };

    if (mode !== 'text') {
        try {
            const parsed = JSON.parse(raw);
            if (mode === 'json-parse') {
                entry.value = parsed;
            }
        } catch {
            entry.valid = false;
            entry.value = null;
            if (mode === 'json-validate') {
                console.warn(`${path.basename(filePath)} is not a valid JSON`);
            }
        }
    }

    if (maxCacheSize > 0) {
        setBoundedMapEntry(cache, key, entry, maxCacheSize);
    } else {
        cache.set(key, entry);
    }
    return entry;
}

/**
 * Returns a fine-grained stat stamp for settings.json so migration rewrites can invalidate the cache without breaking
 * cache hits on repeat reads of an already-migrated user.
 * @param {string} filePath Path to settings.json
 * @returns {string|null}
 */
function getSettingsFileStamp(filePath) {
    try {
        const stats = fs.statSync(filePath, { bigint: true });
        return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
    } catch {
        return null;
    }
}

/**
 * Reads a user's settings.json using the (mtimeMs, size) cache.
 * @param {string} filePath Path to settings.json
 * @param {string[]} signature Receives a generation part for ETag computation
 * @returns {string} Raw settings.json text
 */
function readSettingsFile(filePath, signature) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        singleFileCache.delete(filePath);
        throw error;
    }

    const entry = getCachedFile(singleFileCache, filePath, filePath, stat, 'text', SINGLE_FILE_CACHE_MAX);
    if (!entry) {
        throw new Error(`Failed to read settings file: ${filePath}`);
    }

    signature.push(`settings\0${filePath}\0${entry.generation}`);
    return entry.value;
}

/**
 * Lists the files of a directory with the given extension and returns their cached contents.
 * @param {string} directoryPath Path to the directory
 * @param {string} fileExtension Extension to match, compared case-sensitively
 * @param {FileReadMode} mode How to keep the contents
 * @returns {{ name: string, entry: CachedFile }[]} Files in directory listing order
 */
function readCachedDirectory(directoryPath, fileExtension, mode) {
    const cacheKey = `${mode}\0${fileExtension}\0${directoryPath}`;
    let dirents;
    try {
        dirents = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            directoryFileCache.delete(cacheKey);
            return [];
        }
        throw error;
    }

    let cache = directoryFileCache.get(cacheKey);
    if (!cache) {
        cache = new Map();
        setBoundedMapEntry(directoryFileCache, cacheKey, cache, DIRECTORY_CACHE_MAX);
    }

    const seen = new Set();
    const files = [];

    for (const dirent of dirents) {
        const name = dirent.name;
        if (path.extname(name) !== fileExtension) {
            continue;
        }

        if (!dirent.isFile() && !dirent.isSymbolicLink()) {
            continue;
        }

        const filePath = path.join(directoryPath, name);
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch {
            continue;
        }

        if (!stat.isFile()) {
            continue;
        }

        const entry = getCachedFile(cache, name, filePath, stat, mode);
        if (!entry) {
            continue;
        }

        seen.add(name);
        files.push({ name, entry });
    }

    for (const name of cache.keys()) {
        if (!seen.has(name)) {
            cache.delete(name);
        }
    }

    return files;
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {string} [fileExtension] File extension
 * @param {string[]} [signature] Receives one part per file that changes whenever that file's contents change
 * @param {boolean} [cloneValues] Return fresh copies of cached parsed JSON objects so callers can mutate them safely
 * @returns {Array} Parsed files
 */
export function readAndParseFromDirectory(directoryPath, fileExtension = '.json', signature = undefined, cloneValues = true) {
    const mode = fileExtension == '.json' ? 'json-parse' : 'text';
    const files = readCachedDirectory(directoryPath, fileExtension, mode)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const parsedFiles = [];
    signature?.push(`${mode}\0${directoryPath}`);

    for (const { name, entry } of files) {
        signature?.push(`${name}\0${entry.generation}`);
        if (entry.valid) {
            parsedFiles.push(mode === 'json-parse' && cloneValues ? structuredClone(entry.value) : entry.value);
        }
    }

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

/**
 * Reads the raw text of valid JSON presets from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {object} [options]
 * @param {(a: string, b: string) => number} [options.sortFunction] File name sort function
 * @param {boolean} [options.removeFileExtension] Strip the extension from the returned names
 * @param {string} [options.fileExtension] Extension to match
 * @param {string[]} [signature] Receives one part per file that changes whenever that file's contents change
 * @returns {{ fileContents: string[], fileNames: string[] }} Preset texts and names
 */
export function readPresetsFromDirectory(directoryPath, options = {}, signature = undefined) {
    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
    } = options;

    const files = readCachedDirectory(directoryPath, fileExtension, 'json-validate')
        .sort(sortFunction ? (a, b) => sortFunction(a.name, b.name) : (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const fileContents = [];
    const fileNames = [];
    signature?.push(`json-validate\0${directoryPath}`);

    for (const { name, entry } of files) {
        signature?.push(`${name}\0${entry.generation}`);
        if (entry.valid) {
            fileContents.push(entry.value);
            fileNames.push(removeFileExtension ? name.replace(/\.[^/.]+$/, '') : name);
        }
    }

    return { fileContents, fileNames };
}

async function backupSettings() {
    try {
        const userHandles = await getAllUserHandles();

        for (const handle of userHandles) {
            backupUserSettings(handle, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings file.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {void}
 */
function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        logBackupEvent('settings-backup-skipped', { handle, reason: 'missing-user-root' });
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (preventDuplicates && isDuplicateBackup(handle, sourceFile)) {
        logBackupEvent('settings-backup-skipped', {
            handle,
            reason: 'duplicate',
            ...getSettingsBackupSizeDetails(sourceFile),
        });
        return;
    }

    if (!fs.existsSync(sourceFile)) {
        logBackupEvent('settings-backup-skipped', { handle, reason: 'missing-source' });
        return;
    }

    const sizeDetails = getSettingsBackupSizeDetails(sourceFile);
    fs.copyFileSync(sourceFile, backupFile);
    logBackupEvent('settings-backup-written', { handle, file: path.basename(backupFile), ...sizeDetails });
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate.
 * @param {string} handle User handle
 * @param {string} sourceFile Source file path
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, sourceFile) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup) {
        return false;
    }
    return areFilesEqual(latestBackup, sourceFile);
}

/**
 * Returns true if the two files are equal.
 * @param {string} file1 File path
 * @param {string} file2 File path
 */
export function areFilesEqual(file1, file2) {
    // SillyBunny: compare sizes first and bytes after, instead of decoding both files to strings.
    let stat1, stat2;
    try {
        stat1 = fs.statSync(file1);
        stat2 = fs.statSync(file2);
    } catch {
        return false;
    }

    if (!stat1.isFile() || !stat2.isFile() || stat1.size !== stat2.size) {
        return false;
    }

    return fs.readFileSync(file1).equals(fs.readFileSync(file2));
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: fs.statSync(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

router.post('/save', function (request, response) {
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);

        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
            return response.status(400).send({ error: 'invalid_settings' });
        }

        const settingsExist = fs.existsSync(pathToSettings);
        const currentSettings = settingsExist
            ? JSON.parse(fs.readFileSync(pathToSettings, 'utf8'))
            : {};

        // SillyBunny: every boot saves the settings without a change. Such a save keeps the version, so it does not
        // make the other open tabs and devices stale, and a stale page that sends the stored settings gets the version.
        if (settingsExist && isUnchangedSettingsSave(request.body, currentSettings)) {
            return response.send({ result: 'ok', version: getSettingsVersion(currentSettings), unchanged: true });
        }

        // SillyBunny: prevent one open device or tab from overwriting newer settings from another.
        const preparedSave = prepareSettingsSave(request.body, currentSettings);
        if (!preparedSave.ok) {
            return response.status(409).send({
                error: 'settings_conflict',
                version: preparedSave.currentVersion,
            });
        }

        tryWriteFileSync(pathToSettings, JSON.stringify(preparedSave.settings, null, 4));
        // SillyBunny: invalidate cached settings.json and /get response after a write.
        singleFileCache.delete(pathToSettings);
        settingsResponseCache.delete(request.user.directories.root);
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok', version: preparedSave.version });
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: 'settings_save_failed' });
    }
});

// Wintermute's code
router.post('/get', (request, response) => {
    const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
    // SillyBunny: the conversations are moved out of settings.json before it is read, so the page's first settings save is not refused for an old version.
    try {
        const beforeMigrationStamp = getSettingsFileStamp(pathToSettings);
        const migration = ensureMigrated(request.user);
        if (migration?.state === 'migrated' && getSettingsFileStamp(pathToSettings) !== beforeMigrationStamp) {
            singleFileCache.delete(pathToSettings);
            settingsResponseCache.delete(request.user.directories.root);
        }
    } catch (error) {
        console.error('The conversation migration could not be checked:', error);
    }

    // SillyBunny: the response carries an ETag built from what each file's contents were when read, and
    // repeat calls with nothing changed reuse the last serialized body. A caller that sends If-None-Match
    // with the last ETag gets 304 and no body.
    const signature = [STATIC_SETTINGS_SIGNATURE];
    let settings;
    try {
        settings = readSettingsFile(pathToSettings, signature);
    } catch (e) {
        return response.sendStatus(500);
    }

    // NovelAI Settings
    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = readPresetsFromDirectory(request.user.directories.novelAI_Settings, {
            sortFunction: sortByName(request.user.directories.novelAI_Settings),
            removeFileExtension: true,
        }, signature);

    // OpenAI Settings
    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = readPresetsFromDirectory(request.user.directories.openAI_Settings, {
            sortFunction: sortByName(request.user.directories.openAI_Settings), removeFileExtension: true,
        }, signature);

    // TextGenerationWebUI Settings
    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = readPresetsFromDirectory(request.user.directories.textGen_Settings, {
            sortFunction: sortByName(request.user.directories.textGen_Settings), removeFileExtension: true,
        }, signature);

    //Kobold
    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = readPresetsFromDirectory(request.user.directories.koboldAI_Settings, {
            sortFunction: sortByName(request.user.directories.koboldAI_Settings), removeFileExtension: true,
        }, signature);

    const worldFiles = fs
        .readdirSync(request.user.directories.worlds)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));
    const world_names = worldFiles.map(item => path.parse(item).name);
    signature.push(`worlds\0${request.user.directories.worlds}`, ...worldFiles);

    const themes = readAndParseFromDirectory(request.user.directories.themes, '.json', signature, false);
    const movingUIPresets = readAndParseFromDirectory(request.user.directories.movingUI, '.json', signature, false);
    const quickReplyPresets = readAndParseFromDirectory(request.user.directories.quickreplies, '.json', signature, false);

    const instruct = readAndParseFromDirectory(request.user.directories.instruct, '.json', signature, false);
    const context = readAndParseFromDirectory(request.user.directories.context, '.json', signature, false);
    const sysprompt = readAndParseFromDirectory(request.user.directories.sysprompt, '.json', signature, false);
    const reasoning = readAndParseFromDirectory(request.user.directories.reasoning, '.json', signature, false);
    const inChatAgents = readAndParseFromDirectory(request.user.directories.inChatAgents, '.json', signature, false);

    const etag = `W/"${crypto.createHash('sha1').update(JSON.stringify(signature)).digest('base64url')}"`;
    response.set('ETag', etag);

    if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
        return response.status(304).end();
    }

    const cacheKey = request.user.directories.root;
    const cachedResponse = settingsResponseCache.get(cacheKey);
    if (cachedResponse?.etag === etag) {
        return response.type('json').send(cachedResponse.body);
    }

    const body = JSON.stringify({
        settings,
        koboldai_settings,
        koboldai_setting_names,
        world_names,
        novelai_settings,
        novelai_setting_names,
        openai_settings,
        openai_setting_names,
        textgenerationwebui_presets,
        textgenerationwebui_preset_names,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
        inChatAgents,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
        request_compression: {
            enabled: ENABLE_REQUEST_COMPRESSION,
            minPayloadSize: REQUEST_COMPRESSION_MIN || 0,
            maxPayloadSize: REQUEST_COMPRESSION_MAX || 0,
            timeout: REQUEST_COMPRESSION_TIMEOUT || 0,
        },
    });

    setBoundedMapEntry(settingsResponseCache, cacheKey, { etag, body }, SETTINGS_RESPONSE_CACHE_MAX);

    response.type('json').send(body);
});

router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = fs.readdirSync(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = fs.statSync(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = fs.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/make-snapshot', async (request, response) => {
    try {
        backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        fs.rmSync(pathToSettings, { force: true });
        fs.copyFileSync(snapshotPath, pathToSettings);
        // SillyBunny: invalidate cached settings.json and /get response after restoring a snapshot.
        singleFileCache.delete(pathToSettings);
        settingsResponseCache.delete(request.user.directories.root);

        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
export async function init() {
    await backupSettings();
}
