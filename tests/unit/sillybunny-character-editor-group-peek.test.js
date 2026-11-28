/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from '../util/script-harness.js';

const TRANSPORTS_DOM = `
    <style>.sb-editor-transport { display: none !important; }</style>
    <div id="right-nav-panel" class="sb-settings-mounted-shell openDrawer" data-menu-type="character_edit">
        <div id="rm_ch_create_block">
            <form id="form_create">
                <input id="character_name_pole" value="Alice">
                <div id="character_open_media_overrides" class="sb-editor-transport"></div>
            </form>
        </div>
    </div>
`;

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) activeCleanups.pop()();
    document.head.innerHTML = '';
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

const SAMPLE_CHARACTER = {
    name: 'Alice',
    avatar: 'alice.png',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creatorcomment: '',
    create_date: 0,
    json_data: '{}',
    data: { extensions: {} },
};

describe('select_selected_character External Media transport toggle (group peek vs solo edit)', () => {
    test('hides #character_open_media_overrides inline during group peek', async () => {
        const loaded = await importScriptModule({
            dom: TRANSPORTS_DOM,
            mocks: {
                'scripts/group-chats.js': base => ({
                    ...base,
                    selected_group: 'group-1',
                }),
            },
        });
        activeCleanups.push(() => loaded.cleanup());

        loaded.script.characters.push({ ...SAMPLE_CHARACTER });
        const mediaTransport = document.getElementById('character_open_media_overrides');
        expect(getComputedStyle(mediaTransport).display).toBe('none');

        loaded.script.select_selected_character(0, { switchMenu: false });
        expect(mediaTransport.style.display).toBe('none');
    });

    test('clears inline display: none on #character_open_media_overrides for solo edits', async () => {
        const loaded = await importScriptModule({
            dom: TRANSPORTS_DOM,
            mocks: {
                'scripts/group-chats.js': base => ({
                    ...base,
                    selected_group: null,
                }),
            },
        });
        activeCleanups.push(() => loaded.cleanup());

        loaded.script.characters.push({ ...SAMPLE_CHARACTER });
        const mediaTransport = document.getElementById('character_open_media_overrides');
        mediaTransport.style.display = 'none';

        loaded.script.select_selected_character(0, { switchMenu: false });
        expect(mediaTransport.style.display).not.toBe('none');
    });
});
