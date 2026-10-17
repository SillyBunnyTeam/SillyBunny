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
        const overlayCssSource = readSource('public', 'css', 'character-group-overlay.css');
        const listCssSource = readSource('public', 'css', 'sillybunny-character-list.css');
        const listSource = readSource('public', 'scripts', 'sillybunny-character-list.js');
        const bulkEditSource = readSource('public', 'scripts', 'bulk-edit.js');
        const overlaySource = readSource('public', 'scripts', 'BulkEditOverlay.js');

        expect(tabsSource).not.toContain('sbGroupsGuardBound');
        expect(tabsSource).not.toContain('Bulk edit for groups is not available yet');
        expect(tabsCssSource).not.toContain('[data-menu-type="groups"] #bulkSelectAllButton');
        expect(tabsCssSource).not.toContain('[data-menu-type="groups"] #bulkDeleteButton');
        expect(overlayCssSource).toContain(':is(.character_select, .group_select).character_selected');
        expect(overlayCssSource).not.toContain('.bogus_folder_select,\n#rm_print_characters_block.group_overlay_mode_select .group_select');
        expect(listSource).toContain('clickTransport(\'#bulkEditButton\')');
        expect(listSource).toContain('\'data-grid\': textValue(data.id ?? item.id)');
        expect(listSource).toContain('button.setAttribute(\'role\', \'button\')');
        expect(listSource).toContain('button.addEventListener(\'keydown\', onBulkKey)');
        expect(listCssSource).toMatch(/\.sb-character-list__transports:has\(#bulkEditButton\.bulk_edit_overlay_active\)\s*\{[^}]*display: flex !important;/);
        expect(listCssSource).toContain('#bulkEditButton, #bulkSelectedCount, #bulkSelectAllButton, #bulkDeleteButton');
        expect(listCssSource).toContain('#rm_print_characters_block:is(.bulk_select, .group_overlay_mode_select) .ds-entity-row.character_selected');
        expect(listCssSource).toMatch(/:is\(\.bulk_select, \.group_overlay_mode_select\) \.ds-entity-row__suffix\s*\{\s*visibility: hidden;/);
        expect(bulkEditSource).toContain('#rm_print_characters_block .character_select, #rm_print_characters_block .group_select');
        expect(overlaySource).toContain('element.getAttribute(\'data-grid\')');
        expect(overlaySource).toContain('fetch(\'/api/groups/delete\'');
        expect(overlaySource).toContain('this.characterIds.map(getBulkEntity)');
    });
});
