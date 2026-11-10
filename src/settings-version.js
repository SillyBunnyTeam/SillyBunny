import { isDeepStrictEqual } from 'node:util';

/**
 * Checks whether a save would write the settings that are stored already. The version is not compared.
 * @param {object} incomingSettings Settings that the client sent
 * @param {object} currentSettings Settings on disk
 * @returns {boolean}
 */
export function isUnchangedSettingsSave(incomingSettings, currentSettings) {
    const withoutVersion = settings => {
        const copy = { ...settings };
        delete copy._version;
        return copy;
    };
    return isDeepStrictEqual(withoutVersion(incomingSettings), withoutVersion(currentSettings));
}

export function getSettingsVersion(settings) {
    const version = Number(settings?._version);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

export function prepareSettingsSave(incomingSettings, currentSettings = {}) {
    const incomingVersion = getSettingsVersion(incomingSettings);
    const currentVersion = getSettingsVersion(currentSettings);

    if (incomingVersion !== currentVersion) {
        return {
            ok: false,
            currentVersion,
        };
    }

    const version = currentVersion + 1;
    return {
        ok: true,
        version,
        settings: {
            ...incomingSettings,
            _version: version,
        },
    };
}
