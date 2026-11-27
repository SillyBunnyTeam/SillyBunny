/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static CSS/shell contracts. */
/**
 * Behavioural tests for the Connections panel adapter, plus static CSS/shell contracts.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolvePublic = (relativePath) => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const tabsSource = readSource('public', 'scripts', 'sillybunny-tabs.js');
const scriptSource = readSource('public', 'script.js');
const tabsCss = readSource('public', 'css', 'sillybunny-tabs.css');
const themeCss = readSource('public', 'css', 'sillybunny-theme.css');

const listeners = new Map();
const eventSourceMock = {
    on: jest.fn((name, handler) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
    }),
    off: jest.fn((name, handler) => {
        listeners.get(name)?.delete(handler);
    }),
    emit: (name, ...args) => {
        for (const handler of [...(listeners.get(name) ?? [])]) {
            handler(...args);
        }
    },
};

const openActionMenuMock = jest.fn();
const closeActionMenuMock = jest.fn();
let actionMenuOpen = false;

await jest.unstable_mockModule(resolvePublic('script.js'), () => ({
    eventSource: eventSourceMock,
    event_types: { MAIN_API_CHANGED: 'main_api_changed' },
}));
await jest.unstable_mockModule(resolvePublic('scripts/i18n.js'), () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
    translate: text => text,
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-action-menu.js'), () => ({
    openActionMenu: openActionMenuMock,
    closeActionMenu: closeActionMenuMock,
    isActionMenuOpen: () => actionMenuOpen,
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-editor/list-shell.js'), () => ({
    loadListEditorStyles: jest.fn(),
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-connections-form.js'), () => ({
    applyConnectionsFormPass: jest.fn(),
    presentButtonRow: jest.fn(),
}));
await jest.unstable_mockModule(resolvePublic('scripts/sillybunny-connections-groups.js'), () => ({
    applyConnectionsGroups: jest.fn(() => ({ sync: jest.fn() })),
}));

const { createConnectionsPanel } = await import('../public/scripts/sillybunny-connections-panel.js');

function createElement(tagName, { className, attrs } = {}) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (attrs) {
        for (const [name, value] of Object.entries(attrs)) {
            element.setAttribute(name, value);
        }
    }
    return element;
}

function buildUpstreamDom() {
    document.body.innerHTML = `
        <div id="rm_api_block">
            <select id="main_api">
                <option value="openai">Chat Completion</option>
                <option value="textgenerationwebui">Text Completion</option>
                <option value="novel">NovelAI</option>
                <option value="koboldhorde">AI Horde</option>
                <option value="kobold">KoboldAI</option>
            </select>
            <div class="wide100p" id="profile_card_root">
                <select id="connection_profiles">
                    <option value="">None</option>
                    <option value="prof-1">My Profile</option>
                </select>
                <span id="connection_profile_spinner"></span>
                <div id="sb-connection-profile-sets">Using preset Alpha</div>
                <button id="update_connection_profile"><i class="fa-solid fa-save"></i></button>
                <button id="reload_connection_profile"><i class="fa-solid fa-rotate"></i></button>
                <button id="create_connection_profile"><i class="fa-solid fa-plus"></i></button>
                <button id="edit_connection_profile"><i class="fa-solid fa-pen"></i></button>
                <button id="view_connection_profile"><i class="fa-solid fa-eye"></i></button>
                <button id="toggle_profile_favorite" aria-pressed="true"><i class="fa-solid fa-star"></i></button>
                <button id="manage_profile_folders"><i class="fa-solid fa-folder"></i></button>
                <button id="delete_connection_profile"><i class="fa-solid fa-trash"></i></button>
                <button id="delete_all_connection_profiles"><i class="fa-solid fa-dumpster"></i></button>
            </div>
            <div id="openai_api">
                <h4>Chat Completion Source</h4>
                <select id="chat_completion_source">
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                </select>
                <div class="flex-container" id="openai_connect_row">
                    <div class="online_status"><span class="online_status_text">Connected</span></div>
                    <button class="api_button" id="api_button_openai">Connect</button>
                    <button class="api_loading">Cancel</button>
                    <button id="test_api_button">Test Message</button>
                    <button class="openrouter_authorize">Authorize OpenRouter</button>
                    <button id="customize_additional_parameters">Additional Parameters</button>
                </div>
            </div>
            <div id="textgenerationwebui_api" style="display: none;">
                <h4>API Type</h4>
                <select id="textgen_type">
                    <option value="koboldcpp">KoboldCpp</option>
                    <option value="llamacpp">llama.cpp</option>
                </select>
                <div class="flex-container">
                    <div class="online_status"><span class="online_status_text">Disconnected</span></div>
                    <button class="api_button" id="api_button_textgenerationwebui">Connect</button>
                </div>
            </div>
            <div id="novel_api" style="display: none;">
                <div class="flex-container">
                    <div class="online_status"><span class="online_status_text">Offline</span></div>
                    <button class="api_button">Connect</button>
                </div>
            </div>
            <div id="kobold_horde" style="display: none;">
                <form>
                    <div class="online_status"><span class="online_status_text">Horde</span></div>
                </form>
            </div>
            <div id="kobold_api" style="display: none;">
                <div class="flex-container">
                    <div class="online_status"><span class="online_status_text">Offline</span></div>
                    <button class="api_button">Connect</button>
                </div>
            </div>
            <div class="flex-container alignitemscenter spaceBetween wide100p" id="upstream_general_footer">
                <input type="checkbox" id="auto-connect-checkbox" />
                <button id="viewSecrets">View API Keys</button>
            </div>
        </div>
        <div id="panel_host"></div>
    `;
}

function mountPanel(initialApi = 'openai') {
    buildUpstreamDom();
    const mainApiSelect = document.getElementById('main_api');
    mainApiSelect.value = initialApi;
    const applyPanelApiVisibility = jest.fn();
    const panel = createConnectionsPanel({
        createElement,
        getActiveApi: () => mainApiSelect.value,
        applyPanelApiVisibility,
    });
    document.getElementById('panel_host').append(panel.column);
    return { panel, mainApiSelect, applyPanelApiVisibility };
}

describe('SillyBunny Connections panel', () => {
    let activePanel = null;

    beforeEach(() => {
        listeners.clear();
        eventSourceMock.on.mockClear();
        eventSourceMock.off.mockClear();
        openActionMenuMock.mockReset();
        closeActionMenuMock.mockReset();
        actionMenuOpen = false;
        activePanel = null;
    });

    afterEach(() => {
        activePanel?.teardown();
        document.body.innerHTML = '';
    });

    test('mounts its own panel into the base tab of the backend shell', () => {
        expect(tabsSource).toContain('import { createConnectionsPanel } from \'./sillybunny-connections-panel.js\';');
        expect(tabsSource).toContain('createConnectionsPanel({');
        expect(tabsSource).toContain('basePanel.scroller.appendChild(connectionsPanel.column);');
    });

    test('keeps the five groups in profile, backend, provider, general order', () => {
        const { panel } = mountPanel('openai');
        activePanel = panel;

        const children = [...panel.column.children];
        expect(children[0].dataset.sbEditorField).toBe('profile');
        expect(children[0].querySelector('.ds-pref-group-heading').textContent).toBe('Connection Profile');
        expect(children[1].dataset.sbEditorField).toBe('backend');
        expect(children[1].querySelector('.ds-pref-group-heading').textContent).toBe('Backend');

        const providerOrder = children.slice(2, 7).map(node => node.dataset.sbProvider);
        expect(providerOrder).toEqual(['openai', 'textgenerationwebui', 'novel', 'koboldhorde', 'kobold']);

        expect(children[7].dataset.sbEditorField).toBe('general');
        expect(children[7].querySelector('.ds-pref-group-heading').textContent).toBe('General');
    });

    test('uses the shared radio toggle and three shared source picker rows', () => {
        const { panel, mainApiSelect } = mountPanel('openai');
        activePanel = panel;

        const toggleRow = panel.column.querySelector('[data-sb-editor-field="backend-type"]');
        expect(toggleRow).not.toBeNull();
        expect(toggleRow.querySelector('[role="radiogroup"]')).not.toBeNull();
        const choiceLabels = [...toggleRow.querySelectorAll('[role="radiogroup"] label')];
        const choiceInputs = [...toggleRow.querySelectorAll('input[type="radio"]')];
        expect(choiceLabels.map(label => label.textContent.trim())).toEqual([
            'Chat Completions',
            'Text Completions',
            'Other',
        ]);

        const sourceRows = [...panel.column.querySelectorAll('[data-sb-backend-source]')];
        expect(sourceRows.map(row => row.dataset.sbBackendSource).sort()).toEqual(['chat', 'other', 'text']);
        // The active source row is placed last so the boxed list ends cleanly without a trailing divider.
        expect(sourceRows.at(-1).dataset.sbBackendSource).toBe('chat');
        for (const row of sourceRows) {
            expect(row.querySelector('.ds-row-label').textContent).toBe('Source');
        }
        expect(sourceRows.find(r => r.dataset.sbBackendSource === 'chat').hidden).toBe(false);
        expect(sourceRows.find(r => r.dataset.sbBackendSource === 'text').hidden).toBe(true);
        expect(sourceRows.find(r => r.dataset.sbBackendSource === 'other').hidden).toBe(true);

        // Switching to Other reveals the synthetic other-backend picker and drives #main_api.
        choiceInputs[2].click();
        expect(mainApiSelect.value).toBe('novel');
        const otherRow = panel.column.querySelector('[data-sb-backend-source="other"]');
        expect(otherRow.hidden).toBe(false);
        const otherSelect = otherRow.querySelector('select.sb-connections-other-source');
        expect([...otherSelect.options].map(opt => opt.value)).toEqual(['novel', 'koboldhorde', 'kobold']);
    });

    test('uses the profile row and proxies every menu action to its original button', () => {
        const { panel } = mountPanel('openai');
        activePanel = panel;

        const profileRow = panel.column.querySelector('[data-sb-editor-field="connection-profile"]');
        expect(profileRow).not.toBeNull();
        expect(profileRow.querySelector('#connection_profile_spinner')).not.toBeNull();
        const summary = profileRow.querySelector('#sb-connection-profile-sets');
        expect(summary).not.toBeNull();
        expect(profileRow.querySelector('.ds-select-row__trigger').getAttribute('aria-describedby')).toBe('sb-connection-profile-sets');

        // Disabled upstream actions should be omitted from the action menu.
        document.getElementById('update_connection_profile').classList.add('disabled');

        const menuButton = profileRow.querySelector('.ds-select-row__menu');
        menuButton.click();
        expect(openActionMenuMock).toHaveBeenCalledTimes(1);

        const menuArg = openActionMenuMock.mock.calls[0][0];
        const items = menuArg.sections.flatMap(section => section.items);
        const labels = items.map(item => item.label);
        expect(labels).not.toContain('Update');
        expect(labels).toContain('View Details');
        expect(labels).toContain('Manage Folders…');
        expect(labels).toContain('Delete All…');
        expect(items.find(item => item.label === 'Favorite').checked).toBe(true);
        expect(items.find(item => item.label === 'Delete All…').danger).toBe(true);

        const viewSpy = jest.fn();
        document.getElementById('view_connection_profile').addEventListener('click', viewSpy);
        items.find(item => item.label === 'View Details').onSelect();
        expect(viewSpy).toHaveBeenCalledTimes(1);
    });

    test('records adopted upstream nodes and restores them on teardown', () => {
        const { panel } = mountPanel('openai');
        activePanel = panel;

        const root = document.getElementById('rm_api_block');
        const profileCard = document.getElementById('profile_card_root');
        const profileSelect = document.getElementById('connection_profiles');
        const openaiBlock = document.getElementById('openai_api');
        const chatSource = document.getElementById('chat_completion_source');
        const autoConnect = document.getElementById('auto-connect-checkbox');

        expect(panel.column.contains(profileSelect)).toBe(true);
        expect(panel.column.contains(openaiBlock)).toBe(true);
        expect(panel.column.contains(chatSource)).toBe(true);
        expect(panel.column.contains(autoConnect)).toBe(true);

        panel.teardown();
        activePanel = null;

        expect(panel.isMounted()).toBe(false);
        expect(profileCard.parentElement).toBe(root);
        expect(profileSelect.parentElement).toBe(profileCard);
        expect(openaiBlock.parentElement).toBe(root);
        expect(chatSource.parentElement).toBe(openaiBlock);
        expect(autoConnect.parentElement).toBe(document.getElementById('upstream_general_footer'));
    });

    test('keeps native API and source selects as the source of truth', () => {
        const { panel, mainApiSelect, applyPanelApiVisibility } = mountPanel('openai');
        activePanel = panel;

        expect(panel.column.hasAttribute('data-sb-connections-panel')).toBe(true);

        const changeEvents = [];
        mainApiSelect.addEventListener('change', () => changeEvents.push(mainApiSelect.value));
        applyPanelApiVisibility.mockClear();

        // Re-selecting the already-active API does not re-dispatch change.
        panel.selectBackend('chat');
        expect(changeEvents).toEqual([]);
        expect(applyPanelApiVisibility).toHaveBeenCalledWith('openai');

        // Selecting a different backend updates #main_api and fires a bubbling change event.
        panel.selectBackend('text');
        expect(mainApiSelect.value).toBe('textgenerationwebui');
        expect(changeEvents).toEqual(['textgenerationwebui']);
        expect(applyPanelApiVisibility).toHaveBeenCalledWith('textgenerationwebui');

        expect(scriptSource).toContain('export function changePanelApiVisibility(selectedVal)');
    });

    test('follows MAIN_API_CHANGED and keeps the legacy drawer attached', () => {
        const { panel, mainApiSelect, applyPanelApiVisibility } = mountPanel('openai');
        activePanel = panel;
        applyPanelApiVisibility.mockClear();

        mainApiSelect.value = 'textgenerationwebui';
        eventSourceMock.emit('main_api_changed');

        expect(panel.getBackend()).toBe('text');
        expect(panel.column.querySelector('[data-sb-provider="openai"]').hidden).toBe(true);
        expect(panel.column.querySelector('[data-sb-provider="textgenerationwebui"]').hidden).toBe(false);
        expect(panel.column.querySelector('[data-sb-backend-source="text"]').hidden).toBe(false);
        expect(applyPanelApiVisibility).toHaveBeenCalledWith('textgenerationwebui');
        expect(document.getElementById('rm_api_block')).not.toBeNull();

        panel.teardown();
        activePanel = null;
        expect(eventSourceMock.off).toHaveBeenCalledWith('main_api_changed', expect.any(Function));

        expect(tabsSource).toContain('prepareEmbeddedDrawer(\'sys-settings-button\')');
        expect(tabsSource).toContain('sb-legacy-api-drawer');
        expect(themeCss).not.toContain('#rm_api_block');
        expect(tabsCss).toContain('.sb-legacy-api-drawer');
    });

    test('clears a selected profile for every manual backend or source pick', () => {
        const { panel, mainApiSelect } = mountPanel('openai');
        activePanel = panel;

        const profileSelect = document.getElementById('connection_profiles');
        const profileChanges = [];
        profileSelect.addEventListener('change', () => profileChanges.push(profileSelect.value));

        // Manual backend switch via toggle clears the active connection profile.
        profileSelect.value = 'prof-1';
        const [, textRadio, otherRadio] = panel.column.querySelectorAll('[data-sb-editor-field="backend-type"] input[type="radio"]');
        textRadio.click();
        expect(profileSelect.value).toBe('');
        expect(profileChanges).toEqual(['']);

        // Picking another source in the "Other" backend clears the profile and updates #main_api.
        otherRadio.click();
        profileSelect.value = 'prof-1';
        const otherSelect = panel.column.querySelector('select.sb-connections-other-source');
        otherSelect.value = 'kobold';
        otherSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(mainApiSelect.value).toBe('kobold');
        expect(panel.column.querySelector('[data-sb-provider="kobold"]').hidden).toBe(false);
    });

    test('puts provider status first and keeps the C2a secondary status row', () => {
        const { panel } = mountPanel('openai');
        activePanel = panel;

        const openaiSlot = panel.column.querySelector('[data-sb-provider="openai"]');
        const statusRow = openaiSlot.querySelector('.sb-connections-status-row');
        expect(statusRow).not.toBeNull();
        expect(statusRow.getAttribute('role')).toBe('group');
        expect(statusRow.getAttribute('aria-label')).toBe('Status');
        expect(statusRow.querySelector('.online_status')).not.toBeNull();

        const connectButton = statusRow.querySelector('#api_button_openai');
        expect(connectButton.classList.contains('suggested-action')).toBe(true);
        expect(connectButton.classList.contains('menu_button_primary')).toBe(true);
        expect(statusRow.querySelector('#test_api_button')).not.toBeNull();

        const extras = [...openaiSlot.querySelectorAll('.sb-connections-status-extra')];
        expect(extras).toHaveLength(2);
        expect(extras[0].querySelector('.openrouter_authorize')).not.toBeNull();
        expect(extras[1].querySelector('#customize_additional_parameters')).not.toBeNull();
        expect(panel.column.querySelector('[class*="sb-combo-"]')).toBeNull();
    });

    test('the shell leaves Connections provider expanders under upstream control', () => {
        expect(tabsSource).toMatch(/SB_COLLAPSIBLE_DRAWER_TAB_IDS = .*\['extensions', 'connections'\]/);
    });

    test('the mobile model filter is not injected into a shared searchable picker row', () => {
        const filter = tabsSource.slice(tabsSource.indexOf('function injectModelFilterInput('), tabsSource.indexOf('function buildBottomChatBar('));
        expect(filter).toContain('$select[0].closest(\'.ds-select-row\')');
    });

    test('renders the General controls as shared rows while retaining the hidden key viewer', () => {
        const { panel } = mountPanel('openai');
        activePanel = panel;

        const generalSection = panel.column.querySelector('[data-sb-editor-field="general"]');
        const autoConnect = generalSection.querySelector('#auto-connect-checkbox');
        expect(autoConnect).not.toBeNull();
        expect(autoConnect.getAttribute('role')).toBe('switch');

        const viewSecretsClick = jest.fn();
        document.getElementById('viewSecrets').addEventListener('click', viewSecretsClick);
        const keyButton = generalSection.querySelector('[data-sb-editor-field="view-hidden-api-keys"]');
        expect(keyButton).not.toBeNull();
        keyButton.click();
        expect(viewSecretsClick).toHaveBeenCalledTimes(1);
        expect(panel.column.querySelector('.sb-connections-footer')).toBeNull();
    });

    test('does not retain the old sticky, tab, combo, or stacked-outline implementation', () => {
        const { panel } = mountPanel('openai');
        activePanel = panel;

        expect(panel.column.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
        expect(panel.column.querySelector('.sb-backend-switch-button, .sb-other-backend-button')).toBeNull();
        expect(tabsCss).not.toContain('.sb-connections-switcher');
        expect(tabsCss).not.toContain('.sb-combo-list');
        expect(tabsCss).not.toContain('position: sticky');
        expect(tabsCss).not.toContain('position: -webkit-sticky');
    });
});
