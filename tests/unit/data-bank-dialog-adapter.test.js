/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let menuOptions;
const openActionMenu = jest.fn(options => { menuOptions = options; });
const createListSearch = jest.fn(() => ({
    query: '',
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

function makeRow({ bulk = false } = {}) {
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
    if (bulk) {
        const bulkInput = document.createElement('input');
        bulkInput.type = 'checkbox';
        bulkInput.className = 'attachmentsBulkEditCheckbox';
        bulkInput.checked = true;
        root.append(bulkInput);
    }
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
            const click = jest.fn();
            button.addEventListener('click', click);
            return { label, button, click };
        });
        decorateDataBankRow(row, { view, actions });
        row.querySelector('.attachmentRowMenu').click();
        const items = menuOptions.sections[0].items;
        items.forEach(item => item.onSelect());
        expect(actions.map(action => action.click)).toEqual(actions.map(() => expect.any(Function)));
        actions.forEach(action => expect(action.click).toHaveBeenCalledTimes(1));
    });

    test.each(['Enter', ' '])('activates View from the keyboard with %s', key => {
        const { row, view } = makeRow();
        const click = jest.fn();
        view.addEventListener('click', click);
        decorateDataBankRow(row, { view, actions: [] });
        row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        expect(click).toHaveBeenCalledTimes(1);
    });

    test.each(['Enter', ' '])('toggles selection from the keyboard in bulk mode with %s', key => {
        const { row, checkbox } = makeRow({ bulk: true });
        decorateDataBankRow(row, { view: document.createElement('button'), actions: [] });
        row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        expect(checkbox.checked).toBe(true);
        row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        expect(checkbox.checked).toBe(false);
    });
});
