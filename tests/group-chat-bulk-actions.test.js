import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('Group chat bulk actions', () => {
    test('routes group cards through selection, tag, and delete actions', () => {
        const tabsSource = readSource('public', 'scripts', 'sillybunny-tabs.js');
        const tabsCssSource = readSource('public', 'css', 'sillybunny-tabs.css');
        const bulkEditSource = readSource('public', 'scripts', 'bulk-edit.js');
        const overlaySource = readSource('public', 'scripts', 'BulkEditOverlay.js');

        expect(tabsSource).not.toContain('sbGroupsGuardBound');
        expect(tabsSource).not.toContain('Bulk edit for groups is not available yet');
        expect(tabsCssSource).not.toContain('[data-menu-type="groups"] #bulkSelectAllButton');
        expect(tabsCssSource).not.toContain('[data-menu-type="groups"] #bulkDeleteButton');
        expect(bulkEditSource).toContain('#rm_print_characters_block .character_select, #rm_print_characters_block .group_select');
        expect(overlaySource).toContain('element.getAttribute(\'data-grid\')');
        expect(overlaySource).toContain('fetch(\'/api/groups/delete\'');
        expect(overlaySource).toContain('this.characterIds.map(getBulkEntity)');
    });
});
