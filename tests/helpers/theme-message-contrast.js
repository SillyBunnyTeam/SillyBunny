/**
 * The contrast of message text in a bundled theme, computed from the theme file alone.
 *
 * A message's text sits on the message tint, painted over the chat column's tint, painted over what lies under the chat:
 * the page tone when no background picture is set, or the picture. The chat styles differ in which tint they paint and in
 * what they paint at all, so each style maps to one surface recipe (see `STYLE_SURFACES`). The surfaces below follow
 * `public/css/sillybunny-chat-styles.css` and the Bubbles rules in `public/css/sillybunny-theme.css`.
 */

/** WCAG 2.2 AA for normal text. */
export const MESSAGE_TEXT_CONTRAST = 4.5;

/** Where the theme's blur tint turns the surface tone light (`applyLandingContrastPalette` in `public/scripts/power-user.js`). */
const LIGHT_SURFACE_LUMINANCE = 0.36;

/**
 * Colours that stand in for a background picture. A picture is not one colour, and the contrast of text over it is set by
 * the pixels that lie closest to the text colour, so each picture has the colours of its darkest and its brightest 5% of
 * pixels (the mean of the 4th to the 6th and of the 94th to the 96th percentile of luminance, over the part of the picture
 * that lies behind the chat column at 1440x900). Light text fails on the bright end and dark text on the dark end.
 * The bright picture is `backgrounds/cityscape medieval market.jpg`, the dark one `backgrounds/cityscape medieval night.jpg`.
 */
export const PICTURE_STAND_INS = Object.freeze({
    'bright picture, dark end': [50, 36, 29],
    'bright picture, bright end': [225, 225, 224],
    'dark picture, dark end': [36, 27, 24],
    'dark picture, bright end': [173, 142, 119],
});

/**
 * The surface under the text of each chat style, by body class value of `#chat_display`:
 * - `column`: Flat paints no tint per message; the column carries the bot tint for every message.
 * - `message`: the message's own tint over the column (Bubbles, Document, Echo, Whisper, Hush, Ripple and Tide). Bubbles
 *   marks its card with a ring that is an inset shadow, so the ring does not change the surface under the text.
 */
export const STYLE_SURFACES = Object.freeze({
    flat: 'column',
    bubbles: 'message',
    document: 'message',
    echo: 'message',
    whisper: 'message',
    hush: 'message',
    ripple: 'message',
    tide: 'message',
});

/**
 * @param {string} value An `rgb()` or `rgba()` colour.
 * @returns {{ rgb: number[], alpha: number }}
 */
export function parseColor(value) {
    const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
    if (!match) {
        throw new Error(`Not an rgb() colour: ${value}`);
    }
    return { rgb: match.slice(1, 4).map(Number), alpha: match[4] === undefined ? 1 : Number(match[4]) };
}

