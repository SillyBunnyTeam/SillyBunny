/**
 * The emoji chooser as a surface: a popover on a desktop and a bottom sheet in the mobile layout, from the shared
 * `openPopover()` (focus trap, Escape, swipe to close, return of focus). Load it with `import()` when it is first needed;
 * it fetches its own stylesheet and the emoji table, so nothing of it is in the start-up.
 *
 * Two callers use it: the composer's Emoji button (`kind: 'insert'`) and More Reactions (`kind: 'react'`).
 */

import { loadStylesheetAsync } from '../../dynamic-styles.js';
import { openPopover } from '../../sillybunny-action-menu.js';
import { MENU_SHEET_QUERY } from '../../sillybunny-editor/breakpoints.js';
import { createChooserView } from './emoji-chooser-view.js';
import { pushRecentEmoji, readRecentEmoji } from './emoji-store.js';
import { whenStyled } from './emoji-style-ready.js';
import { emojiTables } from './emoji-table.js';

const STYLESHEET_ID = 'sb-emoji-chooser-css';
const STYLESHEET_HREF = 'css/sillybunny-emoji-chooser.css?v=20261125a';

/** @type {{ trigger: HTMLElement, close: () => void }|null} */
let current = null;

function isSheet() {
    return globalThis.matchMedia?.(MENU_SHEET_QUERY).matches === true;
}

function isTouch() {
    return isSheet() || globalThis.matchMedia?.('(pointer: coarse)').matches === true;
}

/**
 * Opens the chooser, or closes it when it is open already for the same trigger.
 * @param {object} options
 * @param {HTMLElement} options.trigger The control the surface is anchored to and returns the focus to.
 * @param {'insert'|'react'} options.kind
 * @param {(emoji: string, details: { name: string, keepOpen: boolean }) => void} options.onPick Called after the chooser has closed (unless `keepOpen`) with the emoji in its fully-qualified form.
 * @param {(emoji: string) => boolean} [options.isPicked] For `react`: whether the message has the emoji; its cell then shows as selected.
 * @param {Element|null} [options.bounds] The desktop popover stays inside this element.
 * @param {() => void} [options.onClose] Called once when the chooser has closed, whatever closed it.
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openEmojiChooser({ trigger, kind, onPick, isPicked, bounds = null, onClose = null }) {
    if (!(trigger instanceof HTMLElement) || (kind !== 'insert' && kind !== 'react') || typeof onPick !== 'function') {
        throw new TypeError('openEmojiChooser requires a trigger, a kind of insert or react, and an onPick callback');
    }
    if (current?.trigger === trigger) {
        current.close();
        return { close() {}, isOpen: false };
    }
    current?.close();

    let cancelled = false;
    let surface = null;
    let view = null;
    let closed = false;

    const finish = () => {
        if (closed) {
            return;
        }
        closed = true;
        view?.dispose();
        if (current === session) {
            current = null;
        }
        onClose?.();
    };
    const close = () => {
        cancelled = true;
        if (surface) {
            surface.close();
        } else {
            finish();
        }
    };
    const session = { trigger, close };
    current = session;

    const loadTable = (shown) => {
        shown.showLoading();
        emojiTables.load().then((table) => {
            if (!closed) {
                shown.setTable(table);
                if (isTouch() && document.activeElement === shown.element) {
                    shown.focusInitial();
                }
            }
        }, (error) => {
            console.warn('Conversation Mode: the emoji table could not be loaded', error);
            if (!closed) {
                shown.showError(() => loadTable(shown));
            }
        });
    };

    // The surface opens once its stylesheet is there; a sheet that fails to load must not keep the chooser shut.
    Promise.resolve(loadStylesheetAsync(STYLESHEET_HREF, { id: STYLESHEET_ID }))
        .catch(error => console.warn('Conversation Mode: the emoji chooser stylesheet failed to load', error))
        // WebKit applies the sheet a frame or two after its load event, and the popover measures its content when it opens.
        .then(() => whenStyled('sb-emoji-chooser', 'display', 'flex'))
        .then(() => {
            if (cancelled) {
                finish();
                return;
            }
            view = createChooserView({
                kind,
                recents: readRecentEmoji(),
                isPicked,
                touch: isTouch(),
                requestClose: close,
                recordRecent: pushRecentEmoji,
                onPick,
                loadEnglish: () => emojiTables.loadEnglish(),
            });
            view.element.tabIndex = -1;
            surface = openPopover({
                trigger,
                content: view.element,
                title: 'Emoji',
                bounds,
                initialFocus: () => (isTouch() ? view.element : view.element.querySelector('.sb-emoji-search-entry')),
                onClose: finish,
            });
            loadTable(view);
        });

    return {
        close,
        get isOpen() {
            return !closed;
        },
    };
}
