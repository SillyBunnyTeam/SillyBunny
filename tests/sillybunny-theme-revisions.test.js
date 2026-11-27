import { describe, expect, jest, test } from '@jest/globals';
import fs, { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { importPowerUserModule } from './util/power-user-harness.js';
import {
    THEME_COLOR_KEYS,
    THEME_REVISED_KEYS,
    THEME_TEXT_KEYS,
    THEME_TINT_KEYS,
    REVISED_THEMES,
    THEME_TEXT_REVISION,
    hashThemeCss,
    planThemeTextRepair,
} from '../public/scripts/sillybunny-theme-revisions.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { reconcileManagedBundledThemes } = await import('../src/endpoints/content-manager.js');
const { powerUser } = await importPowerUserModule();

const readJson = url => JSON.parse(readFileSync(url, 'utf8'));
const bundled = name => readJson(new URL(`../default/content/themes/${name}.json`, import.meta.url));
/** The file as it shipped before the text colors were raised. */
const previous = name => readJson(new URL(`./fixtures/stale-bundled-themes/${name}.json`, import.meta.url));

const bundledNames = readdirSync(new URL('../default/content/themes/', import.meta.url)).map(file => file.replace(/\.json$/, ''));
const unrevisedNames = bundledNames.filter(name => !Object.hasOwn(REVISED_THEMES, name));

/** The Dark V migration renames this theme to Libadwaita Dark before the repair runs, so a saved palette never carries its name. */
const RENAMED_BEFORE_REPAIR = ['Dark V 1.0'];

/**
 * Bundled themes that replace a retired file of another name. The server does not replace a copy of them, but the client renames a saved
 * selection of the retired theme before the repair runs, so a saved palette of the retired theme is found under the new name.
 */
const RENAMES_OF_RETIRED_THEMES = { 'Libadwaita Dark': 'Libadwaita.json' };

/** Names of the bundled themes the server reconciles, observed by running reconcileManagedBundledThemes against an empty folder. */
function managedThemeNames() {
    const tempThemesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-theme-revisions-'));
    const checkedFiles = [];
    const realExistsSync = fs.existsSync.bind(fs);
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
        if (typeof targetPath === 'string' && targetPath.startsWith(tempThemesDir) && targetPath !== tempThemesDir) {
            checkedFiles.push(path.basename(targetPath));
            return false;
        }
        return realExistsSync(targetPath);
    });
    try {
        reconcileManagedBundledThemes({ themes: tempThemesDir });
    } finally {
        existsSpy.mockRestore();
        fs.rmSync(tempThemesDir, { recursive: true, force: true });
    }
    const retiredFiles = new Set(Object.values(RENAMES_OF_RETIRED_THEMES));
    for (const retiredFile of retiredFiles) {
        expect(checkedFiles).toContain(retiredFile);
    }
    const managedNames = checkedFiles
        .filter(file => !retiredFiles.has(file) && file.endsWith('.json'))
        .map(file => file.replace(/\.json$/, ''));
    return [...new Set([...managedNames, ...Object.keys(RENAMES_OF_RETIRED_THEMES)])];
}

const paletteOf = theme => Object.fromEntries(THEME_COLOR_KEYS.map(key => [key, theme[key]]));

/** What a user has saved after selecting the previous Everforest Dark. */
function savedEverforestDark(overrides = {}) {
    const old = previous('Everforest Dark');
    return {
        themeName: 'Everforest Dark',
        palette: paletteOf(old),
        customCss: old.custom_css,
        themes: [bundled('Everforest Dark')],
        ...overrides,
    };
}

