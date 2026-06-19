import { eventSource, event_types, main_api } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';

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
    const value = String(apiType || '').trim();
    if (!value) {
        return main_api === 'koboldhorde' ? 'kobold' : main_api;
    }

    if (value === 'koboldhorde') {
        return 'kobold';
    }

    return value;
}

function quoteSlashArg(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function makeCommandArg(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ');
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
        const apiKey = String(profile.api);
        if (apiKey === 'chatcompletion') {
            return 'openai';
        }

        return normalizeApiType(apiKey);
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

    await manager.selectPreset(presetValue);
    return true;
}

async function switchToProfile(profileName) {
    const target = profileName || NONE_PROFILE;
    const context = getContext();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        return false;
    }

    const loaded = new Promise(resolve => {
        eventSource.once(event_types.CONNECTION_PROFILE_LOADED, resolve);
    });
    await context.executeSlashCommandsWithOptions(`/profile await=true ${quoteSlashArg(target)}`);
    await Promise.race([
        loaded,
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
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
        if (targetProfileId && targetProfileId !== profileToRestoreId) {
            const targetProfile = getProfileById(targetProfileId);
            const targetName = targetProfile?.name ?? targetProfileId;
            debugLog(`[${extensionName}] Switching profile to: ${targetName}`);
            await switchToProfile(targetName);
        }

        if (targetPreset) {
            const apiType = await getProfileApiType(targetProfileId || await getCurrentProfileId());
            debugLog(`[${extensionName}] Switching preset to: ${targetPreset} (${apiType})`);
            if (targetProfileId && targetPreset) {
                await getContext().executeSlashCommandsWithOptions(`/preset ${makeCommandArg(targetPreset)}`);
            } else {
                await selectPresetByName(targetPreset, apiType);
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

            if (targetPreset && presetToRestore) {
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
