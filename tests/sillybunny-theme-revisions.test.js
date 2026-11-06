import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';

import {
    THEME_COLOR_KEYS,
    THEME_TEXT_KEYS,
    REVISED_THEMES,
    THEME_TEXT_REVISION,
    hashThemeCss,
    planThemeTextRepair,
} from '../public/scripts/sillybunny-theme-revisions.js';

const readJson = url => JSON.parse(readFileSync(url, 'utf8'));
const bundled = name => readJson(new URL(`../default/content/themes/${name}.json`, import.meta.url));
/** The file as it shipped before the text colors were raised. */
const previous = name => readJson(new URL(`./fixtures/stale-bundled-themes/${name}.json`, import.meta.url));
const powerUserSource = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
const contentManagerSource = readFileSync(new URL('../src/endpoints/content-manager.js', import.meta.url), 'utf8');

const bundledNames = readdirSync(new URL('../default/content/themes/', import.meta.url)).map(file => file.replace(/\.json$/, ''));
const unrevisedNames = bundledNames.filter(name => !Object.hasOwn(REVISED_THEMES, name));

/** The Dark V migration renames this theme to Libadwaita before the repair runs, so a saved palette never carries its name. */
const RENAMED_BEFORE_REPAIR = ['Dark V 1.0'];

/** Names of the bundled themes the server replaces while the user's copy is an earlier version, read from content-manager.js. */
function managedThemeNames() {
    const contrastBlock = /const CONTRAST_REVISED_THEME_HASHES = Object\.freeze\(\{\n([\s\S]*?)\n\}\);/.exec(contentManagerSource)?.[1];
    if (!contrastBlock) {
        throw new Error('CONTRAST_REVISED_THEME_HASHES not found in content-manager.js');
    }
    const contrastNames = [...contrastBlock.matchAll(/^ {4}(?:'([^']+)'|([\w-]+)): '[0-9a-f]{64}',$/gm)].map(match => match[1] ?? match[2]);
    const listedNames = [...contentManagerSource.matchAll(/bundledPath: 'themes\/([^']+)\.json'/g)].map(match => match[1]);
    return [...listedNames, ...contrastNames];
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
            text: Object.fromEntries(THEME_TEXT_KEYS.map(key => [key, revised[key]])),
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

        expect(revision.text).toEqual(Object.fromEntries(THEME_TEXT_KEYS.map(key => [key, theme[key]])));
        expect(hashThemeCss(theme.custom_css)).toBe(revision.newCss);
        // The six colors a revision does not touch are the ones the file still has.
        for (const key of THEME_COLOR_KEYS.slice(THEME_TEXT_KEYS.length)) {
            expect([key, revision.old[key]]).toEqual([key, theme[key]]);
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

    test('the revision number in power-user.js is the one in the data', () => {
        expect(powerUserSource).toContain(`const SB_THEME_TEXT_REVISION = ${THEME_TEXT_REVISION};`);
    });
});

describe('revised theme text colors: running once', () => {
    test('power-user.js repairs while the saved revision is below the current one, then records the current one', () => {
        expect(powerUserSource).toMatch(/Number\.isInteger\(savedPowerUserSettings\.sb_theme_text_revision\)\s*&&\s*savedPowerUserSettings\.sb_theme_text_revision >= SB_THEME_TEXT_REVISION/);
        expect(powerUserSource).toContain('planThemeTextRepair(');
        expect(powerUserSource).toContain('power_user.sb_theme_text_revision = SB_THEME_TEXT_REVISION;');
    });

    test('the Dark V 1.0 migration writes the Libadwaita quote the theme ships', () => {
        const libadwaita = bundled('Libadwaita');
        const start = powerUserSource.indexOf('if (power_user.theme === \'Dark V 1.0\') {');

        expect(powerUserSource.slice(start, powerUserSource.indexOf('saveSettingsDebounced();', start))).toContain(`power_user.quote_text_color = '${libadwaita.quote_text_color}';`);
    });
});
