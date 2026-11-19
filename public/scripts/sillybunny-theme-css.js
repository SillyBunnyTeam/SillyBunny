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
 * Checks whether the current Custom CSS differs from the CSS a theme stores. A theme
 * without Custom CSS counts as storing none.
 * @param {object|null|undefined} theme Stored theme, if there is one.
 * @param {unknown} liveCss Current Custom CSS.
 * @returns {boolean} Whether the Custom CSS has changes the theme does not store.
 */
export function isThemeCssDirty(theme, liveCss) {
    return normalizeThemeCss(getThemeCustomCss(theme) ?? '') !== normalizeThemeCss(liveCss);
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

/**
 * Adds CSS below the current Custom CSS, with a blank line between them.
 * @param {unknown} css Current Custom CSS.
 * @param {string} addition CSS to add.
 * @returns {string} Combined CSS.
 */
export function appendCustomCss(css, addition) {
    const currentCss = String(css ?? '');
    return currentCss.trim() ? `${currentCss.trimEnd()}\n\n${addition}` : addition;
}

/**
 * Gets the Custom CSS to apply when an AI wand generation finishes. Append adds the result
 * below the CSS as it is now, so edits made during generation stay. Replace gives null when
 * the CSS changed during generation and is not blank, since replacing it would drop those
 * changes.
 * @param {object} options Generation state.
 * @param {string} options.mode Apply mode picked in the wand popup: 'replace' or 'append'.
 * @param {unknown} options.startCss Custom CSS when generation started.
 * @param {unknown} options.liveCss Custom CSS now.
 * @param {string} options.generatedCss CSS the AI returned.
 * @returns {string|null} CSS to apply, or null when replacing needs confirmation.
 */
export function getGeneratedCustomCss({ mode, startCss, liveCss, generatedCss }) {
    if (mode === 'append') {
        return appendCustomCss(liveCss, generatedCss);
    }

    const currentCss = normalizeThemeCss(liveCss);
    return !currentCss || currentCss === normalizeThemeCss(startCss) ? generatedCss : null;
}

/**
 * What "Reset Theme to Default Libadwaita" writes into the settings. The keys of a saved theme (the ten colors,
 * Custom CSS, the selected theme) come from `default/content/themes/Libadwaita.json`, the file SillyBunny ships, and not
 * from the user's saved copy, which an Update may have changed. The effect keys, `blur_strength`, `shadow_width` and
 * `google_font` are the fresh-install values: the first four are the `defaultValue` of `THEME_EFFECT_PROPERTIES` in
 * `power-user.js`, the rest are in `default/content/settings.json` and in the `power_user` defaults there. The bundled
 * theme file's own `shadow_width` is a legacy key that no code reads, so it is not the source of that value.
 * `tests/unit/sillybunny-theme-reset-defaults.test.js` holds each group to its source.
 */
export const THEME_RESET_DEFAULTS = Object.freeze({
    theme: 'Libadwaita',
    main_text_color: 'rgba(255, 255, 255, 1)',
    italics_text_color: 'rgba(170, 170, 172, 1)',
    underline_text_color: 'rgba(170, 170, 172, 1)',
    quote_text_color: 'rgba(129, 208, 255, 1)',
    blur_tint_color: 'rgba(34, 34, 38, 0.9)',
    chat_tint_color: 'rgba(29, 29, 32, 0.9)',
    user_mes_blur_tint_color: 'rgba(29, 29, 32, 0.9)',
    bot_mes_blur_tint_color: 'rgba(29, 29, 32, 0.9)',
    shadow_color: 'rgba(0, 0, 6, 0.36)',
    border_color: 'rgba(0, 0, 6, 0.5)',
    custom_css: '',
    'customCSS-bg-blur': 0,
    'customCSS-bg-opacity': 1,
    sheldBlurStrength: 0,
    sheldBackgroundColor: 'transparent',
    blur_strength: 13,
    shadow_width: 2,
    google_font: '',
});
