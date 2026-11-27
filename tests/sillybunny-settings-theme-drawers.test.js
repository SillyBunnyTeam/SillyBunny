/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTabsModule } from './util/tabs-harness.js';
import { SB_USER_SETTINGS_CONTAINER_IDS } from '../public/scripts/sillybunny-settings-content.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('SillyBunny settings theme drawers', () => {
    const indexSource = readSource('public', 'index.html');
    const shellTabsCssSource = readSource('public', 'css', 'sillybunny-tabs.css');

    test('keeps full theme controls in their original HTML injection target and omits retired drawer CSS', () => {
        const themeBlockMatch = indexSource.match(/<div id="UI-presets-block"[^>]*>([\s\S]*?)<div class="sb-theme-presets">/);
        expect(themeBlockMatch).not.toBeNull();
        const themeBlock = themeBlockMatch[1];

        expect(themeBlock).toContain('id="themes"');
        expect(themeBlock).toContain('id="ui_preset_import_file"');
        expect(themeBlock).toContain('id="ui_preset_export_button"');
        expect(themeBlock).toContain('id="ui-preset-save-button"');
        expect(shellTabsCssSource).not.toContain('.sb-theme-settings-drawer');
        expect(shellTabsCssSource).not.toContain('.sb-interface-settings-group');
    });

    test('mounts persisted top-bar appearance groups and Interface groups in the rendered settings DOM', async () => {
        loaded = await importTabsModule();
        loaded.shell.openTab('right', 'appearance');
        await loaded.flush();
        loaded.shell.openTab('right', 'interface');
        await loaded.flush();

        // #sb-theme-card is appended into #UI-presets-block (after #themes, not prepended) and
        // its topbar label & quick-access shortcut groups stay inside the card.
        const themeCard = document.getElementById('sb-theme-card');
        expect(themeCard).not.toBeNull();
        const topbarLabelGroup = document.getElementById('sb-topbar-label-drawer');
        const shortcutsGroup = document.getElementById('sb-quick-access-shortcuts-drawer');
        expect(topbarLabelGroup).not.toBeNull();
        expect(shortcutsGroup).not.toBeNull();
        expect(themeCard.querySelector('#sb-topbar-label-drawer')).toBe(topbarLabelGroup);
        expect(themeCard.querySelector('#sb-quick-access-shortcuts-drawer')).toBe(shortcutsGroup);

        // Retired drawers and theme-option pickers are not built.
        for (const retiredSelector of [
            '#sb-interface-drawer',
            '#sb-shell-style-drawer',
            '[data-sb-theme-option]',
            '#sb-frontend-icon-drawer',
            '#sb-frontend-icon',
            '#sb-background-visibility-drawer',
            '#sb-bottom-bar-size-drawer',
        ]) {
            expect(document.querySelector(retiredSelector)).toBeNull();
        }
        expect(document.body.textContent).not.toContain('Change the app icon');
        expect(document.body.textContent).not.toContain('Frontend Icon');

        // Interface page places Splash Character, Compact Mode, and Background Visibility in the General body,
        // and Bottom Bar Size + bar switches in the Bottom Bar body.
        const interfaceBody = document.getElementById('sb-interface-settings-body');
        const bottomBarBody = document.getElementById('sb-bottom-bar-settings');
        expect(interfaceBody).not.toBeNull();
        expect(bottomBarBody).not.toBeNull();
        expect(interfaceBody.querySelector('#sb-splash-character-row')).not.toBeNull();
        expect(interfaceBody.querySelector('#sb-compact-mode-input')).not.toBeNull();
        expect(bottomBarBody.querySelector('#sb-bottom-bar-scale-input')).not.toBeNull();
        expect(bottomBarBody.textContent).toContain('Bottom Bar Size');
        expect(document.body.textContent).toContain('Background Visibility');

        // Section order renders General, Mobile, and Bottom Bar headings and descriptions from settings content.
        const interfacePage = document.getElementById(SB_USER_SETTINGS_CONTAINER_IDS.interface);
        expect(interfacePage.textContent).toContain('General');
        expect(interfacePage.textContent).toContain('Choose the splash character and Compact Mode');
        expect(interfacePage.textContent).toContain('Adjust the button size on phones');
        expect(interfacePage.textContent).toContain('Bottom Bar');
    });
});
