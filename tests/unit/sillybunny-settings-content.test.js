/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SB_DATA_SECURITY_CONTAINER_ID, SB_FLAT_SECTION_CLASS, SB_FLAT_SECTION_TOP_CLASS, flattenNestedSettingsDrawers, splitUserSettingsContent } from '../../public/scripts/sillybunny-settings-content.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

/** Moves the authored settings block into a column the way the right shell does, then splits it. */
function splitAuthoredSettings() {
    const page = new DOMParser().parseFromString(indexHtml, 'text/html');
    const block = document.adoptNode(page.getElementById('user-settings-block'));
    const originalContent = document.createElement('div');
    originalContent.append(...block.childNodes);
    return splitUserSettingsContent(originalContent);
}

describe('Data & Security settings split', () => {
    let previousCSS;
    beforeAll(() => {
        previousCSS = globalThis.CSS;
        // jsdom does not supply `CSS.escape`. The split escapes only plain section ids, so a pass-through is enough.
        globalThis.CSS = { ...previousCSS, escape: value => String(value) };
    });
    afterAll(() => {
        globalThis.CSS = previousCSS;
    });

    test('hands every Data & Security row to the container, Import & Restore last', () => {
        const split = splitAuthoredSettings();
        expect(split.missing).toEqual([]);
        expect(split.dataSecurity.id).toBe(SB_DATA_SECURITY_CONTAINER_ID);

        const children = [...split.dataSecurity.children];
        const ids = children.map(child => child.id || child.querySelector('#version_display')?.id);
        expect(ids).toEqual([
            'UI-language-block',
            'account_controls',
            'user_stats_controls',
            'version_display',
            'user-settings-utility-actions',
            'user_backup_controls',
            'settings_snapshots_controls',
            'SillyTavernImportSection',
        ]);
    });

    test('leaves the grouping of the container to the Data & Security presenter', () => {
        const { dataSecurity } = splitAuthoredSettings();
        expect(dataSecurity.querySelector('[data-sb-category]')).toBeNull();
        expect(dataSecurity.querySelector('#SillyTavernImportSection')).not.toBeNull();
        expect(dataSecurity.querySelector('#sb-import-tools-outlet')).not.toBeNull();
    });
});

describe('Messages settings groups', () => {
    let previousCSS;
    beforeAll(() => {
        previousCSS = globalThis.CSS;
        globalThis.CSS = { ...previousCSS, escape: value => String(value) };
    });
    afterAll(() => {
        globalThis.CSS = previousCSS;
    });

    const bodyOf = (container, id) => container.querySelector(`[data-sb-category="${id}"] > .sb-settings-category-body`);

    test('moves every required section into the page', () => {
        expect(splitAuthoredSettings().missing).toEqual([]);
    });

    test.each([
        ['auto-swipe', '#auto_swipe', ['auto_swipe', 'auto_swipe_minimum_length', 'auto_swipe_blacklist', 'auto_swipe_blacklist_threshold']],
        ['auto-continue', '#auto_continue_enabled', ['auto_continue_enabled', 'auto_continue_allow_chat_completions', 'auto_continue_target_length']],
        ['smooth-streaming', '#smooth_streaming', ['smooth_streaming', 'smooth_streaming_no_think', 'smooth_streaming_speed']],
    ])('%s is its own group, led by the switch that enables it', (id, enabler, controls) => {
        const body = bodyOf(splitAuthoredSettings().messages, id);
        expect(body.dataset.sbEnabledBy).toBe(enabler);
        const ids = controls.map(control => body.querySelector(`#${control}`)?.id);
        expect(ids).toEqual(controls);
        const first = body.querySelector(':scope > :is(.checkbox_label, .ds-row, label)');
        expect(first.contains(body.querySelector(enabler))).toBe(true);
    });

    test('Aggressive DOM Unloading is enabled by its own switch', () => {
        const group = splitAuthoredSettings().messages.querySelector('[name="AggressiveDomUnloadToggles"]');
        expect(group.dataset.sbEnabledBy).toBe('#aggressive_dom_unload');
    });

    test('the Messages group titles are group headings; the tabs that have not adopted the contract keep the flat header', () => {
        const split = splitAuthoredSettings();
        const titles = container => [...container.querySelectorAll('.sb-settings-category-title')];
        expect(titles(split.messages).length).toBeGreaterThan(0);
        expect(titles(split.messages).every(title => title.classList.contains('ds-pref-group-heading'))).toBe(true);
        expect(titles(split.interface).some(title => title.classList.contains('ds-pref-group-heading'))).toBe(false);
    });
});

