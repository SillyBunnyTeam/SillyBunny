/**
 * The Connections panel is built by hand rather than by the subpage stack, and it presents a
 * different contract from the stacked panels: it always shows its backend switch, it never writes
 * global API state just because a control was clicked, and it moves upstream's provider markup
 * rather than copying it.
 *
 * These are the parts of that contract a static read can hold: the wiring that is easy to undo by
 * accident in a later edit.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('SillyBunny Connections panel', () => {
    const panelSource = readSource('public', 'scripts', 'sillybunny-connections-panel.js');
    const tabsSource = readSource('public', 'scripts', 'sillybunny-tabs.js');
    const descriptorsSource = readSource('public', 'scripts', 'sillybunny-settings-subpage-descriptors.js');
    const scriptSource = readSource('public', 'script.js');
    const tabsCss = readSource('public', 'css', 'sillybunny-tabs.css');
    const themeCss = readSource('public', 'css', 'sillybunny-theme.css');

    test('is not presented as a subpage stack', () => {
        expect(tabsSource).toContain("new Set(['extensions', 'prompting'])");
        expect(tabsSource).not.toContain("'connections', 'extensions'");
        expect(descriptorsSource).not.toContain('buildConnectionsSubpage');
        expect(descriptorsSource).not.toContain('SB_PROVIDER_API_IDS');
    });

    test('mounts its own panel into the base tab of the backend shell', () => {
        expect(tabsSource).toContain("import { createConnectionsPanel } from './sillybunny-connections-panel.js';");
        expect(tabsSource).toContain('createConnectionsPanel({');
        expect(tabsSource).toContain('basePanel.scroller.appendChild(connectionsPanel.column);');
    });

    test('keeps the native API selects in the document as the source of truth', () => {
        // The panel draws views over these; removing them would break every reader in the app.
        expect(panelSource).toContain("document.getElementById('main_api')");
        expect(panelSource).toContain("'#chat_completion_source'");
        expect(panelSource).toContain("'#textgen_type'");
        expect(panelSource).not.toContain('main_api\').remove()');
        expect(panelSource).not.toContain("getElementById('rm_api_block').remove()");
    });

    test('never writes the API value behind the change handler that owns it', () => {
        // The write has to go through a dispatched `change`, or the save, the event, and every
        // dependent panel are skipped. Setting the value alone is the bug this guards.
        expect(panelSource).toContain("select.dispatchEvent(new Event('change', { bubbles: true }))");
        expect(panelSource).toMatch(/if \(!\(select instanceof HTMLSelectElement\) \|\| select\.value === value\) \{\s*return false;/);
    });

    test('reserves the side-effectful API change for a real backend switch', () => {
        // A re-click of the backend already in effect must only re-run the visibility pass: the full
        // change resets the connection status and reconnects, which drops a live session.
        expect(panelSource).toContain('applyPanelApiVisibility');
        expect(panelSource).not.toContain('changeMainAPI(');
        expect(scriptSource).toContain('export function changePanelApiVisibility(selectedVal)');
        expect(scriptSource).toMatch(/export function changeMainAPI\(api = null\)[\s\S]{0,120}changePanelApiVisibility\(selectedVal\)/);
    });

    test('follows the API value from anywhere it is moved', () => {
        // The top-bar connection strip, `/api`, and an applied connection profile all move
        // `#main_api` without touching the panel.
        expect(panelSource).toContain('event_types.MAIN_API_CHANGED');
        expect(panelSource).toContain('eventSource.on(name, handler)');
    });

    test('moves the provider markup instead of cloning it', () => {
        // Cloning would duplicate ids and drop the listeners `openai.js`, `textgen-settings.js`,
        // `nai-settings.js`, `horde.js`, and `secrets.js` attached.
        expect(panelSource).toContain('function moveNode(');
        expect(panelSource).not.toContain('cloneNode(true)');
        expect(panelSource).not.toContain('innerHTML =');
    });

    test('empties the upstream drawer without detaching it', () => {
        // `openai.js`, `horde.js`, and `textgen-models.js` look `#rm_api_block` up as a select2
        // dropdown parent, and `script.js` registers it as a layout target.
        expect(tabsSource).toContain("prepareEmbeddedDrawer('sys-settings-button')");
        expect(tabsSource).toContain('sb-legacy-api-drawer');
        expect(themeCss).not.toContain('#rm_api_block');
        expect(tabsCss).toContain('.sb-legacy-api-drawer');
    });

    test('points the connect-row rules at the panel instead of the emptied drawer', () => {
        expect(tabsCss).toContain('.sb-connections-panel');
        expect(themeCss).toContain('[data-sb-connections-panel]');
        expect(themeCss).toContain('[data-sb-connections-panel] .online_status');
        // The theme rules key on this attribute, so the panel column has to carry it or every one
        // of them is dead.
        expect(panelSource).toContain("'data-sb-connections-panel': ''");
    });

    test('boxes every provider, connect card included, in the same pill', () => {
        // Chat Completions authors its connect row on the block itself, Text Completions inside a
        // form; both have to end up inside the body pill.
        expect(panelSource).toContain('const children = Array.from(block.children);');
        expect(panelSource).toContain("connectSlot.className = 'sb-connections-connect-slot';");
        expect(tabsCss).toContain('.sb-connections-provider-body {');
    });

    test('removes the native source pickers from layout entirely', () => {
        expect(tabsCss).toMatch(/\.sb-connections-panel #textgenerationwebui_api h4:has\(\+ select#textgen_type\) \{\n\s+display: none !important;/);
    });

    test('leaves the connect row in place so the mobile rules still match it', () => {
        // The mobile sheet targets the row by its exact parent chain, so lifting it out of its
        // block or its form would take the buttons' mobile layout with it.
        expect(panelSource).toContain("row.parentElement?.prepend(row)");
        expect(panelSource).not.toContain('card.appendChild(row)');
        expect(panelSource).not.toContain('row.cloneNode');
    });

    test('installs the stacked panels on the first mount, not only on a tab switch', () => {
        // The base tab is already active before the settings page is ever mounted, so the mount path
        // has to run the stack install itself or the first paint is the raw legacy drawer.
        expect(tabsSource).toMatch(/flattenSettingsPanelDrawers\(shellKey, shellState\.activeTabId\);[\s\S]{0,700}?installSettingsSubpage\(shellKey, shellState\.activeTabId\);/);
    });

    test('renders the provider list from the select rather than a captured copy', () => {
        // Extensions append providers to these lists as they initialise.
        expect(panelSource).toContain('new MutationObserver(rebuildOptions)');
        expect(panelSource).toContain('for (const child of select.children)');
    });

    test('supports a libadwaita combo row rather than a native select menu', () => {
        expect(panelSource).toContain("'aria-haspopup': 'listbox'");
        expect(panelSource).toContain("role: 'combobox'");
        expect(tabsCss).toContain('.sb-combo-list');
        expect(tabsCss).toContain('.sb-combo-option');
    });
});
