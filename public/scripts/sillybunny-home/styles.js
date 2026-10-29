import { loadListEditorStyles } from '../sillybunny-editor/list-shell.js';

/**
 * The Home rows take their pointer, hover and arrow styles from the deferred editor-shell sheet. Home waits
 * for the sheet together with its template, so a row never paints without them.
 * @returns {Promise<void>} Settles when the sheet is ready, or when it failed. Home works without it.
 */
export async function ensureHomeStyles() {
    try {
        await loadListEditorStyles();
    } catch (error) {
        console.warn('Failed to load the shared row styles for Home.', error);
    }
}
