import { main_api, online_status } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { waitUntilCondition } from '../../../utils.js';

const extensionName = 'guided-generations';
const NONE_PROFILE = '<None>';

function debugLog(...args) {
    if (extension_settings[extensionName]?.debugMode) {
        console.log(`[${extensionName}][DEBUG]`, ...args);
    }
}

function debugWarn(...args) {
    if (extension_settings[extensionName]?.debugMode) {
        console.warn(`[${extensionName}][DEBUG]`, ...args);
    }
}

function normalizeApiType(apiType = '') {
    const value = String(apiType || main_api).trim();
    const mappedApi = getContext()?.CONNECT_API_MAP?.[value]?.selected ?? value;

    if (mappedApi === 'koboldhorde') {
        return 'kobold';
    }

    return mappedApi === 'chatcompletion' ? 'openai' : mappedApi;
}

function quoteSlashArg(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function getConnectionManagerSettings() {
    return extension_settings.connectionManager ?? getContext()?.extensionSettings?.connectionManager ?? {};
}

function getProfileByName(profileName) {
    const profiles = getConnectionManagerSettings().profiles;
    if (!Array.isArray(profiles)) {
        return null;
    }

    return profiles.find(profile => profile.name === profileName) ?? null;
}

function getProfileById(profileId) {
    const profiles = getConnectionManagerSettings().profiles;
    if (!Array.isArray(profiles)) {
        return null;
    }

    return profiles.find(profile => profile.id === profileId) ?? null;
}

/**
 * Resolves a stored profile identifier to a profile object.
 * Accepts both id-based (new) and name-based (legacy) values so existing
 * settings migrate transparently without an explicit migration step. (#529)
 */
function resolveStoredProfile(storedValue) {
    if (!storedValue) {
        return null;
    }

    const byId = getProfileById(storedValue);
    if (byId) {
        return byId;
    }

    return getProfileByName(storedValue);
}

async function getCurrentProfile() {
    const settings = getConnectionManagerSettings();
    const profiles = settings.profiles;
    if (!settings.selectedProfile || !Array.isArray(profiles)) {
        return '';
    }

    return profiles.find(profile => profile.id === settings.selectedProfile)?.name ?? '';
}

async function getCurrentProfileId() {
    const settings = getConnectionManagerSettings();
    return settings.selectedProfile ?? '';
}

async function getProfileList() {
    const profiles = getConnectionManagerSettings().profiles;
    return Array.isArray(profiles)
        ? profiles.filter(profile => profile.id && profile.name).map(profile => ({ id: profile.id, name: profile.name }))
        : [];
}

async function getProfileApiType(profileIdentifier) {
    if (!profileIdentifier) {
        return normalizeApiType();
    }

    // SillyBunny: accept both profile id (new) and profile name (legacy) so
    // existing settings migrate transparently. (#529)
    const profile = getProfileById(profileIdentifier) ?? getProfileByName(profileIdentifier);
    if (!profile) {
        return normalizeApiType();
    }

    if (profile.api) {
        return normalizeApiType(profile.api);
    }

    return profile.mode === 'cc' ? 'openai' : normalizeApiType();
}

async function getPresetsForApiType(apiType) {
    const manager = getPresetManager(normalizeApiType(apiType));
    return manager?.getAllPresets?.() ?? [];
}

function getCurrentPresetName(apiType = '') {
    const manager = getPresetManager(normalizeApiType(apiType));
    return manager?.getSelectedPresetName?.() ?? '';
}

async function selectPresetByName(presetName, apiType = '') {
    if (!presetName) {
        return false;
    }

    const manager = getPresetManager(normalizeApiType(apiType));
    if (!manager) {
        debugWarn(`[${extensionName}] Preset manager not found for API type: ${apiType || main_api}`);
        return false;
    }

    const presetValue = manager.findPreset(presetName);
    if (presetValue === undefined || presetValue === null || presetValue === '') {
        debugWarn(`[${extensionName}] Preset not found: ${presetName}`);
        return false;
    }

    if (manager.getSelectedPresetName() === presetName) {
        return true;
    }

    const shouldReconnect = online_status !== 'no_connection';
    await manager.selectPreset(presetValue);
    if (shouldReconnect) {
        await waitUntilCondition(() => online_status !== 'no_connection', 10000, 100);
    }
    return manager.getSelectedPresetName() === presetName;
}

async function switchToProfile(profileName) {
    const target = profileName || NONE_PROFILE;
    const context = getContext();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        return false;
    }

    await context.executeSlashCommandsWithOptions(`/profile await=true ${quoteSlashArg(target)}`);
    return true;
}

async function handleSwitching(targetProfileId = '', targetPreset = '', originalProfileId = '') {
    const profileToRestoreId = originalProfileId || await getCurrentProfileId();
    const apiToRestore = normalizeApiType();
    const presetToRestore = getCurrentPresetName(apiToRestore);

    // Resolve ids to names for the /profile slash command which accepts names.
    const restoreProfile = getProfileById(profileToRestoreId);
    const profileToRestoreName = restoreProfile?.name ?? '';

    async function switchToTarget() {
        const targetProfile = resolveStoredProfile(targetProfileId);
        if (targetProfileId && !targetProfile) {
            throw new Error('Guided Impersonate connection profile is unavailable.');
        }
        if (targetProfile && targetProfile.id !== profileToRestoreId) {
            const targetName = targetProfile.name;
            debugLog(`[${extensionName}] Switching profile to: ${targetName}`);
            await switchToProfile(targetName);
            if (await getCurrentProfileId() !== targetProfile.id) {
                throw new Error('Guided Impersonate connection profile was not applied.');
            }
        }

        if (targetPreset) {
            const apiType = await getProfileApiType(targetProfileId || await getCurrentProfileId());
            debugLog(`[${extensionName}] Switching preset to: ${targetPreset} (${apiType})`);
            if (!await selectPresetByName(targetPreset, apiType)) {
                throw new Error('Guided Impersonate preset was not applied.');
            }
        }
    }

    async function restore() {
        try {
            const currentId = await getCurrentProfileId();
            if (targetProfileId && currentId !== profileToRestoreId) {
                debugLog(`[${extensionName}] Restoring profile to: ${profileToRestoreName || NONE_PROFILE}`);
                await switchToProfile(profileToRestoreName);
            }

            if ((targetProfileId || targetPreset) && presetToRestore) {
                debugLog(`[${extensionName}] Restoring preset to: ${presetToRestore} (${apiToRestore})`);
                await selectPresetByName(presetToRestore, apiToRestore);
            }
        } catch (error) {
            debugWarn(`[${extensionName}] Error while restoring profile or preset:`, error);
        }
    }

    return {
        switch: switchToTarget,
        restore,
        originalProfile: profileToRestoreName,
        originalPreset: presetToRestore,
    };
}

export {
    getCurrentProfile,
    getCurrentProfileId,
    getPresetsForApiType,
    getProfileApiType,
    getProfileById,
    getProfileList,
    handleSwitching,
    resolveStoredProfile,
};
