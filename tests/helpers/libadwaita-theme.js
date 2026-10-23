import { readFileSync } from 'node:fs';

// Fixture pages skip power-user.js, so apply the bundled Libadwaita theme (the target theme) the way
// applyThemeColor() does: theme colours become the SmartTheme* custom properties on the root element.
const THEME_VARIABLES = {
    main_text_color: '--SmartThemeBodyColor',
    italics_text_color: '--SmartThemeEmColor',
    underline_text_color: '--SmartThemeUnderlineColor',
    quote_text_color: '--SmartThemeQuoteColor',
    blur_tint_color: '--SmartThemeBlurTintColor',
    chat_tint_color: '--SmartThemeChatTintColor',
    user_mes_blur_tint_color: '--SmartThemeUserMesBlurTintColor',
    bot_mes_blur_tint_color: '--SmartThemeBotMesBlurTintColor',
    shadow_color: '--SmartThemeShadowColor',
    border_color: '--SmartThemeBorderColor',
};

/** @param {'Libadwaita'|'Libadwaita Light'} [name] */
export function libadwaitaThemeVariables(name = 'Libadwaita') {
    const theme = JSON.parse(readFileSync(new URL(`../../default/content/themes/${name}.json`, import.meta.url), 'utf8'));
    return Object.fromEntries(Object.entries(THEME_VARIABLES)
        .filter(([key]) => typeof theme[key] === 'string')
        .map(([key, variable]) => [variable, theme[key]]));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'Libadwaita'|'Libadwaita Light'} [name]
 */
export async function applyLibadwaitaTheme(page, name = 'Libadwaita') {
    await page.evaluate(variables => {
        for (const [variable, value] of Object.entries(variables)) {
            document.documentElement.style.setProperty(variable, value);
        }
    }, libadwaitaThemeVariables(name));
}
