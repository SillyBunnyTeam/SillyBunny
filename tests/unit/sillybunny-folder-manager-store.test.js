/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let menuOptions;
let pickerOptions;
let popoverOptions;
const openActionMenu = jest.fn(options => menuOptions = options);
const openPopover = jest.fn(options => { popoverOptions = options; return { close: jest.fn(), get isOpen() { return true; } }; });
const openPicker = jest.fn(options => pickerOptions = options);

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, openPopover,
    closeActionMenu: jest.fn(),
    MOBILE_QUERY: '(max-width: 768px)',
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-delete-confirm.js', () => ({ confirmDestructiveAction: jest.fn(async () => true) }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker: jest.fn(), openPicker }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: ({ sheet, backdrop, getInitialFocus, onClose }) => ({
        open: () => {
            sheet.hidden = false;
            backdrop.hidden = false;
            getInitialFocus()?.focus();
        },
        close: () => {
            sheet.hidden = true;
            backdrop.hidden = true;
            onClose();
            return true;
        },
    }),
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const settingsFolders = await import('../../public/scripts/sillybunny-folders.js');
const { createFolderManager } = await import('../../public/scripts/sillybunny-folder-manager.js');
const { folderCountLabel } = await import('../../public/scripts/sillybunny-editor/folder-row.js');
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

/**
 * A store with the eleven functions of `sillybunny-folders.js` over plain memory, as the conversations have theirs over
 * the server: it keeps no `power_user` and writes no settings.
 */
function createMemoryStore() {
    const state = { folders: [], members: {} };
    const listeners = new Set();
    const calls = [];
    let counter = 0;
    const notify = () => listeners.forEach(listener => listener({ scope: 'conversations' }));
    const record = (name, ...args) => calls.push([name, ...args]);
    return {
        calls,
        state,
        notify,
        getFolders: (scope) => { record('getFolders', scope); return state.folders.map(folder => ({ ...folder })); },
        getFolderMembers: (scope, id) => Object.entries(state.members).filter(([, folderId]) => folderId === id).map(([key]) => key),
        createFolder: (scope, name, options = {}) => {
            record('createFolder', scope, name);
            const folder = { id: options.id ?? `mem-${++counter}`, name, color: options.color ?? '', expanded: true };
            state.folders.push(folder);
            notify();
            return { ...folder };
        },
        renameFolder: (scope, id, name) => { record('renameFolder', scope, id, name); state.folders.find(folder => folder.id === id).name = name; notify(); return true; },
        deleteFolder: (scope, id) => {
            record('deleteFolder', scope, id);
            state.folders = state.folders.filter(folder => folder.id !== id);
            for (const [key, folderId] of Object.entries(state.members)) if (folderId === id) delete state.members[key];
            notify();
            return true;
        },
        moveFolder: (scope, id, delta) => {
            record('moveFolder', scope, id, delta);
            const index = state.folders.findIndex(folder => folder.id === id);
            const [folder] = state.folders.splice(index, 1);
            state.folders.splice(index + delta, 0, folder);
            notify();
            return true;
        },
        setFolderColor: (scope, id, color) => { record('setFolderColor', scope, id, color); state.folders.find(folder => folder.id === id).color = color; notify(); return true; },
        setFolderExpanded: (scope, id, expanded) => { record('setFolderExpanded', scope, id, expanded); state.folders.find(folder => folder.id === id).expanded = expanded; notify(); return true; },
        setFolder: (scope, keys, id) => { record('setFolder', scope, keys, id); for (const key of keys) state.members[key] = id; notify(); return true; },
        removeFromFolder: (scope, keys) => { record('removeFromFolder', scope, keys); for (const key of keys) delete state.members[key]; notify(); return true; },
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
}

let manager;
let store;
let save;
let adapter;

beforeEach(() => {
    document.body.replaceChildren();
    window.matchMedia = () => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() });
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    save = jest.fn();
    settingsFolders.configureFolderStore({ powerUser: { sb_folders: settingsFolders.normalizeFoldersData(null) }, saveSettingsDebounced: save });
    store = createMemoryStore();
    adapter = {
        store,
        getItems: () => [{ id: 'conv_1', name: 'Seraphina' }, { id: 'conv_2', name: 'Weekend plans' }],
        getKey: item => item.id,
        getName: item => item.name,
    };
    menuOptions = null;
    popoverOptions = null;
    pickerOptions = null;
});

afterEach(() => {
    manager?.close();
    manager = null;
    document.body.replaceChildren();
});

function mount(scope = 'conversations') {
    manager = createFolderManager(scope, adapter);
    manager.show();
    return manager;
}

