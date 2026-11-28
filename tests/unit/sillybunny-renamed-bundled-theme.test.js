/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { readFileSync } from 'node:fs';

import { describe, expect, test } from '@jest/globals';

import { getRenamedBundledThemeName } from '../../public/scripts/sillybunny-theme-css.js';
import { REVISED_THEMES, THEME_TEXT_REVISION } from '../../public/scripts/sillybunny-theme-revisions.js';
import { importPowerUserModule } from '../util/power-user-harness.js';

const libadwaitaDark = JSON.parse(readFileSync(new URL('../../default/content/themes/Libadwaita Dark.json', import.meta.url), 'utf8'));
const { powerUser } = await importPowerUserModule();

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
    test('renames the saved Libadwaita selection before text and palette repairs look up the theme by name', async () => {
        const oldPalette = REVISED_THEMES['Libadwaita Dark'].old;

        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Libadwaita',
                    ...oldPalette,
                    custom_css: libadwaitaDark.custom_css,
                    sb_theme_text_revision: 0,
                },
            },
            {
                themes: [libadwaitaDark],
                context: [],
                instruct: [],
                sysprompt: [],
                reasoning: [],
            },
        );

        // Selection moved from 'Libadwaita' to 'Libadwaita Dark', AND text repair found 'Libadwaita Dark' by its new name.
        expect(powerUser.power_user.theme).toBe('Libadwaita Dark');
        expect(powerUser.power_user.sb_theme_text_revision).toBe(THEME_TEXT_REVISION);
        expect(powerUser.power_user.main_text_color).toBe(libadwaitaDark.main_text_color);
        expect(powerUser.power_user.quote_text_color).toBe(libadwaitaDark.quote_text_color);
    });
});
