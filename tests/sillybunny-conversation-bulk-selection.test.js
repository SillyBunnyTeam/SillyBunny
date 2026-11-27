/** @jest-environment jsdom */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

// The translation function reads the page's locale data, which a unit test has no use for; it keeps the text as written.
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => strings.reduce((text, string, index) => text + string + (values[index] ?? ''), '') }));

const { createBatchedList, createBulkSelection } = await import('../public/scripts/sillybunny-conversation/details/bulk-selection.js');

/** A page of the details window as the dialog builds it: a header with its three parts, a body, and the status node after it. */
function buildFrame() {
    document.body.innerHTML = `
        <section class="sb-dialog__page" id="page">
            <header class="sb-dialog__header">
                <div class="sb-dialog__header-start"><button type="button" id="back">Back</button></div>
                <div class="sb-dialog__titles"><h2 class="sb-dialog__title">Chats</h2></div>
                <div class="sb-dialog__header-end"><button type="button" id="close">Close</button></div>
            </header>
            <div class="sb-dialog__body"><div id="list" role="list"></div></div>
            <div class="sb-dialog__status"></div>
        </section>`;
    const page = document.getElementById('page');
    const header = page.querySelector('header');
    // The dialog's own `createIconButton`, as the window hands it to a page.
    const createIconButton = (label, glyph, className = '') => {
        const node = document.createElement('button');
        node.className = `sb-dialog__icon-button ${className}`;
        node.type = 'button';
        node.title = label;
        node.setAttribute('aria-label', label);
        return node;
    };
    return {
        frame: {
            createIconButton,
            page,
            body: page.querySelector('.sb-dialog__body'),
            header,
            headerStart: header.querySelector('.sb-dialog__header-start'),
            headerEnd: header.querySelector('.sb-dialog__header-end'),
            titleNode: header.querySelector('.sb-dialog__title'),
            closeButton: document.getElementById('close'),
            search: null,
        },
        list: document.getElementById('list'),
    };
}

const row = (key) => {
    const node = document.createElement('div');
    node.className = 'row';
    node.setAttribute('role', 'listitem');
    node.setAttribute('aria-label', `Item ${key}`);
    node.dataset.sbListKey = key;
    node.tabIndex = 0;
    return node;
};

const keysOf = count => Array.from({ length: count }, (_, index) => `k${index + 1}`);
const titleText = () => document.querySelector('.sb-dialog__title').textContent;
const selectButton = () => document.querySelector('.sb-details-select');
const click = target => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
/** A press of Show More ignores a press while the first still runs, which takes a few microtasks. */
const settled = async () => {
    for (let turn = 0; turn < 4; turn++) {
        await Promise.resolve();
    }
};
const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('bulk actions: a long list in batches', () => {
    let list;
    let batched;
    let items;

    beforeEach(() => {
        ({ list } = buildFrame());
        items = keysOf(120);
        batched = createBatchedList({ list, renderRow: row });
        list.after(batched.element);
    });

    test('draws fifty rows and offers Show More, then fifty more on each press, then hides the row', async () => {
        batched.update(items);
        expect(list.children).toHaveLength(50);
        expect(batched.element.hidden).toBe(false);

        batched.element.querySelector('button').click();
        await settled();
        expect(list.children).toHaveLength(100);
        expect(batched.element.hidden).toBe(false);

        batched.element.querySelector('button').click();
        await settled();
        expect(list.children).toHaveLength(120);
        expect(batched.element.hidden).toBe(true);
    });

    test('draws a short list whole, with no Show More', () => {
        batched.update(keysOf(12));
        expect(list.children).toHaveLength(12);
        expect(batched.element.hidden).toBe(true);
    });

    test('keeps how many rows are shown when the list is drawn again, so that a change does not fold it', async () => {
        batched.update(items);
        batched.element.querySelector('button').click();
        await settled();
        batched.update([...items.slice(1)]);
        expect(list.children).toHaveLength(100);
        batched.update(items.slice(0, 80));
        expect(list.children).toHaveLength(80);
        expect(batched.element.hidden).toBe(true);
    });

    test('gives a list that was empty its first batch', () => {
        batched.update([]);
        expect(list.children).toHaveLength(0);
        batched.update(keysOf(70));
        expect(list.children).toHaveLength(50);
    });

    test('hands focus to the first row that a press from the keyboard added, and not after a pointer press', async () => {
        const focusTarget = jest.fn(node => node);
        batched.destroy();
        batched = createBatchedList({ list, renderRow: row, focusTarget });
        list.after(batched.element);
        batched.update(items);

        batched.element.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        await settled();
        expect(focusTarget).not.toHaveBeenCalled();

        batched.element.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        await settled();
        expect(focusTarget).toHaveBeenCalledTimes(1);
        expect(focusTarget.mock.calls[0][0]).toBe(list.children[100]);
    });

    test('with rowSelector, gives the list one Tab stop, arrows to Show More, and keeps existing rows when loading more', async () => {
        batched.destroy();
        batched = createBatchedList({ list, renderRow: row, rowSelector: '.row' });
        list.after(batched.element);
        batched.update(keysOf(52));

        const firstRow = list.children[0];
        const lastOfFirstBatch = list.children[49];
        expect(firstRow.tabIndex).toBe(0);
        expect(lastOfFirstBatch.tabIndex).toBe(-1);

        firstRow.focus();
        press(firstRow, 'ArrowDown');
        expect(document.activeElement).toBe(list.children[1]);
        press(list.children[1], 'End');
        expect(document.activeElement).toBe(lastOfFirstBatch);
        press(lastOfFirstBatch, 'ArrowDown');
        expect(document.activeElement).toBe(batched.element.querySelector('button'));

        batched.element.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        await settled();
        expect(list.children).toHaveLength(52);
        expect(list.children[0]).toBe(firstRow);
        expect(document.activeElement).toBe(list.children[50]);
    });
});

