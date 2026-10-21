import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeThemeUpdate, withOwnedThemeCss } from '../public/scripts/sillybunny-theme-css.js';

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

function getSnapshot(name) {
    return Object.fromEntries(PALETTE_SNAPSHOT_KEYS.map(key => [key, key === 'name' ? name : `live-${key}`]));
}

describe('mergeThemeUpdate', () => {
    test('updating a bundled theme keeps every stored key', () => {
        const stored = readBundledTheme('Catppuccin Mocha');
        const merged = mergeThemeUpdate(stored, getSnapshot(stored.name));
        const storedKeys = Object.keys(stored);

        expect(typeof stored.custom_css).toBe('string');
        expect(stored.custom_css.length).toBeGreaterThan(0);
        expect(merged.custom_css).toBe(stored.custom_css);
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

describe('withOwnedThemeCss', () => {
    test('a theme that owns Custom CSS takes the live CSS', () => {
        const stored = { name: 'Mine', custom_css: 'old {}' };

        expect(withOwnedThemeCss(getSnapshot('Mine'), stored, 'new {}').custom_css).toBe('new {}');
    });

    test('an empty stored string still counts as owning Custom CSS', () => {
        const stored = readBundledTheme('Dark V 1.0');

        expect(stored.custom_css).toBe('');
        expect(withOwnedThemeCss(getSnapshot(stored.name), stored, 'mine {}').custom_css).toBe('mine {}');
        expect(withOwnedThemeCss(getSnapshot(stored.name), stored, undefined).custom_css).toBe('');
    });

    test('a theme without Custom CSS stays without it', () => {
        const snapshot = getSnapshot('Mine');

        expect(withOwnedThemeCss(snapshot, { name: 'Mine', main_text_color: 'c' }, 'live {}')).not.toHaveProperty('custom_css');
        expect(withOwnedThemeCss(snapshot, undefined, 'live {}')).not.toHaveProperty('custom_css');
        expect(withOwnedThemeCss(snapshot, null, 'live {}')).not.toHaveProperty('custom_css');
    });

    test('updating a bundled theme saves the live CSS and keeps every stored key', () => {
        const stored = readBundledTheme('Catppuccin Mocha');
        const merged = mergeThemeUpdate(stored, withOwnedThemeCss(getSnapshot(stored.name), stored, 'edited {}'));

        expect(merged.custom_css).toBe('edited {}');
        expect(Object.keys(merged)).toEqual(expect.arrayContaining(Object.keys(stored)));
    });

    test('an export of a bundled theme leaves out its legacy layout keys', () => {
        const stored = readBundledTheme('Catppuccin Mocha');
        const exported = withOwnedThemeCss(getSnapshot(stored.name), stored, stored.custom_css);

        expect(stored).toHaveProperty('chat_width');
        expect(Object.keys(exported).sort()).toEqual([...PALETTE_SNAPSHOT_KEYS, 'custom_css'].sort());
        expect(exported.custom_css).toBe(stored.custom_css);
    });

    test('leaves the snapshot unchanged', () => {
        const snapshot = getSnapshot('Mine');
        const copy = { ...snapshot };

        withOwnedThemeCss(snapshot, { name: 'Mine', custom_css: 'old {}' }, 'new {}');

        expect(snapshot).toEqual(copy);
    });
});
