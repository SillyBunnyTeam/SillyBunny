import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildImportedTheme,
    getThemeCustomCss,
    isCssStoredInThemes,
    isThemeCssDirty,
    mergeThemeUpdate,
    normalizeThemeCss,
    shouldConfirmCssReplace,
} from '../public/scripts/sillybunny-theme-css.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readBundledTheme(name) {
    return JSON.parse(readFileSync(path.join(repoRoot, 'default', 'content', 'themes', `${name}.json`), 'utf8'));
}

const PALETTE_SNAPSHOT_KEYS = [
    'name',
    'main_text_color',
    'italics_text_color',
    'underline_text_color',
    'quote_text_color',
    'blur_tint_color',
    'chat_tint_color',
    'user_mes_blur_tint_color',
    'bot_mes_blur_tint_color',
    'shadow_color',
    'border_color',
    'customCSS-bg-blur',
    'customCSS-bg-opacity',
    'sheldBlurStrength',
    'sheldBackgroundColor',
];

function getPaletteSnapshot(name) {
    return Object.fromEntries(PALETTE_SNAPSHOT_KEYS.map(key => [key, key === 'name' ? name : `live-${key}`]));
}

describe('mergeThemeUpdate', () => {
    test('updating a bundled theme keeps every stored key and saves the snapshot CSS', () => {
        const stored = readBundledTheme('Catppuccin Mocha');
        const merged = mergeThemeUpdate(stored, { ...getPaletteSnapshot(stored.name), custom_css: 'edited {}' });
        const storedKeys = Object.keys(stored);

        expect(merged.custom_css).toBe('edited {}');
        expect(Object.keys(merged).slice(0, storedKeys.length)).toEqual(storedKeys);
        expect(Object.keys(merged)).toEqual(expect.arrayContaining(PALETTE_SNAPSHOT_KEYS));
    });

    test('snapshot values replace the stored values they carry', () => {
        const stored = { name: 'Mine', main_text_color: 'old', chat_width: 50, custom_css: 'a {}' };
        const merged = mergeThemeUpdate(stored, { name: 'Mine', main_text_color: 'new' });

        expect(merged).toEqual({ name: 'Mine', main_text_color: 'new', chat_width: 50, custom_css: 'a {}' });
    });

    test('returns a copy of the snapshot when nothing is stored', () => {
        const snapshot = { name: 'New', main_text_color: 'c' };

        expect(mergeThemeUpdate(undefined, snapshot)).toEqual(snapshot);
        expect(mergeThemeUpdate(null, snapshot)).toEqual(snapshot);
        expect(mergeThemeUpdate(undefined, snapshot)).not.toBe(snapshot);
    });

    test('leaves both inputs unchanged', () => {
        const stored = { name: 'Mine', main_text_color: 'old' };
        const snapshot = { name: 'Mine', main_text_color: 'new' };

        mergeThemeUpdate(stored, snapshot);

        expect(stored).toEqual({ name: 'Mine', main_text_color: 'old' });
        expect(snapshot).toEqual({ name: 'Mine', main_text_color: 'new' });
    });
});

describe('Custom CSS values', () => {
    test('normalization ignores line endings and surrounding whitespace', () => {
        expect(normalizeThemeCss('  a {}\r\nb {}\n')).toBe('a {}\nb {}');
        expect(normalizeThemeCss(undefined)).toBe('');
        expect(normalizeThemeCss(null)).toBe('');
    });

    test('a theme carries Custom CSS only as a string, empty included', () => {
        expect(getThemeCustomCss({ custom_css: 'a {}' })).toBe('a {}');
        expect(getThemeCustomCss({ custom_css: '' })).toBe('');
        expect(getThemeCustomCss({ name: 'Palette only' })).toBeNull();
        expect(getThemeCustomCss({ custom_css: 42 })).toBeNull();
        expect(getThemeCustomCss(undefined)).toBeNull();
    });
});

