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
        expect(labels).toEqual(['Language', 'Account', 'Admin Panel', 'Logout', 'Usage Stats', 'Version', 'Clear all cache', 'Auto-clear cache after updates']);
        for (const [id, node] of Object.entries(nodes)) {
            expect(container.querySelector(`#${id}`)).toBe(node);
            expect(general.contains(node)).toBe(true);
        }
        expect(general.contains(usageButton)).toBe(true);
        for (const id of ['UI-language-block', 'account_controls', 'user_stats_controls', 'user-settings-utility-actions']) {
            expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
            expect(general.querySelector(`#${id}`)).not.toBeNull();
        }
    });

    test('Language, Usage Stats and Version keep their translation keys and the copy of the upstream rows', () => {
        const container = authoredContainer();
        presentDataSecurity(container);
        expect(container.querySelector('#UI-language-block .ds-row-label').dataset.i18n).toBe('UI Language');
        expect(container.querySelector('#UI-language-block .ds-row-label').textContent).toBe('Language');
        expect(container.querySelector('#UI-language-block .ds-row-subtitle').textContent).toBe('Choose which language is used for menus and settings.');
        const subtitle = container.querySelector('#user_stats_controls .ds-row-subtitle');
        expect(subtitle.textContent).toBe(SETTINGS_COPY.usageStatsSubtitle);
        expect(subtitle.dataset.i18n).toBe(SETTINGS_COPY.usageStatsSubtitle);
        expect(container.querySelector('#user_stats_controls .ds-row-label').dataset.i18n).toBe('Usage Stats');
        const button = container.querySelector('#user_stats_controls .ds-row-suffix > button.user_stats_button');
        expect(button.type).toBe('button');
        expect(button.dataset.i18n).toBe('Usage Stats');
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

    test('Admin Panel and Logout rows follow the display of their buttons', async () => {
        const container = authoredContainer();
        // user.js hides both buttons with jQuery, which writes the inline display.
        for (const id of ['admin_button', 'logout_button']) container.querySelector(`#${id}`).style.display = 'none';
        presentDataSecurity(container);
        const flush = () => new Promise(resolve => setTimeout(resolve, 0));
        for (const id of ['admin_button', 'logout_button']) {
            const button = container.querySelector(`#${id}`);
            const row = button.closest('.ds-row');
            expect(row.style.display).toBe('none');
            button.style.display = '';
            await flush();
            expect(row.style.display).toBe('');
            button.style.display = 'none';
            await flush();
            expect(row.style.display).toBe('none');
        }
    });

    test.each([
        ['user_backup_controls', 'user_backup_button', 'Download Backup', 'Download a complete backup of your user data.'],
        ['settings_snapshots_controls', 'settings_snapshots_button', 'Settings Snapshots', 'Manage your settings snapshots.'],
    ])('Export row %s reuses the upstream strings', (rowId, buttonId, label, subtitle) => {
        const container = authoredContainer();
        const upstreamButton = container.querySelector(`#${buttonId}`);
        presentDataSecurity(container);
        const row = container.querySelector(`[data-sb-category="export"] #${rowId}`);
        expect(row.querySelector('.ds-row-label').dataset.i18n).toBe(label);
        expect(row.querySelector('.ds-row-subtitle').dataset.i18n).toBe(subtitle);
        const button = row.querySelector(`.ds-row-suffix > button#${buttonId}`);
        expect(button).toBe(upstreamButton);
        expect(button.type).toBe('button');
        expect(button.textContent).toBe(label);
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
