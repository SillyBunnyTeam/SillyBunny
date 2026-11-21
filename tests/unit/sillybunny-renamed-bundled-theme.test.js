import { readFileSync } from 'node:fs';

import { describe, expect, test } from '@jest/globals';

import { getRenamedBundledThemeName } from '../../public/scripts/sillybunny-theme-css.js';

describe('getRenamedBundledThemeName', () => {
    test('selects Libadwaita Dark when the saved selection is Libadwaita and no Libadwaita theme is loaded', () => {
        expect(getRenamedBundledThemeName('Libadwaita', [{ name: 'Libadwaita Dark' }, { name: 'Libadwaita Light' }])).toBe('Libadwaita Dark');
        expect(getRenamedBundledThemeName('Libadwaita', [])).toBe('Libadwaita Dark');
    });

    test('keeps the selection when an edited Libadwaita theme is loaded', () => {
        expect(getRenamedBundledThemeName('Libadwaita', [{ name: 'Libadwaita' }, { name: 'Libadwaita Dark' }])).toBeNull();
    });

    test.each(['Libadwaita Dark', 'Libadwaita Light', 'Dark V 1.0', 'libadwaita', '', undefined])('leaves the name %p alone', (name) => {
        expect(getRenamedBundledThemeName(name, [{ name: 'Libadwaita Dark' }])).toBeNull();
    });

    test('ignores loaded entries without a name', () => {
        expect(getRenamedBundledThemeName('Libadwaita', [null, {}, { name: 'Cinder' }])).toBe('Libadwaita Dark');
    });
});

describe('loadPowerUserSettings', () => {
    test('renames the selection before the palette and text repairs, which find the theme by name', () => {
        const source = readFileSync(new URL('../../public/scripts/power-user.js', import.meta.url), 'utf8');
        const rename = source.indexOf('getRenamedBundledThemeName(power_user.theme, themes)');
        const paletteRepair = source.indexOf('const migratedTheme = themes.find');
        const textRepair = source.indexOf('planThemeTextRepair({');

        expect(rename).toBeGreaterThan(source.indexOf('themes = data.themes;'));
        expect(rename).toBeLessThan(paletteRepair);
        expect(rename).toBeLessThan(textRepair);
    });
});