describe('buildImportedTheme', () => {
    test('takes Custom CSS from the file, empty included', () => {
        const template = getPaletteSnapshot('Shared');

        expect(buildImportedTheme({ name: 'Shared', custom_css: 'a {}' }, template).custom_css).toBe('a {}');
        expect(buildImportedTheme({ name: 'Shared', custom_css: '' }, template).custom_css).toBe('');
    });

    test('never takes Custom CSS from the template', () => {
        const template = { ...getPaletteSnapshot('Shared'), custom_css: 'importer {}' };

        expect(buildImportedTheme({ name: 'Shared', main_text_color: 'red' }, template)).not.toHaveProperty('custom_css');
    });

    test('takes the file values for template keys and drops everything else', () => {
        const stored = readBundledTheme('Catppuccin Mocha');
        const theme = buildImportedTheme(stored, getPaletteSnapshot('Placeholder'));

        expect(theme.name).toBe('Catppuccin Mocha');
        expect(theme.main_text_color).toBe(stored.main_text_color);
        expect(theme['sheldBlurStrength']).toBe('live-sheldBlurStrength');
        expect(theme.custom_css).toBe(stored.custom_css);
        expect(theme).not.toHaveProperty('chat_width');
        expect(Object.keys(theme).sort()).toEqual([...PALETTE_SNAPSHOT_KEYS, 'custom_css'].sort());
    });
});

describe('isCssStoredInThemes', () => {
    const themes = [
        { name: 'Palette only' },
        { name: 'Empty', custom_css: '' },
        { name: 'Mine', custom_css: 'a {}\r\nb {}' },
    ];

    test('blank Custom CSS counts as stored', () => {
        expect(isCssStoredInThemes([], '')).toBe(true);
        expect(isCssStoredInThemes([], '  \n')).toBe(true);
        expect(isCssStoredInThemes([], undefined)).toBe(true);
    });

    test('matches a stored copy despite line endings and surrounding whitespace', () => {
        expect(isCssStoredInThemes(themes, 'a {}\nb {}\n')).toBe(true);
    });

    test('unsaved Custom CSS is not stored', () => {
        expect(isCssStoredInThemes(themes, 'c {}')).toBe(false);
    });

    test('Custom CSS saved only in a deleted theme is not stored in the remaining themes', () => {
        const remaining = themes.filter(theme => theme.name !== 'Mine');

        expect(isCssStoredInThemes(remaining, 'a {}\nb {}')).toBe(false);
    });
});

describe('isThemeCssDirty', () => {
    test('matches the stored copy despite line endings and surrounding whitespace', () => {
        expect(isThemeCssDirty({ name: 'Mine', custom_css: 'a {}\r\nb {}' }, '\na {}\nb {}  ')).toBe(false);
    });

    test('an edit the theme does not store is unsaved', () => {
        expect(isThemeCssDirty({ name: 'Mine', custom_css: 'a {}' }, 'a { color: red; }')).toBe(true);
    });

    test('a theme without Custom CSS counts as storing none', () => {
        expect(isThemeCssDirty({ name: 'Palette only' }, '')).toBe(false);
        expect(isThemeCssDirty({ name: 'Palette only' }, 'a {}')).toBe(true);
    });

    test('Custom CSS without a current theme is unsaved unless blank', () => {
        expect(isThemeCssDirty(undefined, ' ')).toBe(false);
        expect(isThemeCssDirty(undefined, 'a {}')).toBe(true);
    });
});

describe('shouldConfirmCssReplace', () => {
    const themes = [
        { name: 'Mine', custom_css: 'mine {}' },
        { name: 'Preset', custom_css: 'preset {}' },
        { name: 'Plain', custom_css: '' },
        { name: 'Palette only' },
    ];
    const getTheme = name => themes.find(theme => theme.name === name);

    test('asks when the switch replaces unsaved Custom CSS', () => {
        expect(shouldConfirmCssReplace(getTheme('Preset'), 'edited {}', themes)).toBe(true);
    });

    test('asks when the switch clears unsaved Custom CSS', () => {
        expect(shouldConfirmCssReplace(getTheme('Plain'), 'edited {}', themes)).toBe(true);
    });

    test('does not ask when a theme stores the current Custom CSS', () => {
        expect(shouldConfirmCssReplace(getTheme('Preset'), 'mine {}\n', themes)).toBe(false);
    });

    test('does not ask when the current Custom CSS is blank', () => {
        expect(shouldConfirmCssReplace(getTheme('Preset'), '', themes)).toBe(false);
    });

    test('does not ask when the theme leaves Custom CSS alone', () => {
        expect(shouldConfirmCssReplace(getTheme('Palette only'), 'edited {}', themes)).toBe(false);
    });

    test('does not ask when the theme CSS matches the current CSS', () => {
        expect(shouldConfirmCssReplace({ name: 'Copy', custom_css: 'edited {}' }, ' edited {}\r\n', themes)).toBe(false);
    });
});
