const QUICK_IMAGE_GEN_KEY = 'quick-image-gen';

/**
 * Settings that an extension opens a dialog for on a new account would stack under the welcome dialog, where its
 * buttons cannot be pressed. Quick Image Gen opens its setup wizard whenever its saved settings are missing or empty.
 * The seed marks the wizard as seen. The wizard stays reachable from its own button.
 *
 * The extension treats any non-empty saved object as an existing install and then skips its starter presets
 * unless `starterPresetsSeeded` is named, so the seed names it as `false`.
 * @param {Record<string, any> | undefined} extensionSettings The `extension_settings` of the loaded settings.
 * @returns {Record<string, any>} A new object. The argument is not changed.
 */
export function seedQuickImageGenFirstRun(extensionSettings) {
    const saved = extensionSettings?.[QUICK_IMAGE_GEN_KEY];
    const isAbsentOrEmpty = saved == null || (typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length === 0);
    if (!isAbsentOrEmpty) {
        return /** @type {Record<string, any>} */ (extensionSettings);
    }
    return { ...extensionSettings, [QUICK_IMAGE_GEN_KEY]: { setupWizardSeen: true, starterPresetsSeeded: false } };
}
