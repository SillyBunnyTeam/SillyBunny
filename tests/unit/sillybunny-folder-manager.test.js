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

function mount(scope = 'groups') {
    manager = createFolderManager(scope, adapter);
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
        expect(items.map(item => item.label)).toEqual(['Rename', 'Colour', 'Expanded by Default', 'Move Up', 'Move Down', 'Delete']);
        items.find(item => item.label === 'Expanded by Default').onSelect();
        items.find(item => item.label === 'Move Down').onSelect();
        expect(folders.getFolders('groups').map(folder => folder.name)).toEqual(['Second', 'Renamed']);
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
});
