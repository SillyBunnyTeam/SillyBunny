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
            'sb-interface-drawer',
            'sb-topbar-label-drawer',
            'sb-quick-access-shortcuts-drawer',
        ];

        expect(shellTabsSource).toContain('\'data-settings-tab\': \'appearance\'');
        expect(shellTabsSource).toContain('body.style.display = \'none\';');
        expect(shellTabsSource).toContain('themeBlock.append(card);');
        expect(shellTabsSource).not.toContain('themeBlock.prepend(card);');
        for (const drawerId of drawerIds) {
            expect(shellTabsSource).toContain(`'${drawerId}'`);
        }
        expect(shellTabsSource).toContain('content: [frontendIconSettingsGroup, surfaceSliderGroup, bottomBarSliderGroup],');
        expect(shellTabsSource).not.toContain('sb-shell-style-drawer');
        expect(shellTabsSource).not.toContain('data-sb-theme-option');
        expect(shellTabsSource).not.toContain('sb-frontend-icon-drawer');
        expect(shellTabsSource).not.toContain('sb-background-visibility-drawer');
        expect(shellTabsSource).not.toContain('sb-bottom-bar-size-drawer');
        expect(shellTabsCssSource).toContain('.sb-theme-settings-drawer > .inline-drawer-header');
        expect(shellTabsCssSource).toContain('.sb-theme-settings-drawer > .sb-theme-settings-drawer-body');
        expect(shellTabsCssSource).toContain('.sb-interface-settings-group + .sb-interface-settings-group');
    });
});
