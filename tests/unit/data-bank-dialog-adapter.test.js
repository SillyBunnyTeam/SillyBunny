/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let menuOptions;
const openActionMenu = jest.fn(options => { menuOptions = options; });
const createListSearch = jest.fn(() => ({
    query: '',
    isOpen: false,
    open: jest.fn(),
    close: jest.fn(),
    setQuery: jest.fn(),
    toggle: jest.fn(),
    destroy: jest.fn(),
    report: jest.fn(),
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/list-search.js', () => ({ createListSearch }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/status-page.js', () => ({
    createStatusPage: () => ({ element: document.createElement('div') }),
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const { decorateDataBankRow, frameDataBankManager } = await import('../../public/scripts/sillybunny-editor/adapters/data-bank-dialog.js');

beforeEach(() => {
    document.body.replaceChildren();
    menuOptions = null;
    jest.clearAllMocks();
});

function makePopup() {
    const dlg = document.createElement('dialog');
    const header = document.createElement('header');
    header.className = 'sb-dialog__header';
    const body = document.createElement('div');
    body.className = 'popup-content';
    const manager = document.createElement('div');
    manager.className = 'dataBankAttachments';
    const search = document.createElement('input');
    search.type = 'search';
    search.id = 'attachmentSearch';
    const sort = document.createElement('select');
    sort.id = 'attachmentSort';
    for (const label of ['Date', 'Name']) {
        const option = document.createElement('option');
        option.textContent = label;
        sort.append(option);
    }
    const bulk = document.createElement('label');
    bulk.className = 'attachmentsBulkEditButton';
    bulk.append(document.createElement('i'), document.createElement('span'));
    const bulkInput = document.createElement('input');
    bulkInput.type = 'checkbox';
    bulkInput.className = 'attachmentsBulkEditCheckbox';
    bulk.append(bulkInput);
    const closeButton = document.createElement('button');
    closeButton.className = 'popup-button-close';
    body.append(manager);
    dlg.append(header, body, search, sort, bulk);
    document.body.append(dlg);
    return { popup: { dlg, closeButton }, manager, search, sort, bulkInput };
}

function makeRow() {
    const root = document.createElement('div');
    root.className = 'dataBankAttachments';
    const row = document.createElement('div');
    const view = document.createElement('button');
    view.className = 'viewAttachmentButton';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'attachmentListItemCheckbox';
    const actions = document.createElement('div');
    actions.className = 'attachmentRowActions';
    row.append(checkbox, view, actions);
    root.append(row);
    document.body.append(root);
    return { row, view, checkbox };
}

describe('Data Bank dialog adapter', () => {
    test('fails fast when the Popup page or source controls are missing', () => {
        expect(() => frameDataBankManager({})).toThrow(TypeError);
        expect(() => frameDataBankManager({ dlg: document.createElement('div') })).toThrow(TypeError);

        const { popup, search } = makePopup();
        search.remove();
        expect(() => frameDataBankManager(popup)).toThrow('The Data Bank manager is missing its source controls.');
    });

    test('forwards sort selection through the adopted select change event', () => {
        const { popup, sort } = makePopup();
        const change = jest.fn();
        sort.addEventListener('change', change);
        const frame = frameDataBankManager(popup);
        popup.dlg.querySelector('.sb-data-bank-sort').click();
        menuOptions.sections[0].items[1].onSelect();
        expect(sort.selectedIndex).toBe(1);
        expect(change).toHaveBeenCalledTimes(1);
        expect(createListSearch).toHaveBeenCalledTimes(1);
        frame.destroy();
    });

    test('forwards every row menu action to its original control', () => {
        const { row, view } = makeRow();
        const actions = ['Enable', 'Move', 'Edit', 'Download', 'Delete'].map(label => {
            const button = document.createElement('button');
            if (label === 'Delete') button.className = 'deleteAttachmentButton';
            const click = jest.fn();
            button.addEventListener('click', click);
            return { label, button, click };
        });
        decorateDataBankRow(row, { view, actions });
        row.querySelector('.attachmentRowMenu').click();
        menuOptions.sections.flatMap(section => section.items).forEach(item => item.onSelect());
        expect(actions.map(action => action.click)).toEqual(actions.map(() => expect.any(Function)));
        actions.forEach(action => expect(action.click).toHaveBeenCalledTimes(1));
    });

    test('the menu is titled with the attachment name, and "Menu" when the row has none', () => {
        const named = makeRow();
        const name = document.createElement('div');
        name.className = 'attachmentListItemName';
        name.textContent = ' notes.txt ';
        named.row.append(name);
        decorateDataBankRow(named.row, { view: named.view, actions: [] });
        named.row.querySelector('.attachmentRowMenu').click();
        expect(menuOptions.title).toBe('notes.txt');

        const bare = makeRow();
        decorateDataBankRow(bare.row, { view: bare.view, actions: [] });
        bare.row.querySelector('.attachmentRowMenu').click();
        expect(menuOptions.title).toBe('Menu');
    });

    test('Delete is the red last item, in a section of its own', () => {
        const { row, view } = makeRow();
        const actions = ['Enable', 'Edit', 'Delete'].map(label => {
            const button = document.createElement('button');
            if (label === 'Delete') button.className = 'deleteAttachmentButton';
            return { label, button };
        });
        decorateDataBankRow(row, { view, actions });
        row.querySelector('.attachmentRowMenu').click();

        expect(menuOptions.sections.map(section => section.items.map(item => item.label))).toEqual([['Enable', 'Edit'], ['Delete']]);
        expect(menuOptions.sections[1].items[0].danger).toBe(true);
        expect(menuOptions.sections[0].items.some(item => item.danger)).toBe(false);
    });

    test.each(['Enter', ' '])('activates View from the keyboard with %s', key => {
        const { row, view } = makeRow();
        const click = jest.fn();
        view.addEventListener('click', click);
        decorateDataBankRow(row, { view, actions: [] });
        row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        expect(click).toHaveBeenCalledTimes(1);
    });

    describe('Bulk Edit', () => {
        function framedManager() {
            const { popup, manager, bulkInput } = makePopup();
            const title = document.createElement('h2');
            title.className = 'sb-dialog__title';
            popup.dlg.querySelector('.sb-dialog__header').append(title);
            const lists = ['globalAttachmentsList', 'characterAttachmentsList'].map(name => {
                const list = document.createElement('div');
                list.className = `${name} attachmentsList`;
                manager.append(list);
                return list;
            });
            const template = document.createElement('div');
            template.className = 'attachmentListItemTemplate';
            manager.append(template);
            const makeBankRow = (list, url) => {
                const row = document.createElement('div');
                row.className = 'attachmentListItem';
                row.dataset.attachmentSource = 'global';
                row.dataset.attachmentUrl = url;
                const name = document.createElement('div');
                name.className = 'attachmentListItemName';
                name.textContent = url;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'attachmentListItemCheckbox';
                row.append(checkbox, name);
                list.append(row);
                return { row, checkbox };
            };
            const frame = frameDataBankManager(popup);
            return { popup, manager, bulkInput, frame, lists, template, makeBankRow };
        }

        test('enters the shared selection mode and mirrors it to the upstream checkboxes', () => {
            const { popup, bulkInput, frame, lists, template, makeBankRow } = framedManager();
            const first = makeBankRow(lists[0], '/a.txt');
            const second = makeBankRow(lists[1], '/b.txt');
            const spare = makeBankRow(template, '/template.txt');
            bulkInput.checked = true;
            bulkInput.dispatchEvent(new Event('change'));
            expect(popup.dlg.dataset.selectionMode).toBe('true');
            expect(popup.dlg.querySelectorAll('.sb-selection-action').length).toBe(3);

            first.row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            expect([first.checkbox.checked, second.checkbox.checked]).toEqual([true, false]);
            first.row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
            expect(first.checkbox.checked).toBe(false);

            popup.dlg.querySelector('.sb-dialog__selection-select-all').click();
            expect([first.checkbox.checked, second.checkbox.checked, spare.checkbox.checked]).toEqual([true, true, false]);
            frame.destroy();
        });

        test('Cancel leaves the mode and clears the upstream flag, and a finished bulk action ends it', () => {
            const { popup, bulkInput, frame, lists, makeBankRow } = framedManager();
            makeBankRow(lists[0], '/a.txt');
            bulkInput.checked = true;
            bulkInput.dispatchEvent(new Event('change'));
            popup.dlg.querySelector('.sb-dialog__selection-cancel').click();
            expect(popup.dlg.dataset.selectionMode).toBe('false');
            expect(bulkInput.checked).toBe(false);

            bulkInput.checked = true;
            bulkInput.dispatchEvent(new Event('change'));
            expect(popup.dlg.dataset.selectionMode).toBe('true');
            // Upstream clears its own flag after a bulk action completes.
            bulkInput.checked = false;
            frame.report(1, 1);
            expect(popup.dlg.dataset.selectionMode).toBe('false');
            frame.destroy();
        });

        test('each action clicks the hidden upstream bulk control', () => {
            const { popup, bulkInput, frame, lists, makeBankRow } = framedManager();
            const clicks = [];
            for (const name of ['Disable', 'Enable', 'Delete']) {
                const control = document.createElement('div');
                control.className = `bulkAction${name}`;
                control.addEventListener('click', () => clicks.push(name));
                popup.dlg.append(control);
            }
            const { row } = makeBankRow(lists[0], '/a.txt');
            bulkInput.checked = true;
            bulkInput.dispatchEvent(new Event('change'));
            row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            for (const button of popup.dlg.querySelectorAll('.sb-selection-action')) button.click();
            expect(clicks).toEqual(['Disable', 'Enable', 'Delete']);
            frame.destroy();
        });
    });
});
