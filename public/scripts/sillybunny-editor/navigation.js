// SillyBunny: shared leave protection for the scrolling-sheet editors.
// One set of document listeners serves every registered editor, so the
// character and group editors cannot drift apart on Ctrl+S, dirty Escape,
// tab-switch interception, the unsaved-changes dialog, or unload backup.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../popup.js';
import { isActionMenuOpen } from '../sillybunny-action-menu.js';
import { isPickerOpen } from './picker.js';
import { t } from '../i18n.js';

const DISCARD_RESULT = 2;

/**
 * @typedef {object} EditorRegistration
 * @property {ReturnType<typeof import('./session.js').createEditorSession>} session
 * @property {() => boolean} isActive  Authoritative "this editor is on screen" check.
 * @property {() => void} close  Leaves the editor (navigates back to its list).
 * @property {() => void} [afterDiscard]  Editor-specific resync after a discard.
 * @property {string} [guardSelector]  Click targets that must pass the leave guard first.
 *     Defaults to the character-panel tabs other than the character editor's own.
 * @property {boolean} [escape=true]  Guard Escape here; false when the editor's shell owns Escape.
 */

// Character panel tabs: the drawer rail uses data-sb-character-tab, the page-hosted
// layout uses data-sb-settings-tab. The character and group editors live on "editor".
export const CHARACTER_TAB_GUARD_SELECTOR = '[data-sb-character-tab]:not([data-sb-character-tab="editor"]), '
    + '[data-sb-settings-tab]:not([data-sb-settings-tab="editor"])';

/**
 * Tab selector guarding every character-panel tab except `tabId`.
 * @param {string} tabId
 */