function luminance(channels) {
    return channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(first, second) {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
}

/** `top` painted over an opaque colour. */
const paint = (top, under) => top.rgb.map((channel, index) => channel * top.alpha + under[index] * (1 - top.alpha));

/**
 * `--sb-page-bg-source`: the blur tint mixed with the body colour (88/12, or 86/14 on a light surface), premultiplied
 * like color-mix(in srgb), then painted as an opaque page background.
 */
function pageTone(blur, body) {
    const light = luminance(blur.rgb) > LIGHT_SURFACE_LUMINANCE;
    const blurWeight = (light ? 0.86 : 0.88) * blur.alpha;
    const bodyWeight = (light ? 0.14 : 0.12) * body.alpha;
    return blur.rgb.map((channel, index) => (channel * blurWeight + body.rgb[index] * bodyWeight) / (blurWeight + bodyWeight));
}

/**
 * Every opaque colour a message's text can sit on in a theme and chat style.
 * @param {object} theme A theme file.
 * @param {string} styleId A key of `STYLE_SURFACES`.
 * @param {number[] | null} picture The colour of the picture under the chat, or null for no picture.
 * @returns {number[][]} One surface per speaker.
 */
export function messageSurfaces(theme, styleId, picture) {
    return surfacesOf(theme, styleId, picture, 1);
}

/** The surfaces of `messageSurfaces`, with each message tint painted `layers` times. */
function surfacesOf(theme, styleId, picture, layers) {
    const recipe = STYLE_SURFACES[styleId];
    if (!recipe) {
        throw new Error(`Unknown chat style "${styleId}".`);
    }
    const body = parseColor(theme.main_text_color);
    const under = picture ?? pageTone(parseColor(theme.blur_tint_color), body);
    const column = paint(parseColor(theme.chat_tint_color), under);
    const layered = (tint) => {
        let surface = column;
        for (let layer = 0; layer < layers; layer++) {
            surface = paint(tint, surface);
        }
        return surface;
    };
    const botTint = parseColor(theme.bot_mes_blur_tint_color);
    const userTint = parseColor(theme.user_mes_blur_tint_color);

    if (recipe === 'column') {
        return [layered(botTint)];
    }
    return [layered(botTint), layered(userTint)];
}

/**
 * The chat styles whose name row has no card of its own. `public/css/sillybunny-chat-styles.css` gives the name the message
 * tint as its own surface there, painted twice over the chat column, so a name sits on the message surface of its speaker with
 * a second layer of the tint.
 */
export const NAME_STYLES = Object.freeze(['echo', 'whisper', 'hush', 'ripple', 'tide']);

/**
 * The name colour of each speaker, bot first. A bot's name takes the main text colour; a user's name takes the colour that
 * the theme's Custom CSS gives to `.name_text` of a user message, which is a `--customThemeColor-*` variable that the same
 * CSS defines, or the main text colour when the CSS does not set one.
 * @param {object} theme A theme file.
 * @returns {object[]} Two parsed colours: bot, user.
 */
export function nameColours(theme) {
    const css = theme.custom_css ?? '';
    const variable = /\.name_text\s*\{\s*color:\s*var\((--[\w-]+)\)/.exec(css)?.[1];
    const defined = variable && new RegExp(`${variable}\\s*:\\s*([^;]+);`).exec(css)?.[1];
    return [parseColor(theme.main_text_color), parseColor(defined ?? theme.main_text_color)];
}

/**
 * The lowest contrast of a character name in a chat style whose names sit on their own surface, over one picture (or none).
 * @param {object} theme A theme file.
 * @param {string} styleId One of `NAME_STYLES`.
 * @param {number[] | null} picture
 * @returns {{ ratio: number, speaker: string }}
 */
export function lowestNameContrast(theme, styleId, picture) {
    if (!NAME_STYLES.includes(styleId)) {
        throw new Error(`Chat style "${styleId}" has no name surface.`);
    }
    const surfaces = surfacesOf(theme, styleId, picture, 2);
    const colours = nameColours(theme);
    let lowest = { ratio: Infinity, speaker: '' };
    surfaces.forEach((surface, index) => {
        const ratio = contrast(paint(colours[index], surface), surface);
        if (ratio < lowest.ratio) {
            lowest = { ratio, speaker: index === 0 ? 'bot' : 'user' };
        }
    });
    return lowest;
}

/** The text colours that sit in a message: body, italics and quotes. */
const textColoursOf = theme => Object.entries({
    'main text': theme.main_text_color,
    italics: theme.italics_text_color,
    quote: theme.quote_text_color,
}).map(([role, value]) => [role, parseColor(value)]);

/**
 * The lowest contrast of the message text of a theme, in one chat style and over one picture (or none).
 * @param {object} theme A theme file.
 * @param {string} styleId A key of `STYLE_SURFACES`.
 * @param {number[] | null} picture
 * @param {string[]} [roles] The text colours to check; all of them by default.
 * @returns {{ ratio: number, role: string }}
 */
export function lowestMessageContrast(theme, styleId, picture, roles) {
    let lowest = { ratio: Infinity, role: '' };
    for (const surface of messageSurfaces(theme, styleId, picture)) {
        for (const [role, text] of textColoursOf(theme)) {
            if (roles && !roles.includes(role)) {
                continue;
            }
            const ratio = contrast(paint(text, surface), surface);
            if (ratio < lowest.ratio) {
                lowest = { ratio, role };
            }
        }
    }
    return lowest;
}
