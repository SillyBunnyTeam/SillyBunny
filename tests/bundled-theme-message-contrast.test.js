import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';

import { MESSAGE_TEXT_CONTRAST, NAME_STYLES, PICTURE_STAND_INS, STYLE_SURFACES, lowestMessageContrast, lowestNameContrast, messageSurfaces, nameColours } from './helpers/theme-message-contrast.js';

const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themes = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort()
    .map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));
const powerUserSource = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
const chatStylesSource = readFileSync(new URL('../public/css/sillybunny-chat-styles.css', import.meta.url), 'utf8');

/** The body class that each chat style puts on `<body>` (`CHAT_STYLE_BODY_CLASSES` in power-user.js), by the style's name in `STYLE_SURFACES`. */
const STYLE_BODY_CLASSES = Object.freeze({
    flat: 'flatchat',
    bubbles: 'bubblechat',
    document: 'documentstyle',
    echo: 'echostyle',
    whisper: 'whisperstyle',
    hush: 'hushstyle',
    ripple: 'ripplestyle',
    tide: 'tidestyle',
});

/** Without a picture, and over each stand-in for the darkest and the brightest end of the bright and the dark picture. */
const CASES = Object.freeze([['no picture', null], ...Object.entries(PICTURE_STAND_INS)]);

function weakCellsOf(theme) {
    const weak = [];
    for (const style of Object.keys(STYLE_SURFACES)) {
        for (const [label, picture] of CASES) {
            const { ratio, role } = lowestMessageContrast(theme, style, picture);
            if (ratio < MESSAGE_TEXT_CONTRAST) {
                weak.push(`${theme.name}: ${role} in ${style}, ${label}, is ${ratio.toFixed(2)}:1`);
            }
        }
    }
    return weak;
}

function weakNamesOf(theme) {
    const weak = [];
    for (const style of NAME_STYLES) {
        for (const [label, picture] of CASES) {
            const { ratio, speaker } = lowestNameContrast(theme, style, picture);
            if (ratio < MESSAGE_TEXT_CONTRAST) {
                weak.push(`${theme.name}: the ${speaker} name in ${style}, ${label}, is ${ratio.toFixed(2)}:1`);
            }
        }
    }
    return weak;
}

describe('bundled theme message text contrast', () => {
    test('covers every bundled theme', () => {
        expect(themes.length).toBeGreaterThan(0);
        expect(new Set(themes.map(theme => theme.name)).size).toBe(themes.length);
    });

    test('has a surface recipe for each chat style of power-user.js, and for no other', () => {
        const classesInSource = [...powerUserSource.matchAll(/\[chat_styles\.\w+\]: '(\w+)',/g)].map(match => match[1]);

        expect(classesInSource.sort()).toEqual(Object.values(STYLE_BODY_CLASSES).sort());
        expect(Object.keys(STYLE_SURFACES).sort()).toEqual(Object.keys(STYLE_BODY_CLASSES).sort());
    });

    test.each(themes.map(theme => [theme.name, theme]))('%s keeps main text, italics and quotes at 4.5:1 in every chat style, without and with a background picture', (_name, theme) => {
        expect(weakCellsOf(theme)).toEqual([]);
    });

    test('a translucent message tint lets a bright picture lower the contrast of light text', () => {
        const glass = { ...themes.find(theme => theme.name === 'Azure'), chat_tint_color: 'rgba(23, 23, 23, 0)' };

        expect(weakCellsOf(glass).some(line => line.includes('bright picture, bright end'))).toBe(true);
    });

    test('paints the message tint over the chat column, and Flat paints the bot tint for both speakers', () => {
        const theme = { ...themes[0], chat_tint_color: 'rgba(0, 0, 0, 1)', bot_mes_blur_tint_color: 'rgba(200, 0, 0, 1)', user_mes_blur_tint_color: 'rgba(0, 200, 0, 1)' };

        expect(messageSurfaces(theme, 'flat', null)).toEqual([[200, 0, 0]]);
        expect(messageSurfaces(theme, 'tide', [255, 255, 255])).toEqual([[200, 0, 0], [0, 200, 0]]);
    });

    test('a ring on the Bubbles card does not change the surface under its text', () => {
        const theme = themes.find(theme => theme.name === 'Dracula');

        expect(messageSurfaces(theme, 'bubbles', null)).toEqual(messageSurfaces(theme, 'document', null));
    });

    test.each(themes.map(theme => [theme.name, theme]))('%s keeps character names at 4.5:1 in the chat styles where a name has no card of its own', (_name, theme) => {
        expect(weakNamesOf(theme)).toEqual([]);
    });

    test('a user name takes the colour that the theme CSS gives it, and a bot name the main text colour', () => {
        const amber = themes.find(theme => theme.name === 'Amber Dusk');
        const dracula = themes.find(theme => theme.name === 'Dracula');
        const plain = themes.find(theme => theme.name === 'Libadwaita');

        expect(nameColours(amber)[1].rgb).toEqual([250, 189, 47]);
        expect(nameColours(dracula)[0]).toEqual({ rgb: [225, 215, 239], alpha: 0.74 });
        expect(nameColours(dracula)[1].rgb).toEqual([200, 163, 255]);
        expect(nameColours(plain)[1]).toEqual(nameColours(plain)[0]);
    });

    test('a name on a translucent tint over a bright picture fails, which is why the name has its own surface', () => {
        const glass = { ...themes.find(theme => theme.name === 'Amber Dusk'), user_mes_blur_tint_color: 'rgba(67, 40, 33, 0)', bot_mes_blur_tint_color: 'rgba(58, 31, 24, 0)' };

        expect(weakNamesOf(glass).some(line => line.includes('bright picture, bright end'))).toBe(true);
    });

    test('the chat styles stylesheet paints the message tints under the names that the name guard assumes a surface for', () => {
        const selectorList = NAME_STYLES.map(style => `.${STYLE_BODY_CLASSES[style]}`).join(', ');
        const rule = /body:is\(([^)]*)\) #chat \.mes \.name_text \{([^}]*)\}/.exec(chatStylesSource);
        const userRule = /body:is\(([^)]*)\) #chat \.mes\[is_user="true"\] \.name_text \{([^}]*)\}/.exec(chatStylesSource.slice(chatStylesSource.indexOf(rule?.[0] ?? '')));

        expect(rule?.[1]).toBe(selectorList);
        expect(rule?.[2]).toContain('--moonlit-sb-name-surface: var(--moonlit-sb-bot-message-bg);');
        expect(rule?.[2]).toContain('background: linear-gradient(var(--moonlit-sb-name-surface), var(--moonlit-sb-name-surface)), var(--moonlit-sb-name-surface);');
        expect(userRule?.[1]).toBe(selectorList);
        expect(userRule?.[2]).toContain('--moonlit-sb-name-surface: var(--moonlit-sb-user-message-bg);');
        expect(chatStylesSource).toContain('--moonlit-sb-bot-message-bg: color-mix(in srgb, var(--SmartThemeBotMesBlurTintColor)');
        expect(chatStylesSource).toContain('--moonlit-sb-user-message-bg: color-mix(in srgb, var(--SmartThemeUserMesBlurTintColor)');
    });

    test('rejects a chat style without a name surface', () => {
        expect(() => lowestNameContrast(themes[0], 'flat', null)).toThrow('no name surface');
    });

    test('rejects a chat style it has no recipe for', () => {
        expect(() => messageSurfaces(themes[0], 'unknown', null)).toThrow('Unknown chat style');
    });
});
