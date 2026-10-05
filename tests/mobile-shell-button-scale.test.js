import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const jsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

describe('mobile shell button scale', () => {
    test('defines mobile rail scale variables in :root', () => {
        expect(cssSource).toContain('--sb-mobile-toggle-min-size:');
        expect(cssSource).toContain('--sb-mobile-rail-action-size:');
        expect(cssSource).toContain('--sb-mobile-rail-tab-height:');
        expect(cssSource).toContain('--sb-mobile-rail-label-size:');
    });

    test('keeps shared mobile navigation controls at the documented touch target floor', () => {
        expect(cssSource).toContain('--sb-mobile-toggle-min-size: var(--sb-mobile-touch-target, 44px);');
        expect(cssSource).toContain('--sb-mobile-rail-tab-height: clamp(var(--sb-mobile-touch-target, 44px),');
    });

    test('mobile vertical rail action uses scale variable instead of hard-coded 44px', () => {
        // Match the specific .sb-shell-rail-action rule block within mobile vertical layout
        const mobileRailActionMatch = cssSource.match(
            /:root\[data-sb-mobile-nav-layout='vertical'\][^\{]*\.sb-shell-rail-action\s*\{[^}]*\}/
        );
        expect(mobileRailActionMatch).not.toBeNull();

        const block = mobileRailActionMatch[0];
        expect(block).toContain('var(--sb-mobile-rail-action-size)');
        expect(block).not.toMatch(/width:\s*44px/);
        expect(block).not.toMatch(/min-width:\s*44px/);
    });

    test('mobile vertical rail tab uses scale variable instead of hard-coded 50px', () => {
        const mobileRailTabMatch = cssSource.match(
            /@media[^{]*max-width:\s*768px[^{]*\{[\s\S]*?data-sb-mobile-nav-layout='vertical'[\s\S]*?\.sb-shell-tab\s*\{[^}]*\}/
        );
        expect(mobileRailTabMatch).not.toBeNull();

        const block = mobileRailTabMatch[0];
        expect(block).toContain('var(--sb-mobile-rail-tab-height)');
        expect(block).not.toMatch(/min-height:\s*50px/);
    });

    test('toggle label mentions Workspace and Customize for vertical layout', () => {
        expect(jsSource).toContain('Show Workspace and Customize shortcuts in each side rail');
    });
});
