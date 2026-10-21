/**
 * Merges a fresh theme snapshot over the stored theme, so saving never drops keys the
 * snapshot does not carry, such as legacy SillyTavern layout keys in bundled themes.
 * @param {object|null|undefined} stored Stored theme object, if the theme exists.
 * @param {object} snapshot Snapshot of the theme keys taken from the current settings.
 * @returns {object} Theme object to write.
 */
export function mergeThemeUpdate(stored, snapshot) {
    return { ...(stored ?? {}), ...snapshot };
}

/**
 * Adds the live Custom CSS to a theme snapshot when the stored theme owns Custom CSS, so
 * saving or exporting that theme keeps the user's edits instead of the stored copy that
 * selecting it would re-apply. A theme without Custom CSS stays without it.
 * @param {object} snapshot Snapshot of the theme keys taken from the current settings.
 * @param {object|null|undefined} stored Stored theme object, if the theme exists.
 * @param {unknown} liveCss Current Custom CSS.
 * @returns {object} Snapshot to save or export.
 */
export function withOwnedThemeCss(snapshot, stored, liveCss) {
    if (typeof stored?.custom_css !== 'string') {
        return { ...snapshot };
    }

    return { ...snapshot, custom_css: String(liveCss ?? '') };
}
