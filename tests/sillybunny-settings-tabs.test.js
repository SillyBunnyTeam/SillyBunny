import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('SillyBunny settings theme drawers', () => {
    const indexSource = readSource('public', 'index.html');
    const settingsTabsSource = readSource('public', 'scripts', 'sillybunny-settings-tabs.js');

    test('separates full UI themes from palette and accent presets', () => {
        expect(settingsTabsSource).not.toContain('UI Theme & Presets');
        expect(settingsTabsSource).toContain('mainHeaderSpan.textContent = \'UI Theme\';');
        expect(settingsTabsSource).toContain('mainHeaderSpan.setAttribute(\'data-i18n\', \'UI Theme\');');
        expect(settingsTabsSource).toContain('parentAppearance.querySelector(\'#UI-presets-block > .sb-theme-presets\')');
        expect(settingsTabsSource).toContain('presetsDrawer.id = \'sb-theme-presets-drawer\';');
        expect(settingsTabsSource).toContain('<span data-i18n="Presets">Presets</span>');
        expect(settingsTabsSource).toContain('presetsDrawer.querySelector(\'.inline-drawer-content\').appendChild(themePresets);');
        expect(settingsTabsSource).toContain('\'sb-theme-presets-drawer\': \'appearance\',');
    });

    test('keeps full theme controls in their original injection target', () => {
        const themeBlockMatch = indexSource.match(/<div id="UI-presets-block"[^>]*>([\s\S]*?)<div class="sb-theme-presets">/);
        expect(themeBlockMatch).not.toBeNull();
        const themeBlock = themeBlockMatch[1];

        expect(themeBlock).toContain('id="themes"');
        expect(themeBlock).toContain('id="ui_preset_import_file"');
        expect(themeBlock).toContain('id="ui_preset_export_button"');
        expect(themeBlock).toContain('id="ui-preset-save-button"');
    });
});
