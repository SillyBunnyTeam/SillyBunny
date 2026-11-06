import { t } from '../i18n.js';

const PANEL_SELECTOR = '#chat > .welcomePanel';

/** Windows that are loading or open, by name. */
const activeWindows = new Map();

/**
 * Names the Home control that is about to open a window, by the stable key of its tile or card. The control
 * itself cannot be kept: a render of Home (a pin, a rename or a delete) replaces the whole panel.
 * @returns {{ opener: Element | null, key: string | null }}
 */
function rememberOpener() {
    const opener = document.activeElement;
    return { opener, key: opener?.closest(`${PANEL_SELECTOR} [data-sb-home-key]`)?.dataset.sbHomeKey ?? null };
}

/**
 * The button of the tile or card with this key in the current panel, or null.
 * @param {string | null} key
 * @returns {HTMLElement | null}
 */
function findHomeControl(key) {
    const keyed = key === null ? null : [...document.querySelectorAll(`${PANEL_SELECTOR} [data-sb-home-key]`)].find(node => node.dataset.sbHomeKey === key);
    return keyed?.matches('button') ? keyed : keyed?.querySelector('.sbHomeCardOpen') ?? null;
}

/**
 * The window returns focus to the control that opened it. When Home rendered again meanwhile, that control is
 * gone, so focus goes to the same tile or card in the current panel, or to the main menu button when the key
 * is gone too, or the window was opened from the menu.
 * @param {{ opener: Element | null, key: string | null }} remembered
 */
function focusCurrentOpener({ opener, key }) {
    const panel = document.querySelector(PANEL_SELECTOR);
    if (!panel || opener?.isConnected) {
        return;
    }
    (findHomeControl(key) ?? panel.querySelector('.sbHomeMenuButton'))?.focus({ preventScroll: true });
}

/**
 * Makes the opener of one window. The module loads on first use, so Home adds nothing to startup for windows
 * the user may never open. While the window loads or is open, another activation does nothing, because a second
 * call would push the same window as a page over itself. A failed load logs the error and shows a toast.
 * @template [Options=undefined]
 * @param {string} name
 * @param {(options: Options) => Promise<{ closed: Promise<unknown> }>} load Opens the window and resolves with its handle.
 * @returns {(options?: Options) => void}
 */
function openOnce(name, load) {
    return (options) => {
        if (activeWindows.has(name)) {
            return;
        }
        const remembered = rememberOpener();
        const pending = load(options);
        activeWindows.set(name, pending);
        const release = () => {
            if (activeWindows.get(name) === pending) {
                activeWindows.delete(name);
            }
        };
        pending.then(dialog => dialog.closed.then(() => {
            release();
            focusCurrentOpener(remembered);
        }), (error) => {
            release();
            console.error(`Could not open the ${name} window.`, error);
            reportLoadFailure();
        });
    };
}

function reportLoadFailure() {
    globalThis.toastr?.error(t`This window couldn't open. Try again, or reload SillyBunny.`);
}

/**
 * Opens a window from outside Home on behalf of one of its tiles. The tile takes focus first, so the window
 * returns focus to it when it closes, as if the tile had opened the window. Without a tile, because Home is not
 * shown, the window leaves focus where it is.
 * @param {string} key The `data-sb-home-key` of the tile.
 * @param {() => void} open One of the openers below.
 */
export function openFromHomeTile(key, open) {
    findHomeControl(key)?.focus({ preventScroll: true });
    open();
}

export const showWelcome = openOnce('Welcome', async () => (await import('../sillybunny-welcome.js')).openWelcomeDialog());
export const openKeyboardShortcuts = openOnce('Keyboard Shortcuts', async () => (await import('../sillybunny-shortcuts.js')).openShortcutsWindow());
/** Takes `{ topic }`, the id of a Help topic to open the window at. */
export const openHelp = openOnce('Help', async options => (await import('../sillybunny-help/help-window.js')).openHelpWindow({ topicId: options?.topic ?? null }));
export const openAbout = openOnce('About', async () => (await import('../sillybunny-about.js')).openAboutWindow());
export const openGettingStarted = openOnce('Getting Started', async () => (await import('./getting-started-window.js')).openGettingStartedWindow());
export const openBundledExtras = openOnce('Bundled Extras', async () => (await import('./bundled-extras-window.js')).openBundledExtrasWindow());
/** Takes what the picker needs: `{ getEntries, getThumbnailUrl, choose }`. */
export const openAssistantPicker = openOnce('Choose Assistant', async options => (await import('./assistant-picker.js')).openAssistantPickerWindow(options));
