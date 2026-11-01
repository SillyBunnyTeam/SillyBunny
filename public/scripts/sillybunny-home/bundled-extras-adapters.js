import { getRequestHeaders } from '../../script.js';
import { confirmAndDeleteExtension, disableExtension, enableExtension, findExtension, getExtensionType, installExtension } from '../extensions.js';
import { registerUiTheme, switchUiTheme } from '../power-user.js';
import { getPresetManager } from '../preset-manager.js';
import { isAdmin } from '../user.js';
import { hasBundledAssistantCard, installBundledAssistant } from '../welcome-screen.js';
import { createBundledExtrasActions } from './bundled-extras-actions.js';
import { createPresetsAdapter } from './bundled-extras-presets.js';

/** The preset list that holds the bundled presets of Bundled Extras. */
const PRESET_API_ID = 'openai';
const INSTALL_THEME_URL = '/api/sillybunny/themes/install-bundled';

/**
 * Installs go to the same flow as the Extensions panel, for the current user only: a global install needs an
 * administrator and is the panel's own choice to offer. Enable and disable reload the page, as they do there.
 * @type {import('./bundled-extras-actions.js').ExtensionsAdapter}
 */
const extensions = {
    find: folder => findExtension(folder),
    install: url => installExtension(url, false),
    enable: name => enableExtension(name),
    disable: name => disableExtension(name),
    remove: name => confirmAndDeleteExtension(name),
    // A global extension belongs to every user, and only an administrator may delete it.
    canRemove: name => getExtensionType(name) !== 'global' || isAdmin(),
};

const presets = createPresetsAdapter({ getManager: getPresetManager, apiId: PRESET_API_ID });

/** The saved theme of that name, read back from the server. Only a theme that was there already needs it: a new install returns its theme. */
async function readSavedTheme(name) {
    const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
    if (!response.ok) {
        throw new Error(`The saved themes could not be read: ${response.status}`);
    }
    const { themes } = await response.json();
    const theme = themes.find(candidate => candidate.name === name);
    if (!theme) {
        throw new Error('The installed theme is not among the saved themes.');
    }
    return theme;
}

/** @type {import('./bundled-extras-actions.js').ThemesAdapter} */
const themes = {
    has: themeName => [...document.querySelectorAll('#themes option')].some(option => option.value === themeName),
    async install(id) {
        const response = await fetch(INSTALL_THEME_URL, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id }) });
        const body = await response.json().catch(() => ({}));
        const alreadySaved = response.status === 409;
        if (!response.ok && !alreadySaved) {
            throw new Error(`The theme could not be installed: ${body.error ?? response.status}`);
        }
        // A theme of that name was saved before, perhaps edited, and the route leaves it: the list gets that one.
        registerUiTheme(alreadySaved ? await readSavedTheme(body.name) : body.theme);
        return { name: body.name };
    },
    apply: themeName => switchUiTheme(themeName),
};

/** @type {import('./bundled-extras-actions.js').AssistantsAdapter} */
const assistants = {
    has: id => hasBundledAssistantCard(id),
    install: id => installBundledAssistant(id),
};

/** The actions of the Bundled Extras window, over the app. */
export function createAppBundledExtrasActions() {
    return createBundledExtrasActions({ extensions, presets, themes, assistants });
}
