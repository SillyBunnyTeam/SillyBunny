import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-theme.css'), 'utf8');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const sidePanelCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-side-panel.css'), 'utf8');

describe('libadwaita surface and layer foundations', () => {
    test('the z-index ladder orders chat, sprites, avatars, panels, shell, popovers and dialogs', () => {
        expect(themeCss).toContain('--sb-z-sprites: 100;');
        expect(themeCss).toContain('--sb-z-zoomed-avatar: 200;');
        expect(themeCss).toContain('--sb-z-side-panel: 300;');
        expect(themeCss).toContain('--sb-z-shell-panel: 1100;');
        expect(themeCss).toContain('--sb-z-shell-sidebar: 1200;');
        expect(themeCss).toContain('--sb-z-modal: 3000;');
        expect(themeCss).toContain('--sb-z-context-menu: 4000;');
        expect(themeCss).not.toContain('--sb-z-dialog:');
        // Panels sit below the shell drawers and the settings page; critical overlays stay above menus.
        expect(Number(/--sb-z-side-panel: (\d+);/.exec(themeCss)[1]))
            .toBeLessThan(Number(/--sb-z-shell-panel: (\d+);/.exec(themeCss)[1]));
        expect(Number(/--sb-z-context-menu: (\d+);/.exec(themeCss)[1]))
            .toBeLessThan(Number(/--sb-z-critical: (\d+);/.exec(themeCss)[1]));
    });

    test('zoomed avatars and side panels consume the ladder tokens', () => {
        expect(themeCss).toContain('z-index: var(--sb-z-zoomed-avatar) !important;');
        expect(sidePanelCss).toMatch(/\.sb-side-panel \{[^}]*z-index: var\(--sb-z-side-panel, 300\);/);
    });

    test('each tier carries its own surface tokens', () => {
        expect(themeCss).toContain('--sb-layer-alert: var(--sb-layer-dialog);');
        expect(themeCss).toContain('--sb-layer-view-surface: var(--sb-layer-view);');
        expect(themeCss).toContain('dialog.popup.sb-dialog--alert,\ndialog.popup.sb-dialog--alert > .popup-body {\n    background: var(--sb-layer-alert);');
        expect(themeCss).toContain('.sb-dialog--dialog,\n.sb-dialog--window {\n    background: var(--sb-layer-window);');
        expect(themeCss).toContain('.sb-dialog--window.sb-dialog--view .sb-dialog__body {\n    background: var(--sb-layer-view-surface);');
        expect(themeCss).toMatch(/\.sb-dialog--window \.sb-dialog__header \{[^}]*background: var\(--sb-layer-headerbar\);/);
    });

    test('floating entry rows keep captions below the field and never re-show the placeholder', () => {
        expect(tabsCss).not.toContain('.ds-row-entry--floating .ds-row-entry__field > input:focus::placeholder');
        expect(tabsCss).toMatch(/\.ds-row-entry--floating > \.ds-row-entry__caption \{[^}]*width: 100%;[^}]*white-space: normal;/);
    });
});
