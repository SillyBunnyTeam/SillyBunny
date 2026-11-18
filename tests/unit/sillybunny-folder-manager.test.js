/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let menuOptions;
let pickerOptions;
const openActionMenu = jest.fn(options => menuOptions = options);
let popoverOptions;
const openPopover = jest.fn(options => { popoverOptions = options; return { close: jest.fn(), get isOpen() { return true; } }; });
const closeActionMenu = jest.fn();
const openPicker = jest.fn(options => pickerOptions = options);
const closePicker = jest.fn();

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu, openPopover,
    closeActionMenu,
    MOBILE_QUERY: '(max-width: 768px)',
}));
const confirmDestructiveAction = jest.fn(async () => true);
await jest.unstable_mockModule('../../public/scripts/sillybunny-delete-confirm.js', () => ({ confirmDestructiveAction }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ closePicker, openPicker }));
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

const folders = await import('../../public/scripts/sillybunny-folders.js');
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const { createFolderManager } = await import('../../public/scripts/sillybunny-folder-manager.js');

let settings;
let manager;
let save;
let id;
const adapter = {
    getItems: () => [{ id: 'g1', name: 'Group One' }, { id: 'g2', name: 'Group Two' }],
    getKey: item => item.id,
    getName: item => item.name,
};

beforeEach(() => {
    document.body.replaceChildren();
    window.matchMedia = () => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() });
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    save = jest.fn();
    id = 0;
    settings = { sb_folders: folders.normalizeFoldersData(null) };
    folders.configureFolderStore({ powerUser: settings, saveSettingsDebounced: save, idFactory: () => `folder-${++id}` });
    menuOptions = null;
    popoverOptions = null;
    pickerOptions = null;
});

afterEach(() => {
    manager?.close();
    manager = null;
    document.body.replaceChildren();
});

const personaAdapter = {
    getItems: () => ['a.png', 'b.png'],
    getKey: avatarId => avatarId,
    getName: avatarId => ({ 'a.png': 'Alice', 'b.png': 'Bob' })[avatarId],
};

function mount(scope = 'groups', source = adapter) {
    manager = createFolderManager(scope, source);
    manager.show();
    return manager;
}

