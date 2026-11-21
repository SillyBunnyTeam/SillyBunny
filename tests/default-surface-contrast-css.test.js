import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-theme.css'), 'utf8');

describe('default surface contrast', () => {
    test('mixes the layers to libadwaita\'s role colours on the bundled themes', () => {
        expect(themeCss).toContain('--sb-layer-canvas-source: color-mix(in srgb, var(--SmartThemeBlurTintColor) 95%, var(--SmartThemeBodyColor) 5%);');
        expect(themeCss).toContain('--sb-layer-popover-source: color-mix(in srgb, var(--SmartThemeBlurTintColor) 91.8%, var(--SmartThemeBodyColor) 8.2%);');
        expect(themeCss).toMatch(/:root\[data-sb-surface-tone='light'\]\s*\{[^}]*--sb-layer-canvas-source:\s*color-mix\(in srgb, var\(--SmartThemeBlurTintColor\) 93\.3%, var\(--SmartThemeBodyColor\) 6\.7%\);/);
        expect(themeCss).toMatch(/:root\[data-sb-surface-tone='light'\]\s*\{[^}]*--sb-layer-headerbar-source:\s*var\(--SmartThemeChatTintColor\);/);
        expect(themeCss).toContain('--sb-layer-view-source: var(--SmartThemeChatTintColor);');
        expect(themeCss).toContain('--sb-page-bg-source: color-mix(in srgb, var(--SmartThemeBlurTintColor) 88%, var(--SmartThemeBodyColor) 12%);');
        expect(themeCss).toContain('--sb-layer-view: rgb(from var(--sb-layer-view-source) r g b / 1);');
        expect(themeCss).toContain('--sb-page-bg: rgb(from var(--sb-page-bg-source) r g b / 1);');
        expect(themeCss).toMatch(/body\s*\{[^}]*background-color:\s*var\(--sb-page-bg\);/);
        expect(themeCss).toMatch(/#send_form,\s*body\.no-blur #send_form\s*\{[^}]*background:\s*var\(--sb-layer-bottombar\)\s*!important;/);
        // A bottom bar takes the header bar's fill, as libadwaita's do, in both tones.
        expect(themeCss).toContain('--sb-layer-bottombar-source: var(--sb-layer-canvas-source);');
        expect(themeCss).toMatch(/:root\[data-sb-surface-tone='light'\]\s*\{[^}]*--sb-layer-bottombar-source:\s*var\(--SmartThemeChatTintColor\);/);
        expect(themeCss).toMatch(/@media screen and \(min-width: 769px\)\s*\{\s*#chat\s*\{[^}]*margin-block-start:\s*var\(--sb-drawer-top-gap, 6px\);/);
        expect(themeCss).toMatch(/@media screen and \(max-width: 768px\)\s*\{\s*#chat\s*\{[^}]*margin-block-start:\s*0;/);
    });
});
