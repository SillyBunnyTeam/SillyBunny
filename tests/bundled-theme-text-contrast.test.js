import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';

const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themeFiles = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort();
const themes = themeFiles.map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));

/** DESIGN.md Contrast Rule: body text, and heading text at the sizes the app renders it, needs 4.5:1. */
const TEXT_CONTRAST = 4.5;
/** The surface tone switches to light above this relative luminance of the blur tint (power-user.js applyLandingContrastPalette). */
const LIGHT_SURFACE_LUMINANCE = 0.36;

function parseColor(value) {
    const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
    if (!match) {
        throw new Error(`Not an rgb() colour: ${value}`);
    }
    return { rgb: match.slice(1, 4).map(Number), alpha: match[4] === undefined ? 1 : Number(match[4]) };
}

function luminance(channels) {
    return channels.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

const contrast = (first, second) => (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);

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

/** The surfaces a theme's text sits on, from its own tints: page, chat column, Window layer, and both message tints over the column. */
function surfacesOf(theme) {
    const page = pageTone(parseColor(theme.blur_tint_color), parseColor(theme.main_text_color));
    const chatColumn = paint(parseColor(theme.chat_tint_color), page);
    return {
        page,
        'chat column': chatColumn,
        'window layer': parseColor(theme.blur_tint_color).rgb,
        'user message': paint(parseColor(theme.user_mes_blur_tint_color), chatColumn),
        'bot message': paint(parseColor(theme.bot_mes_blur_tint_color), chatColumn),
    };
}

/** Custom CSS variables a theme declares on :root, such as --customThemeColor-text. */
function customThemeColors(css) {
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    return Object.fromEntries([...root.matchAll(/(--customThemeColor-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

/** Inline code sits on the blur tint at 70%, painted over whichever surface the code is in. */
const INLINE_CODE_LAYER_ALPHA = 0.7;
/** Inline code without a colour of its own is the body colour at 70%. */
const INLINE_CODE_BODY_ALPHA = 0.7;
/**
 * Libadwaita Light keeps libadwaita's own standalone blue (#0461be) for quote text. It is 4.41:1 on the page tone,
 * which only shows beside the chat column and paints no quote text: Home derives its own, darker link colour.
 */
const BELOW_FLOOR_ON_PAGE_TONE = new Set(['Libadwaita Light: quote']);
const ALL_SURFACES = ['page', 'chat column', 'window layer', 'user message', 'bot message'];

/** Link, heading, inline code and user name colours that custom CSS takes from the theme's own variables. */
function customTextRoles(theme) {
    const variables = customThemeColors(theme.custom_css);
    const rules = [
        ['link', /(?:^|\n)a\s*\{\s*color:\s*var\((--customThemeColor-[\w-]+)\)/, ALL_SURFACES],
        ['link hover', /(?:^|\n)a:hover\s*\{\s*color:\s*var\((--customThemeColor-[\w-]+)\)/, ALL_SURFACES],
        ['heading', /(?:^|\n)h1,\s*h2,\s*h3\s*\{\s*color:\s*var\((--customThemeColor-[\w-]+)\)/, ALL_SURFACES],
        ['inline code', /(?:^|\n)code\s*\{\s*color:\s*var\((--customThemeColor-[\w-]+)\)/, ALL_SURFACES],
        ['user name', /\.name_text\s*\{\s*color:\s*var\((--customThemeColor-[\w-]+)\)/, ['user message']],
    ];
    return rules.flatMap(([role, pattern, surfaces]) => {
        const name = pattern.exec(theme.custom_css)?.[1];
        return name && variables[name] ? [{ role, value: variables[name], surfaces }] : [];
    });
}

/** Every text colour a theme defines, with the surfaces that colour has to hold up on. */
function textRolesOf(theme) {
    const roles = [
        { role: 'main text', value: theme.main_text_color, surfaces: ALL_SURFACES },
        { role: 'italics', value: theme.italics_text_color, surfaces: ALL_SURFACES },
        { role: 'underline', value: theme.underline_text_color, surfaces: ALL_SURFACES },
        { role: 'quote', value: theme.quote_text_color, surfaces: ALL_SURFACES },
        ...customTextRoles(theme),
    ];
    if (!roles.some(({ role }) => role === 'inline code')) {
        const body = parseColor(theme.main_text_color);
        roles.push({ role: 'inline code', value: `rgba(${body.rgb.join(', ')}, ${body.alpha * INLINE_CODE_BODY_ALPHA})`, surfaces: ALL_SURFACES });
    }
    return roles;
}

function weakTextOf(theme) {
    const surfaces = surfacesOf(theme);
    const blur = parseColor(theme.blur_tint_color);
    const codeLayer = { rgb: blur.rgb, alpha: blur.alpha * INLINE_CODE_LAYER_ALPHA };
    const weak = [];
    for (const { role, value, surfaces: roleSurfaces } of textRolesOf(theme)) {
        const text = parseColor(value);
        for (const surfaceName of roleSurfaces) {
            if (surfaceName === 'page' && BELOW_FLOOR_ON_PAGE_TONE.has(`${theme.name}: ${role}`)) {
                continue;
            }
            const surface = role === 'inline code' ? paint(codeLayer, surfaces[surfaceName]) : surfaces[surfaceName];
            const ratio = contrast(paint(text, surface), surface);
            if (ratio < TEXT_CONTRAST) {
                weak.push(`${theme.name}: ${role} ${value} on ${surfaceName} is ${ratio.toFixed(2)}:1`);
            }
        }
    }
    return weak;
}

describe('bundled theme text contrast', () => {
    test('covers every bundled theme', () => {
        expect(themes.length).toBeGreaterThan(0);
        expect(themes.map(theme => `${theme.name}.json`)).toEqual(themeFiles);
    });

    test.each(themes.map(theme => [theme.name, theme]))('%s keeps its text colours at 4.5:1 on the surfaces it paints', (_name, theme) => {
        expect(weakTextOf(theme)).toEqual([]);
    });

    test('reads the text colours that custom CSS takes from the theme variables', () => {
        const everforest = themes.find(theme => theme.name === 'Everforest Dark');
        const roles = textRolesOf(everforest).map(({ role }) => role);

        expect(roles).toEqual(expect.arrayContaining(['main text', 'italics', 'underline', 'quote', 'link', 'link hover', 'heading', 'inline code', 'user name']));
    });

    test('flags text that is too weak on the page tone it also moves', () => {
        const weakPink = { ...themes.find(theme => theme.name === 'Rosé Pine Dawn'), main_text_color: 'rgba(215, 130, 126, 1)' };

        expect(weakTextOf(weakPink).some(line => line.includes('main text') && line.includes('page'))).toBe(true);
    });
});