describe('Folder Manager', () => {
    test('creates folders from the header plus and reports empty names inline', () => {
        mount();
        manager.root.querySelector('.sb-folder-manager__add').click();
        const input = popoverOptions.content.querySelector('input');
        expect(input.placeholder).toBe('');
        expect(popoverOptions.titleInput).toBe(input);
        expect(popoverOptions.titleLabel.textContent).toBe('New Folder');
        input.value = '  Scenes  ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        expect(folders.getFolders('groups')).toEqual([]);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
        expect(folders.getFolders('groups')).toEqual([]);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(folders.getFolders('groups').map(folder => folder.name)).toEqual(['Scenes']);
        input.value = ' ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(popoverOptions.content.querySelector('.sb-folder-manager__error').textContent).toBe('Enter a folder name.');
    });

    test('renames inline and exposes colour, expansion, ordering and delete actions', async () => {
        const first = folders.createFolder('groups', 'First');
        folders.createFolder('groups', 'Second');
        mount();
        const input = manager.root.querySelector(`[data-folder-id="${first.id}"] input`);
        input.value = 'Renamed';
        input.dispatchEvent(new Event('blur'));
        expect(folders.getFolders('groups')[0].name).toBe('Renamed');
        manager.root.querySelector(`[data-folder-id="${first.id}"] .sb-folder-manager__row-menu`).click();
        const items = menuOptions.sections.flatMap(section => section.items);
        expect(items.map(item => item.label)).toEqual(['Rename', 'Colour', 'Expanded by Default', 'Move Down', 'Delete']);
        expect(items.filter(item => item.data?.sbReorder).map(item => item.data.sbReorder)).toEqual(['down']);
        items.find(item => item.label === 'Expanded by Default').onSelect();
        items.find(item => item.label === 'Move Down').onSelect();
        expect(folders.getFolders('groups').map(folder => folder.name)).toEqual(['Second', 'Renamed']);
        expect(document.querySelector('.sb-reorder-status').textContent).toBe('Moved Renamed to position 2 of 2');
        expect(folders.getFolders('groups')[1].expanded).toBe(false);
        items.find(item => item.label === 'Colour').onSelect();
        expect(manager.root.querySelector('toolcool-color-picker')).not.toBeNull();
        expect(save).toHaveBeenCalled();
    });

    test('delete confirmation is a destructive alert with Cancel focused; Delete leaves members unfiled', async () => {
        const folder = folders.createFolder('groups', 'Delete me');
        folders.setFolder('groups', ['g1'], folder.id);
        mount();
        const openDelete = () => {
            manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__row-menu`).click();
            menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Delete').onSelect();
            return document.querySelector('.sb-dialog-host[role="alertdialog"]');
        };
        let alert = openDelete();
        expect(alert.querySelector('.sb-dialog__heading').textContent).toBe('Delete Folder?');
        expect(document.activeElement).toBe(alert.querySelector('[data-response="cancel"]'));
        alert.querySelector('[data-response="cancel"]').click();
        await settle();
        expect(folders.getFolders('groups')).toHaveLength(1);
        alert = openDelete();
        const remove = alert.querySelector('[data-response="delete"]');
        expect(remove.classList.contains('is-destructive')).toBe(true);
        remove.click();
        await settle();
        expect(folders.getFolders('groups')).toEqual([]);
        expect(folders.getFolderId('groups', 'g1')).toBeNull();
        expect(manager.host.open).toBe(true);
    });

    test('deleting the folder whose members page is open pops the page', async () => {
        const folder = folders.createFolder('groups', 'Open');
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();
        expect(manager.root.querySelector('.sb-dialog__back')).not.toBeNull();
        folders.deleteFolder('groups', folder.id);
        await settle();
        expect(manager.root.querySelector('.sb-dialog__back')).toBeNull();
        expect(manager.root.textContent).toContain('No Folders');
    });

    test('opens member page, removes members and adds searchable items', () => {
        const folder = folders.createFolder('groups', 'Members');
        folders.setFolder('groups', ['g1'], folder.id);
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();
        expect(manager.root.querySelector('.sb-dialog__back')).not.toBeNull();
        expect(manager.root.querySelector('.sb-dialog__page:not([hidden]) .sb-dialog__title').textContent).toBe('Members');
        expect(manager.root.querySelectorAll('.sb-folder-manager__member-row')).toHaveLength(1);
        manager.root.querySelector('.sb-folder-manager__remove').click();
        expect(folders.getFolderMembers('groups', folder.id)).toEqual([]);
        manager.root.querySelector('.sb-folder-manager__add-member').click();
        expect(pickerOptions.items).toHaveLength(2);
        expect(pickerOptions.bounds).toBe(manager.root);
        expect(pickerOptions.renderAsPopover).toBeUndefined();
        pickerOptions.onSelect('g2');
        expect(folders.getFolderMembers('groups', folder.id)).toEqual(['g2']);
        expect(manager.root.querySelectorAll('.sb-folder-manager__member-row')).toHaveLength(1);
        manager.root.querySelector('.sb-dialog__back').click();
        expect(manager.root.querySelector('.sb-dialog__back')).toBeNull();
        expect(manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__count`)).not.toBeNull();
    });

    test('opens as a Window-tier frame with Close and closes through it', async () => {
        mount();
        expect(manager.host.classList.contains('sb-dialog-host')).toBe(true);
        expect(manager.root.classList.contains('sb-dialog--window')).toBe(true);
        expect(manager.root.querySelector('.sb-dialog__title').textContent).toBe('Folders');
        expect(document.activeElement).toBe(manager.root.querySelector('.sb-dialog__search-toggle'));
        manager.root.querySelector('.sb-dialog__close').click();
        await manager.closed;
        expect(manager.host.isConnected).toBe(false);
        manager = null;
    });

    test('uses scope-specific empty state copy', () => {
        mount('characters');
        expect(manager.root.textContent).toContain('No Folders');
        expect(manager.root.textContent).toContain('Create a folder to sort characters in the list.');
    });

    test('the empty page offers New Folder and opens the create popover', () => {
        mount();
        const action = manager.root.querySelector('.sb-status-page__action');
        expect(action.textContent).toBe('New Folder');
        action.click();
        expect(popoverOptions.title).toBe('New Folder');
        expect(popoverOptions.trigger).toBe(manager.root.querySelector('.sb-folder-manager__add'));
    });

    test('a search without a match offers no action', () => {
        jest.useFakeTimers();
        folders.createFolder('groups', 'Alpha');
        mount();
        manager.root.querySelector('.sb-dialog__search-toggle').click();
        const search = manager.root.querySelector('.sb-dialog__search-input');
        search.value = 'zzz';
        search.dispatchEvent(new Event('input'));
        jest.advanceTimersByTime(300);
        expect(manager.root.querySelector('.sb-status-page__title').textContent).toBe('No results');
        expect(manager.root.querySelector('.sb-status-page__action')).toBeNull();
        jest.useRealTimers();
    });

    test('the members page offers Add when the folder is empty and rows use the shared row button', () => {
        const folder = folders.createFolder('groups', 'Empty');
        mount();
        expect(manager.root.querySelector('.sb-folder-manager__list').classList.contains('ds-pref-group')).toBe(false);
        expect(manager.root.querySelector('.sb-folder-manager__row-menu').classList.contains('ds-entity-row__button')).toBe(true);
        expect(manager.root.querySelector('.sb-folder-manager__folder-row .menu_button')).toBeNull();
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();
        const action = manager.root.querySelector('.sb-dialog__page:not([hidden]) .sb-status-page__action');
        expect(action.textContent).toBe('Add');
        action.click();
        expect(pickerOptions.items).toHaveLength(2);
    });
});

