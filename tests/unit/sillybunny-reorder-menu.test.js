/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const { reorderMenuItems, announceReorder } = await import('../../public/scripts/sillybunny-editor/reorder-menu.js');

const labels = items => items.map(item => item.label);
const build = (overrides = {}) => reorderMenuItems({ index: 1, count: 3, name: 'Row', move: jest.fn(), ...overrides });

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('reorderMenuItems', () => {
    test('offers Move Up and Move Down in the action menu item shape', () => {
        const items = build();
        expect(labels(items)).toEqual(['Move Up', 'Move Down']);
        expect(items.map(item => item.icon)).toEqual(['fa-solid fa-arrow-up', 'fa-solid fa-arrow-down']);
        expect(items.every(item => typeof item.onSelect === 'function')).toBe(true);
    });

    test('marks each item with its kind for tests and tools', () => {
        expect(build({ extremes: true }).map(item => item.data.sbReorder)).toEqual(['top', 'up', 'down', 'bottom']);
    });

    test('adds Move to Top and Move to Bottom only when the adopter asks for them', () => {
        expect(labels(build({ extremes: true }))).toEqual(['Move to Top', 'Move Up', 'Move Down', 'Move to Bottom']);
        expect(labels(build())).not.toContain('Move to Top');
    });

    test('leaves out the items that cannot act at the first row', () => {
        expect(labels(build({ index: 0, extremes: true }))).toEqual(['Move Down', 'Move to Bottom']);
    });

    test('leaves out the items that cannot act at the last row', () => {
        expect(labels(build({ index: 2, extremes: true }))).toEqual(['Move to Top', 'Move Up']);
    });

    test('offers nothing for a single row or a row outside the list', () => {
        expect(build({ index: 0, count: 1, extremes: true })).toEqual([]);
        expect(build({ index: -1 })).toEqual([]);
        expect(build({ index: 3 })).toEqual([]);
        expect(build({ index: Number.NaN })).toEqual([]);
    });

    test('omits the whole section while a search or filter hides rows', () => {
        expect(build({ filtered: true, extremes: true })).toEqual([]);
        expect(labels(build({ filtered: false }))).toEqual(['Move Up', 'Move Down']);
    });

    test('passes the new zero-based position to the adopter', () => {
        const move = jest.fn();
        const items = build({ index: 2, count: 5, extremes: true, move });
        const byLabel = Object.fromEntries(items.map(item => [item.label, item]));
        byLabel['Move to Top'].onSelect();
        byLabel['Move Up'].onSelect();
        byLabel['Move Down'].onSelect();
        byLabel['Move to Bottom'].onSelect();
        expect(move.mock.calls.map(([to]) => to)).toEqual([0, 1, 3, 4]);
    });

    test('announces the new position in a polite live region of the document', () => {
        build({ index: 1, count: 12, name: 'Persona', move: () => true })[0].onSelect();
        const region = document.querySelector('.sb-reorder-status');
        expect(region.textContent).toBe('Moved Persona to position 1 of 12');
        expect(region.getAttribute('role')).toBe('status');
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.classList.contains('sr-only')).toBe(true);
        expect(document.body.contains(region)).toBe(true);
    });

    test('reuses one shared region for every announcement', () => {
        build({ index: 1, count: 3, name: 'A' })[1].onSelect();
        build({ index: 1, count: 3, name: 'B' })[0].onSelect();
        expect(document.querySelectorAll('.sb-reorder-status')).toHaveLength(1);
        expect(document.querySelector('.sb-reorder-status').textContent).toBe('Moved B to position 1 of 3');
    });

    test('writes into the region a list already owns instead of the shared one', () => {
        const own = document.createElement('div');
        document.body.append(own);
        build({ index: 0, count: 4, name: 'Own', region: own })[0].onSelect();
        expect(own.textContent).toBe('Moved Own to position 2 of 4');
        expect(document.querySelector('.sb-reorder-status')).toBeNull();
    });

    test('puts the shared region inside an open modal dialog, which makes the body inert', () => {
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        dialog.setAttribute('data-sb-modal', '');
        document.body.append(dialog);
        build({ name: 'Tag' })[0].onSelect();
        expect(dialog.querySelector(':scope > .sb-reorder-status').textContent).toBe('Moved Tag to position 1 of 3');
        expect(document.body.querySelector(':scope > .sb-reorder-status')).toBeNull();
    });

    test('moves focus to the control the adopter names once the move has finished', () => {
        const row = document.createElement('div');
        row.tabIndex = 0;
        const other = document.createElement('button');
        document.body.append(row, other);
        other.focus();
        const order = [];
        const focus = jest.fn(() => { order.push('focus'); return row; });
        build({ move: () => { order.push('move'); }, focus })[0].onSelect();
        expect(order).toEqual(['move', 'focus']);
        expect(document.activeElement).toBe(row);
    });

    test('ignores a focus target that is no longer in the document', () => {
        const detached = document.createElement('div');
        detached.tabIndex = 0;
        const focus = jest.spyOn(detached, 'focus');
        build({ focus: () => detached })[0].onSelect();
        expect(focus).not.toHaveBeenCalled();
    });

    test('waits for an asynchronous move before it announces and focuses', async () => {
        const row = document.createElement('div');
        row.tabIndex = 0;
        document.body.append(row);
        let finish;
        const move = () => new Promise(resolve => { finish = resolve; });
        const pending = build({ name: 'Slow', move, focus: () => row })[0].onSelect();
        expect(document.querySelector('.sb-reorder-status')).toBeNull();
        expect(document.activeElement).not.toBe(row);
        finish(true);
        await pending;
        expect(document.querySelector('.sb-reorder-status').textContent).toBe('Moved Slow to position 1 of 3');
        expect(document.activeElement).toBe(row);
    });

    test.each([
        ['false', () => false],
        ['a promise of false', () => Promise.resolve(false)],
    ])('stays quiet when the adopter declines with %s', async (_label, move) => {
        const focus = jest.fn();
        await build({ move, focus })[0].onSelect();
        expect(document.querySelector('.sb-reorder-status')).toBeNull();
        expect(focus).not.toHaveBeenCalled();
    });

    test('hands an error of the move to onError and stays quiet', async () => {
        const onError = jest.fn();
        const failure = new Error('save failed');
        build({ move: () => { throw failure; }, onError })[0].onSelect();
        await build({ move: () => Promise.reject(failure), onError })[0].onSelect();
        expect(onError).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledWith(failure);
        expect(document.querySelector('.sb-reorder-status')).toBeNull();
    });

    test('lets an error propagate when no onError is given', async () => {
        const failure = new Error('save failed');
        expect(() => build({ move: () => { throw failure; } })[0].onSelect()).toThrow(failure);
        await expect(build({ move: () => Promise.reject(failure) })[0].onSelect()).rejects.toBe(failure);
    });
});

describe('announceReorder', () => {
    test('writes the same text for a move made by keyboard or drag', () => {
        announceReorder({ name: 'Intro', position: 3, count: 12 });
        expect(document.querySelector('.sb-reorder-status').textContent).toBe('Moved Intro to position 3 of 12');
    });
});