describe('revised theme text colors: matching', () => {
    test('an exact old palette and old CSS take the new text colors and the new CSS', () => {
        const revised = bundled('Everforest Dark');

        expect(planThemeTextRepair(savedEverforestDark())).toEqual({
            text: Object.fromEntries(THEME_REVISED_KEYS.map(key => [key, revised[key]])),
            css: revised.custom_css,
        });
        expect(revised.italics_text_color).not.toBe(previous('Everforest Dark').italics_text_color);
    });

    test('an old palette with edited CSS takes only the new text colors and keeps the CSS', () => {
        const plan = planThemeTextRepair(savedEverforestDark({ customCss: `${previous('Everforest Dark').custom_css}\n#chat { gap: 2px; }` }));

        expect(plan.text.italics_text_color).toBe(bundled('Everforest Dark').italics_text_color);
        expect(plan.css).toBeNull();
    });

    test('line endings and surrounding whitespace in the saved CSS do not count as an edit', () => {
        const css = `\n${previous('Everforest Dark').custom_css.replace(/\n/g, '\r\n')}  `;

        expect(planThemeTextRepair(savedEverforestDark({ customCss: css })).css).toBe(bundled('Everforest Dark').custom_css);
    });

    test('old CSS is kept when the loaded theme does not carry the revised CSS', () => {
        const plan = planThemeTextRepair(savedEverforestDark({ themes: [previous('Everforest Dark')] }));

        expect(plan.text.italics_text_color).toBe(bundled('Everforest Dark').italics_text_color);
        expect(plan.css).toBeNull();
    });

    test('a palette the user changed is left alone, whatever the CSS is', () => {
        for (const key of THEME_COLOR_KEYS) {
            const palette = { ...savedEverforestDark().palette, [key]: 'rgba(1, 2, 3, 1)' };

            expect([key, planThemeTextRepair(savedEverforestDark({ palette }))]).toEqual([key, null]);
        }
    });

    test('a palette that already has the new colors is left alone', () => {
        expect(planThemeTextRepair(savedEverforestDark({ palette: paletteOf(bundled('Everforest Dark')) }))).toBeNull();
    });

    test('the same palette under another theme name is left alone', () => {
        expect(planThemeTextRepair(savedEverforestDark({ themeName: 'My Everforest' }))).toBeNull();
        expect(planThemeTextRepair(savedEverforestDark({ themeName: undefined }))).toBeNull();
    });

    test('a theme that was not revised is left alone', () => {
        expect(unrevisedNames.length).toBeGreaterThan(0);
        const theme = bundled(unrevisedNames[0]);

        expect(planThemeTextRepair({ themeName: theme.name, palette: paletteOf(theme), customCss: theme.custom_css, themes: [theme] })).toBeNull();
    });

    test('a theme whose CSS did not change takes only the text colors', () => {
        const theme = bundled('Amber Dusk');
        const plan = planThemeTextRepair({ themeName: 'Amber Dusk', palette: REVISED_THEMES['Amber Dusk'].old, customCss: theme.custom_css, themes: [theme] });

        expect(plan).toEqual({ text: expect.objectContaining({ italics_text_color: theme.italics_text_color }), css: null });
    });
});