describe('Folder Manager persona scope', () => {
    test('lists personas under their folder, adds and removes members, and counts personas', () => {
        const folder = folders.createFolder('personas', 'Casts');
        folders.setFolder('personas', ['a.png'], folder.id);
        mount('personas', personaAdapter);
        expect(manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__count`).textContent).toBe('1 persona');
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();
        expect(manager.root.querySelectorAll('.sb-folder-manager__member-row')).toHaveLength(1);
        expect(manager.root.querySelector('.sb-folder-manager__member-row').textContent).toContain('Alice');
        manager.root.querySelector('.sb-folder-manager__add-member').click();
        expect(pickerOptions.items.map(item => item.label)).toEqual(['Alice', 'Bob']);
        pickerOptions.onSelect('b.png');
        expect(folders.getFolderMembers('personas', folder.id)).toEqual(['a.png', 'b.png']);
        manager.root.querySelector('.sb-folder-manager__remove').click();
        expect(folders.getFolderMembers('personas', folder.id)).toEqual(['b.png']);
        expect(folders.getFolders('groups')).toEqual([]);
    });

    test('marks the placeholder wording of its empty page and its delete alert', async () => {
        const folder = folders.createFolder('personas', 'Casts');
        mount('personas', personaAdapter);
        manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__row-menu`).click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Delete').onSelect();
        const body = document.querySelector('.sb-dialog-host[role="alertdialog"] .sb-dialog__message');
        expect(body.textContent).toBe('TODO(copy)');
        expect(body.querySelector('[data-sb-copy-placeholder="true"]')).not.toBeNull();
        document.querySelector('.sb-dialog-host[role="alertdialog"] [data-response="cancel"]').click();
        await settle();
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();
        expect(manager.root.querySelector('.sb-status-page__description').getAttribute('data-sb-copy-placeholder')).toBe('true');
    });

    test.each([
        ['personas', personaAdapter, ['a.png', 'gone.png', 'also-gone.png'], '1 persona'],
        ['groups', adapter, ['g1', 'gone'], '1 group'],
    ])('the %s folder count leaves out members that no longer exist', (scope, source, keys, label) => {
        const folder = folders.createFolder(scope, 'Casts');
        folders.setFolder(scope, keys, folder.id);
        mount(scope, source);
        expect(manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__count`).textContent).toBe(label);
    });
});

describe('Folder Manager selection mode', () => {
    const checks = () => [...manager.root.querySelectorAll('.sb-folder-manager__folder-row > .sb-selection-check')];
    const deleteButton = () => manager.root.querySelector('.sb-folder-manager__selection-bar [data-action-id="delete"]');

    function enter() {
        manager.root.querySelector('.sb-dialog__menu').click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Select').onSelect();
    }

    test('the header menu carries Select, and selecting takes the rows\' name fields and buttons out of use', () => {
        folders.createFolder('groups', 'First');
        mount();
        manager.root.querySelector('.sb-dialog__menu').click();
        expect(menuOptions.title).toBe('Folders');
        expect(menuOptions.sections.flatMap(section => section.items).map(item => item.label)).toEqual(['Select']);
        enter();
        expect(manager.root.dataset.selectionMode).toBe('true');
        expect(manager.root.querySelector('.sb-folder-manager__name').inert).toBe(true);
        expect([...manager.root.querySelectorAll('.sb-folder-manager__folder-row .ds-entity-row__suffix')].every(node => node.inert)).toBe(true);
        expect([...manager.root.querySelectorAll('.sb-folder-manager__selection-bar [data-action-id]')].map(node => node.dataset.actionId)).toEqual(['delete']);
    });

    test('Select is disabled while there is no folder', () => {
        mount();
        manager.root.querySelector('.sb-dialog__menu').click();
        expect(menuOptions.sections[0].items[0].disabled).toBe(true);
    });

    test('Delete confirms once with the count, deletes each folder and leaves its members unfiled', async () => {
        const first = folders.createFolder('groups', 'First');
        folders.createFolder('groups', 'Second');
        const third = folders.createFolder('groups', 'Third');
        folders.setFolder('groups', ['g1'], first.id);
        mount();
        enter();
        checks()[0].click();
        checks()[1].click();
        deleteButton().click();
        await settle();
        expect(confirmDestructiveAction).toHaveBeenCalledTimes(1);
        expect(confirmDestructiveAction.mock.calls[0][0]).toMatchObject({ confirmLabel: 'Delete', copyPlaceholder: true });
        expect(confirmDestructiveAction.mock.calls[0][0].text).toMatch(/^TODO\(copy\) \(2\) /);
        expect(folders.getFolders('groups').map(folder => folder.id)).toEqual([third.id]);
        expect(folders.getFolderId('groups', 'g1')).toBeNull();
        expect(manager.root.dataset.selectionMode).toBe('false');
    });

    test('declining the confirmation keeps every folder and the selection', async () => {
        folders.createFolder('groups', 'First');
        mount();
        enter();
        confirmDestructiveAction.mockResolvedValueOnce(false);
        checks()[0].click();
        deleteButton().click();
        await settle();
        expect(folders.getFolders('groups')).toHaveLength(1);
        expect(manager.root.dataset.selectionMode).toBe('true');
    });
});