describe('the Folder Manager with a store of its own', () => {
    test('accepts the conversations scope', () => {
        expect(() => createFolderManager('conversations', adapter)).not.toThrow();
        expect(() => createFolderManager('nonsense', adapter)).toThrow(TypeError);
    });

    test('makes a folder in its store with the scope, and writes nothing to the settings', () => {
        mount();
        manager.root.querySelector('.sb-folder-manager__add').click();
        const input = popoverOptions.content.querySelector('input');
        input.value = '  Work  ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        expect(store.calls).toContainEqual(['createFolder', 'conversations', 'Work']);
        expect(store.state.folders.map(folder => folder.name)).toEqual(['Work']);
        expect(manager.root.querySelector('.sb-folder-manager__name').value).toBe('Work');
        expect(save).not.toHaveBeenCalled();
        expect(settingsFolders.getFolders('groups')).toEqual([]);
    });

    test('renames through the store, and shows the count of the folder as conversations', () => {
        store.createFolder('conversations', 'First');
        store.createFolder('conversations', 'Second');
        store.setFolder('conversations', ['conv_1', 'gone'], store.state.folders[0].id);
        mount();
        const [row] = manager.root.querySelectorAll('.sb-folder-manager__folder-row');

        expect(row.querySelector('.sb-folder-manager__count').textContent).toBe('1 conversation');
        const input = row.querySelector('input');
        input.value = 'Renamed';
        input.dispatchEvent(new Event('blur'));

        expect(store.calls).toContainEqual(['renameFolder', 'conversations', store.state.folders[0].id, 'Renamed']);
        expect(folderCountLabel(2, 'conversations')).toBe('2 conversations');
    });

    test('moves a folder by a delta through the store, from its menu and from the Alt keys', () => {
        const first = store.createFolder('conversations', 'First');
        const second = store.createFolder('conversations', 'Second');
        mount();
        manager.root.querySelector(`[data-folder-id="${first.id}"] .sb-folder-manager__row-menu`).click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Move Down').onSelect();

        expect(store.calls).toContainEqual(['moveFolder', 'conversations', first.id, 1]);
        manager.root.querySelector(`[data-folder-id="${first.id}"]`).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
        expect(store.state.folders.map(folder => folder.id)).toEqual([first.id, second.id]);
    });

    test('changes the open state of a folder through the store', () => {
        const folder = store.createFolder('conversations', 'Work');
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__row-menu`).click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Expanded by Default').onSelect();

        expect(store.calls).toContainEqual(['setFolderExpanded', 'conversations', folder.id, false]);
    });

    test('deletes through the store after the alert, with a placeholder body that is marked in markup', async () => {
        const folder = store.createFolder('conversations', 'Delete me');
        store.setFolder('conversations', ['conv_1'], folder.id);
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__row-menu`).click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Delete').onSelect();
        const alert = document.querySelector('.sb-dialog-host[role="alertdialog"]');

        expect(alert.querySelector('[data-sb-copy-placeholder="true"]').textContent).toBe('TODO(copy)');
        alert.querySelector('[data-response="delete"]').click();
        await settle();

        expect(store.calls).toContainEqual(['deleteFolder', 'conversations', folder.id]);
        expect(store.state.members).toEqual({});
    });

    test('lists the members of a folder from the store, takes one out and adds another from the adapter\'s items', () => {
        const folder = store.createFolder('conversations', 'Members');
        store.setFolder('conversations', ['conv_1'], folder.id);
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();

        expect(manager.root.querySelectorAll('.sb-folder-manager__member-row')).toHaveLength(1);
        manager.root.querySelector('.sb-folder-manager__remove').click();
        expect(store.calls).toContainEqual(['removeFromFolder', 'conversations', ['conv_1']]);
        manager.root.querySelector('.sb-folder-manager__add-member').click();
        expect(pickerOptions.items.map(item => item.label)).toEqual(['Seraphina', 'Weekend plans']);
        pickerOptions.onSelect('conv_2');
        expect(store.state.members).toEqual({ conv_2: folder.id });
    });

    test('draws again when the store tells it that something changed, and only for its own scope', () => {
        mount();
        expect(manager.root.querySelectorAll('.sb-folder-manager__folder-row')).toHaveLength(0);

        store.state.folders.push({ id: 'late', name: 'Late', color: '', expanded: true });
        store.notify();

        expect(manager.root.querySelectorAll('.sb-folder-manager__folder-row')).toHaveLength(1);
    });

    test('uses the placeholder copy for the empty page, marked in markup', () => {
        mount();

        const description = manager.root.querySelector('.sb-status-page__description');
        expect(description.textContent).toBe('TODO(copy)');
        expect(description.getAttribute('data-sb-copy-placeholder')).toBe('true');
    });

    test('the colour picker of a row writes the colour through the store', () => {
        const folder = store.createFolder('conversations', 'Work');
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__row-menu`).click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Colour').onSelect();
        const picker = manager.root.querySelector('toolcool-color-picker');
        picker.dispatchEvent(new CustomEvent('change', { detail: { rgba: 'rgba(1, 2, 3, 1)' } }));

        expect(store.calls).toContainEqual(['setFolderColor', 'conversations', folder.id, 'rgba(1, 2, 3, 1)']);
    });
});

describe('the Folder Manager without a store of its own', () => {
    test('uses the settings store, as it always did', () => {
        settingsFolders.createFolder('groups', 'Scenes');
        adapter = { getItems: () => [], getKey: item => item.id, getName: item => item.name };
        mount('groups');

        expect(manager.root.querySelector('.sb-folder-manager__name').value).toBe('Scenes');
        expect(store.calls).toEqual([]);
    });
});
