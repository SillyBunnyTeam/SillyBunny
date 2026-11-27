/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const { bindListFocus } = await import('../../public/scripts/sillybunny-editor/list-focus.js');

let handle;

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    handle?.destroy();
    handle = null;
});

/** Rows with two controls each, as an entity row has; jsdom has no layout, so rows count as shown unless hidden. */
function buildList(count, { selected = -1 } = {}) {
    const container = document.createElement('div');
    for (let index = 0; index < count; index++) {
        const row = document.createElement('div');
        row.className = 'row';
        row.tabIndex = 0;
        row.dataset.sbListKey = `row:${index}`;
        if (index === selected) row.setAttribute('aria-current', 'true');
        for (const name of ['edit', 'menu']) {
            const control = document.createElement('button');
            control.className = name;
            row.append(control);
        }
        container.append(row);
    }
    document.body.append(container);
    return { container, rows: [...container.querySelectorAll('.row')] };
}

const press = (target, key, init = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};
const tabbable = container => [...container.querySelectorAll('.row, button')].filter(element => element.tabIndex >= 0);

describe('bindListFocus', () => {
    test('leaves one Tab stop: the first row, with every control of the other rows out of the Tab order', () => {
        const { container, rows } = buildList(4);
        handle = bindListFocus(container, { rowSelector: '.row' });

        expect(tabbable(container)).toEqual([rows[0], ...rows[0].querySelectorAll('button')]);
    });

    test('the selected row holds the stop until focus has been in the list', () => {
        const { container, rows } = buildList(4, { selected: 2 });
        handle = bindListFocus(container, { rowSelector: '.row' });

        expect(rows[2].tabIndex).toBe(0);
        expect(rows[0].tabIndex).toBe(-1);
        rows[1].focus();
        expect(rows[1].tabIndex).toBe(0);
        expect(rows[2].tabIndex).toBe(-1);
        expect(tabbable(container)).toEqual([rows[1], ...rows[1].querySelectorAll('button')]);
    });

    test('a control gets its own tabindex back when its row becomes the stop', () => {
        const { container, rows } = buildList(2);
        rows[1].querySelector('.edit').setAttribute('tabindex', '0');
        handle = bindListFocus(container, { rowSelector: '.row' });
        expect(rows[1].querySelector('.edit').getAttribute('tabindex')).toBe('-1');

        rows[1].focus();

        expect(rows[1].querySelector('.edit').getAttribute('tabindex')).toBe('0');
        expect(rows[1].querySelector('.menu').hasAttribute('tabindex')).toBe(false);
    });

    test('destroy gives every control its own tabindex back, so a list that outlives the binding keeps its Tab order', () => {
        const { container, rows } = buildList(3);
        rows[2].querySelector('.edit').setAttribute('tabindex', '0');
        handle = bindListFocus(container, { rowSelector: '.row' });
        expect(rows[2].querySelector('.edit').getAttribute('tabindex')).toBe('-1');
        expect(rows[1].querySelector('.menu').getAttribute('tabindex')).toBe('-1');

        handle.destroy();
        handle = null;

        expect(rows[2].querySelector('.edit').getAttribute('tabindex')).toBe('0');
        expect(rows[1].querySelector('.menu').hasAttribute('tabindex')).toBe(false);
        expect(rows[1].querySelector('.edit').hasAttribute('tabindex')).toBe(false);
    });

    test('arrow keys, Home and End move focus between rows, and Alt with an arrow is left alone', () => {
        const { container, rows } = buildList(5);
        handle = bindListFocus(container, { rowSelector: '.row' });
        rows[0].focus();

        expect(press(rows[0], 'ArrowDown').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(rows[1]);
        press(rows[1], 'End');
        expect(document.activeElement).toBe(rows[4]);
        press(rows[4], 'ArrowUp');
        expect(document.activeElement).toBe(rows[3]);
        press(rows[3], 'Home');
        expect(document.activeElement).toBe(rows[0]);
        expect(press(rows[0], 'ArrowDown', { altKey: true }).defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(rows[0]);
    });

    test('arrow keys pressed on a control of a row do not leave the row', () => {
        const { container, rows } = buildList(3);
        handle = bindListFocus(container, { rowSelector: '.row' });
        const control = rows[0].querySelector('.edit');
        control.focus();

        expect(press(control, 'ArrowDown').defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(control);
    });

    test('hidden and aria-disabled rows are skipped, and a stop on a hidden row moves to the first row shown', async () => {
        const { container, rows } = buildList(5);
        handle = bindListFocus(container, { rowSelector: '.row' });
        rows[1].hidden = true;
        rows[2].setAttribute('aria-disabled', 'true');
        rows[0].focus();

        press(rows[0], 'ArrowDown');
        expect(document.activeElement).toBe(rows[3]);

        rows[3].hidden = true;
        rows[0].hidden = true;
        await Promise.resolve();
        expect(rows[4].tabIndex).toBe(0);
        expect(tabbable(container).filter(element => element.matches('.row'))).toEqual([rows[4]]);
    });

    test('a row added later joins the list with its controls out of the Tab order', async () => {
        const { container, rows } = buildList(2);
        handle = bindListFocus(container, { rowSelector: '.row' });
        const added = rows[1].cloneNode(true);
        container.append(added);
        await Promise.resolve();

        expect(added.tabIndex).toBe(-1);
        expect([...added.querySelectorAll('button')].map(button => button.tabIndex)).toEqual([-1, -1]);
    });

    test('Down from the last row reaches a trailing stop, Up returns, and a keyboard press moves focus to the first new row', async () => {
        const { container, rows } = buildList(3);
        const more = document.createElement('button');
        more.textContent = 'Show More';
        document.body.append(more);
        more.addEventListener('click', () => {
            const added = rows[0].cloneNode(true);
            added.dataset.sbListKey = 'row:new';
            container.append(added);
        });
        handle = bindListFocus(container, { rowSelector: '.row', trailingStops: () => [more] });
        rows[2].focus();

        press(rows[2], 'ArrowDown');
        expect(document.activeElement).toBe(more);
        press(more, 'ArrowUp');
        expect(document.activeElement).toBe(rows[2]);

        more.focus();
        more.click();
        await Promise.resolve();
        expect(document.activeElement).toBe(container.lastElementChild);
        expect(container.lastElementChild.tabIndex).toBe(0);
    });

    test('a row that holds only controls is entered at its first control', () => {
        const container = document.createElement('div');
        for (let index = 0; index < 3; index++) {
            const row = document.createElement('div');
            row.className = 'row';
            row.append(document.createElement('button'));
            container.append(row);
        }
        document.body.append(container);
        handle = bindListFocus(container, { rowSelector: '.row' });
        const buttons = [...container.querySelectorAll('button')];

        expect(buttons.map(button => button.tabIndex)).toEqual([0, -1, -1]);
        buttons[0].focus();
        press(buttons[0], 'ArrowDown');
        expect(document.activeElement).toBe(buttons[1]);
        expect(buttons.map(button => button.tabIndex)).toEqual([-1, 0, -1]);
    });

    test('singleTabStop false keeps the Tab order and the arrow keys', () => {
        const { container, rows } = buildList(3);
        handle = bindListFocus(container, { rowSelector: '.row', singleTabStop: false });

        expect(rows.map(row => row.tabIndex)).toEqual([0, 0, 0]);
        rows[0].focus();
        press(rows[0], 'ArrowDown');
        expect(document.activeElement).toBe(rows[1]);
    });
});
