import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-theme.css'), 'utf8');

describe('default surface contrast', () => {
    test('keeps the canvas visibly distinct from the lighter header bar', () => {
        expect(themeCss).toContain('--sb-layer-canvas-source: color-mix(in srgb, var(--SmartThemeBlurTintColor) 90%, var(--SmartThemeBodyColor) 10%);');
        expect(themeCss).toContain('--sb-layer-headerbar-source: var(--SmartThemeChatTintColor);');
        expect(themeCss).toContain('--sb-layer-view-source: var(--SmartThemeChatTintColor);');
    });
});
