/**
 * Third-party settings drawers that are appended to the legacy settings column.
 *
 * Extensions that predate the Extensions panel add their drawer to `#user-settings-block-content`. The
 * settings split leaves that column unpainted, so such a drawer would show on no page. The Extensions page
 * builds one row for every container of `#extensions_settings2`, so a stray drawer moves there and is listed
 * with the other user-installed extensions, and nowhere else.
 *
 * Only a direct child of the column counts. The drawers that the column was authored with sit deeper, under
 * `#UI-Customization`, and they stay where they are.
 */

/**
 * @param {HTMLElement|null} legacyColumn
 * @param {HTMLElement|null} destination
 * @returns {number} how many drawers moved
 */
export function adoptStrayExtensionDrawers(legacyColumn, destination) {
    if (!(legacyColumn instanceof HTMLElement) || !(destination instanceof HTMLElement)) {
        return 0;
    }

    const strays = Array.from(legacyColumn.children).filter(child => child.classList.contains('inline-drawer'));
    // Moved, not cloned, so the extension keeps its ids, listeners and the references it holds to its nodes.
    strays.forEach(drawer => destination.appendChild(drawer));
    return strays.length;
}

/**
 * Adopts the drawers that are in the column now and every one that is appended later.
 * @param {HTMLElement|null} legacyColumn
 * @param {() => HTMLElement|null} getDestination Read on each pass, because the Extensions block can mount after the column.
 * @returns {MutationObserver|null}
 */
export function watchStrayExtensionDrawers(legacyColumn, getDestination) {
    if (!(legacyColumn instanceof HTMLElement)) {
        return null;
    }

    const adopt = () => adoptStrayExtensionDrawers(legacyColumn, getDestination());
    adopt();
    const observer = new MutationObserver(adopt);
    observer.observe(legacyColumn, { childList: true });
    return observer;
}
