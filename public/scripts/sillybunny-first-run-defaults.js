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

/**
 * Shows the Welcome dialog in place of the onboarding popup of upstream, and resolves once the persona has a name.
 * The first run is decided before the dialog loads, so a dialog that cannot load leaves nothing for APP_READY to
 * open and the caller falls back to the popup. Only the loading is guarded: a failure after the dialog has opened
 * must not stack the popup on top of it.
 * @param {string} avatarId The avatar of the persona to name.
 * @returns {Promise<boolean>} Whether Welcome handled the first run.
 */
export async function showFirstRunWelcome(avatarId) {
    const boot = await importWelcomeModule(() => import('./sillybunny-home/welcome-boot.js'));
    if (!boot) {
        return false;
    }
    if (!boot.getWelcomeStartup().decide({ firstRun: true }).open) {
        return true;
    }
    const welcome = await importWelcomeModule(() => import('./sillybunny-welcome.js'));
    if (!welcome) {
        return false;
    }
    await welcome.runFirstRunWelcome(avatarId);
    return true;
}

/**
 * @template T
 * @param {() => Promise<T>} load
 * @returns {Promise<T | null>} The module, or null after the failure is logged.
 */
async function importWelcomeModule(load) {
    try {
        return await load();
    } catch (error) {
        console.error('The Welcome dialog failed on the first run, so the onboarding popup takes over.', error);
        return null;
    }
}