describe('revised theme text colors: the data', () => {
    test('has an entry for every managed theme that is still selected under its own name, and for no other', () => {
        const managed = managedThemeNames();

        expect(managed.filter(name => !bundledNames.includes(name))).toEqual([]);
        expect(Object.keys(REVISED_THEMES).sort()).toEqual(managed.filter(name => !RENAMED_BEFORE_REPAIR.includes(name)).sort());
    });

    test('has no entry for a theme the Dark V migration renames', () => {
        for (const name of RENAMED_BEFORE_REPAIR) {
            expect(Object.hasOwn(REVISED_THEMES, name)).toBe(false);
        }
    });

    test.each(Object.keys(REVISED_THEMES))('%s carries the colors and CSS of its bundled file as the new version', (name) => {
        const theme = bundled(name);
        const revision = REVISED_THEMES[name];

        expect(revision.text).toEqual(Object.fromEntries(THEME_REVISED_KEYS.map(key => [key, theme[key]])));
        expect(hashThemeCss(theme.custom_css)).toBe(revision.newCss);
        // The three colors a revision does not touch are the ones the file still has.
        for (const key of THEME_COLOR_KEYS.filter(key => !THEME_REVISED_KEYS.includes(key))) {
            expect([key, revision.old[key]]).toEqual([key, theme[key]]);
        }
    });

    test('a saved palette takes the message tints that the bundled file moved after the text colors', () => {
        const dracula = bundled('Dracula');
        const old = REVISED_THEMES.Dracula.old;
        const plan = planThemeTextRepair({ themeName: 'Dracula', palette: old, customCss: dracula.custom_css, themes: [dracula] });

        expect(Object.keys(plan.text)).toEqual([...THEME_REVISED_KEYS]);
        expect(old.user_mes_blur_tint_color).not.toBe(dracula.user_mes_blur_tint_color);
        expect(plan.text.user_mes_blur_tint_color).toBe(dracula.user_mes_blur_tint_color);
        expect(plan.text.bot_mes_blur_tint_color).toBe(dracula.bot_mes_blur_tint_color);
    });

    test('a user who changed one message tint, or the chat tint, keeps the whole saved palette', () => {
        const dracula = bundled('Dracula');
        for (const key of THEME_TINT_KEYS) {
            const palette = { ...REVISED_THEMES.Dracula.old, [key]: 'rgba(1, 2, 3, 0.5)' };

            expect([key, planThemeTextRepair({ themeName: 'Dracula', palette, customCss: dracula.custom_css, themes: [dracula] })]).toEqual([key, null]);
        }
    });

    test.each(Object.keys(REVISED_THEMES))('%s changed a text color or its CSS', (name) => {
        const revision = REVISED_THEMES[name];
        const textChanged = THEME_TEXT_KEYS.some(key => revision.old[key] !== revision.text[key]);

        expect(textChanged || revision.oldCss !== revision.newCss).toBe(true);
    });

    test('the previous Everforest Dark file is what the data calls the old version', () => {
        const old = previous('Everforest Dark');
        const revision = REVISED_THEMES['Everforest Dark'];

        expect(revision.old).toEqual(paletteOf(old));
        expect(revision.oldCss).toBe(hashThemeCss(old.custom_css));
        expect(revision.newCss).not.toBe(revision.oldCss);
    });

    test('the revision number recorded by power-user.js matches THEME_TEXT_REVISION', async () => {
        const dracula = bundled('Dracula');
        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Dracula',
                    ...REVISED_THEMES.Dracula.old,
                    custom_css: dracula.custom_css,
                    sb_theme_text_revision: THEME_TEXT_REVISION - 1,
                },
            },
            { themes: [dracula], context: [], instruct: [], sysprompt: [], reasoning: [] },
        );

        expect(powerUser.power_user.sb_theme_text_revision).toBe(THEME_TEXT_REVISION);
    });
});

describe('revised theme text colors: running once', () => {
    test('power-user.js repairs when the saved revision is below the current one, records it, and skips once current', async () => {
        const dracula = bundled('Dracula');
        const loadData = { themes: [dracula], context: [], instruct: [], sysprompt: [], reasoning: [] };

        // Below current revision: repairs old palette to the revised bundled colors and stamps THEME_TEXT_REVISION.
        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Dracula',
                    ...REVISED_THEMES.Dracula.old,
                    custom_css: dracula.custom_css,
                    sb_theme_text_revision: THEME_TEXT_REVISION - 1,
                },
            },
            loadData,
        );
        expect(powerUser.power_user.main_text_color).toBe(dracula.main_text_color);
        expect(powerUser.power_user.sb_theme_text_revision).toBe(THEME_TEXT_REVISION);

        // Already at current revision: leaves the saved palette untouched even if it matches the old revision.
        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Dracula',
                    ...REVISED_THEMES.Dracula.old,
                    custom_css: dracula.custom_css,
                    sb_theme_text_revision: THEME_TEXT_REVISION,
                },
            },
            loadData,
        );
        expect(powerUser.power_user.main_text_color).toBe(REVISED_THEMES.Dracula.old.main_text_color);
    });

    test('the Dark V 1.0 migration writes the Libadwaita Dark quote the theme ships', async () => {
        const libadwaita = bundled('Libadwaita Dark');
        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Dark V 1.0',
                    quote_text_color: 'rgba(198, 193, 151, 1)',
                    underline_text_color: 'rgba(145, 145, 145, 1)',
                    sb_theme_text_revision: THEME_TEXT_REVISION,
                },
            },
            { themes: [libadwaita], context: [], instruct: [], sysprompt: [], reasoning: [] },
        );

        expect(powerUser.power_user.theme).toBe('Libadwaita Dark');
        expect(powerUser.power_user.quote_text_color).toBe(libadwaita.quote_text_color);
    });
});
