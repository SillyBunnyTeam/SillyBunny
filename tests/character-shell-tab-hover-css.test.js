import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');

describe('character shell tab hover styling', () => {
    test('uses the same Libadwaita hover states for Characters and Groups', () => {
        expect(tabsCss).toContain('#right-nav-panel.openDrawer .sb-character-shell-nav > .sb-shell-tab:hover');
        expect(tabsCss).toContain('background: var(--sb-flat-hover-bg);');
        expect(tabsCss).toContain('#right-nav-panel.openDrawer .sb-character-shell-nav > .sb-shell-tab:is(.is-active, .active, .selected, .is-selected, .is-current, [aria-selected=\'true\'], [aria-current]):hover');
        expect(tabsCss).toContain('background: var(--sb-flat-selected-hover-bg);');
        expect(tabsCss).toContain('border-color: transparent;');
    });
});
