/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';

import { loadDeclarations } from '../util/load-declarations.js';

function createCharacterEditorActionsHarness({ mode = 'edit', entityId = 'alice.png' } = {}) {
    const dispatched = [];
    const context = vm.createContext({
        document,
        HTMLElement: window.HTMLElement,
        getComputedStyle: window.getComputedStyle.bind(window),
        Array,
        Set,
        session: { context: { mode, entityId } },
        characters: [{ name: 'Alice', avatar: 'alice.png', data: { extensions: {} } }],
        _relatedEntries: () => [],
        translate: text => text,
        t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
        _dispatchTransportAction: id => dispatched.push({ kind: 'option', id }),
        _dispatchTransportClick: selector => dispatched.push({ kind: 'click', selector }),
    });
    loadDeclarations(context, 'scripts/sillybunny-character-editor.js', [
        'ACTION_GLYPHS',
        'RECOVERED_ACTIONS',
        '_buildActionSections',
    ]);
    return { context, dispatched };
}

function mountCharacterEditorTransports() {
    document.head.innerHTML = '<style>.sb-editor-transport { display: none !important; }</style>';
    document.body.innerHTML = `
        <select id="char-management-dropdown" class="sb-editor-transport">
            <option id="renameCharButton" value="rename">Rename Character</option>
        </select>
        <div id="creators_note_styles_button" class="sb-editor-transport"></div>
        <div id="character_open_media_overrides" class="sb-editor-transport"></div>
        <div class="rm_stats_button sb-editor-transport"></div>
        <div id="delete_button" class="sb-editor-transport"></div>
    `;
}

function recoveredLabels(sections) {
    return sections[1].items.map(item => item.label);
}

describe('character editor action menu External Media visibility (group peek and create form)', () => {
    beforeEach(() => {
        mountCharacterEditorTransports();
    });

    test('omits External Media in group peek when upstream hides #character_open_media_overrides inline while keeping it for solo edits', () => {
        const mediaTransport = document.getElementById('character_open_media_overrides');

        // All transports are hidden by .sb-editor-transport CSS, so computed display is none in every mode.
        expect(getComputedStyle(mediaTransport).display).toBe('none');

        // Upstream select_selected_character() runs `$('#character_open_media_overrides').toggle(!selected_group)`.
        // Verify that exact wiring exists and apply its DOM effect for solo edit vs group peek.
        const scriptCalls = [];
        const jqueryStub = selector => {
            const element = typeof selector === 'string' ? document.querySelector(selector) : null;
            const chain = {
                css: () => chain,
                attr: () => chain,
                children: () => chain,
                html: () => chain,
                show: () => {
                    if (element) element.style.display = '';
                    return chain;
                },
                hide: () => {
                    if (element) element.style.display = 'none';
                    return chain;
                },
                toggle: state => {
                    scriptCalls.push({ selector, state: Boolean(state) });
                    if (element) {
                        element.style.display = state ? '' : 'none';
                    }
                    return chain;
                },
                val: () => chain,
                text: () => chain,
                prop: () => chain,
                find: () => chain,
                empty: () => chain,
                append: () => chain,
                off: () => chain,
                on: () => chain,
                trigger: () => chain,
                removeClass: () => chain,
                addClass: () => chain,
                toggleClass: () => chain,
                data: () => chain,
            };
            return chain;
        };

        const runUpstreamToggle = selectedGroup => {
            scriptCalls.length = 0;
            const scriptContext = vm.createContext({
                $: jqueryStub,
                selected_group: selectedGroup,
                characters: [{ name: 'Alice', avatar: 'alice.png', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creatorcomment: '', create_date: 0, json_data: '{}', data: { extensions: {} } }],
                select_rm_create: jest.fn(),
                setMenuType: jest.fn(),
                beginCharacterEditorLoad: jest.fn(),
                formatCreatorNotes: () => '',
                depth_prompt_depth_default: 4,
                depth_prompt_role_default: 'system',
                talkativeness_default: 0.5,
                getStoredChatName: () => '',
                timestampToMoment: () => ({ toISOString: () => '2026-01-01T00:00:00.000Z' }),
                updateFavButtonState: jest.fn(),
                getThumbnailUrl: () => '/thumbnail?type=avatar&file=alice.png',
                default_avatar: 'img/ai4.png',
                setWorldInfoButtonClass: jest.fn(),
                checkEmbeddedWorld: jest.fn(),
                loadCharacterEditorGreetings: jest.fn(),
                openCharacterEditorSession: jest.fn(),
                isExternalMediaAllowed: () => false,
                getCharacterSource: () => '',
                eventSource: { emit: jest.fn() },
                event_types: { CHARACTER_EDITOR_OPENED: 'character_editor_opened' },
                saveSettingsDebounced: jest.fn(),
                Array,
            });
            loadDeclarations(scriptContext, 'script.js', ['select_selected_character']);
            scriptContext.select_selected_character(0, { switchMenu: false });
        };

        // Group peek: select_selected_character toggles #character_open_media_overrides off inline.
        runUpstreamToggle('group-1');
        expect(scriptCalls).toContainEqual({ selector: '#character_open_media_overrides', state: false });
        expect(mediaTransport.style.display).toBe('none');

        const groupPeekHarness = createCharacterEditorActionsHarness({ mode: 'edit', entityId: 'alice.png' });
        const groupPeekLabels = recoveredLabels(groupPeekHarness.context._buildActionSections());
        expect(groupPeekLabels).toEqual(['Global Styles', 'Character Stats']);
        expect(groupPeekLabels).not.toContain('External Media');

        // Solo character edit: select_selected_character toggles #character_open_media_overrides back on.
        runUpstreamToggle(null);
        expect(scriptCalls).toContainEqual({ selector: '#character_open_media_overrides', state: true });
        expect(mediaTransport.style.display).toBe('');

        const soloEditHarness = createCharacterEditorActionsHarness({ mode: 'edit', entityId: 'alice.png' });
        expect(recoveredLabels(soloEditHarness.context._buildActionSections())).toEqual([
            'Global Styles',
            'External Media',
            'Character Stats',
        ]);
    });

    test('omits External Media and Delete Character in the create form when the transport is hidden inline', () => {
        const mediaTransport = document.getElementById('character_open_media_overrides');
        mediaTransport.style.display = 'none';

        const createHarness = createCharacterEditorActionsHarness({ mode: 'create', entityId: '' });
        const sections = createHarness.context._buildActionSections();

        expect(recoveredLabels(sections)).toEqual(['Global Styles', 'Character Stats']);
        expect(sections[2].items).toEqual([]);
    });
});
