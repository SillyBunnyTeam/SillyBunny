/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_COPY } from '../helpers/copy-settings.js';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(),
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_SLOW: 250,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { splitUserSettingsContent } = await import('../../public/scripts/sillybunny-settings-content.js');
const { buildImportGroup, presentDataSecurity } = await import('../../public/scripts/sillybunny-data-security.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

/** The container as the right shell hands it over: the authored settings block, split. */
function authoredContainer() {
    const page = new DOMParser().parseFromString(indexHtml, 'text/html');
    const block = document.adoptNode(page.getElementById('user-settings-block'));
    const originalContent = document.createElement('div');
    originalContent.append(...block.childNodes);
    const { dataSecurity } = splitUserSettingsContent(originalContent);
    document.body.replaceChildren(dataSecurity);
    return dataSecurity;
}

describe('Data & Security groups', () => {
    let previousCSS;
    beforeAll(() => {
        previousCSS = globalThis.CSS;
        globalThis.CSS = { ...previousCSS, escape: value => String(value) };
    });
    afterAll(() => {
        globalThis.CSS = previousCSS;
    });
    beforeEach(() => {
        Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: jest.fn(() => ({ matches: false })) });
    });

    const titles = container => [...container.querySelectorAll(':scope > section .ds-pref-group-heading')].map(heading => heading.textContent);

    test('builds General, then Export, around the Import & Restore section', () => {
        const container = authoredContainer();
        presentDataSecurity(container);
        expect(titles(container)).toEqual(['General', 'Export']);
        const sections = [...container.children];
        expect(sections.map(section => section.dataset.sbCategory ?? section.id)).toEqual(['general', 'SillyTavernImportSection', 'export']);
        for (const section of sections.filter(section => section.dataset.sbCategory)) {
            expect(section.dataset.sbPresentation).toBe('manual');
            expect(section.querySelector(':scope > .ds-pref-group-header > h3.ds-pref-group-heading')).not.toBeNull();
        }
    });

    test('presents a container once', () => {
        const container = authoredContainer();
        expect(presentDataSecurity(container)).not.toBeNull();
        const html = container.innerHTML;
        expect(presentDataSecurity(container)).toBeNull();
        expect(container.innerHTML).toBe(html);
    });

    test('General keeps its rows in order and every live node with its ID', () => {
        const container = authoredContainer();
        const nodes = Object.fromEntries(['ui_language_select', 'account_button', 'admin_button', 'logout_button', 'version_display', 'clear_all_cache_button', 'clear_cookies_cache_button', 'auto_clear_cache_on_update']
            .map(id => [id, container.querySelector(`#${id}`)]));
        const usageButton = container.querySelector('.user_stats_button');
        presentDataSecurity(container);

        const general = container.querySelector('[data-sb-category="general"] > .ds-pref-group');
        const labels = [...general.children].map(row => row.querySelector('.ds-row-label, .ds-row-subtitle').textContent);
        expect(labels).toEqual(['Language', 'Account', 'Admin Panel', 'Logout', 'Usage Stats', 'Version', 'Browser Cache', 'Auto-Clear Cache After Updates']);
        for (const [id, node] of Object.entries(nodes)) {
            expect(container.querySelector(`#${id}`)).toBe(node);
            expect(general.contains(node)).toBe(true);
        }
        expect(general.contains(usageButton)).toBe(true);
        for (const id of ['UI-language-block', 'user-settings-utility-actions']) {
            expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
            expect(general.querySelector(`#${id}`)).not.toBeNull();
        }
    });

    test('Account, Admin Panel, Usage Stats and Logout are the upstream buttons as button rows titled with the action', () => {
        const container = authoredContainer();
        const usageButton = container.querySelector('.user_stats_button');
        const nodes = Object.fromEntries(['account_button', 'admin_button', 'logout_button'].map(id => [id, container.querySelector(`#${id}`)]));
        presentDataSecurity(container);
        const general = container.querySelector('[data-sb-category="general"] > .ds-pref-group');
        const rows = [
            [nodes.account_button, 'Account', true],
            [nodes.admin_button, 'Admin Panel', true],
            [usageButton, 'Usage Stats', true],
            [nodes.logout_button, 'Logout', false],
        ];
        for (const [button, title, arrow] of rows) {
            expect(button.parentElement).toBe(general);
            expect(button.matches('.ds-row.ds-button-row')).toBe(true);
            expect(button.classList.contains('menu_button')).toBe(false);
            expect(button.querySelector('.ds-row-label').textContent).toBe(title);
            expect(button.querySelector('.ds-row-label').dataset.i18n).toBe(title);
            expect(button.hasAttribute('data-i18n')).toBe(false);
            expect(button.querySelector('.ds-row-subtitle')).toBeNull();
            expect(button.querySelector('.ds-row__chevron') !== null).toBe(arrow);
        }
        expect(usageButton.type).toBe('button');
        for (const id of ['account_controls', 'user_stats_controls']) expect(container.querySelector(`#${id}`)).toBeNull();
    });

    test('Language and Version keep their translation keys and the copy of the upstream rows', () => {
        const container = authoredContainer();
        presentDataSecurity(container);
        expect(container.querySelector('#UI-language-block .ds-row-label').dataset.i18n).toBe('UI Language');
        expect(container.querySelector('#UI-language-block .ds-row-label').textContent).toBe('Language');
        expect(container.querySelector('#UI-language-block .ds-row-subtitle').textContent).toBe('Choose which language is used for menus and settings');
        expect(container.querySelector('#version_display').closest('.ds-row-property').querySelector('.ds-row-subtitle').dataset.i18n).toBe('Version');
    });

    test('the switch for the cache keeps its ID and is named by its row', () => {
        const container = authoredContainer();
        presentDataSecurity(container);
        const input = container.querySelector('#auto_clear_cache_on_update');
        expect(input.getAttribute('role')).toBe('switch');
        expect(input.closest('label.ds-row-switch')).not.toBeNull();
        expect(input.closest('.ds-row').querySelector('.ds-row-subtitle').textContent)
            .toBe('Automatically clear browser cache and temporary UI data after SillyBunny updates, then reload.');
        expect(input.hasAttribute('aria-labelledby')).toBe(false);
    });

    test('Admin Panel and Logout stay hidden by the display that user.js writes on their buttons', () => {
        const container = authoredContainer();
        // user.js hides both buttons with jQuery, which writes the inline display; the button is the row.
        for (const id of ['admin_button', 'logout_button']) container.querySelector(`#${id}`).style.display = 'none';
        presentDataSecurity(container);
        for (const id of ['admin_button', 'logout_button']) {
            const button = container.querySelector(`#${id}`);
            expect(button.matches('.ds-row')).toBe(true);
            expect(button.style.display).toBe('none');
            button.style.display = '';
            expect(button.style.display).toBe('');
        }
    });

    test.each([
        ['user_backup_button', 'Download Backup', false],
        ['settings_snapshots_button', 'Settings Snapshots', true],
    ])('Export row %s is the upstream button as a button row', (buttonId, label, arrow) => {
        const container = authoredContainer();
        const upstreamButton = container.querySelector(`#${buttonId}`);
        presentDataSecurity(container);
        const button = container.querySelector(`[data-sb-category="export"] > .ds-pref-group > button#${buttonId}`);
        expect(button).toBe(upstreamButton);
        expect(button.type).toBe('button');
        expect(button.matches('.ds-row.ds-button-row')).toBe(true);
        expect(button.querySelector('.ds-row-label').dataset.i18n).toBe(label);
        expect(button.textContent).toBe(label);
        expect(button.querySelector('.ds-row-subtitle')).toBeNull();
        expect(button.querySelector('.ds-row__chevron') !== null).toBe(arrow);
        expect(container.querySelector(`#${buttonId.replace('_button', '_controls')}`)).toBeNull();
    });

    test('Export has its written description, translated like its siblings', () => {
        const container = authoredContainer();
        presentDataSecurity(container);
        const exportGroup = container.querySelector('[data-sb-category="export"]');
        expect(exportGroup.querySelector('.ds-pref-group-heading').dataset.i18n).toBe('Export');
        const description = exportGroup.querySelector('.ds-pref-group-subtitle');
        expect(description.textContent).toBe(SETTINGS_COPY.exportDescription);
        expect(description.dataset.i18n).toBe(SETTINGS_COPY.exportDescription);
        expect(description.hasAttribute('data-sb-copy-placeholder')).toBe(false);
    });

    test('Import & Restore builds one boxed group with the controls the importer reads', () => {
        const container = authoredContainer();
        presentDataSecurity(container);
        const built = buildImportGroup();
        container.querySelector('#SillyTavernImportSection').replaceWith(built.section);

        expect(built.section.id).toBe('SillyTavernImportSection');
        expect(built.card.id).toBe('sb-import-card');
        expect(built.card.matches('.ds-pref-group')).toBe(true);
        expect(built.section.querySelector('.ds-pref-group-heading').textContent).toBe('Import & Restore');
        expect(built.pathInput.id).toBe('sb-import-path-input');
        expect(built.zipFileInput.id).toBe('sb-import-zip-input');
        expect(built.zipFileInput.type).toBe('file');
        expect(built.folderRows).toHaveLength(3);
        expect(built.folderRows.every(row => built.card.contains(row))).toBe(true);
        for (const button of [built.folderButton, built.syncButton]) {
            expect(button.matches('button.ds-button-row')).toBe(true);
        }
        const panes = [...built.card.querySelectorAll('.sb-import-pane')];
        expect(panes.map(pane => pane.textContent)).toEqual([
            expect.stringContaining('Import From Folder Path'),
            expect.stringContaining('Import From Backup ZIP'),
        ]);
        expect(built.folderPane).toBe(panes[0]);
        expect(built.report.hidden).toBe(true);
        expect(built.note.matches('.ds-row.sb-server-note.sb-import-note')).toBe(true);
        expect(built.card.querySelector('.ds-row-entry__caption code').textContent).toBe('data');
    });
});
