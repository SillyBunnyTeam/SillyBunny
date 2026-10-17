import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const tabsJs = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8').replace(/\r\n/g, '\n');
const personaDrawer = indexHtml.split('<div id="persona-management-button"')[1].split('<div id="rightNavHolder"')[0];

// Upstream c0a417b24's complete drawer ID set, retained as hidden transports.
const upstreamDrawerIds = [
    'PersonaManagement', 'personas_backup', 'personas_restore', 'personas_restore_input',
    'persona-management-block', 'create_dummy_persona', 'persona_search_bar', 'persona_sort_order',
    'persona_pagination_container', 'persona_grid_toggle', 'user_avatar_block', 'form_upload_avatar',
    'avatar_upload_file', 'avatar_upload_overwrite', 'persona_controls', 'your_name',
    'persona_rename_button', 'sync_name_button', 'persona_lore_button', 'persona_set_image_button',
    'persona_duplicate_button', 'persona_delete_button', 'persona-management-dropdown', 'persona_lorebook_link',
    'persona_description', 'persona_description_token_count', 'persona_description_position',
    'persona_depth_position_settings', 'persona_depth_value', 'persona_depth_role', 'persona_connections_buttons',
    'lock_persona_default', 'lock_persona_to_char', 'lock_user_name', 'persona_connections_info_block',
    'persona_connections_list', 'persona_show_notifications', 'persona_allow_multi_connections', 'persona_auto_lock',
];

describe('legacy persona layout retirement', () => {
    test('removes the SillyBunny layout stylesheet and registration', () => {
        expect(existsSync(path.join(repoRoot, 'public', 'css', 'personas.css'))).toBe(false);
        expect(tabsJs).not.toContain('css/personas.css');
        expect(tabsJs).not.toContain('deferred-personas-css');
    });

    test('removes SillyBunny-only legacy layout IDs and quick actions', () => {
        expect(indexHtml).not.toMatch(/id="persona_(?:workspace_|editor_(?:tab|panel)_|selected_|appendi(?:x|ces)_|effective_description_preview|to_character_button|management_list_scroller)/);
        expect(indexHtml).not.toMatch(/persona_quick_(?:rename|delete)/);
    });

    test('retains the upstream drawer ID set and every external transport', () => {
        const drawerIds = [...personaDrawer.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        expect(drawerIds.sort()).toEqual([...upstreamDrawerIds].sort());
        expect(indexHtml).toContain('id="persona-management-button"');
        expect(indexHtml).toContain('id="user_avatar_template"');
        expect(indexHtml).toContain('id="sb_character_persona_panel"');
        expect(personaDrawer).toContain('user_stats_button');
        expect(personaDrawer).toMatch(/id="persona_description"[^>]*\bdata-macros\b/);
    });

    test('indexes personas from data rather than hidden transports or transient editor DOM', () => {
        expect(tabsJs).toContain('if (tabState.id === \'persona\') return [];');
        expect(tabsJs).toContain('? getPersonaSearchEntries(tabState)');
        expect(tabsJs).toContain('getPersonaSearchEntries(getCharacterPanelTabConfig(\'persona\'))');
        expect(tabsJs).not.toContain('getPersonaSearchAvatarId');
        expect(tabsJs).not.toContain('.persona_management_global_settings');
    });

    test('switches picker fallbacks through the persona API, not legacy cards', () => {
        expect(tabsJs).toContain('const { usePersona } = await import(\'./personas.js\');');
        expect(tabsJs).toContain('await usePersona(avatarId);');
        expect(tabsJs).not.toContain('#user_avatar_block .avatar-container.selected');
        expect(tabsJs).not.toContain('.avatar-container[title=');
    });

    test('the Scenario Notes shortcut opens the persona editor at the notes section', () => {
        expect(tabsJs).toContain('await openPersonaEditor({ avatarId: currentAvatarId, section: \'notes\' });');
    });
});