describe('bulk actions: selection mode on a page of the details window', () => {
    let frame;
    let list;
    let items;
    let batched;
    let bulk;
    let run;

    /** `rows` is how many of the items the page has drawn; the rest wait behind Show More. */
    function mountPage({ gestures = false, count = 120 } = {}) {
        ({ frame, list } = buildFrame());
        items = keysOf(count);
        run = jest.fn(async () => true);
        bulk = createBulkSelection({
            getList: () => list,
            rowSelector: '.row',
            getKey: node => node.dataset.sbListKey,
            getAllKeys: () => items,
            gestures,
            actions: [{ id: 'act', label: 'Act', icon: 'fa-solid fa-check', run }],
        });
        batched = createBatchedList({ list, renderRow: row, onDrawn: () => bulk.sync() });
        list.after(batched.element);
        batched.update(items);
        bulk.mount({ frame });
    }

    test('puts a Select button in the header, before Close, and a bar under the body', () => {
        mountPage();
        expect(frame.headerEnd.firstElementChild).toBe(selectButton());
        expect(selectButton().getAttribute('aria-label')).toBe('Select');
        expect(selectButton().title).toBe('Select');
        expect(frame.body.nextElementSibling.classList.contains('sb-details-selection-bar')).toBe(true);
    });

    test('Select turns the header into the selection header, Cancel leaves, and the header is as it was', () => {
        mountPage();
        click(selectButton());
        expect(bulk.isActive).toBe(true);
        expect(titleText()).toBe('0 Selected');
        expect(frame.headerStart.querySelector('.sb-selection-cancel')).not.toBeNull();
        expect(frame.headerEnd.querySelector('.sb-selection-select-all')).not.toBeNull();
        expect(document.getElementById('back').hidden).toBe(true);
        expect(frame.closeButton.hidden).toBe(false);

        click(frame.headerStart.querySelector('.sb-selection-cancel'));
        expect(bulk.isActive).toBe(false);
        expect(titleText()).toBe('Chats');
        expect(document.getElementById('back').hidden).toBe(false);
        expect(frame.headerStart.querySelector('.sb-selection-cancel')).toBeNull();
    });

    test('Select All covers every item, also the ones that Show More has not drawn yet', async () => {
        mountPage();
        expect(list.children).toHaveLength(50);
        click(selectButton());
        click(frame.headerEnd.querySelector('.sb-selection-select-all'));
        expect(bulk.selectedKeys).toHaveLength(120);
        expect(titleText()).toBe('120 Selected');

        batched.element.querySelector('button').click();
        await settled();
        expect(list.querySelectorAll('.is-selection-selected')).toHaveLength(100);
        expect(list.querySelector('[data-sb-list-key="k100"] .sb-selection-check').checked).toBe(true);
    });

    test('a press on a row chooses it, and a Shift-press chooses the range from the last row that was pressed', () => {
        mountPage();
        click(selectButton());
        click(list.querySelector('[data-sb-list-key="k3"]'));
        click(list.querySelector('[data-sb-list-key="k6"]'));
        expect(bulk.selectedKeys.sort()).toEqual(['k3', 'k6']);
        list.querySelector('[data-sb-list-key="k9"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
        expect(bulk.selectedKeys.sort()).toEqual(['k3', 'k6', 'k7', 'k8', 'k9']);
    });

    test('a row that has a menu is chosen from the menu: a secondary click starts nothing, and enter() does', () => {
        mountPage({ gestures: false });
        const target = list.querySelector('[data-sb-list-key="k2"]');
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(bulk.isActive).toBe(false);

        bulk.enter('k2');
        expect(bulk.isActive).toBe(true);
        expect(bulk.selectedKeys).toEqual(['k2']);
    });

    test('a row that has no menu is chosen by a secondary click', () => {
        mountPage({ gestures: true });
        list.querySelector('[data-sb-list-key="k4"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(bulk.isActive).toBe(true);
        expect(bulk.selectedKeys).toEqual(['k4']);
    });

    test('Escape leaves selection mode', () => {
        mountPage();
        bulk.enter('k1');
        press(list.querySelector('[data-sb-list-key="k1"]'), 'Escape');
        expect(bulk.isActive).toBe(false);
    });

    test('Escape and a swipe leave selection mode and keep the page, and every other way out leaves it and goes on', () => {
        mountPage();
        const outcomes = {};
        for (const reason of ['escape', 'swipe', 'back', 'close', 'scrim']) {
            bulk.enter('k1');
            outcomes[reason] = [bulk.canClose(reason), bulk.isActive];
        }
        expect(outcomes).toEqual({
            escape: [false, false],
            swipe: [false, false],
            back: [true, false],
            close: [true, false],
            scrim: [true, false],
        });
    });

    test('a page that is not in selection mode closes by any route, and a programmatic close never waits for selection mode', () => {
        mountPage();
        expect(bulk.canClose('escape')).toBe(true);
        bulk.enter('k1');
        expect(bulk.canClose('programmatic')).toBe(true);
        expect(bulk.isActive).toBe(true);
    });

    test('sync drops the chosen items that are gone, keeps one that is behind Show More, and gives new rows their checks', () => {
        mountPage();
        bulk.enter('k1');
        click(list.querySelector('[data-sb-list-key="k2"]'));
        click(frame.headerEnd.querySelector('.sb-selection-select-all'));
        expect(bulk.selectedKeys).toHaveLength(120);

        items = items.filter(key => key !== 'k2' && key !== 'k60');
        batched.update(items);
        expect(bulk.selectedKeys).toHaveLength(118);
        expect(bulk.selectedKeys).not.toContain('k2');
        expect(bulk.selectedKeys).toContain('k110');
        expect(titleText()).toBe('118 Selected');
        expect(list.querySelectorAll('.sb-selection-check')).toHaveLength(batched.shownCount);
    });

    test('an action gets the chosen keys, and selection mode ends when it says that it is done', async () => {
        mountPage();
        bulk.enter('k1');
        click(list.querySelector('[data-sb-list-key="k5"]'));
        const bar = frame.body.nextElementSibling;
        click(bar.querySelector('[data-action-id="act"]'));
        await Promise.resolve();
        await Promise.resolve();
        expect(run).toHaveBeenCalledWith(['k1', 'k5'], expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(bulk.isActive).toBe(false);
    });

    test('selection mode stays when an action says that it is not done, so that the user can try again', async () => {
        mountPage();
        run.mockResolvedValue(false);
        bulk.enter('k1');
        click(frame.body.nextElementSibling.querySelector('[data-action-id="act"]'));
        await Promise.resolve();
        await Promise.resolve();
        expect(bulk.isActive).toBe(true);
        expect(bulk.selectedKeys).toEqual(['k1']);
    });

    test('an action that is running disables the action bar, is not started twice, and receives an abort on Cancel', async () => {
        mountPage();
        let finish;
        let receivedSignal;
        run.mockImplementation((_keys, { signal }) => {
            receivedSignal = signal;
            return new Promise((resolve) => { finish = resolve; });
        });
        bulk.enter('k1');
        const button = frame.body.nextElementSibling.querySelector('[data-action-id="act"]');
        click(button);
        expect(button.disabled).toBe(true);
        click(button);
        expect(run).toHaveBeenCalledTimes(1);
        expect(receivedSignal.aborted).toBe(false);

        click(frame.headerStart.querySelector('.sb-selection-cancel'));
        expect(receivedSignal.aborted).toBe(true);
        expect(bulk.isActive).toBe(false);

        finish(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(bulk.isActive).toBe(false);
    });

    test('hides the Select button of a page that has nothing to choose, leaves selection mode, and keeps focus in the header', () => {
        mountPage();
        selectButton().focus();
        click(selectButton());
        list.replaceChildren();
        bulk.setSelectable(false);
        expect(selectButton().hidden).toBe(true);
        expect(bulk.isActive).toBe(false);
        expect(document.activeElement).toBe(document.getElementById('back'));
        bulk.setSelectable(true);
        expect(selectButton().hidden).toBe(false);
    });

    test('keySourceSelector lets a nested button extend a range with Shift+Space', () => {
        ({ frame, list } = buildFrame());
        const cellRow = (key) => {
            const item = document.createElement('div');
            item.className = 'media-item';
            item.dataset.sbSelectKey = key;
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'media-cell';
            item.append(cell);
            return item;
        };
        items = keysOf(5);
        bulk = createBulkSelection({
            getList: () => list,
            rowSelector: '.media-item',
            keySourceSelector: '.media-cell',
            getKey: node => node.dataset.sbSelectKey,
            getAllKeys: () => items,
            actions: [{ id: 'act', label: 'Act', icon: 'fa-solid fa-check', run: jest.fn(async () => true) }],
        });
        list.replaceChildren(...items.map(cellRow));
        bulk.mount({ frame });
        bulk.enter('k1');
        const fourthCell = list.children[3].querySelector('.media-cell');
        fourthCell.focus();
        fourthCell.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true }));
        expect(bulk.selectedKeys.sort()).toEqual(['k1', 'k2', 'k3', 'k4']);
    });

    test('takes its button and its bar away when the page is dropped', () => {
        mountPage();
        bulk.enter('k1');
        bulk.destroy();
        expect(selectButton()).toBeNull();
        expect(document.querySelector('.sb-details-selection-bar')).toBeNull();
        expect(titleText()).toBe('Chats');
    });
});
