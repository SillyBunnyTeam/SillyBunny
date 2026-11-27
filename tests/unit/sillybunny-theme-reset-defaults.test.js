import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME_RESET_DEFAULTS } from '../../public/scripts/sillybunny-theme-css.js';
import { importPowerUserModule } from '../util/power-user-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readText = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');
const bundledTheme = JSON.parse(readText('default', 'content', 'themes', 'Libadwaita Dark.json'));
const freshInstall = JSON.parse(readText('default', 'content', 'settings.json')).power_user;

const { powerUser } = await importPowerUserModule();

const COLOR_KEYS = [
    'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color', 'blur_tint_color',
    'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color', 'shadow_color', 'border_color',
];
const EFFECT_KEYS = ['customCSS-bg-blur', 'customCSS-bg-opacity', 'sheldBlurStrength', 'sheldBackgroundColor'];

describe('the theme reset defaults', () => {
    test('are frozen', () => {
        expect(Object.isFrozen(THEME_RESET_DEFAULTS)).toBe(true);
    });

    test('hold exactly the keys that the reset writes', () => {
        expect(Object.keys(THEME_RESET_DEFAULTS).sort()).toEqual(
            ['theme', ...COLOR_KEYS, 'custom_css', ...EFFECT_KEYS, 'blur_strength', 'shadow_width', 'google_font'].sort(),
        );
    });

    test('take the selected theme, the ten colors and empty Custom CSS from the bundled Libadwaita theme', () => {
        expect(THEME_RESET_DEFAULTS.theme).toBe(bundledTheme.name);
        for (const key of [...COLOR_KEYS, 'custom_css']) expect(THEME_RESET_DEFAULTS[key]).toBe(bundledTheme[key]);
        expect(THEME_RESET_DEFAULTS.custom_css).toBe('');
    });

    test('take the effect keys from the power_user effect defaults', () => {
        const snapshot = powerUser.getThemeObject('probe');
        for (const key of EFFECT_KEYS) {
            expect(THEME_RESET_DEFAULTS[key]).toBe(powerUser.power_user[key]);
            expect(snapshot[key]).toBe(THEME_RESET_DEFAULTS[key]);
        }
    });

    test('take Blur Strength and Shadow Width from the fresh-install settings', () => {
        expect(THEME_RESET_DEFAULTS.blur_strength).toBe(freshInstall.blur_strength);
        expect(THEME_RESET_DEFAULTS.shadow_width).toBe(freshInstall.shadow_width);
    });

    test('take the font choice from the power_user default, which is none', () => {
        expect(powerUser.power_user.google_font).toBe('');
        expect(THEME_RESET_DEFAULTS.google_font).toBe('');
    });

    test('agree with the fresh-install colors, which are the bundled theme colors', () => {
        for (const key of COLOR_KEYS) expect(THEME_RESET_DEFAULTS[key]).toBe(freshInstall[key]);
    });
});
