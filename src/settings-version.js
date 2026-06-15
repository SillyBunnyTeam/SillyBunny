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
