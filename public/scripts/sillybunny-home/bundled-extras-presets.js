/**
 * The presets side of Bundled Extras. A bundled preset ships in `default/content`, and the Presets panel already has
 * a restore for one preset by name: the server hands out the bundled copy, and a save writes it and retires its
 * deletion record. This adapter composes those two, so a row restores its own preset and no other.
 *
 * The bulk restore of the panel is left alone on purpose. It copies every bundled preset of the list over the file
 * of the user, edited or not.
 *
 * The preset manager comes in as a parameter, so a test can run the adapter without the app.
 * @param {object} options
 * @param {(apiId: string) => ReturnType<typeof import('../preset-manager.js').getPresetManager>} options.getManager
 * @param {string} options.apiId The preset list that holds the bundled presets.
 * @returns {import('./bundled-extras-actions.js').PresetsAdapter}
 */
export function createPresetsAdapter({ getManager, apiId }) {
    const requireManager = () => {
        const manager = getManager(apiId);
        if (!manager) {
            throw new Error(`There is no preset manager for "${apiId}".`);
        }
        return manager;
    };

    return {
        has: presetName => getManager(apiId)?.findPreset(presetName) !== undefined,
        async restore(presetName) {
            const manager = requireManager();
            // A preset of that name is the user's now, edited or not, and a restore would write over it.
            if (manager.findPreset(presetName) !== undefined) {
                throw new Error(`The preset "${presetName}" is in the list already.`);
            }
            const data = await manager.getDefaultPreset(presetName);
            if (!data?.isDefault || !data.preset || Object.keys(data.preset).length === 0) {
                throw new Error(`The preset "${presetName}" has no bundled copy to restore.`);
            }
            // The save would select the preset and so switch the one in use; the list refresh only adds it. The
            // refresh takes a file name and cuts the extension off, which would cut "(v5.2)" short without one.
            await manager.savePreset(presetName, data.preset, { skipUpdate: true });
            await manager.refreshRestoredDefaultOptions([`${presetName}.json`]);
        },
    };
}
