/**
 * Conversation Mode REST API - Store Management
 *
 * Functions for reading, writing, and normalizing the Conversation Mode store.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_FILE } from '../constants.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { tryWriteFileSync } from '../util.js';
import { CONVERSATION_STORE_KEY } from '../../public/scripts/sillybunny-conversation/constants.js';
import {
    getObject,
    getOwnRecord,
    getSafeRecord,
    hasOwn,
    isObject,
    parsePositiveInt,
    scopeConversationStorageKey,
    validateConversationStoragePart,
    validateStoreStructure,
} from './conversation-utils.js';

/**
 * Read JSON file with error handling
 * Returns { ok, data, missing?, error? }
 */
export function readJsonFile(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) {
            return { ok: true, data: fallback, missing: true };
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        return { ok: true, data, missing: false };
    } catch (error) {
        console.error(`Failed to read or parse JSON file ${filePath}:`, error.message);
        return { ok: false, error: error.message, missing: false };
    }
}

/**
 * Get the path to the user's settings.json file
 */
export function getSettingsPath(request) {
    return path.join(request.user.directories.root, SETTINGS_FILE);
}

/**
 * Read user settings (returns data only, no error handling)
 */
export function readUserSettings(request) {
    const result = readUserSettingsWithStatus(request);
    if (!result.ok) {
        throw new Error(result.error || 'Failed to read settings');
    }
    return result.data;
}

/**
 * Read user settings with status (returns { ok, data, error? })
 */
export function readUserSettingsWithStatus(request) {
    const result = readJsonFile(getSettingsPath(request), {});
    if (!result.ok) {
        return result;
    }
    if (!isObject(result.data)) {
        return { ok: false, error: 'Settings must contain a JSON object', missing: false };
    }
    if (hasOwn(result.data, 'extension_settings') && !isObject(result.data.extension_settings)) {
        return { ok: false, error: 'Settings extension_settings must contain a JSON object', missing: false };
    }
    if (isObject(result.data.extension_settings)
        && hasOwn(result.data.extension_settings, CONVERSATION_STORE_KEY)
        && !isObject(result.data.extension_settings[CONVERSATION_STORE_KEY])) {
        return { ok: false, error: 'Conversation settings must contain a JSON object', missing: false };
    }
    if (isObject(result.data.extension_settings) && hasOwn(result.data.extension_settings, CONVERSATION_STORE_KEY)) {
        const storeValidation = validateStoreStructure(result.data.extension_settings[CONVERSATION_STORE_KEY]);
        if (!storeValidation.valid) {
            return { ok: false, error: storeValidation.error, missing: false };
        }
    }
    return result;
}

/**
 * Ensure Conversation Mode store exists and is normalized
 * Mutates settings.extension_settings in place
 */
export function ensureConversationStore(settings, normalizeConversationGroupRecord) {
    settings.extension_settings = { ...getObject(settings.extension_settings) };

    const current = hasOwn(settings.extension_settings, CONVERSATION_STORE_KEY)
        ? getObject(settings.extension_settings[CONVERSATION_STORE_KEY])
        : {};
    const store = getOwnRecord(current);
    store.version = parsePositiveInt(current.version, 1, 1);
    store.localStorageMigrated = Boolean(current.localStorageMigrated);
    store.settings = getObject(current.settings);
    store.characters = getSafeRecord(current.characters);
    store.groups = Array.isArray(current.groups) ? current.groups.map(normalizeConversationGroupRecord).filter(Boolean) : [];
    store.legacyThreadPersonaAssignments = getSafeRecord(current.legacyThreadPersonaAssignments);
    store.reminders = Array.isArray(current.reminders) ? current.reminders : [];

    settings.extension_settings[CONVERSATION_STORE_KEY] = store;
    return store;
}

/**
 * Validate an expected settings version supplied by a mutation.
 */
export function validateExpectedSettingsVersion(version) {
    return Number.isSafeInteger(version) && version >= 0
        ? { valid: true, version }
        : { valid: false, error: version === undefined ? 'version_required' : 'invalid_version' };
}

