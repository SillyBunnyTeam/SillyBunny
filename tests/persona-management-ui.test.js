/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importTabsModule } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
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

let loaded = null;

afterEach(() => {
    jest.useRealTimers();
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('legacy persona layout retirement', () => {
    test('removes the SillyBunny layout stylesheet, keeps the entity-row preload, and retains upstream drawer IDs in HTML', () => {
        expect(existsSync(path.join(repoRoot, 'public', 'css', 'personas.css'))).toBe(false);
        expect(indexHtml).toMatch(/<link rel="preload" as="style" href="css\/sillybunny-entity-list\.css\?v=20261118zza" data-sb-deferred-style/);
        expect(indexHtml).not.toMatch(/<link rel="stylesheet"[^>]*href="css\/sillybunny-entity-list\.css/);
        expect(indexHtml).not.toMatch(/id="persona_(?:workspace_|editor_(?:tab|panel)_|selected_|appendi(?:x|ces)_|effective_description_preview|to_character_button|management_list_scroller)/);
        expect(indexHtml).not.toMatch(/persona_quick_(?:rename|delete)/);

        const drawerIds = [...personaDrawer.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        expect(drawerIds.sort()).toEqual([...upstreamDrawerIds].sort());
        expect(indexHtml).toContain('id="persona-management-button"');
        expect(indexHtml).toContain('id="user_avatar_template"');
        expect(indexHtml).toContain('id="sb_character_persona_panel"');
        expect(personaDrawer).toContain('user_stats_button');
        expect(personaDrawer).toMatch(/id="persona_description"[^>]*\bdata-macros\b/);
    });

    test('opening the Persona tab loads the shared entity-list sheet and never requests retired personas.css', async () => {
        const loadPersonaEditorStyles = jest.fn(async () => {});
        const mountPersonaEditor = jest.fn(() => ({ ready: Promise.resolve(), onReveal: jest.fn() }));
        loaded = await importTabsModule({
            mocks: {
                'scripts/sillybunny-persona-editor.js': {
                    loadPersonaEditorStyles,
                    mountPersonaEditor,
                    openPersonaEditor: jest.fn(async () => {}),
                },
            },
        });

        await loaded.shell.openTab('characters', 'persona');
        await loaded.flush();

        expect(loadPersonaEditorStyles).toHaveBeenCalled();
        const passedSheets = loadPersonaEditorStyles.mock.calls.flatMap(([sheets]) => sheets ?? []);
        expect(passedSheets).toContainEqual({
            href: 'css/sillybunny-entity-list.css?v=20261118zza',
            id: 'deferred-entity-list-css',
        });
        expect(passedSheets.some(s => String(s.href).includes('css/personas.css') || s.id === 'deferred-personas-css')).toBe(false);
    });

    test('indexes personas from powerUserSettings data in global search rather than hidden transport DOM', async () => {
        loaded = await importTabsModule({
            power_user: {
                personas: { 'hero.png': 'Captain Starlight' },
                persona_descriptions: { 'hero.png': { title: 'Starship Captain' } },
                default_persona: 'hero.png',
            },
            extraDom: '<div id="hidden_dom_trap"><span class="persona_management_global_settings">Phantom Transport Persona</span></div>',
        });

        loaded.shell.openGlobalSearch({ focusInput: true });
        await loaded.flush();

        const input = /** @type {HTMLInputElement} */ (document.activeElement);
        expect(input).toBeInstanceOf(HTMLInputElement);
        input.value = 'Starlight';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 250));

        const resultsText = document.querySelector('.sb-search-results')?.textContent ?? '';
        expect(resultsText).toContain('Captain Starlight');

        input.value = 'Phantom Transport';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(document.querySelector('.sb-search-results')?.textContent ?? '').not.toContain('Phantom Transport Persona');
    });

    test('switches personas via usePersona fallback and opens Scenario Notes via openPersonaEditor', async () => {
        const usePersona = jest.fn(async () => {});
        const openPersonaEditor = jest.fn(async () => {});
        loaded = await importTabsModule({
            power_user: {
                personas: {
                    'alice.png': 'Alice',
                    'bob.png': 'Bob',
                },
                persona_descriptions: {
                    'alice.png': { title: 'Default Hero' },
                    'bob.png': { title: 'Alternate Hero' },
                },
                default_persona: 'alice.png',
            },
            context: {
                userAvatar: 'alice.png',
            },
            mocks: {
                'scripts/personas.js': { usePersona },
                'scripts/sillybunny-persona-editor.js': {
                    mountPersonaEditor: jest.fn(() => ({ ready: Promise.resolve() })),
                    openPersonaEditor,
                },
            },
        });

        const bubble = document.getElementById('sb-persona-bubble');
        expect(bubble).not.toBeNull();
        bubble.click();
        await loaded.flush();

        const picker = document.getElementById('sb-persona-picker');
        expect(picker).not.toBeNull();

        // Scenario Notes "Manage" shortcut opens the persona editor at the notes section.
        const manageBtn = picker.querySelector('.sb-persona-picker-manage');
        expect(manageBtn).not.toBeNull();
        manageBtn.click();
        await loaded.flush();
        expect(openPersonaEditor).toHaveBeenCalledWith({ avatarId: 'alice.png', section: 'notes' });

        // Re-open the picker and click Bob to verify the usePersona API fallback (no executeSlashCommandsWithOptions on context).
        bubble.click();
        await loaded.flush();
        const bobOption = [...document.querySelectorAll('#sb-persona-picker .sb-persona-option')]
            .find(opt => opt.textContent.includes('Bob'));
        expect(bobOption).not.toBeNull();
        bobOption.click();
        await loaded.flush();

        expect(usePersona).toHaveBeenCalledWith('bob.png');
    });
});
