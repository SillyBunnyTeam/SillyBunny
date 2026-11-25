import { loadStylesheetAsync } from '../../dynamic-styles.js';

const DETAILS_STYLESHEET = Object.freeze({ href: 'css/sillybunny-conversation-details.css?v=20261125a', id: 'sb-conversation-details-css' });
// The collection rows (members, chats, files, pinned messages) are the shared entity rows, whose sheet the mode does not load otherwise.
const ENTITY_LIST_STYLESHEET = Object.freeze({ href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' });

// User custom CSS (#custom-style) must keep winning, so the sheet is inserted before it, as the mode's own sheet is.
function insertDetailsStylesheetLink() {
    const customStyle = document.getElementById('custom-style');
    if (document.getElementById(DETAILS_STYLESHEET.id) || !(customStyle instanceof HTMLElement) || !customStyle.parentNode) {
        return;
    }
    const link = document.createElement('link');
    link.id = DETAILS_STYLESHEET.id;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.media = 'print';
    link.href = DETAILS_STYLESHEET.href;
    customStyle.before(link);
}

/**
 * Loads the sheet of the details window and the entity-list sheet that its rows need. Each loads once, so the mode's lazy
 * part and the window both call it. The shared editor sheet (buttons, text areas) is loaded by the mode's own lazy part.
 */
export function ensureDetailsStyles() {
    insertDetailsStylesheetLink();
    return Promise.all([
        loadStylesheetAsync(DETAILS_STYLESHEET.href, { id: DETAILS_STYLESHEET.id }),
        loadStylesheetAsync(ENTITY_LIST_STYLESHEET.href, { id: ENTITY_LIST_STYLESHEET.id }),
    ]);
}
