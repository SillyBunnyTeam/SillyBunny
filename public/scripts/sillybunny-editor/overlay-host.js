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
