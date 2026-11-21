/**
 * Keeps an open jQuery UI autocomplete list inside the window. The widget positions its list under the field with
 * no collision handling, and it caps the list at 300px, so a field near an edge pushes the list past the window.
 * A type-ahead list stays anchored below its field (DESIGN.md, Menus and Popovers), so the clamp shifts it sideways
 * and shortens it; it never flips it above the field.
 */

const MARGIN = 8;
/** Two rows. Below this, a shorter list would be a sliver, so the list keeps this height and reaches past the window. */
const MIN_HEIGHT = 64;

let installed = false;

/**
 * @param {HTMLElement} list The `.ui-autocomplete` element.
 */
export function clampAutocompleteList(list) {
    if (!(list instanceof HTMLElement) || !list.getClientRects().length) return;
    const view = window.visualViewport;
    const width = view?.width ?? window.innerWidth;
    const height = view?.height ?? window.innerHeight;
    const originX = view?.offsetLeft ?? 0;
    const originY = view?.offsetTop ?? 0;

    // An earlier open set these for another position; measure the list as the widget placed it.
    list.style.removeProperty('max-width');
    list.style.removeProperty('max-height');
    list.style.removeProperty('overflow-y');

    list.style.maxWidth = `${Math.max(0, width - MARGIN * 2)}px`;
    let rect = list.getBoundingClientRect();
    const overflowRight = rect.right - (originX + width - MARGIN);
    const overflowLeft = originX + MARGIN - rect.left;
    // The widget writes `left` in document pixels, so a shift of the box moves it one for one.
    const shift = overflowRight > 0 ? -Math.min(overflowRight, Math.max(0, rect.left - (originX + MARGIN))) : Math.max(0, overflowLeft);
    if (shift) list.style.left = `${(parseFloat(list.style.left) || 0) + shift}px`;

    rect = list.getBoundingClientRect();
    const room = originY + height - MARGIN - rect.top;
    if (rect.height > room) {
        list.style.maxHeight = `${Math.max(MIN_HEIGHT, room)}px`;
        list.style.overflowY = 'auto';
    }
}

/**
 * Clamps each list as it opens. Safe to call more than once.
 * @param {EventTarget} [opened] The field whose list is already open, which the caller saw open before this module loaded.
 */
export function installAutocompleteClamp(opened) {
    const jquery = window.jQuery;
    if (typeof jquery !== 'function') return;
    const clamp = target => {
        const widget = jquery(target).autocomplete?.('widget')?.[0];
        if (widget) clampAutocompleteList(widget);
    };
    if (!installed) {
        installed = true;
        jquery(document).on('autocompleteopen', event => clamp(event.target));
    }
    if (opened) clamp(opened);
}
