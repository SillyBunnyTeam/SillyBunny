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

    test('the floating entry row is the field: its height is the row token and its ring goes round the row', () => {
        expect(tabsCss).not.toContain('max(48px, 3.4em)');
        expect(tabsCss).toMatch(/\.ds-row-entry--floating \.ds-row-entry__field \{[^}]*min-height: var\(--sb-entry-field-height\);/);
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating \{[^}]*--sb-entry-field-height: calc\(var\(--sb-density-row-min-height\) - 2 \* var\(--sb-density-row-padding-block\)\);/);
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating \.ds-row-entry__field > :is\(input, textarea\),[^{]*\{[^}]*min-height: var\(--sb-entry-field-height\);[^}]*border: 0;[^}]*background: none;[^}]*box-shadow: none;/);
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating:has\(\.ds-row-entry__field > :is\(input, textarea\):focus\) \{[^}]*box-shadow: var\(--sb-focus-ring-inset\);/);
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating:hover:not\(:has\(\.ds-row-entry__field > :is\(input, textarea\):focus,/);
        expect(tabsCss).not.toContain('.sb-connections-provider .ds-row-entry__field > input');
        // A textarea in an entry row (a value that may hold line breaks) shows one line and grows with its text.
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating \.ds-row-entry__field > textarea \{[^}]*resize: none;[^}]*field-sizing: content;/);
    });

    test('the floating entry row dims its title, floats it at Caption size and hides the pencil while the text has focus', () => {
        expect(tabsCss).toMatch(/\.ds-row-entry--floating \.ds-row-entry__title \{[^}]*color: var\(--sb-muted-fg\);[^}]*font-size: var\(--sb-type-body\);/);
        expect(tabsCss).toMatch(/\.ds-row-entry__edit \{[^}]*color: var\(--sb-shell-text\);[^}]*font-size: 16px;/);
        expect(tabsCss).toMatch(/\.ds-row-entry--floating > \.ds-row-entry__line > \.ds-row-suffix:has\(> :not\(\[hidden\], \.sr-only\)\)::before \{[^}]*width: 1px;[^}]*height: 24px;[^}]*background: var\(--sb-shell-border\);/);
        expect(tabsCss).toMatch(/\.ds-row-entry--floating \.ds-row-entry__field:is\(:focus-within, [^{]*:-webkit-autofill[^{]*> \.ds-row-entry__title \{[^}]*font-size: var\(--sb-type-caption\);/);
        expect(tabsCss).toMatch(/\.ds-row-entry__field:focus-within > \.ds-row-entry__edit \{[^}]*display: none;/);
    });

    test('upstream warning text follows the theme warning colour, and the selected secret row the flat selected fill', () => {
        expect(themeCss).toMatch(/--sb-warning-fg: [^;]+;[\s\S]{0,200}--warning: var\(--sb-warning-fg\);/);
        const secretsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'secrets.css'), 'utf8');
        expect(secretsCss).toMatch(/\.secretKeyManagerItem\.active \{[^}]*background-color: var\(--sb-flat-selected-bg, var\(--cobalt30a\)\);/);
        expect(themeCss).toMatch(/\.sb-dialog table\.responsiveTable \{[^}]*border: 0;[^}]*border-collapse: collapse;/);
    });

    test('a Dialog page follows its content, a Window page keeps the height of the Window it covers', () => {
        expect(themeCss).toMatch(/dialog\.popup\.sb-dialog--page\.sb-dialog--dialog:not\(\[data-covers-sheet\]\) \{[^}]*min-height: 0;/);
        expect(themeCss).not.toMatch(/dialog\.popup\.sb-dialog--page\.sb-dialog--window \{[^}]*min-height: 0;/);
    });

    test('the legacy popup is a bottom sheet under the overlay breakpoint, with Cancel last', () => {
        const sheet = /@media \(max-width: 450px\), \(max-height: 22\.5rem\) \{\s*#dialogue_popup \{([^}]*)\}[\s\S]*?#dialogue_popup_controls \{([^}]*)\}/.exec(themeCss);
        expect(sheet).not.toBeNull();
        expect(sheet[1]).toMatch(/inset: auto 0 0;[^}]*transform: none;/);
        expect(sheet[2]).toMatch(/flex-direction: column-reverse;/);
    });

    test('floating entry rows draw an error in Destructive Red and fade when disabled', () => {
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating:has\(\.ds-row-entry__field > :is\(input, textarea\)\[aria-invalid='true'\]\) \{[^}]*outline: 2px solid var\(--sb-color-danger\);/);
        expect(tabsCss).toMatch(/\.ds-row-entry__error \{[^}]*color: var\(--sb-color-danger\);/);
        expect(tabsCss).toMatch(/\.ds-row\.ds-row-entry--floating:is\(\.is-insensitive, :has\(\.ds-row-entry__field > :is\(input, textarea\):disabled\)\) \{[^}]*opacity: var\(--sb-disabled-opacity\);[^}]*cursor: not-allowed;/);
        expect(tabsCss).toMatch(/\.ds-row-entry--floating:is\(\.is-insensitive, :has\(\.ds-row-entry__field > :is\(input, textarea\):disabled\)\) \.ds-row-entry__edit \{[^}]*opacity: 0\.6;/);
    });
});
