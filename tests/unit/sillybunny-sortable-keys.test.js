/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { readFileSync } from 'node:fs';
import { jest, describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const readLibrary = name => readFileSync(new URL(`../../public/lib/${name}`, import.meta.url), 'utf8');
const { attachSortableKeys, adoptUpstreamSortables, UPSTREAM_SORTABLES } = await import('../../public/scripts/sillybunny-editor/reorder-menu.js');

let $;

beforeAll(() => {
    // The app's own jQuery and jQuery UI: the helper reads the real widget's options and calls its real handlers.
    new Function(readLibrary('jquery-3.5.1.min.js')).call(window);
    new Function(readLibrary('jquery-ui.min.js')).call(window);
    $ = window.jQuery;
});

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    document.body.replaceChildren();
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** A list of rows named by their text. */
function makeList({ names = ['A', 'B', 'C', 'D'], options = {}, rowHtml = name => `<div data-id="${name}"><span>${name}</span></div>`, attach = {} } = {}) {
    const list = document.createElement('div');
    list.innerHTML = names.map(rowHtml).join('');
    document.body.append(list);
    const stop = options.stop ?? jest.fn();
    $(list).sortable({ ...options, stop });
    const keys = attachSortableKeys(list, { name: row => row.textContent, ...attach });
    return { list, stop, keys };
}

const order = list => [...list.children].map(row => row.dataset.id ?? row.textContent);
const press = (target, key, init = {}) => {
    const event = new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};
const region = () => document.querySelector('.sb-reorder-status');

describe('attachSortableKeys: focus targets', () => {
    test('makes each row focusable with a name that says it can be moved', () => {
        const { list } = makeList();
        const first = list.children[0];
        expect(first.getAttribute('tabindex')).toBe('0');
        expect(first.getAttribute('role')).toBe('group');
        expect(first.getAttribute('aria-label')).toBe('Drag to Reorder A');
        expect(first.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End');
    });

    test('makes the handle focusable, and only the handle, when the sortable has one', () => {
        const { list } = makeList({
            options: { handle: '.grip' },
            rowHtml: name => `<div data-id="${name}"><span class="grip">☰</span><input value="${name}"></div>`,
            attach: { name: row => row.querySelector('input').value },
        });
        const row = list.children[1];
        const grip = row.querySelector('.grip');
        // The list has one tab stop, on its first handle; the arrow keys move it.
        expect(grip.getAttribute('tabindex')).toBe('-1');
        expect(list.children[0].querySelector('.grip').getAttribute('tabindex')).toBe('0');
        expect(grip.getAttribute('role')).toBe('button');
        expect(grip.getAttribute('aria-label')).toBe('Drag to Reorder B');
        expect(row.hasAttribute('tabindex')).toBe(false);
    });

    test('keeps a tabindex, role or label that the row already has', () => {
        const { list } = makeList({ rowHtml: name => `<div data-id="${name}" tabindex="-1" role="listitem" aria-label="Mine ${name}">${name}</div>` });
        const first = list.children[0];
        expect([first.getAttribute('tabindex'), first.getAttribute('role'), first.getAttribute('aria-label')]).toEqual(['-1', 'listitem', 'Mine A']);
    });

    test('falls back to the row text, then to a generic name', () => {
        const { list } = makeList({ names: ['Alpha', ''], attach: { name: null } });
        expect(list.children[0].getAttribute('aria-label')).toBe('Drag to Reorder Alpha');
        expect(list.children[1].getAttribute('aria-label')).toBe('Drag to Reorder Entry');
    });

    test('is attached once per list', () => {
        const { list, keys } = makeList();
        expect(attachSortableKeys(list)).toBe(keys);
    });

    test('does nothing to a list that has no sortable', () => {
        const list = document.createElement('div');
        list.innerHTML = '<div>A</div><div>B</div>';
        document.body.append(list);
        attachSortableKeys(list);
        expect(list.children[0].hasAttribute('tabindex')).toBe(false);
        expect(press(list.children[0], 'ArrowDown').defaultPrevented).toBe(false);
        expect(order(list)).toEqual(['A', 'B']);
    });

    test('detach removes what the helper added and the key handling', () => {
        const { list, keys, stop } = makeList();
        const first = list.children[0];
        keys.detach();
        expect(['tabindex', 'role', 'aria-label', 'aria-keyshortcuts'].some(name => first.hasAttribute(name))).toBe(false);
        press(first, 'ArrowDown');
        expect(order(list)).toEqual(['A', 'B', 'C', 'D']);
        expect(stop).not.toHaveBeenCalled();
    });
});

describe('attachSortableKeys: moves', () => {
    test('Alt+ArrowDown and Alt+ArrowUp move the focused row one place and keep focus on it', () => {
        const { list } = makeList();
        const row = list.children[1];
        row.focus();
        expect(press(row, 'ArrowDown').defaultPrevented).toBe(true);
        expect(order(list)).toEqual(['A', 'C', 'B', 'D']);
        expect(document.activeElement).toBe(row);
        press(row, 'ArrowUp');
        press(row, 'ArrowUp');
        expect(order(list)).toEqual(['B', 'A', 'C', 'D']);
        expect(document.activeElement).toBe(row);
    });

    test('Alt+Home and Alt+End move the row to the ends', () => {
        const { list } = makeList();
        const row = list.children[1];
        row.focus();
        press(row, 'End');
        expect(order(list)).toEqual(['A', 'C', 'D', 'B']);
        press(row, 'Home');
        expect(order(list)).toEqual(['B', 'A', 'C', 'D']);
    });

    test('leaves the order alone at a boundary and does not run the handler', () => {
        const { list, stop } = makeList();
        const first = list.children[0];
        const last = list.children[3];
        expect(press(first, 'ArrowUp').defaultPrevented).toBe(true);
        expect(press(last, 'ArrowDown').defaultPrevented).toBe(true);
        expect(order(list)).toEqual(['A', 'B', 'C', 'D']);
        expect(stop).not.toHaveBeenCalled();
    });

    test('ignores keys with a modifier other than Alt, and keys from inside a row control', () => {
        const { list, stop } = makeList({ rowHtml: name => `<div data-id="${name}">${name}<input></div>` });
        const row = list.children[1];
        expect(press(row, 'ArrowDown', { altKey: false, shiftKey: true }).defaultPrevented).toBe(false);
        expect(press(row, 'ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
        expect(press(row, 'ArrowDown', { metaKey: true }).defaultPrevented).toBe(false);
        expect(press(row.querySelector('input'), 'ArrowDown').defaultPrevented).toBe(false);
        expect(order(list)).toEqual(['A', 'B', 'C', 'D']);
        expect(stop).not.toHaveBeenCalled();
    });

    test('a handle moves its row', () => {
        const { list } = makeList({
            options: { handle: '.grip' },
            rowHtml: name => `<div data-id="${name}"><span class="grip">☰</span>${name}</div>`,
        });
        const grip = list.children[0].querySelector('.grip');
        grip.focus();
        press(grip, 'ArrowDown');
        expect(order(list)).toEqual(['B', 'A', 'C', 'D']);
        expect(document.activeElement).toBe(grip);
    });
});

describe('attachSortableKeys: the list handlers', () => {
    test('runs the stop option with the moved row as ui.item, after the DOM has moved', () => {
        let seen;
        const stop = jest.fn(function (event, ui) {
            seen = { order: order(this), item: ui.item[0].dataset.id, type: event.type, self: this };
        });
        const { list } = makeList({ options: { stop } });
        press(list.children[2], 'ArrowUp');
        expect(stop).toHaveBeenCalledTimes(1);
        expect(seen).toEqual({ order: ['A', 'C', 'B', 'D'], item: 'C', type: 'sortstop', self: list });
        expect(seen.self).toBe(list);
    });

    test('also runs an update option first, as a drag does', () => {
        const calls = [];
        const { list } = makeList({ options: { update: () => calls.push('update'), stop: () => calls.push('stop') } });
        press(list.children[0], 'ArrowDown');
        expect(calls).toEqual(['update', 'stop']);
    });

    test('reads the handler at the time of the key press', () => {
        const first = jest.fn();
        const second = jest.fn();
        const { list } = makeList({ options: { stop: first } });
        $(list).sortable('option', 'stop', second);
        press(list.children[0], 'ArrowDown');
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('follows a sortable that is destroyed and created again on the same element', async () => {
        const { list } = makeList();
        const second = jest.fn();
        $(list).sortable('destroy');
        await flush();
        expect(list.children[0].hasAttribute('tabindex')).toBe(false);
        expect(press(list.children[0], 'ArrowDown').defaultPrevented).toBe(false);
        $(list).sortable({ stop: second });
        await flush();
        expect(list.children[0].getAttribute('tabindex')).toBe('0');
        press(list.children[0], 'ArrowDown');
        expect(second).toHaveBeenCalledTimes(1);
        expect(order(list)).toEqual(['B', 'A', 'C', 'D']);
    });

    test('a list that saves the inverted DOM order (logit bias) gets the same saved order as from a drag', () => {
        const entries = ['A', 'B', 'C'].map(id => ({ id }));
        const list = document.createElement('div');
        document.body.append(list);
        // The list prepends each entry, so the first entry sits at the bottom.
        for (const entry of entries) {
            const row = document.createElement('div');
            $(row).data('id', entry.id);
            row.textContent = entry.id;
            list.prepend(row);
        }
        $(list).sortable({
            stop() {
                const saved = [];
                $(list).children().each(function () {
                    saved.unshift($(this).data('id'));
                });
                entries.sort((a, b) => saved.indexOf(a.id) - saved.indexOf(b.id));
            },
        });
        attachSortableKeys(list, { name: row => row.textContent, key: row => $(row).data('id') });
        expect([...list.children].map(row => row.textContent)).toEqual(['C', 'B', 'A']);

        // Alt+ArrowUp on A moves it up on screen, from the bottom to the middle.
        press(list.children[2], 'ArrowUp');
        expect([...list.children].map(row => row.textContent)).toEqual(['C', 'A', 'B']);
        expect(entries.map(entry => entry.id)).toEqual(['B', 'A', 'C']);
        expect(region().textContent).toBe('Moved A to position 2 of 3');
    });

    test('waits for an asynchronous handler, then finds the row again when the handler rebuilt the list', async () => {
        let release;
        const stop = jest.fn(() => new Promise(resolve => {
            release = () => {
                const rebuilt = [...list.children].map(row => {
                    const copy = row.cloneNode(true);
                    copy.removeAttribute('tabindex');
                    return copy;
                });
                list.replaceChildren(...rebuilt);
                resolve();
            };
        }));
        const { list } = makeList({ options: { stop } });
        const row = list.children[1];
        row.focus();
        press(row, 'ArrowDown');
        expect(region()).toBeNull();
        release();
        await flush();
        expect(row.isConnected).toBe(false);
        expect(order(list)).toEqual(['A', 'C', 'B', 'D']);
        expect(document.activeElement).toBe(list.children[2]);
        expect(document.activeElement.dataset.id).toBe('B');
        expect(region().textContent).toBe('Moved B to position 3 of 4');
    });

    test('still announces and rethrows when the handler throws', () => {
        const { list } = makeList({ options: { stop: () => { throw new Error('save failed'); } } });
        const errors = [];
        const onError = event => {
            event.preventDefault();
            errors.push(event.error.message);
        };
        window.addEventListener('error', onError);
        try {
            press(list.children[0], 'ArrowDown');
        } finally {
            window.removeEventListener('error', onError);
        }
        expect(errors).toEqual(['save failed']);
        expect(region().textContent).toBe('Moved A to position 2 of 4');
    });
});

describe('attachSortableKeys: disabled and excluded rows', () => {
    test('does nothing while the sortable is disabled, and takes the rows out of the tab order', async () => {
        const { list, stop } = makeList();
        $(list).sortable('disable');
        await flush();
        expect(list.children[0].hasAttribute('tabindex')).toBe(false);
        expect(press(list.children[0], 'ArrowDown').defaultPrevented).toBe(false);
        expect(order(list)).toEqual(['A', 'B', 'C', 'D']);
        expect(stop).not.toHaveBeenCalled();
        $(list).sortable('enable');
        await flush();
        expect(list.children[0].getAttribute('tabindex')).toBe('0');
        press(list.children[0], 'ArrowDown');
        expect(order(list)).toEqual(['B', 'A', 'C', 'D']);
    });

    test('does nothing when the list is disabled by an option at creation', () => {
        const { list, stop } = makeList({ options: { disabled: true } });
        expect(list.children[0].hasAttribute('tabindex')).toBe(false);
        press(list.children[0], 'ArrowDown');
        expect(stop).not.toHaveBeenCalled();
    });

    test('skips rows that the items option excludes', () => {
        const { list } = makeList({
            options: { items: '> .row' },
            rowHtml: name => (name === 'B' ? `<div data-id="${name}">${name}</div>` : `<div class="row" data-id="${name}">${name}</div>`),
        });
        const [a, b, c] = list.children;
        expect(b.hasAttribute('tabindex')).toBe(false);
        press(a, 'ArrowDown');
        expect(order(list)).toEqual(['B', 'C', 'A', 'D']);
        expect(press(b, 'ArrowDown').defaultPrevented).toBe(false);
        press(c, 'Home');
        expect(order(list)).toEqual(['B', 'C', 'A', 'D']);
    });

    test('skips a focus target that the cancel option excludes', () => {
        const { list } = makeList({
            options: { cancel: '.locked' },
            rowHtml: name => `<div data-id="${name}" class="${name === 'C' ? 'locked' : ''}">${name}</div>`,
        });
        expect(list.children[2].hasAttribute('tabindex')).toBe(false);
        expect(list.children[0].getAttribute('tabindex')).toBe('0');
        expect(list.children[1].getAttribute('tabindex')).toBe('-1');
        press(list.children[1], 'ArrowDown');
        expect(order(list)).toEqual(['A', 'C', 'D', 'B']);
    });

    test('skips a row that the adopter marks as not movable, and keeps it out of the position count', () => {
        const names = ['A', 'B', 'C', 'D'];
        const { list, stop } = makeList({
            names,
            rowHtml: name => `<div data-id="${name}" class="${name === 'D' ? 'disabled' : ''}">${name}</div>`,
            attach: { name: row => row.textContent, movable: row => !row.classList.contains('disabled') },
        });
        const [, , c, d] = list.children;
        expect(d.hasAttribute('tabindex')).toBe(false);
        press(c, 'ArrowDown');
        expect(order(list)).toEqual(['A', 'B', 'C', 'D']);
        expect(stop).not.toHaveBeenCalled();
        press(list.children[0], 'End');
        expect(order(list)).toEqual(['B', 'C', 'A', 'D']);
        expect(region().textContent).toBe('Moved A to position 3 of 3');
    });

    test('follows a row that is switched off later', async () => {
        const { list } = makeList({ attach: { name: row => row.textContent, movable: row => !row.classList.contains('disabled') } });
        const row = list.children[0];
        expect(row.getAttribute('tabindex')).toBe('0');
        row.classList.add('disabled');
        await flush();
        expect(row.hasAttribute('tabindex')).toBe(false);
        row.classList.remove('disabled');
        await flush();
        expect(row.getAttribute('tabindex')).toBe('0');
    });

    test('skips hidden rows', () => {
        const { list } = makeList({ rowHtml: name => `<div data-id="${name}" ${name === 'B' ? 'hidden' : ''}>${name}</div>` });
        expect(list.children[1].hasAttribute('tabindex')).toBe(false);
        press(list.children[0], 'ArrowDown');
        expect(order(list)).toEqual(['B', 'C', 'A', 'D']);
    });
});

describe('attachSortableKeys: one tab stop per list', () => {
    const stops = list => [...list.children].filter(row => row.getAttribute('tabindex') === '0');

    test('only one row of the list is in the tab order, and the others can be focused by script', () => {
        const { list } = makeList({ names: ['A', 'B', 'C', 'D', 'E'] });
        expect(stops(list)).toEqual([list.children[0]]);
        expect([...list.children].slice(1).map(row => row.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '-1']);
    });

    test('the arrow keys move the focus and the tab stop, and Home and End go to the ends', () => {
        const { list } = makeList({ names: ['A', 'B', 'C', 'D'] });
        const [a, b, c, d] = list.children;
        a.focus();
        expect(press(a, 'ArrowDown', { altKey: false }).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(b);
        expect(stops(list)).toEqual([b]);
        press(b, 'End', { altKey: false });
        expect(document.activeElement).toBe(d);
        press(d, 'ArrowUp', { altKey: false });
        expect(document.activeElement).toBe(c);
        press(c, 'Home', { altKey: false });
        expect(document.activeElement).toBe(a);
        expect(order(list)).toEqual(['A', 'B', 'C', 'D']);
    });

    test('an arrow key at the end of the list stays where it is and is left to the page', () => {
        const { list } = makeList({ names: ['A', 'B'] });
        const [a, b] = list.children;
        b.focus();
        expect(press(b, 'ArrowDown', { altKey: false }).defaultPrevented).toBe(false);
        expect(press(a, 'ArrowUp', { altKey: false }).defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(b);
    });

    test('a row that brings its own tabindex keeps it', () => {
        const { list } = makeList({ rowHtml: name => `<div data-id="${name}" tabindex="0">${name}</div>` });
        expect([...list.children].map(row => row.getAttribute('tabindex'))).toEqual(['0', '0', '0', '0']);
        press(list.children[1], 'ArrowDown', { altKey: false });
        expect(document.activeElement).not.toBe(list.children[2]);
    });
});

describe('attachSortableKeys: rows that arrive later', () => {
    test('makes a row that the list adds or builds again focusable', async () => {
        const { list } = makeList();
        const added = document.createElement('div');
        added.dataset.id = 'E';
        added.textContent = 'E';
        list.append(added);
        await flush();
        expect(added.getAttribute('tabindex')).toBe('-1');
        press(added, 'ArrowUp');
        expect(order(list)).toEqual(['A', 'B', 'C', 'E', 'D']);

        list.replaceChildren(...['X', 'Y'].map(name => Object.assign(document.createElement('div'), { textContent: name })));
        await flush();
        expect([...list.children].map(row => row.getAttribute('aria-label'))).toEqual(['Drag to Reorder X', 'Drag to Reorder Y']);
    });

    test('shows the current name when a row is focused', () => {
        const { list } = makeList({
            rowHtml: name => `<div data-id="${name}"><input value="${name}"></div>`,
            attach: { name: row => row.querySelector('input').value },
        });
        const row = list.children[0];
        row.querySelector('input').value = 'Renamed';
        row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(row.getAttribute('aria-label')).toBe('Drag to Reorder Renamed');
    });
});

describe('attachSortableKeys: announcement', () => {
    test('announces the new position among the movable rows in the shared polite region', () => {
        const { list } = makeList();
        press(list.children[0], 'ArrowDown');
        const status = region();
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.textContent).toBe('Moved A to position 2 of 4');
        press(list.children[1], 'End');
        expect(status.textContent).toBe('Moved A to position 4 of 4');
    });
});

describe('adoptUpstreamSortables', () => {
    test('attaches the helper to a listed list when its sortable is created, once, and not to others', async () => {
        expect(adoptUpstreamSortables()).toBe(true);
        expect(adoptUpstreamSortables()).toBe(false);

        const listed = document.createElement('div');
        listed.id = 'koboldcpp_order';
        listed.innerHTML = '<div data-id="0"><span>Top K</span></div><div data-id="1"><span>Top P</span></div>';
        const other = document.createElement('div');
        other.innerHTML = '<div>A</div><div>B</div>';
        document.body.append(listed, other);
        const stop = jest.fn();
        $(listed).sortable({ stop });
        $(other).sortable({ stop });

        expect(listed.children[0].getAttribute('aria-label')).toBe('Drag to Reorder Top K');
        expect(other.children[0].hasAttribute('tabindex')).toBe(false);
        press(listed.children[0], 'ArrowDown');
        expect(listed.children[1].dataset.id).toBe('0');
        expect(stop).toHaveBeenCalledTimes(1);

        $(listed).sortable('destroy');
        $(listed).sortable({ stop });
        await flush();
        // The row that was moved took the focus, so it is the list's tab stop again.
        expect(listed.children[1].getAttribute('tabindex')).toBe('0');
        expect(listed.children[0].getAttribute('tabindex')).toBe('-1');
    });

    test('lists every upstream sortable of the app once', () => {
        const selectors = UPSTREAM_SORTABLES.flatMap(entry => entry.selector.split(',').map(selector => selector.trim()));
        expect(selectors).toEqual(expect.arrayContaining([
            '#saved_regex_scripts', '#saved_scoped_scripts', '#saved_preset_scripts',
            '.qr--set-qrListContents', '.qr--setList', '#qr--ctxEditor',
            '.logit_bias_list', '.openai_logit_bias_list',
            '#kobold_order', '#koboldcpp_order', '#llamacpp_samplers_sortable', '#sampler_priority_container', '#sampler_priority_container_aphrodite', '#novel_order',
        ]));
        expect(new Set(selectors).size).toBe(selectors.length);
    });

    test('the NovelAI list leaves a switched-off sampler where it is', () => {
        const entry = UPSTREAM_SORTABLES.find(({ selector }) => selector === '#novel_order');
        const row = document.createElement('div');
        expect(entry.options.movable(row)).toBe(true);
        row.classList.add('disabled');
        expect(entry.options.movable(row)).toBe(false);
    });
});