export function characterTabGuardSelector(tabId) {
    const id = String(tabId).replace(/["\\]/g, '\\$&');
    return `[data-sb-character-tab]:not([data-sb-character-tab="${id}"]), [data-sb-settings-tab]:not([data-sb-settings-tab="${id}"])`;
}

/** @type {Set<EditorRegistration>} */
const editors = new Set();
let bound = false;
let promptOpen = false;

/**
 * Register an editor with the shared guards. Listeners are bound once, on the
 * first registration.
 * @param {EditorRegistration} registration
 * @returns {() => void} unregister
 */
export function registerEditorNavigation(registration) {
    editors.add(registration);
    if (!bound) {
        bound = true;
        bindDocumentGuards();
    }
    return () => editors.delete(registration);
}

/**
 * Asks to leave the editor. Resolves true when nothing unsaved remains, after
 * the user saved or discarded; false when they cancelled or the save failed.
 * @param {EditorRegistration} registration
 * @returns {Promise<boolean>}
 */
export async function confirmEditorLeave(registration) {
    const { session } = registration;
    if (!session.isOpen() || !session.isDirty()) return true;
    if (promptOpen) return false;

    promptOpen = true;
    let result;
    try {
        const message = document.createElement('p');
        message.textContent = t`Unsaved changes`;
        const popup = new Popup(message, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Save`,
            cancelButton: t`Cancel`,
            customButtons: [{ text: t`Discard`, result: DISCARD_RESULT, classes: ['sb-editor-discard'] }],
            defaultResult: POPUP_RESULT.NEGATIVE,
        });
        // AdwAlertDialog order: Cancel (start) · Discard · Save (end). The theme
        // already sets .popup-button-cancel { order: -1 }, so only Save moves.
        popup.okButton.style.order = '2';
        result = await popup.show();
    } finally {
        promptOpen = false;
    }

    if (result === POPUP_RESULT.AFFIRMATIVE) return session.save();
    if (result === DISCARD_RESULT) {
        discardEditorChanges(registration);
        return true;
    }
    return false;
}

/**
 * Runs the leave guard for whichever registered editor is open and on screen.
 * @returns {Promise<boolean>} True when there is no active editor or leaving is approved.
 */
export async function confirmActiveEditorLeave() {
    const editor = activeEditor();
    return editor ? confirmEditorLeave(editor) : true;
}

/**
 * Commit whatever field currently holds focus by blurring it, so a control that
 * reports its edit on `change` cannot land that edit *after* the caller has
 * already acted. `change` fires on blur, so a Cancel clicked while focus is still
 * inside such a field would otherwise revert first and then re-apply the stale
 * value, leaving the editor dirty again.
 */
function commitFocusedField() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/**
 * Revert to the saved baseline and run the editor's resync hook.
 * @param {EditorRegistration} registration
 */
export function discardEditorChanges(registration) {
    commitFocusedField();
    registration.session.discard();
    registration.afterDiscard?.();
}

/** @returns {EditorRegistration|null} */
function activeEditor() {
    for (const editor of editors) {
        if (editor.session.isOpen() && editor.isActive()) return editor;
    }
    return null;
}

function isPopupOpen() {
    return Boolean(document.querySelector('dialog.popup[open]'));
}

/**
 * True when a key event belongs to an inline editor that owns its own Enter and
 * Escape handling. These guards run on capture, so without this they would claim
 * the key first: Escape in the header title rename would open the leave
 * confirmation instead of abandoning the rename, and the blur that follows would
 * commit the abandoned name. The input's own handler stops the event, so once it
 * has run nothing here needs to act.
 * @param {Event} event
 */
function isInlineEditorEvent(event) {
    const target = /** @type {Element|null} */ (event.target);
    return Boolean(target?.closest?.('.sb-editor-title-input'));
}

function bindDocumentGuards() {
    // Ctrl/Cmd+S saves whichever editor is on screen.
    document.addEventListener('keydown', (event) => {
        // Lowercase only: Ctrl+Shift+S belongs to the browser (Firefox screenshots).
        if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return;
        if (isInlineEditorEvent(event)) return;
        const editor = activeEditor();
        if (!editor) return;
        event.preventDefault();
        void editor.session.save();
    }, { capture: true });

    // Escape is guarded from inside fields too: while editing, focus is almost
    // always in a field. A clean editor lets Escape fall through to the shell.
    document.addEventListener('keydown', async (event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
        if (isInlineEditorEvent(event)) return;
        const editor = activeEditor();
        if (!editor || editor.escape === false) return;
        // Open overlays own Escape; check them before the dirty snapshot, which serialises every field.
        if (isPopupOpen() || isActionMenuOpen() || isPickerOpen()) return;
        if (!editor.session.isDirty()) return;

        event.preventDefault();
        event.stopPropagation();
        if (await confirmEditorLeave(editor)) editor.close();
    }, { capture: true });

    // Tab and other navigation clicks named by the active editor's guard selector.
    document.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        const target = /** @type {HTMLElement} */ (event.target);
        if (!target?.closest) return;
        // Match a guarded target before isDirty(): the dirty check serialises every field.
        let editor = null;
        let tab = null;
        for (const candidate of editors) {
            const match = target.closest(candidate.guardSelector ?? CHARACTER_TAB_GUARD_SELECTOR);
            if (match && candidate.session.isOpen() && candidate.isActive()) {
                editor = candidate;
                tab = match;
                break;
            }
        }
        if (!editor || !editor.session.isDirty()) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        // Replayed untrusted, so it passes this guard on the second trip.
        if (await confirmEditorLeave(editor)) tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, { capture: true });

    const flushAll = () => {
        for (const editor of editors) editor.session.flushDraft();
    };

    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flushAll();
    });
    window.addEventListener('beforeunload', (event) => {
        let dirty = false;
        for (const editor of editors) {
            if (!editor.session.isDirty()) continue;
            editor.session.flushDraft();
            dirty = true;
        }
        if (!dirty) return;
        event.preventDefault();
        // preventDefault() alone does not arm the browser's "leave site?"
        // prompt; the spec requires a truthy-assigned returnValue.
        event.returnValue = '';
    });
}
