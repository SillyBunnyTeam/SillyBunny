/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';

let menuOptions;
const openActionMenu = jest.fn(options => menuOptions = options);
const closeActionMenu = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, closeActionMenu, MOBILE_QUERY: '(max-width: 768px)',
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(), stopMotion: jest.fn(), play: jest.fn(),
    animateOut: jest.fn((node, frames, done) => done()), MOTION_FAST: 0, MOTION_SLOW: 0, SPRING_SHEET: {},
}));
const { createTagManager, parseTagName, countLiveTagEntities, updateTagColors, loadTagManagerStyles, openTagManager, refreshTagManager } = await import('../../public/scripts/sillybunny-tag-manager.js');
const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
let manager;
let state;
let adapter;
let mobile;
const names = () => [...manager.root.querySelectorAll('.tag_view_item')].map(row => row.id);
const input = id => manager.root.querySelector(`[id="${id}"] .sb-tag-manager__name`);
const key = (node, value) => node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));

beforeEach(() => {
    jest.clearAllMocks();
    menuOptions = null;
    mobile = { matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };
    window.matchMedia = () => mobile;
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    state = {
        tags: [{ id: 'alpha', name: 'Alpha', color: 'red', sort_order: 0 }, { id: 'beta', name: 'Béta', sort_order: 1 }],
        tagMap: { 'Alice.png': ['alpha', 'alpha'], group: ['alpha'], orphan: ['alpha'] },
        characters: [{ avatar: 'Alice.png' }], groups: [{ id: 'group' }],
        settings: { tag_sort_mode: 'manual', bogus_folders: false, main_text_color: 'white' },
    };
    adapter = {
        getState: () => state, commit: jest.fn(),
        create: jest.fn(name => { const tag = { id: 'new', name }; state.tags.push(tag); return tag; }),
        rename: jest.fn((tag, name) => tag.name = name),
        sort: tags => tags.slice().sort((a, b) => a.sort_order - b.sort_order),
        folderTypes: { NONE: { tooltip: 'No Folder' }, OPEN: { tooltip: 'Open Folder', fa_icon: 'fa-folder-open' }, CLOSED: { tooltip: 'Closed Folder', fa_icon: 'fa-eye-slash' } },
        actions: Object.fromEntries(['backup', 'restore', 'prune', 'delete', 'folder', 'color'].map(action => [action, jest.fn()])),
    };
    globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn(async () => {}) };
});

afterEach(() => {
    if (manager) {
        for (const tag of state.tags) { const field = input(tag.id); if (field) field.value = tag.name; }
        manager.close();
    }
    manager = null;
    document.body.replaceChildren();
    delete globalThis.SillyBunnyAssets;
    delete globalThis.$;
    jest.useRealTimers();
});

function mount() {
    manager = createTagManager(adapter);
    manager.show();
    return manager;
}

describe('tag manager model', () => {
    test('trims names; rejects empty, case and accent duplicates except self', () => {
        expect(parseTagName('  New  ', state.tags)).toEqual({ ok: true, name: 'New' });
        expect(parseTagName(' \n ', state.tags).ok).toBe(false);
        expect(parseTagName('alpha', state.tags).ok).toBe(false);
        expect(parseTagName('BETA', state.tags).ok).toBe(false);
        expect(parseTagName('Alpha', state.tags, 'alpha').ok).toBe(true);
    });

    test('counts unique live character/group keys, not duplicate assignments, entities or orphans', () => {
        state.characters.push({ avatar: 'Alice.png' }, { avatar: 'Bob.png' });
        state.groups.push({ id: 'group' });
        state.tagMap['Bob.png'] = null;
        expect([...countLiveTagEntities(state.tagMap, state.characters, state.groups)]).toEqual([['alpha', 2]]);
    });

    test('F6 updates every chip and dot token immediately, including resets and folder avatars', () => {
        document.body.innerHTML = '<div class="ds-tag-chips"><span class="tag" id="alpha"></span></div><i data-sb-tag-id="alpha"></i><div class="bogus_folder_select" tagid="alpha"><span class="avatar"></span></div><span class="tag" id="beta"></span>';
        const tag = { id: 'alpha', color: 'rgb(1, 2, 3)', color2: 'rgb(4, 5, 6)' };
        updateTagColors(tag);
        for (const node of document.querySelectorAll('[id="alpha"], [data-sb-tag-id="alpha"], [tagid="alpha"]')) {
            expect(node.style.getPropertyValue('--sb-tag-color')).toBe(tag.color);
            expect(node.style.getPropertyValue('--sb-tag-color2')).toBe(tag.color2);
        }
        expect(document.querySelector('.avatar').style.backgroundColor).toBe(tag.color);
        expect(document.querySelector('[id="beta"]').style.cssText).toBe('');
        updateTagColors({ ...tag, color: '', color2: '' });
        expect(document.querySelector('.tag').style.getPropertyValue('--sb-tag-color')).toBe('var(--sb-muted-fg)');
    });
});

