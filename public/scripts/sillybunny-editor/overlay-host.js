/**
 * A modal <dialog> makes everything outside it inert. Menus, pickers and sheets that open from
 * inside one are therefore re-parented into the topmost modal dialog while they are open, and
 * moved back to <body> before that dialog is removed.
 */

const LAYER_ATTRIBUTE = 'data-sb-overlay-layer';
/** Set by SillyBunny frames that always open with showModal(). */
export const MODAL_ATTRIBUTE = 'data-sb-modal';

function isModal(dialog) {
    if (dialog.hasAttribute(MODAL_ATTRIBUTE)) return true;
    try {
        return dialog.matches(':modal');
    } catch {
        return true;
    }
}

/** The last open modal dialog that is not closing, or null. */
export function getTopmostDialog() {
    const dialogs = [...document.querySelectorAll('dialog[open]:not([closing])')].filter(isModal);
    return dialogs.at(-1) ?? null;
}

/**
 * Mounts overlay layers in the topmost modal dialog, or in <body> when none is open.
 * @param {...(HTMLElement|null|undefined)} layers
 * @returns {HTMLElement} The element the layers were mounted in.
 */
export function hostOverlayLayer(...layers) {
    const host = getTopmostDialog() ?? document.body;
    for (const layer of layers) {
        if (!(layer instanceof HTMLElement)) continue;
        layer.setAttribute(LAYER_ATTRIBUTE, '');
        if (layer.parentElement !== host) host.append(layer);
    }
    return host;
}

/** Moves hosted layers out of `root` so cached menu frames survive its removal. */
export function releaseOverlayLayers(root) {
    if (!(root instanceof Element)) return;
    for (const layer of root.querySelectorAll(`[${LAYER_ATTRIBUTE}]`)) {
        layer.dispatchEvent(new Event('sb-overlay-host-closing'));
        if (root.contains(layer)) document.body.append(layer);
    }
}

/** Announced on the document when a menu surface (a popover or a sheet) closes; the detail is its id. */
export const MENU_LAYER_CLOSED_EVENT = 'sb-menu-layer-closed';

const MENU_SURFACE_SELECTOR = '.sb-action-popover, .sb-action-sheet';
let menuLayerId = 0;

/**
 * Makes a surface that opens from inside a menu popover or sheet (a select picker, a colour picker) a child of that
 * surface. A menu closes on a press, a focus, a scroll or an Escape that is outside it, and a child sits in the page
 * outside the menu's element, so without this link a press on the child would close the menu under it, and the child
 * with it. The menu treats the child as inside (`isChildLayerOf()`), and the child goes with the menu.
 * @param {HTMLElement} surface The element that the page hosts, which holds everything of the child.
 * @param {HTMLElement} owner The control that opened it.
 * @param {() => void} onParentClosed
 * @returns {(() => void)|null} Unlinks the child, or null when the owner is not in a menu surface.
 */
export function linkChildLayer(surface, owner, onParentClosed) {
    const parent = owner.closest(MENU_SURFACE_SELECTOR);
    if (!(parent instanceof HTMLElement)) return null;
    if (!parent.id) {
        menuLayerId += 1;
        parent.id = `sb-menu-layer-${menuLayerId}`;
    }
    const parentId = parent.id;
    surface.dataset.sbParentLayer = parentId;
    const onClosed = event => {
        if (/** @type {CustomEvent} */ (event).detail === parentId) onParentClosed();
    };
    document.addEventListener(MENU_LAYER_CLOSED_EVENT, onClosed);
    return () => document.removeEventListener(MENU_LAYER_CLOSED_EVENT, onClosed);
}

/** Whether a node is in a surface that was linked to this menu root: a press, a focus or a scroll there is not outside the menu. */
export function isChildLayerOf(root, node) {
    if (!(node instanceof Element) || !root.id) return false;
    const layer = node.closest('[data-sb-parent-layer]');
    return layer instanceof HTMLElement && layer.dataset.sbParentLayer === root.id;
}
