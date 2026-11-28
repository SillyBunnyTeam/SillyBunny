/** @jest-environment jsdom */
import { afterEach, describe, expect, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let activeScript = null;

afterEach(() => {
    activeScript?.cleanup();
    activeScript = null;
    document.body.innerHTML = '';
});

describe('public/script.js dormant World Info OpenAll/CloseAll handlers', () => {
    test('toggles every inline-drawer in #world_popup_entries_list on #OpenAllWIEntries and #CloseAllWIEntries click', async () => {
        const loaded = await importScriptModule({
            dom: `
                <div id="chat"></div>
                <button id="OpenAllWIEntries" type="button"></button>
                <button id="CloseAllWIEntries" type="button"></button>
                <div id="world_popup_entries_list">
                    <div class="inline-drawer" id="drawer-a"></div>
                    <div class="inline-drawer" id="drawer-b"></div>
                </div>
            `,
        });
        activeScript = loaded;

        await loaded.runReady();
        const toggleDrawer = loaded.mocks['scripts/utils.js'].toggleDrawer;
        const drawerA = document.getElementById('drawer-a');
        const drawerB = document.getElementById('drawer-b');

        document.getElementById('OpenAllWIEntries').click();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(toggleDrawer).toHaveBeenCalledWith(drawerA, true);
        expect(toggleDrawer).toHaveBeenCalledWith(drawerB, true);

        toggleDrawer.mockClear();
        document.getElementById('CloseAllWIEntries').click();
        expect(toggleDrawer).toHaveBeenCalledWith(drawerA, false);
        expect(toggleDrawer).toHaveBeenCalledWith(drawerB, false);
    });
});
