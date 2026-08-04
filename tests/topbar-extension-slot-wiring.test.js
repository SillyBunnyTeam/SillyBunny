import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8');
const tabsSource = readRepoFile('public', 'scripts', 'sillybunny-tabs.js');
const tabsCss = readRepoFile('public', 'css', 'sillybunny-tabs.css');
const mobileShellCss = readRepoFile('public', 'css', 'sillybunny-mobile-shell.css');
const paperThemeCss = readRepoFile('public', 'css', 'sillybunny-paper-theme.css');
const settingsTabsSource = readRepoFile('public', 'scripts', 'sillybunny-settings-tabs.js');

describe('top-bar extension slot wiring', () => {
    test('connects the adoption module to the shell lifecycle', () => {
        expect(tabsSource).toContain('from \'./topbar-extension-slot/index.js\';');
        expect(tabsSource).toContain('resolveTopbarAdoptionPlan({');
        expect(tabsSource).toContain('resolveCharacterBadgeMirrorPlan({');
        expect(tabsSource).toContain('adoptTopbarExtensionNodes(preservedExtensionChildren);');
        expect(tabsSource).toContain('bindTopbarExtensionAdoption();');
    });

    test('declares the slot sizing and panel anchoring contracts', () => {
        expect(tabsCss).toContain('#sb-topbar-extension-slot[data-sb-topbar-slot-empty=\'true\']');
        expect(tabsCss).toContain('#sb-topbar-extension-slot .menu_button,');
        expect(tabsCss).toContain('max-inline-size: min(12rem, 45vw);');
        expect(tabsCss).toContain('--topBarBlockSize: max(var(--sb-host-topbar-block-size), var(--sb-topbar-layout-offset));');
        expect(mobileShellCss).toContain('#sb-topbar-extension-slot .menu_button,');
        expect(paperThemeCss).toContain('#top-bar .menu_button:not(#sb-topbar-extension-slot .menu_button),');
    });

    test('keeps third-party composer controls available on mobile', () => {
        expect(mobileShellCss).not.toContain('#rightSendForm > div:not(#send_but)');
        expect(mobileShellCss).toContain('#rightSendForm > #mes_impersonate,');
        expect(tabsSource).toContain('placeComposerExtensionButtons(leftForm, rightForm);');
    });

    test('assigns late third-party drawers to a visible settings tab', () => {
        expect(settingsTabsSource).toContain('const DEFAULT_SETTINGS_TAB = \'system-device\';');
        expect(settingsTabsSource).toContain('.inline-drawer:not([data-settings-tab])');
        expect(settingsTabsSource).toContain('tagUntaggedDrawers();');
        expect(settingsTabsSource).toContain('watchForLateDrawers();');
    });
});
