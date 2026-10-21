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

    test('snapshots carry Custom CSS while imports take it only from the file', () => {
        const getThemeObjectSource = requireSection('export function getThemeObject(name)', '/**\n * Gets a snapshot of the current theme colors and effects.');
        const getThemePaletteObjectSource = requireSection('function getThemePaletteObject(name)', '/**\n * Gets the theme object to save from the current settings.');
        const getNewThemeSource = requireSection('function getNewTheme(parsed)', 'async function saveMovingUI');

        expect(getThemeObjectSource).toContain('return { ...getThemePaletteObject(name), custom_css: String(power_user.custom_css ?? \'\') };');
        expect(getThemePaletteObjectSource).toContain('const theme = { name };');
        expect(getThemePaletteObjectSource).not.toContain('custom_css');
        expect(getNewThemeSource).toContain('return buildImportedTheme(parsed, getThemePaletteObject(parsed.name));');
        expect(getNewThemeSource).not.toContain('getThemeObject(');
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

    test('export downloads the theme snapshot without rewriting the stored theme file', () => {
        const exportThemeSource = requireSection('function exportTheme()', '/**\n * Imports a theme from a file.');

        expect(exportThemeSource).toContain('const themeFile = getThemeObject(themeName);');
        expect(exportThemeSource).toContain('download(');
        expect(exportThemeSource).not.toContain('saveTheme(');
        expect(exportThemeSource).not.toContain('getThemeSaveObject(');
    });

    test('Reset restores colors without replacing Custom CSS', () => {
        const resetSource = requireSection('.on(\'click\', \'.sb-theme-preset-reset\'', '// Accent color presets');

        expect(resetSource).toContain('applyTheme(\'Dark V 1.0\', { applyCss: false });');
    });
});

describe('theme changes guard unsaved Custom CSS', () => {
    test('the theme dropdown keeps the current theme until the switch goes through', () => {
        const handlerSource = requireSection('$(\'#themes\').on(\'change\'', '$(\'#movingUIPresets\').on(\'change\'');

        expect(handlerSource).toContain('$(this).val(power_user.theme);');
        expect(handlerSource).toContain('void switchUiTheme(themeSelected);');
        expect(handlerSource).not.toContain('applyTheme(');
    });

    test('/theme switches through the same check', () => {
        const callbackSource = requireSection('async function setThemeCallback(', 'async function setmovingUIPreset');

        expect(callbackSource).toContain('await switchUiTheme(theme.name);');
        expect(callbackSource).not.toContain('applyTheme(');
    });

    test('a switch asks before replacing Custom CSS that no theme stores', () => {
        const switchSource = requireSection('async function switchUiTheme(name)', 'async function deleteTheme()');

        expect(switchSource).toContain('if (!theme || isThemeSwitchPending) {');
        expect(switchSource).toContain('shouldConfirmCssReplace(theme, power_user.custom_css, themes) && !await confirmThemeCssReplace(power_user.theme)');
        expect(switchSource).toContain('isThemeSwitchPending = false;');
        expect(switchSource).toContain('applyTheme(name);');
    });

    test('the popup defaults to Save, keeps Discard last, and saves only the Custom CSS', () => {
        const confirmSource = requireSection('async function confirmThemeCssReplace(themeName)', '/**\n * Switches the UI theme');
        const saveCssSource = requireSection('async function saveThemeCss(name)', '/**\n * Asks what to do with Custom CSS');

        expect(confirmSource).toContain('defaultResult: POPUP_RESULT.AFFIRMATIVE,');
        expect(confirmSource).toContain('result: POPUP_RESULT.CUSTOM1, classes: [\'red_button\'], appendAtEnd: true');
        expect(confirmSource).toContain('return Boolean(await saveThemeCss(themeName));');
        expect(confirmSource).toContain('return result === POPUP_RESULT.CUSTOM1;');
        expect(saveCssSource).toContain('{ ...storedTheme, custom_css: String(power_user.custom_css ?? \'\') }');
    });

    test('import asks before saving a theme whose Custom CSS would replace unsaved CSS', () => {
        const importThemeSource = requireSection('async function importTheme(file)', '/**\n * Saves the current theme to the server.');
        const guardIndex = importThemeSource.indexOf('shouldConfirmCssReplace(theme, power_user.custom_css, themes) && !await confirmThemeCssReplace(power_user.theme)');

        expect(guardIndex).toBeGreaterThan(-1);
        expect(guardIndex).toBeLessThan(importThemeSource.indexOf('await saveTheme(parsed.name, theme);'));
    });

    test('deleting a theme keeps Custom CSS that no remaining theme stores', () => {
        const deleteSource = requireSection('async function deleteTheme()', '/**\n * Exports the current theme to a file.');

        expect(deleteSource).toContain('applyTheme(power_user.theme, { applyCss: isCssStoredInThemes(themes, power_user.custom_css) });');
    });
});