describe('Account popup', () => {
    test('leaves Settings Snapshots and Download Backup to Data & Security', () => {
        const templateHtml = readFileSync(path.join(repoRoot, 'public', 'scripts', 'templates', 'userProfile.html'), 'utf8');
        const template = new DOMParser().parseFromString(templateHtml, 'text/html');
        expect(template.querySelector('.userSettingsSnapshotsButton')).toBeNull();
        expect(template.querySelector('.userBackupButton')).toBeNull();

        // With accounts off, Change Password hides, and an Account Actions heading over nothing would remain.
        const accountActions = template.querySelector('h3[data-i18n="Account Actions"]').parentElement;
        expect(accountActions.hasAttribute('data-require-accounts')).toBe(true);
        expect(accountActions.querySelector('.userChangePasswordButton')).not.toBeNull();
    });
});

describe('flattening settings drawers', () => {
    /** A drawer as the settings markup writes it: a header and a content wrapper. */
    function drawer(id) {
        const element = document.createElement('div');
        element.id = id;
        element.className = 'inline-drawer';
        element.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header"><b></b><div class="inline-drawer-icon"></div></div><div class="inline-drawer-content"></div>';
        element.querySelector('b').textContent = id;
        return element;
    }

    const levelOf = element => ({
        flat: element.classList.contains(SB_FLAT_SECTION_CLASS),
        top: element.classList.contains(SB_FLAT_SECTION_TOP_CLASS),
    });

    test('a drawer inside another one is a subsection when both exist on the first run', () => {
        const root = document.createElement('div');
        const outer = drawer('outer');
        const inner = drawer('inner');
        outer.querySelector('.inline-drawer-content').append(inner);
        root.append(outer);

        flattenNestedSettingsDrawers(root, { includeTopLevel: true });

        expect(levelOf(outer)).toEqual({ flat: true, top: true });
        expect(levelOf(inner)).toEqual({ flat: true, top: false });
    });

    test('a drawer that is built inside a section after it was flattened is a subsection too', () => {
        const root = document.createElement('div');
        const outer = drawer('outer');
        root.append(outer);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });

        const inner = drawer('inner');
        outer.append(inner);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });

        expect(levelOf(outer)).toEqual({ flat: true, top: true });
        expect(levelOf(inner)).toEqual({ flat: true, top: false });
    });

    test('a drawer inside a boxed group or a row is a subsection, with no drawer around it', () => {
        const root = document.createElement('div');
        const group = document.createElement('div');
        group.className = 'ds-pref-group';
        const row = document.createElement('div');
        row.className = 'ds-row';
        const inGroup = drawer('in-group');
        const inRow = drawer('in-row');
        const free = drawer('free');
        row.append(inRow);
        group.append(row, inGroup);
        root.append(group, free);

        flattenNestedSettingsDrawers(root, { includeTopLevel: true });

        expect(levelOf(inGroup)).toEqual({ flat: true, top: false });
        expect(levelOf(inRow)).toEqual({ flat: true, top: false });
        expect(levelOf(free)).toEqual({ flat: true, top: true });
    });

    test('a section that is moved into a boxed row after it was flattened becomes a subsection on the next run', () => {
        const root = document.createElement('div');
        const moved = drawer('moved');
        const stays = drawer('stays');
        root.append(moved, stays);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        expect(levelOf(moved)).toEqual({ flat: true, top: true });

        const group = document.createElement('div');
        group.className = 'ds-pref-group';
        const row = document.createElement('div');
        row.className = 'ds-row';
        group.append(row);
        root.append(group);
        row.append(moved);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });

        expect(levelOf(moved)).toEqual({ flat: true, top: false });
        expect(levelOf(stays)).toEqual({ flat: true, top: true });
    });

    test('a root that sits inside a boxed group keeps its own sections at the top level', () => {
        const outside = document.createElement('div');
        outside.className = 'ds-pref-group';
        const outsideRow = document.createElement('div');
        outsideRow.className = 'ds-row';
        const root = document.createElement('div');
        const section = drawer('section');
        root.append(section);
        outsideRow.append(root);
        outside.append(outsideRow);

        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        expect(levelOf(section)).toEqual({ flat: true, top: true });

        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        expect(levelOf(section)).toEqual({ flat: true, top: true });
    });

    test('a run after everything is flattened and moved changes nothing', () => {
        const root = document.createElement('div');
        const group = document.createElement('div');
        group.className = 'ds-pref-group';
        const moved = drawer('moved');
        const stays = drawer('stays');
        root.append(moved, stays, group);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        group.append(moved);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        const before = root.innerHTML;

        expect(flattenNestedSettingsDrawers(root, { includeTopLevel: true })).toBe(0);
        expect(root.innerHTML).toBe(before);
        expect(levelOf(moved)).toEqual({ flat: true, top: false });
        expect(levelOf(stays)).toEqual({ flat: true, top: true });
    });

    test('a later run without top-level flattening unwraps a drawer inside a flattened section', () => {
        const root = document.createElement('div');
        const outer = drawer('outer');
        root.append(outer);
        flattenNestedSettingsDrawers(root, { includeTopLevel: true });

        const inner = drawer('inner');
        outer.append(inner);

        expect(flattenNestedSettingsDrawers(root)).toBe(1);
        expect(levelOf(inner)).toEqual({ flat: true, top: false });
    });
});