/**
 * Read and preflight settings before an expensive mutation.
 */
export function readConversationStoreForWrite(request, expectedVersion, normalizeConversationGroupRecord) {
    const versionValidation = validateExpectedSettingsVersion(expectedVersion);
    if (!versionValidation.valid) {
        return { ok: false, status: 400, body: { error: versionValidation.error } };
    }

    const settingsResult = readUserSettingsWithStatus(request);
    if (!settingsResult.ok) {
        return { ok: false, status: 500, body: { error: 'settings_read_failed' } };
    }
    const currentVersion = getSettingsVersion(settingsResult.data);
    if (currentVersion !== versionValidation.version) {
        return {
            ok: false,
            status: 409,
            body: { error: 'settings_conflict', version: currentVersion },
        };
    }

    return {
        ok: true,
        settings: settingsResult.data,
        store: ensureConversationStore(settingsResult.data, normalizeConversationGroupRecord),
        version: currentVersion,
        missing: settingsResult.missing,
    };
}

/**
 * Save Conversation Mode store to disk with version conflict detection
 * Returns { ok, version?, settings?, store?, status?, body? }
 */
export function saveConversationStore(request, store, version) {
    const versionValidation = validateExpectedSettingsVersion(version);
    if (!versionValidation.valid) {
        return { ok: false, status: 400, body: { error: versionValidation.error } };
    }

    const latestResult = readUserSettingsWithStatus(request);
    if (!latestResult.ok) {
        return { ok: false, status: 500, body: { error: 'settings_read_failed' } };
    }
    const latestSettings = latestResult.data;
    const latestVersion = getSettingsVersion(latestSettings);
    if (latestVersion !== versionValidation.version) {
        return {
            ok: false,
            status: 409,
            body: { error: 'settings_conflict', version: latestVersion },
        };
    }

    const incomingSettings = {
        ...latestSettings,
        extension_settings: {
            ...getObject(latestSettings.extension_settings),
            [CONVERSATION_STORE_KEY]: store,
        },
        _version: versionValidation.version,
    };
    const preparedSave = prepareSettingsSave(incomingSettings, latestSettings);
    if (!preparedSave.ok) {
        return {
            ok: false,
            status: 409,
            body: {
                error: 'settings_conflict',
                version: preparedSave.currentVersion,
            },
        };
    }

    try {
        tryWriteFileSync(getSettingsPath(request), JSON.stringify(preparedSave.settings, null, 4));
    } catch (error) {
        console.error('Conversation REST API: failed to save settings', error);
        return { ok: false, status: 500, body: { error: 'settings_save_failed' } };
    }
    return {
        ok: true,
        version: preparedSave.version,
        settings: preparedSave.settings,
        store: preparedSave.settings.extension_settings[CONVERSATION_STORE_KEY],
    };
}

/**
 * Build a thread storage key from avatar, groupId, and personaId
 */
export function getConversationThreadKey(avatar, groupId = '', personaId = '') {
    const safeAvatar = String(avatar || '').trim();
    const safeGroupId = String(groupId || '').trim();
    const avatarValidation = validateConversationStoragePart(safeAvatar, { required: true, allowColon: false });
    const groupValidation = validateConversationStoragePart(safeGroupId, { allowColon: false });
    const personaValidation = validateConversationStoragePart(personaId);
    if (!avatarValidation.valid || !groupValidation.valid || !personaValidation.valid) {
        return '';
    }

    const GROUP_CONVERSATION_STORE_PREFIX = 'group:';
    const threadKey = groupValidation.value
        ? `${GROUP_CONVERSATION_STORE_PREFIX}${groupValidation.value}:${avatarValidation.value}`
        : avatarValidation.value;
    return scopeConversationStorageKey(threadKey, personaValidation.value);
}

/**
 * Send standard save result response
 */
export function respondSaveResult(response, saveResult, successBody) {
    if (saveResult.ok) {
        return response.send({
            ...successBody,
            version: saveResult.version,
        });
    }

    return response.status(saveResult.status || 500).send(saveResult.body || { error: 'save_failed' });
}
