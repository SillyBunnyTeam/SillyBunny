import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('SillyBunny settings theme drawers', () => {
    const indexSource = readSource('public', 'index.html');
    const shellTabsSource = readSource('public', 'scripts', 'sillybunny-tabs.js');
    const shellTabsCssSource = readSource('public', 'css', 'sillybunny-tabs.css');

    test('keeps full theme controls in their original injection target', () => {
        const themeBlockMatch = indexSource.match(/<div id="UI-presets-block"[^>]*>([\s\S]*?)<div class="sb-theme-presets">/);
        expect(themeBlockMatch).not.toBeNull();
        const themeBlock = themeBlockMatch[1];

        expect(themeBlock).toContain('id="themes"');
        expect(themeBlock).toContain('id="ui_preset_import_file"');
        expect(themeBlock).toContain('id="ui_preset_export_button"');
        expect(themeBlock).toContain('id="ui-preset-save-button"');
    });

    test('groups shell theme controls into persisted appearance drawers', () => {
        const drawerIds = [
            'sb-topbar-label-drawer',
            'sb-quick-access-shortcuts-drawer',
        ];

        expect(shellTabsSource).toContain('themeBlock.append(card);');
        expect(shellTabsSource).not.toContain('createThemeSettingsDrawer');
        expect(shellTabsSource).not.toContain('themeBlock.prepend(card);');
        for (const drawerId of drawerIds) {
            expect(shellTabsSource).toContain(`'${drawerId}'`);
        }
        // The Interface page's first list: Splash Character, Compact Mode, Bottom Bar Size, and Background Visibility until the Appearance Background group takes it.
        expect(shellTabsSource).not.toContain('\'sb-interface-drawer\'');
        expect(shellTabsSource).toContain('createInterfaceGroupBody(\'sb-interface-settings-body\', [splashCharacterRow.row, createCompactModeRow(), bottomBarSliderGroup, surfaceSliderGroup]);');
        expect(shellTabsSource).toContain('title: \'Background Visibility\',');
        expect(shellTabsSource).toContain('title: \'Bottom Bar Size\',');
        expect(readSource('public', 'scripts', 'sillybunny-settings-content.js')).toContain('description: \'Choose the splash character and adjust background visibility and the bottom bar size.\',');
        expect(shellTabsSource).not.toContain('Change the app icon');
        expect(shellTabsSource).not.toContain('sb-shell-style-drawer');
        expect(shellTabsSource).not.toContain('data-sb-theme-option');
        expect(shellTabsSource).not.toContain('sb-frontend-icon-drawer');
        expect(shellTabsSource).not.toContain('sb-frontend-icon');
        expect(shellTabsSource).not.toContain('Frontend Icon');
        expect(shellTabsSource).not.toContain('sb-background-visibility-drawer');
        expect(shellTabsSource).not.toContain('sb-bottom-bar-size-drawer');
        expect(shellTabsCssSource).not.toContain('.sb-theme-settings-drawer');
        expect(shellTabsCssSource).not.toContain('.sb-interface-settings-group');
    });
});
