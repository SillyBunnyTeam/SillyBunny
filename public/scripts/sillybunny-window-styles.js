import { loadListEditorStyles } from './sillybunny-editor/list-shell.js';

const WINDOWS_STYLESHEET = { href: 'css/sillybunny-windows.css?v=20261031a', id: 'deferred-windows-css' };

/**
 * The Welcome, Help, About and Keyboard Shortcuts windows take their row styles from the deferred
 * editor-shell sheet and their own layout from the windows sheet. A window waits for both before it
 * opens, so a row never paints without them.
 * @returns {Promise<void>} Settles when the sheets are ready, or when one failed. The windows work without them.
 */
export async function ensureWindowStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    try {
        await Promise.all([
            loadListEditorStyles(),
            loader ? loader(WINDOWS_STYLESHEET.href, { id: WINDOWS_STYLESHEET.id }) : undefined,
        ]);
    } catch (error) {
        console.warn('Failed to load the window styles.', error);
    }
}
