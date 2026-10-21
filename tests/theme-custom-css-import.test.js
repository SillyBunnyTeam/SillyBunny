import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powerUserSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'power-user.js'), 'utf8').replace(/\r\n/g, '\n');

// Fails instead of returning '' so a moved marker cannot turn not.toContain checks into silent passes.
function requireSection(startMarker, endMarker) {
    const startIndex = powerUserSource.indexOf(startMarker);
    const endIndex = startIndex === -1 ? -1 : powerUserSource.indexOf(endMarker, startIndex);

    if (startIndex === -1 || endIndex === -1) {
        throw new Error(`power-user.js section not found: ${startMarker}`);
    }

    return powerUserSource.slice(startIndex, endIndex);
}

describe('theme custom CSS import wiring', () => {
    test('theme selection applies the theme custom CSS payload', () => {
        const applyThemeSource = requireSection('function applyTheme(', 'async function applyMovingUIPreset');

        expect(applyThemeSource).toContain('if (applyCss && typeof theme.custom_css === \'string\') {');
        expect(applyThemeSource).toContain('power_user.custom_css = theme.custom_css;');
        expect(applyThemeSource).toContain('applyCustomCSS();');
    });

    test('import selects and applies the saved theme instead of only adding it', () => {
        const importThemeSource = requireSection('async function importTheme(file)', '/**\n * Saves the current theme to the server.');

        expect(importThemeSource).toContain('const theme = getNewTheme(parsed);');
        expect(importThemeSource).toContain('await saveTheme(parsed.name, theme);');
        expect(importThemeSource).toContain('applyTheme(parsed.name);');
        expect(importThemeSource).toContain('power_user.custom_css = theme.custom_css;');
        expect(importThemeSource).toContain('applyCustomCSS();');
        expect(importThemeSource).toContain('saveSettingsDebounced();');
        expect(importThemeSource).not.toContain('themes.push(parsed);');
    });

    test('theme normalization only keeps explicitly bundled custom CSS', () => {
        const getThemeObjectSource = requireSection('export function getThemeObject(name)', '/**\n * Gets the theme object to save or export');
        const getNewThemeSource = requireSection('function getNewTheme(parsed)', 'async function saveMovingUI');

        expect(getThemeObjectSource).toContain('const theme = { name };');
        expect(getThemeObjectSource).not.toContain('custom_css: power_user.custom_css');
        expect(getNewThemeSource).toContain('if (typeof parsed.custom_css === \'string\') {');
        expect(getNewThemeSource).toContain('theme.custom_css = parsed.custom_css;');
    });
});

describe('theme actions keep stored theme data', () => {
    test('saving merges the current snapshot over the stored theme', () => {
        const saveThemeSource = requireSection('async function saveTheme(', '/**\n * Gets a snapshot of the current theme settings.');
        const getThemeSaveObjectSource = requireSection('function getThemeSaveObject(name)', '/**\n * Applies imported theme properties');

        expect(saveThemeSource).toContain('theme = getThemeSaveObject(name);');
        expect(saveThemeSource).not.toContain('theme = getThemeObject(name);');
        expect(getThemeSaveObjectSource).toContain('mergeThemeUpdate(themes.find(x => x.name == name), getThemeObject(name))');
    });

    test('export downloads without rewriting the stored theme file', () => {
        const exportThemeSource = requireSection('function exportTheme()', '/**\n * Imports a theme from a file.');

        expect(exportThemeSource).toContain('getThemeSaveObject(themeName)');
        expect(exportThemeSource).toContain('download(');
        expect(exportThemeSource).not.toContain('saveTheme(');
    });

    test('Reset restores colors without replacing Custom CSS', () => {
        const resetSource = requireSection('.on(\'click\', \'.sb-theme-preset-reset\'', '// Accent color presets');

        expect(resetSource).toContain('applyTheme(\'Dark V 1.0\', { applyCss: false });');
    });
});
