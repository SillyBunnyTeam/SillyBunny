import { getExtensionFolderName } from '../sillybunny-bundled-extras.js';

/**
 * What a row of the Bundled Extras window shows and does. The module decides, from the state of the app, which
 * state an item is in and which actions that state offers. It does not install anything itself: the adapters do,
 * and the real ones are in `bundled-extras-adapters.js`.
 *
 * @typedef {'not-installed' | 'installed' | 'enabled'} ItemStatus
 * @typedef {'install' | 'enable' | 'disable' | 'remove' | 'restore' | 'apply'} ItemAction
 * @typedef {{ status: ItemStatus, actions: ItemAction[] }} ItemState
 *
 * @typedef {object} ExtensionsAdapter
 * @property {(folder: string) => { name: string, enabled: boolean } | null} find The installed extension of a folder.
 * @property {(url: string) => Promise<unknown>} install
 * @property {(name: string) => Promise<unknown>} enable
 * @property {(name: string) => Promise<unknown>} disable
 * @property {(name: string) => Promise<unknown>} remove
 * @property {(name: string) => boolean} canRemove
 *
 * @typedef {object} PresetsAdapter
 * @property {(presetName: string) => boolean} has
 * @property {(presetName: string) => Promise<unknown>} restore
 *
 * @typedef {object} AssistantsAdapter
 * @property {(id: string) => boolean} has Whether the library has the card of the assistant.
 * @property {(id: string) => Promise<unknown>} install Imports the card of the assistant into the library.
 *
 * @typedef {object} ThemesAdapter
 * @property {(themeName: string) => boolean} has Whether the UI theme list has a theme of that name.
 * @property {(id: string) => Promise<{ name: string }>} install
 * @property {(themeName: string) => Promise<unknown>} apply
 */

/**
 * @param {{ extensions: ExtensionsAdapter, presets: PresetsAdapter, themes: ThemesAdapter, assistants: AssistantsAdapter }} adapters
 */
export function createBundledExtrasActions({ extensions, presets, themes, assistants }) {
    /** The names that the server gave to themes installed in this session, by item id. */
    const installedThemeNames = new Map();

    const themeNameOf = item => installedThemeNames.get(item.id) ?? item.themeName;
    const installedExtensionOf = item => extensions.find(getExtensionFolderName(item));

    /** @returns {ItemState} */
    function getState(item) {
        switch (item.kind) {
            case 'extension':
            case 'theme-extension': {
                const found = installedExtensionOf(item);
                if (!found) {
                    return { status: 'not-installed', actions: ['install'] };
                }
                const remove = extensions.canRemove(found.name) ? ['remove'] : [];
                return found.enabled
                    ? { status: 'enabled', actions: ['disable', ...remove] }
                    : { status: 'installed', actions: ['enable', ...remove] };
            }
            case 'preset':
                return presets.has(item.presetName)
                    ? { status: 'installed', actions: [] }
                    : { status: 'not-installed', actions: ['restore'] };
            case 'assistant':
                // Removing an assistant is deleting her character, which the app does for every card. So an installed row offers nothing.
                return assistants.has(item.id)
                    ? { status: 'installed', actions: [] }
                    : { status: 'not-installed', actions: ['install'] };
            case 'theme-css':
                return themes.has(themeNameOf(item))
                    ? { status: 'installed', actions: ['apply'] }
                    : { status: 'not-installed', actions: ['install'] };
            default:
                throw new Error(`The ${item.kind} "${item.id}" has no state here.`);
        }
    }

    /**
     * Runs one of the actions that the state of the item offers.
     * @param {object} item
     * @param {ItemAction} action
     * @returns {Promise<ItemState>} The state after the action.
     */
    async function run(item, action) {
        if (!getState(item).actions.includes(action)) {
            throw new Error(`The action "${action}" is not offered for "${item.id}" in its state.`);
        }
        switch (action) {
            case 'install':
                if (item.kind === 'theme-css') {
                    installedThemeNames.set(item.id, (await themes.install(item.id)).name);
                } else if (item.kind === 'assistant') {
                    await assistants.install(item.id);
                } else {
                    await extensions.install(item.url);
                }
                break;
            case 'enable':
            case 'disable':
            case 'remove':
                await extensions[action](installedExtensionOf(item).name);
                break;
            case 'restore':
                await presets.restore(item.presetName);
                break;
            case 'apply':
                await themes.apply(themeNameOf(item));
                break;
            default:
                throw new Error(`Unknown action: ${action}`);
        }
        return getState(item);
    }

    return { getState, run };
}
