import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeThemeUpdate } from '../public/scripts/sillybunny-theme-css.js';

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

describe('mergeThemeUpdate', () => {
    test('updating a bundled theme keeps its custom CSS and every stored key', () => {
        const stored = readBundledTheme('Catppuccin Mocha');
        const snapshot = Object.fromEntries(PALETTE_SNAPSHOT_KEYS.map(key => [key, key === 'name' ? stored.name : `live-${key}`]));

        const merged = mergeThemeUpdate(stored, snapshot);

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
