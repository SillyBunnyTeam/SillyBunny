import { t } from '../i18n.js';

/** Windows that are loading or open, by name. */
const activeWindows = new Map();

/**
 * Makes the opener of one window. The module loads on first use, so Home adds nothing to startup for windows
 * the user may never open. While the window loads or is open, another activation does nothing, because a second
 * call would push the same window as a page over itself. A failed load logs the error and shows a toast.
 * @param {string} name
 * @param {() => Promise<{ closed: Promise<unknown> }>} load Opens the window and resolves with its handle.
 * @returns {() => void}
 */
function openOnce(name, load) {
    return () => {
        if (activeWindows.has(name)) {
            return;
        }
        const pending = load();
        activeWindows.set(name, pending);
        const release = () => {
            if (activeWindows.get(name) === pending) {
                activeWindows.delete(name);
            }
        };
        pending.then(dialog => dialog.closed.then(release), (error) => {
            release();
            console.error(`Could not open the ${name} window.`, error);
            globalThis.toastr?.error(t`TODO(copy)`);
        });
    };
}

export const showWelcome = openOnce('Welcome', async () => (await import('../sillybunny-welcome.js')).openWelcomeDialog());
export const openKeyboardShortcuts = openOnce('Keyboard Shortcuts', async () => (await import('../sillybunny-shortcuts.js')).openShortcutsWindow());
export const openHelp = openOnce('Help', async () => (await import('../sillybunny-help/help-window.js')).openHelpWindow());
export const openAbout = openOnce('About', async () => (await import('../sillybunny-about.js')).openAboutWindow());
