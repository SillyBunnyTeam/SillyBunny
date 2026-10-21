/**
 * Merges a fresh theme snapshot over the stored theme, so saving never drops keys the
 * snapshot does not carry (a bundled theme's custom_css, legacy SillyTavern layout keys).
 * @param {object|null|undefined} stored Stored theme object, if the theme exists.
 * @param {object} snapshot Snapshot of the theme keys taken from the current settings.
 * @returns {object} Theme object to write.
 */
export function mergeThemeUpdate(stored, snapshot) {
    return { ...(stored ?? {}), ...snapshot };
}
