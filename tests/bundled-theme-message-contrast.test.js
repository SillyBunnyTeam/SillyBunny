import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';

import { MESSAGE_TEXT_CONTRAST, PICTURE_STAND_INS, STYLE_SURFACES, lowestMessageContrast, messageSurfaces } from './helpers/theme-message-contrast.js';

const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themes = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort()
    .map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));
const powerUserSource = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');

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

    test('rejects a chat style it has no recipe for', () => {
        expect(() => messageSurfaces(themes[0], 'unknown', null)).toThrow('Unknown chat style');
    });
});
