import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powerUserSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'power-user.js'), 'utf8').replace(/\r\n/g, '\n');

function getSourceSection(startMarker, endMarker) {
    const startIndex = powerUserSource.indexOf(startMarker);
    const endIndex = powerUserSource.indexOf(endMarker, startIndex);

    return startIndex === -1 || endIndex === -1 ? '' : powerUserSource.slice(startIndex, endIndex);
}

describe('theme custom CSS import wiring', () => {
    test('theme selection applies the theme custom CSS payload', () => {
        const applyThemeSource = getSourceSection('function applyTheme(name)', 'async function applyMovingUIPreset');

        expect(applyThemeSource).toContain('if (typeof theme.custom_css === \'string\') {');
        expect(applyThemeSource).toContain('power_user.custom_css = theme.custom_css;');
        expect(applyThemeSource).toContain('applyCustomCSS();');
    });

    test('import selects and applies the saved theme instead of only adding it', () => {
        const importThemeSource = getSourceSection('async function importTheme(file)', '/**\n * Saves the current theme to the server.');

        expect(importThemeSource).toContain('const theme = getNewTheme(parsed);');
        expect(importThemeSource).toContain('await saveTheme(parsed.name, theme);');
        expect(importThemeSource).toContain('applyTheme(parsed.name);');
        expect(importThemeSource).toContain('power_user.custom_css = theme.custom_css;');
        expect(importThemeSource).toContain('applyCustomCSS();');
        expect(importThemeSource).toContain('saveSettingsDebounced();');
        expect(importThemeSource).not.toContain('themes.push(parsed);');
    });

    test('theme normalization only keeps explicitly bundled custom CSS', () => {
        const getThemeObjectSource = getSourceSection('export function getThemeObject(name)', '/**\n * Applies imported theme properties');
        const getNewThemeSource = getSourceSection('function getNewTheme(parsed)', 'async function saveMovingUI');

        expect(getThemeObjectSource).toContain('const theme = { name };');
        expect(getThemeObjectSource).not.toContain('custom_css: power_user.custom_css');
        expect(getNewThemeSource).toContain('if (typeof parsed.custom_css === \'string\') {');
        expect(getNewThemeSource).toContain('theme.custom_css = parsed.custom_css;');
    });
});
