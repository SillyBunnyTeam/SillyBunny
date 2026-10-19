/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let menuOptions;
let pickerOptions;
const openActionMenu = jest.fn(options => menuOptions = options);
const closeActionMenu = jest.fn();
const openPicker = jest.fn(options => pickerOptions = options);
const closePicker = jest.fn();
const confirmDelete = jest.fn(async () => 0);

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu,
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
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(),
    stopMotion: jest.fn(),
    SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: { show: { confirm: confirmDelete } },
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const folders = await import('../../public/scripts/sillybunny-folders.js');
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
    pickerOptions = null;
    confirmDelete.mockClear();
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
    test('creates folders on Enter and reports empty names inline', () => {
        mount();
        const input = manager.root.querySelector('.sb-folder-manager__new');
        input.value = '  Scenes  ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(folders.getFolders('groups').map(folder => folder.name)).toEqual(['Scenes']);
        input.value = ' ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(manager.root.querySelector('.sb-folder-manager__error').textContent).toBe('Enter a folder name.');
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

    test('delete confirmation leaves members unfiled when affirmed', async () => {
        const folder = folders.createFolder('groups', 'Delete me');
        folders.setFolder('groups', ['g1'], folder.id);
        confirmDelete.mockResolvedValue(1);
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"] .sb-folder-manager__row-menu`).click();
        menuOptions.sections.flatMap(section => section.items).find(item => item.label === 'Delete').onSelect();
        await Promise.resolve();
        await Promise.resolve();
        expect(folders.getFolders('groups')).toEqual([]);
        expect(folders.getFolderId('groups', 'g1')).toBeNull();
    });

    test('opens member page, removes members and adds searchable items', () => {
        const folder = folders.createFolder('groups', 'Members');
        folders.setFolder('groups', ['g1'], folder.id);
        mount();
        manager.root.querySelector(`[data-folder-id="${folder.id}"]`).click();
        expect(manager.root.querySelector('.sb-folder-manager__back')).not.toBeNull();
        expect(manager.root.querySelectorAll('.sb-folder-manager__member-row')).toHaveLength(1);
        manager.root.querySelector('.sb-folder-manager__remove').click();
        expect(folders.getFolderMembers('groups', folder.id)).toEqual([]);
        manager.root.querySelector('.sb-folder-manager__add-member').click();
        expect(pickerOptions.items).toHaveLength(2);
        pickerOptions.onSelect('g2');
        expect(folders.getFolderMembers('groups', folder.id)).toEqual(['g2']);
    });

    test('uses scope-specific empty state copy', () => {
        mount('characters');
        expect(manager.root.textContent).toContain('No Folders');
        expect(manager.root.textContent).toContain('Create a folder to sort characters in the list.');
    });
});