describe('tag manager interactions', () => {
    test('does not save while typing; commits trimmed value once on Enter, not again on blur', () => {
        mount();
        const field = input('alpha');
        field.value = '  Renamed  ';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.tags[0].name).toBe('Alpha');
        expect(adapter.commit).not.toHaveBeenCalled();
        key(field, 'Enter');
        field.dispatchEvent(new Event('blur'));
        expect(state.tags[0].name).toBe('Renamed');
        expect(field.value).toBe('Renamed');
        expect(adapter.commit).toHaveBeenCalledTimes(1);
    });

    test('keeps an invalid value with inline error and vetoes close, returning focus', () => {
        mount();
        const field = input('alpha');
        field.value = 'beta';
        field.dispatchEvent(new Event('blur'));
        manager.root.querySelector('.sb-tag-manager__close').focus();
        expect(manager.close()).toBe(false);
        expect(field.value).toBe('beta');
        expect(field.getAttribute('aria-invalid')).toBe('true');
        expect(field.getAttribute('aria-describedby')).toBe(field.nextElementSibling.id);
        expect(document.activeElement).toBe(field);
        expect(manager.host.open).toBe(true);
        expect(adapter.commit).not.toHaveBeenCalled();
    });

    test('Escape reverts an invalid pending rename without saving or closing the dialog', () => {
        mount();
        const field = input('alpha');
        field.value = '';
        key(field, 'Enter');
        key(field, 'Escape');
        expect(field.value).toBe('Alpha');
        expect(field.getAttribute('aria-invalid')).toBe('false');
        expect(adapter.commit).not.toHaveBeenCalled();
        expect(manager.host.open).toBe(true);
    });

    test('a valid pending rename commits before closing', async () => {
        mount();
        input('alpha').value = 'Final';
        expect(manager.close()).toBe(true);
        await manager.closed;
        expect(state.tags[0].name).toBe('Final');
        expect(adapter.commit).toHaveBeenCalledTimes(1);
        expect(manager.host.isConnected).toBe(false);
    });

    test.each(['cancel', 'scrim', 'button', 'drag'])('mobile %s close route vetoes invalid pending names', route => {
        mobile.matches = true;
        mount();
        input('alpha').value = ' ';
        if (route === 'cancel') manager.host.dispatchEvent(new Event('cancel', { cancelable: true }));
        if (route === 'scrim') manager.host.querySelector('.sb-tag-manager__backdrop').click();
        if (route === 'button') manager.root.querySelector('.sb-tag-manager__close').click();
        if (route === 'drag') {
            const handle = manager.root.querySelector('.sb-tag-manager__handle');
            handle.dispatchEvent(new MouseEvent('pointerdown', { clientY: 5 }));
            handle.dispatchEvent(new MouseEvent('pointerup', { clientY: 150 }));
        }
        expect(manager.host.open).toBe(true);
        expect(input('alpha').getAttribute('aria-invalid')).toBe('true');
    });

    test('creation happens on commit, not keystrokes; duplicate creation is rejected', () => {
        mount();
        const field = manager.root.querySelector('.sb-tag-manager__new');
        field.value = 'New tag';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        expect(adapter.create).not.toHaveBeenCalled();
        key(field, 'Enter');
        expect(adapter.create).toHaveBeenCalledWith('New tag');
        expect(input('new').value).toBe('New tag');
        field.value = 'alpha';
        key(field, 'Enter');
        expect(adapter.create).toHaveBeenCalledTimes(1);
        expect(field.getAttribute('aria-invalid')).toBe('true');
    });

    test('the creation entry uses one placeholder and a labelled plus affordance', () => {
        mount();
        const entry = manager.root.querySelector('[data-sb-editor-field="new-tag"]');
        expect(entry.textContent).toBe('');
        const field = entry.querySelector('input');
        expect(field.placeholder).toBe('Create a new tag');
        field.value = 'From plus';
        entry.querySelector('.sb-tag-manager__add').click();
        expect(adapter.create).toHaveBeenCalledWith('From plus');
    });

    test.each(['alphabetical', 'by_entries'])('dragging from %s keeps the grip and switches to manual ordering', mode => {
        state.settings.tag_sort_mode = mode;
        const sortable = jest.fn();
        globalThis.$ = Object.assign(() => ({ sortable }), { fn: { sortable() {} } });
        mount();
        expect(manager.root.querySelector('.drag-handle').hidden).toBe(false);
        const options = sortable.mock.calls[0][0];
        expect(options.disabled).toBe(false);
        options.start();
        const list = manager.root.querySelector('.tag_view_list_tags');
        list.insertBefore(list.lastElementChild, list.firstElementChild);
        options.update();
        options.stop();
        expect(state.settings.tag_sort_mode).toBe('manual');
        expect(names()).toEqual(['beta', 'alpha']);
        expect(adapter.commit).toHaveBeenCalledTimes(1);
    });

    test('folder controls follow Tags as Folders and route through the upstream action', async () => {
        mount();
        const folder = manager.root.querySelector('.sb-tag-manager__folder');
        expect(folder.hidden).toBe(true);
        manager.root.querySelector('.sb-tag-manager__menu').click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Tags as Folders').onSelect();
        await settle();
        expect(folder.hidden).toBe(false);
        folder.click();
        expect(adapter.actions.folder).toHaveBeenCalledWith(folder.closest('.tag_view_item'));
    });

    test.each(['Backup', 'Restore', 'Prune'])('%s routes to its upstream handler', async label => {
        mount();
        manager.root.querySelector('.sb-tag-manager__menu').click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === label).onSelect();
        await settle();
        expect(adapter.actions[label.toLowerCase()]).toHaveBeenCalledTimes(1);
    });

    test('row menu routes delete and colour actions, and manual moves are keyboard alternatives', async () => {
        mount();
        const row = manager.root.querySelector('[id="alpha"]');
        expect(manager.root.querySelectorAll('toolcool-color-picker')).toHaveLength(0);
        row.querySelector('.sb-tag-manager__row-menu').click();
        let items = menuOptions.sections.flatMap(section => section.items);
        expect(items.find(item => item.label === 'Move up').disabled).toBe(true);
        items.find(item => item.label === 'Move down').onSelect();
        await settle();
        expect(names()).toEqual(['beta', 'alpha']);
        items.find(item => item.label === 'Delete').onSelect();
        await settle();
        expect(adapter.actions.delete).toHaveBeenCalledWith(row);
        items[0].onSelect();
        await settle();
        const picker = row.querySelector('toolcool-color-picker');
        expect(manager.root.querySelectorAll('toolcool-color-picker')).toHaveLength(1);
        expect(picker.parentElement.hidden).toBe(false);
        picker.dispatchEvent(new CustomEvent('change', { detail: { rgba: 'red' } }));
        expect(adapter.actions.color).toHaveBeenCalledWith(expect.any(CustomEvent), 'color');
        state.settings.tag_sort_mode = 'alphabetical';
        row.querySelector('.sb-tag-manager__row-menu').click();
        items = menuOptions.sections.flatMap(section => section.items);
        expect(items.find(item => item.label === 'Move down').disabled).toBe(true);
    });

    test('external reprint reconciles counts, colour and rows while preserving focus and scroll', () => {
        mount();
        const field = input('alpha');
        field.focus();
        field.value = 'Pending';
        const scroller = manager.root.querySelector('.sb-tag-manager__body');
        scroller.scrollTop = 100;
        state.tagMap['Alice.png'].push('beta');
        state.tags[0].color = 'blue';
        state.tags.push({ id: 'external', name: 'External', sort_order: 2 });
        manager.refresh();
        expect(input('alpha')).toBe(field);
        expect(field.value).toBe('Pending');
        expect(document.activeElement).toBe(field);
        expect(scroller.scrollTop).toBe(100);
        expect(names()).toContain('external');
        expect(manager.root.querySelector('[id="beta"] .ds-entity-row__subtitle').textContent).toBe('1\u00a0entries');
        expect(manager.root.querySelector('[data-sb-tag-id="alpha"]').style.getPropertyValue('--sb-tag-color')).toBe('blue');
        expect(adapter.commit).not.toHaveBeenCalled();
    });

    test('a reconciliation-induced blur neither commits nor replaces the focused draft or selection', () => {
        mount();
        const field = input('beta');
        field.focus();
        field.value = 'Pending rename';
        field.setSelectionRange(1, 5, 'backward');
        const list = manager.root.querySelector('.tag_view_list_tags');
        const insertBefore = list.insertBefore.bind(list);
        jest.spyOn(list, 'insertBefore').mockImplementation((node, cursor) => {
            if (node.contains(field)) field.blur();
            return insertBefore(node, cursor);
        });
        state.tags[1].sort_order = -1;
        manager.refresh();
        expect(names()).toEqual(['beta', 'alpha']);
        expect(field.value).toBe('Pending rename');
        expect(document.activeElement).toBe(field);
        expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([1, 5, 'backward']);
        expect(state.tags[1].name).toBe('Béta');
        expect(adapter.rename).not.toHaveBeenCalled();
        expect(adapter.commit).not.toHaveBeenCalled();
    });

    test('restore replacement with the same id edits the live object, not the stale row closure', () => {
        mount();
        const original = state.tags[0];
        state.tags[0] = { ...original, name: 'Restored' };
        manager.refresh();
        const field = input('alpha');
        expect(field.value).toBe('Restored');
        field.value = 'Live rename';
        key(field, 'Enter');
        expect(state.tags[0].name).toBe('Live rename');
        expect(original.name).toBe('Alpha');
        field.value = 'draft';
        key(field, 'Escape');
        expect(field.value).toBe('Live rename');
    });

    test('closing reveals a hidden invalid pending field before returning focus', () => {
        jest.useFakeTimers();
        mount();
        const field = input('alpha');
        field.value = ' ';
        key(field, 'Enter');
        const search = manager.root.querySelector('.sb-tag-manager__search');
        search.value = 'beta';
        search.dispatchEvent(new Event('input'));
        jest.advanceTimersByTime(300);
        expect(field.closest('.tag_view_item').hidden).toBe(true);
        expect(manager.close()).toBe(false);
        expect(field.closest('.tag_view_item').hidden).toBe(false);
        expect(document.activeElement).toBe(field);
    });

    test('search uses the shared debounce and retains mounted pending fields', () => {
        jest.useFakeTimers();
        mount();
        const search = manager.root.querySelector('.sb-tag-manager__search');
        search.value = 'alpha';
        search.dispatchEvent(new Event('input'));
        jest.advanceTimersByTime(300);
        expect(manager.root.querySelector('[id="beta"]').hidden).toBe(true);
        expect(manager.root.querySelector('[id="alpha"]').hidden).toBe(false);
        expect(input('beta')).not.toBeNull();
        key(search, 'Escape');
        expect(manager.root.querySelector('.sb-tag-manager__search-field').hidden).toBe(false);
        expect(search.value).toBe('');
        expect(manager.root.querySelector('[id="beta"]').hidden).toBe(false);
    });

    test('failed deferred styles remove only failed links and permit a retry', async () => {
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockImplementation((href, { id }) => {
            const link = document.createElement('link');
            link.id = id;
            document.head.append(link);
            return id === 'deferred-tag-manager-css' ? Promise.reject(new Error('offline')) : Promise.resolve();
        });
        await expect(loadTagManagerStyles()).rejects.toThrow('offline');
        expect(document.getElementById('deferred-tag-manager-css')).toBeNull();
        globalThis.SillyBunnyAssets.loadStylesheetAsync.mockResolvedValue();
        await expect(loadTagManagerStyles()).resolves.toBeUndefined();
        document.head.querySelectorAll('link').forEach(link => link.remove());
    });

    test('the singleton reprint entry coalesces refreshes of an open manager', async () => {
        const opening = openTagManager(adapter);
        await settle();
        const sort = jest.spyOn(adapter, 'sort');
        state.tags.push({ id: 'external', name: 'External' });
        refreshTagManager();
        refreshTagManager();
        refreshTagManager();
        expect(sort).not.toHaveBeenCalled();
        await settle();
        expect(sort).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[id="external"]')).not.toBeNull();
        document.querySelector('.sb-tag-manager__close').click();
        await opening;
    });

    test('the upstream bridge keeps all callers on one opener and does not change F1/F2 paths', () => {
        const source = fs.readFileSync(new URL('../../public/scripts/tags.js', import.meta.url), 'utf8');
        expect(source).toContain('VIEW: { id: \'2\'');
        expect(source).toContain('action: onViewTagsListClick');
        for (const handler of ['backup: onTagsBackupClick', 'restore: onBackupRestoreClick', 'prune: onTagsPruneClick', 'await onTagDeleteClick.call(row)', 'folder: row => onTagAsFolderClick.call(row)']) expect(source).toContain(handler);
        expect(source).toContain('tag_map[key].splice(indexOf, 1);');
        expect(source).toContain('if (mergeTagId) tag_map[key].push(mergeTagId);');
    });
});
