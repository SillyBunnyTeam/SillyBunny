/**
 * Source contracts for the Connections panel adapter. These contracts protect the seams between
 * SillyBunny's presentation and the upstream connection handlers.
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
    const scriptSource = readSource('public', 'script.js');
    const tabsCss = readSource('public', 'css', 'sillybunny-tabs.css');
    const themeCss = readSource('public', 'css', 'sillybunny-theme.css');

    test('mounts its own panel into the base tab of the backend shell', () => {
        expect(tabsSource).toContain('import { createConnectionsPanel } from \'./sillybunny-connections-panel.js\';');
        expect(tabsSource).toContain('createConnectionsPanel({');
        expect(tabsSource).toContain('basePanel.scroller.appendChild(connectionsPanel.column);');
    });

    test('keeps the five groups in profile, backend, provider, general order', () => {
        expect(panelSource).toContain('column.append(profileGroup.section, backendGroup.section, ...providerSlots, generalGroup.section);');
        expect(panelSource).toContain('createPrefGroup({');
        expect(panelSource).toContain('title: t`Connection Profile`');
        expect(panelSource).toContain('title: t`Backend`');
        expect(panelSource).toContain('title: t`General`');
        expect(panelSource).toContain('data-sb-provider');
    });

    test('uses the shared radio toggle and three shared source picker rows', () => {
        expect(panelSource).toContain('createToggleRow({');
        expect(panelSource).toContain('fill: true');
        expect(panelSource).toContain('choices: [');
        expect(panelSource).toContain('[\'chat\', t`Chat Completions`]');
        expect(panelSource).toContain('[\'text\', t`Text Completions`]');
        expect(panelSource).toContain('[\'other\', t`Other`]');
        expect(panelSource).toContain('createSelectRow({');
        expect(panelSource).toContain('label: t`Source`');
        expect(panelSource).toContain('sourceRows');
        expect(panelSource).toContain('onPick: clearProfileSelection');
        expect(panelSource).toContain('otherSelect');
    });

    test('uses the profile row and proxies every menu action to its original button', () => {
        expect(panelSource).toContain('createProfileRow({');
        expect(panelSource).toContain('openActionMenu({');
        expect(panelSource).toContain('original.click()');
        expect(panelSource).toContain('connection_profile_spinner');
        expect(panelSource).toContain('sb-connection-profile-sets');
        expect(panelSource).toContain('View Details');
        expect(panelSource).toContain('Manage Folders…');
        expect(panelSource).toContain('Delete All…');
    });

    test('records adopted upstream nodes and restores them on teardown', () => {
        expect(panelSource).toContain('function moveNode(');
        expect(panelSource).toContain('state.moved.push({ node, parent: node.parentNode, next: node.nextSibling });');
        expect(panelSource).toContain('restoreMoved();');
        expect(panelSource).not.toContain('cloneNode(true)');
        expect(panelSource).not.toContain('innerHTML =');
        expect(panelSource).not.toContain('changeMainAPI(');
    });

    test('keeps native API and source selects as the source of truth', () => {
        expect(panelSource).toContain('document.getElementById(\'main_api\')');
        expect(panelSource).toContain('\'#chat_completion_source\'');
        expect(panelSource).toContain('\'#textgen_type\'');
        expect(panelSource).toContain('select.dispatchEvent(new Event(\'change\', { bubbles: true }))');
        expect(panelSource).toContain('\'data-sb-connections-panel\': \'\'');
        expect(panelSource).toMatch(/if \(!\(select instanceof HTMLSelectElement\) \|\| select\.value === value\) \{\s*return false;/);
        expect(panelSource).toContain('applyPanelApiVisibility');
        expect(scriptSource).toContain('export function changePanelApiVisibility(selectedVal)');
    });

    test('follows MAIN_API_CHANGED and keeps the legacy drawer attached', () => {
        expect(panelSource).toContain('event_types.MAIN_API_CHANGED');
        expect(panelSource).toContain('eventSource.on(name, handler)');
        expect(panelSource).toContain('document.getElementById(\'rm_api_block\')');
        expect(tabsSource).toContain('prepareEmbeddedDrawer(\'sys-settings-button\')');
        expect(tabsSource).toContain('sb-legacy-api-drawer');
        expect(themeCss).not.toContain('#rm_api_block');
        expect(tabsCss).toContain('.sb-legacy-api-drawer');
    });

    test('clears a selected profile for every manual backend or source pick', () => {
        expect(panelSource).toContain('clearProfileSelection();');
        expect(panelSource).toContain('onPick: clearProfileSelection');
        expect(panelSource).toContain('selectBackend(next, { byHand: true })');
        expect(panelSource).toMatch(/onChange: backend\.id === 'other'\s*\? value => \{\s*applyApi\(value\);\s*syncFromApi\(\);/);
    });

    test('puts provider status first and keeps the C2a secondary status row', () => {
        expect(panelSource).toContain('liftConnectRow(slot)');
        expect(panelSource).toContain('sb-connections-status-row');
        expect(panelSource).toContain('sb-connections-status-extra');
        expect(panelSource).toContain('.openrouter_authorize, #customize_additional_parameters');
        expect(panelSource).toContain('suggested-action');
        expect(panelSource).not.toContain('buildComboRow');
        expect(panelSource).not.toContain('sb-combo-');
    });

    test('the shell leaves Connections provider expanders under upstream control', () => {
        expect(tabsSource).toMatch(/SB_COLLAPSIBLE_DRAWER_TAB_IDS = .*\['extensions', 'connections'\]/);
    });

    test('the mobile model filter is not injected into a shared searchable picker row', () => {
        const filter = tabsSource.slice(tabsSource.indexOf('function injectModelFilterInput('), tabsSource.indexOf('function buildBottomChatBar('));
        expect(filter).toContain('$select[0].closest(\'.ds-select-row\')');
    });

    test('renders the General controls as shared rows while retaining the hidden key viewer', () => {
        expect(panelSource).toContain('createSwitchRow({');
        expect(panelSource).toContain('document.getElementById(\'auto-connect-checkbox\')');
        expect(panelSource).toContain('createButtonRow({');
        expect(panelSource).toContain('document.getElementById(\'viewSecrets\')');
        expect(panelSource).toContain('originalViewSecrets.click()');
        expect(panelSource).not.toContain('sb-connections-footer');
    });

    test('does not retain the old sticky, tab, combo, or stacked-outline implementation', () => {
        expect(panelSource).not.toContain('role: \'tablist\'');
        expect(panelSource).not.toContain('role: \'tab\'');
        expect(panelSource).not.toContain('sb-backend-switch-button');
        expect(panelSource).not.toContain('sb-other-backend-button');
        expect(tabsCss).not.toContain('.sb-connections-switcher');
        expect(tabsCss).not.toContain('.sb-combo-list');
        expect(tabsCss).not.toContain('position: sticky');
        expect(tabsCss).not.toContain('position: -webkit-sticky');
    });
});
