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
import { getObject, parsePositiveInt, scopeConversationStorageKey } from './conversation-utils.js';

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
        return { ok: false, error: error.message, data: fallback };
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
    const result = readJsonFile(getSettingsPath(request), {});
    return result.data;
}

/**
 * Read user settings with status (returns { ok, data, error? })
 */
export function readUserSettingsWithStatus(request) {
    return readJsonFile(getSettingsPath(request), {});
}

/**
 * Ensure Conversation Mode store exists and is normalized
 * Mutates settings.extension_settings in place
 */
export function ensureConversationStore(settings, normalizeConversationGroupRecord) {
    settings.extension_settings = getObject(settings.extension_settings);

    const current = getObject(settings.extension_settings[CONVERSATION_STORE_KEY]);
    const store = {
        ...current,
        version: parsePositiveInt(current.version, 1, 1),
        localStorageMigrated: Boolean(current.localStorageMigrated),
        settings: getObject(current.settings),
        characters: getObject(current.characters),
        groups: Array.isArray(current.groups) ? current.groups.map(normalizeConversationGroupRecord).filter(Boolean) : [],
        reminders: Array.isArray(current.reminders) ? current.reminders : [],
    };

    settings.extension_settings[CONVERSATION_STORE_KEY] = store;
    return store;
}

/**
 * Save Conversation Mode store to disk with version conflict detection
 * Returns { ok, version?, settings?, store?, status?, body? }
 */
export function saveConversationStore(request, currentSettings, store, version = undefined) {
    const incomingVersion = version === undefined
        ? getSettingsVersion(currentSettings)
        : getSettingsVersion({ _version: version });
    const incomingSettings = {
        ...currentSettings,
        extension_settings: {
            ...getObject(currentSettings.extension_settings),
            [CONVERSATION_STORE_KEY]: store,
        },
        _version: incomingVersion,
    };
    const preparedSave = prepareSettingsSave(incomingSettings, currentSettings);
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

    tryWriteFileSync(getSettingsPath(request), JSON.stringify(preparedSave.settings, null, 4));
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
    if (!safeAvatar) {
        return '';
    }

    const GROUP_CONVERSATION_STORE_PREFIX = 'group:';
    const threadKey = safeGroupId ? `${GROUP_CONVERSATION_STORE_PREFIX}${safeGroupId}:${safeAvatar}` : safeAvatar;
    return scopeConversationStorageKey(threadKey, personaId);
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
