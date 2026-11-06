/*
 * A window that carries a picture beside its content is wider by the width of that picture. The Dialog and Window
 * tiers read `--sb-dialog-aside` in their width rules (`css/sillybunny-theme.css`, `.sb-dialog--dialog` and
 * `.sb-dialog--window`), so the content column keeps the width that the tier gives it. A sheet ignores the property:
 * its width is the screen.
 */

const PROPERTY = '--sb-dialog-aside';

/**
 * @param {HTMLElement} surface The `.sb-dialog` element.
 * @returns {number} The extra width in CSS pixels, 0 when none is set.
 */
export function readDialogAside(surface) {
    const value = Number.parseFloat(surface.style.getPropertyValue(PROPERTY));
    return Number.isFinite(value) ? value : 0;
}

/**
 * @param {HTMLElement} surface The `.sb-dialog` element.
 * @param {number} pixels Extra width in CSS pixels. 0 or less removes it.
 */
export function writeDialogAside(surface, pixels) {
    if (pixels > 0) {
        surface.style.setProperty(PROPERTY, `${pixels}px`);
        return;
    }
    surface.style.removeProperty(PROPERTY);
}
