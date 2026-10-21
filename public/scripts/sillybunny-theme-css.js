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
 * Normalizes Custom CSS for comparisons, so line endings and surrounding whitespace never
 * count as a change.
 * @param {unknown} css Custom CSS.
 * @returns {string} Normalized CSS.
 */
export function normalizeThemeCss(css) {
    return String(css ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Gets the Custom CSS a theme carries. Selecting a theme applies it only when it is a
 * string, so '' clears the Custom CSS and a missing key leaves it alone.
 * @param {object|null|undefined} theme Theme object.
 * @returns {string|null} Theme Custom CSS, or null when the theme carries none.
 */
export function getThemeCustomCss(theme) {
    return typeof theme?.custom_css === 'string' ? theme.custom_css : null;
}

/**
 * Builds an imported theme. The template's keys take the file's values, and Custom CSS
 * comes only from the file, never from the importer's current settings.
 * @param {object} parsed Parsed theme file.
 * @param {object} template Theme keys taken from the current settings.
 * @returns {object} Theme to save.
 */
export function buildImportedTheme(parsed, template) {
    const theme = { ...template };
    delete theme.custom_css;

    for (const key in parsed) {
        if (Object.hasOwn(theme, key)) {
            theme[key] = parsed[key];
        }
    }

    const customCss = getThemeCustomCss(parsed);

    if (customCss !== null) {
        theme.custom_css = customCss;
    }

    return theme;
}

/**
 * Checks whether a stored theme keeps a copy of the given Custom CSS. Blank CSS counts as
 * kept, since replacing it loses nothing.
 * @param {object[]} themes Stored themes.
 * @param {unknown} css Custom CSS.
 * @returns {boolean} Whether replacing the CSS keeps a copy of it.
 */
export function isCssStoredInThemes(themes, css) {
    const target = normalizeThemeCss(css);

    if (!target) {
        return true;
    }

    return themes.some(theme => {
        const themeCss = getThemeCustomCss(theme);
        return themeCss !== null && normalizeThemeCss(themeCss) === target;
    });
}

/**
 * Checks whether switching to a theme needs confirmation: the theme's Custom CSS would
 * replace the current Custom CSS, and no stored theme keeps a copy of the current CSS.
 * @param {object} nextTheme Theme to switch to.
 * @param {unknown} liveCss Current Custom CSS.
 * @param {object[]} themes Stored themes.
 * @returns {boolean} Whether to ask before switching.
 */
export function shouldConfirmCssReplace(nextTheme, liveCss, themes) {
    const nextCss = getThemeCustomCss(nextTheme);

    if (nextCss === null || normalizeThemeCss(nextCss) === normalizeThemeCss(liveCss)) {
        return false;
    }

    return !isCssStoredInThemes(themes, liveCss);
}
