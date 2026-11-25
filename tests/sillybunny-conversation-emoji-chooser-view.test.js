/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { createChooserView, SECTION_CHUNK } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-chooser-view.js');
const { buildSearchIndex } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-search.js');

const TONES = ['hell', 'mittelhell', 'mittel', 'mitteldunkel', 'dunkel'];
const WAVE_VARIANTS = ['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];

function makeTable(locale = 'de', overrides = {}) {
    const smileys = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉'].map((emoji, index) => [emoji, `gesicht ${index}`, `lachen|freude${index}`, 0, 1]);
    smileys[0] = ['😀', 'grinsendes Gesicht', 'lachen|grinsen', 0, 1];
    const people = [
        ['👋', 'winkende Hand', 'hallo|winken', 1, 0.6, WAVE_VARIANTS],
        ['👍', 'Daumen hoch', 'gut|ok', 1, 0.6, ['👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿']],
        ['🧑', 'Person', 'mensch', 1, 0.6],
        ['🤝', 'Händedruck', 'hand|einigung', 1, 3, ['🤝🏻', '🤝🏼', '🤝🏽', '🤝🏾', '🤝🏿']],
        ['🙏', 'zusammengelegte Hände', 'bitte|danke', 1, 0.6],
        ['🧔', 'Mann mit Bart', 'bart', 1, 5],
    ];
    const flags = [['🇯🇵', 'Flagge: Japan', 'japan', 2, 0.6], ['🇫🇷', 'Flagge: Frankreich', 'frankreich', 2, 0.6], ['🇩🇪', 'Flagge: Deutschland', 'deutschland', 2, 0.6], ['❤️', 'rotes Herz', 'liebe|herz', 2, 0.6]];
    const rows = [...smileys, ...people, ...flags];
    return { locale, groups: ['Smileys', 'Personen', 'Flaggen'], tones: TONES, rows, getIndex: (() => { let index = null; return () => (index ??= buildSearchIndex(rows)); })(), ...overrides };
}

let queue;
const schedule = (task) => {
    queue.push(task);
};
const flush = () => {
    while (queue.length) {
        queue.shift()();
    }
};
const flushPromises = async () => {
    for (let turn = 0; turn < 6; turn++) {
        await Promise.resolve();
    }
};

function makeView(options = {}) {
    const calls = { picked: [], closed: 0, recorded: [], order: [] };
    const view = createChooserView({
        kind: 'insert',
        recents: [],
        columns: () => 4,
        schedule,
        requestClose: () => {
            calls.closed += 1;
            calls.order.push('close');
        },
        recordRecent: (entry) => {
            calls.recorded.push(entry);
            calls.order.push('record');
        },
        onPick: (emoji, details) => {
            calls.picked.push([emoji, details]);
            calls.order.push('pick');
        },
        ...options,
    });
    document.body.append(view.element);
    view.setTable(options.table ?? makeTable());
    return { view, calls, root: view.element };
}

const key = (target, name, init = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
};
const cells = root => [...root.querySelectorAll('.sb-emoji-scroller .sb-emoji-cell')];
const cellOf = (root, emoji) => cells(root).find(cell => cell.dataset.emoji === emoji);
const stops = root => [...root.querySelectorAll('.sb-emoji-grid [tabindex="0"]')];
const search = root => root.querySelector('.sb-emoji-search-entry');
const type = (root, text) => {
    search(root).value = text;
    search(root).dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
    queue = [];
});

afterEach(() => {
    document.body.replaceChildren();
    jest.useRealTimers();
});

describe('what the chooser is made of', () => {
    test('is a search entry, a listbox of groups, and a toolbar of one button for each section', () => {
        const { root } = makeView();
        flush();
        expect(search(root).type).toBe('search');
        expect(search(root).getAttribute('aria-label')).toBe('Search Emoji');
        const listbox = root.querySelector('[role="listbox"]');
        expect(listbox.getAttribute('aria-label')).toBe('Emoji');
        const groups = [...listbox.querySelectorAll('[role="group"]')];
        expect(groups.map(group => document.getElementById(group.getAttribute('aria-labelledby')).textContent)).toEqual(['Smileys', 'Personen', 'Flaggen']);
        expect([...root.querySelectorAll('[role="toolbar"] button')].map(button => button.getAttribute('aria-label'))).toEqual(['Smileys', 'Personen', 'Flaggen']);
        expect(root.querySelector('[role="toolbar"]').getAttribute('aria-label')).toBe('Categories');
    });

    test('gives every cell the name of its emoji, and marks the ones that have skin tones', () => {
        const { root } = makeView();
        flush();
        expect(cellOf(root, '👍').getAttribute('aria-label')).toBe('Daumen hoch');
        expect(cellOf(root, '👍').getAttribute('role')).toBe('option');
        expect(cellOf(root, '👍').dataset.variants).toBe('5');
        expect(cellOf(root, '🧑').dataset.variants).toBeUndefined();
        expect(cells(root)).toHaveLength(20);
    });

    test('shows a Recent section first, and none while there are no recents', () => {
        const withRecents = makeView({ recents: [{ e: '🙏', n: 'bitte' }, { e: '👍🏽' }] });
        flush();
        const headings = [...withRecents.root.querySelectorAll('.sb-emoji-heading')].map(heading => heading.textContent);
        expect(headings).toEqual(['Recent', 'Smileys', 'Personen', 'Flaggen']);
        const recent = withRecents.root.querySelector('[data-section="recent"]');
        expect([...recent.querySelectorAll('.sb-emoji-cell')].map(cell => [cell.dataset.emoji, cell.getAttribute('aria-label')])).toEqual([['🙏', 'bitte'], ['👍🏽', 'Daumen hoch: mittel']]);
        expect(recent.querySelector('[data-variants]')).toBeNull();

        document.body.replaceChildren();
        const without = makeView();
        flush();
        expect(without.root.querySelector('[data-section="recent"]')).toBeNull();
    });

    test('has one tab stop in the grid, on the first cell', () => {
        const { root } = makeView();
        flush();
        expect(stops(root)).toHaveLength(1);
        expect(stops(root)[0]).toBe(cells(root)[0]);
        expect(root.querySelectorAll('.sb-emoji-categories [tabindex="0"]')).toHaveLength(1);
    });

    test('shows a message instead of the grid while there is no table', () => {
        const view = createChooserView({ kind: 'insert', recents: [], columns: () => 4, schedule, requestClose() {}, recordRecent() {}, onPick() {} });
        document.body.append(view.element);
        view.showLoading();
        expect(view.element.querySelector('[role="listbox"] .sb-emoji-cell')).toBeNull();
        expect(view.element.dataset.state).toBe('loading');
        view.setTable(makeTable());
        expect(view.element.dataset.state).toBe('ready');
    });
});

describe('building', () => {
    test('builds the first section at once, and the others one at a time, in pieces of at most one chunk', () => {
        const smileys = Array.from({ length: SECTION_CHUNK * 2 + 10 }, (_, index) => ['😀', `name ${index}`, '', 0, 1]);
        const table = makeTable('de', { rows: [...smileys, ['👍', 'Daumen', '', 1, 1], ['🇯🇵', 'Japan', '', 2, 1]] });
        table.getIndex = () => buildSearchIndex(table.rows);
        const { root } = makeView({ table });

        expect(cells(root)).toHaveLength(SECTION_CHUNK);
        const sizes = [];
        let before = cells(root).length;
        while (queue.length) {
            queue.shift()();
            sizes.push(cells(root).length - before);
            before = cells(root).length;
        }
        expect(Math.max(...sizes)).toBeLessThanOrEqual(SECTION_CHUNK);
        expect(cells(root)).toHaveLength(SECTION_CHUNK * 2 + 10 + 2);
    });

    test('reserves the height of a section that is not built yet, from its count and the columns', () => {
        const { root } = makeView();
        const flags = root.querySelector('[data-section="2"]');
        expect(flags.querySelector('.sb-emoji-grid').children).toHaveLength(0);
        expect(flags.dataset.built).toBe('false');
        expect(flags.style.getPropertyValue('--sb-emoji-rows')).toBe('1');
        flush();
        expect(flags.dataset.built).toBe('true');
    });

    test('builds a section that the user jumps to at once, before it moves the focus there', () => {
        const { root } = makeView();
        expect(root.querySelector('[data-section="2"]').dataset.built).toBe('false');
        root.querySelectorAll('[role="toolbar"] button')[2].click();
        expect(root.querySelector('[data-section="2"]').dataset.built).toBe('true');
    });
});

describe('picking', () => {
    test('a click records the pick, closes the chooser and then hands the emoji to the caller', () => {
        const { root, calls } = makeView();
        flush();
        cellOf(root, '😂').click();
        expect(calls.order).toEqual(['record', 'close', 'pick']);
        expect(calls.recorded).toEqual([{ e: '😂', n: 'gesicht 6' }]);
        expect(calls.picked).toEqual([['😂', { name: 'gesicht 6', keepOpen: false }]]);
    });

    test('a Shift click keeps the chooser open', () => {
        const { root, calls } = makeView();
        flush();
        cellOf(root, '😂').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        expect(calls.closed).toBe(0);
        expect(calls.picked).toEqual([['😂', { name: 'gesicht 6', keepOpen: true }]]);
    });

    test('Enter and Space on a cell pick it, and Shift keeps the chooser open', () => {
        const { root, calls } = makeView();
        flush();
        const cell = cellOf(root, '🧑');
        cell.focus();
        key(cell, 'Enter');
        expect(calls.picked.at(-1)).toEqual(['🧑', { name: 'Person', keepOpen: false }]);
        key(cell, ' ', { shiftKey: true });
        expect(calls.picked.at(-1)).toEqual(['🧑', { name: 'Person', keepOpen: true }]);
        expect(calls.closed).toBe(1);
    });

    test('for reactions, marks the emoji that the message has, and reads the marks again after a pick that keeps it open', () => {
        const have = new Set(['😂']);
        const { root, view } = makeView({ kind: 'react', isPicked: emoji => have.has(emoji) });
        flush();
        expect(cellOf(root, '😂').getAttribute('aria-selected')).toBe('true');
        expect(cellOf(root, '😀').getAttribute('aria-selected')).toBe('false');
        have.add('😀');
        have.delete('😂');
        view.refreshSelection();
        expect(cellOf(root, '😀').getAttribute('aria-selected')).toBe('true');
        expect(cellOf(root, '😂').getAttribute('aria-selected')).toBe('false');
    });

    test('for inserting, sets no selected state at all', () => {
        const { root } = makeView();
        flush();
        expect(root.querySelector('[aria-selected]')).toBeNull();
    });
});

describe('keys in the grid', () => {
    test('arrows move the one tab stop and the focus, and Home, End and the page keys follow the lines', () => {
        const { root } = makeView();
        flush();
        const first = cells(root)[0];
        first.focus();
        key(first, 'ArrowRight');
        expect(document.activeElement).toBe(cells(root)[1]);
        expect(stops(root)).toEqual([cells(root)[1]]);
        key(document.activeElement, 'ArrowDown');
        expect(document.activeElement).toBe(cells(root)[5]);
        key(document.activeElement, 'End');
        expect(document.activeElement).toBe(cells(root)[7]);
        key(document.activeElement, 'Home');
        expect(document.activeElement).toBe(cells(root)[4]);
        key(document.activeElement, 'Home', { ctrlKey: true });
        expect(document.activeElement).toBe(cells(root)[0]);
        key(document.activeElement, 'End', { ctrlKey: true });
        expect(document.activeElement).toBe(cells(root).at(-1));
        expect(stops(root)).toHaveLength(1);
    });

    test('Up from the first line goes to the search entry, and Down from the entry goes to the first cell', () => {
        const { root } = makeView();
        flush();
        const first = cells(root)[0];
        first.focus();
        key(first, 'ArrowUp');
        expect(document.activeElement).toBe(search(root));
        key(search(root), 'ArrowDown');
        expect(document.activeElement).toBe(first);
    });

    test('Alt+Down, Alt+Up, Ctrl+N and Ctrl+P jump between sections', () => {
        const { root } = makeView();
        flush();
        const first = cells(root)[0];
        first.focus();
        key(first, 'ArrowDown', { altKey: true });
        expect(document.activeElement).toBe(cellOf(root, '👋'));
        key(document.activeElement, 'n', { ctrlKey: true });
        expect(document.activeElement).toBe(cellOf(root, '🇯🇵'));
        key(document.activeElement, 'ArrowUp', { altKey: true });
        expect(document.activeElement).toBe(cellOf(root, '👋'));
        key(document.activeElement, 'p', { ctrlKey: true });
        expect(document.activeElement).toBe(first);
    });

    test('a key that moves the focus is stopped, so that the page behind does not scroll or act on it', () => {
        const { root } = makeView();
        flush();
        const first = cells(root)[0];
        first.focus();
        expect(key(first, 'ArrowRight').defaultPrevented).toBe(true);
        expect(key(first, 'a').defaultPrevented).toBe(false);
    });

    test('a move into a section that is not built builds it first', () => {
        const { root } = makeView();
        const smileys = cells(root);
        smileys[0].focus();
        key(smileys[0], 'ArrowDown', { altKey: true });
        key(document.activeElement, 'ArrowDown', { altKey: true });
        expect(document.activeElement).toBe(cellOf(root, '🇯🇵'));
    });
});

describe('Tab', () => {
    test('visits the search entry, the grid and the toolbar, one stop each, and wraps', () => {
        const { root } = makeView();
        flush();
        search(root).focus();
        const toolbarStop = root.querySelector('.sb-emoji-categories [tabindex="0"]');
        let event = key(search(root), 'Tab');
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(stops(root)[0]);
        key(document.activeElement, 'Tab');
        expect(document.activeElement).toBe(toolbarStop);
        key(document.activeElement, 'Tab');
        expect(document.activeElement).toBe(search(root));
        event = key(search(root), 'Tab', { shiftKey: true });
        expect(document.activeElement).toBe(toolbarStop);
        key(document.activeElement, 'Tab', { shiftKey: true });
        expect(document.activeElement).toBe(stops(root)[0]);
    });

    test('is not taken from the page when the chooser is the only thing that holds the focus outside', () => {
        const { root } = makeView();
        flush();
        const outside = document.createElement('button');
        document.body.append(outside);
        expect(key(outside, 'Tab').defaultPrevented).toBe(false);
        expect(root.contains(outside)).toBe(false);
    });
});

describe('the toolbar', () => {
    test('moves with the arrow keys and keeps one stop; Enter scrolls to the section and leaves the focus on the button', () => {
        const { root } = makeView();
        flush();
        const buttons = [...root.querySelectorAll('.sb-emoji-categories button')];
        buttons[0].focus();
        key(buttons[0], 'ArrowRight');
        expect(document.activeElement).toBe(buttons[1]);
        expect(root.querySelectorAll('.sb-emoji-categories [tabindex="0"]')).toEqual(expect.objectContaining({ length: 1 }));
        key(buttons[1], 'End');
        expect(document.activeElement).toBe(buttons[2]);
        key(buttons[2], 'Home');
        expect(document.activeElement).toBe(buttons[0]);
        key(buttons[0], 'ArrowLeft');
        expect(document.activeElement).toBe(buttons[2]);
    });

    test('marks the section that the grid shows', () => {
        const { root } = makeView();
        flush();
        const buttons = [...root.querySelectorAll('.sb-emoji-categories button')];
        buttons[1].click();
        expect(buttons.map(button => button.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    });
});

describe('search', () => {
    test('replaces the sections with the matches, best first, and puts them back when the entry is cleared', () => {
        const { root } = makeView();
        flush();
        type(root, 'hand');
        const results = root.querySelectorAll('[role="group"]');
        expect(results).toHaveLength(1);
        expect([...results[0].querySelectorAll('.sb-emoji-cell')].map(cell => cell.dataset.emoji)).toEqual(['🤝', '👋', '🙏']);
        expect(root.querySelector('[role="status"]').textContent).toBe('3 Results');
        type(root, '');
        expect(root.querySelectorAll('[role="group"]')).toHaveLength(3);
        expect(cells(root)).toHaveLength(20);
    });

    test('picks the first result on Enter, and moves into the results with the Down arrow', () => {
        const { root, calls } = makeView();
        flush();
        type(root, 'hand');
        key(search(root), 'ArrowDown');
        expect(document.activeElement).toBe(cellOf(root, '🤝'));
        search(root).focus();
        key(search(root), 'Enter');
        expect(calls.picked).toEqual([['🤝', { name: 'Händedruck', keepOpen: false }]]);
    });

    test('says so when nothing matches, and Enter then picks nothing', () => {
        const { root, calls } = makeView();
        flush();
        type(root, 'zzzz');
        expect(root.querySelector('[role="status"]').textContent).toBe('No Results');
        expect(root.querySelector('.sb-emoji-empty')).not.toBeNull();
        key(search(root), 'Enter');
        expect(calls.picked).toEqual([]);
    });

    test('looks in English when the language of the interface finds nothing, and says nothing about it', async () => {
        const english = makeTable('en', { rows: [['🧪', 'test tube', 'lab|chemistry', 0, 1]] });
        english.getIndex = () => buildSearchIndex(english.rows);
        const loadEnglish = jest.fn(async () => english);
        const { root } = makeView({ loadEnglish });
        flush();
        type(root, 'chemistry');
        await flushPromises();
        expect(loadEnglish).toHaveBeenCalledTimes(1);
        expect([...root.querySelectorAll('.sb-emoji-cell')].map(cell => cell.dataset.emoji)).toEqual(['🧪']);
        expect(root.querySelector('[role="status"]').textContent).toBe('1 Result');
    });

    test('does not ask for English when the interface is English, or when its own table has a match', async () => {
        const loadEnglish = jest.fn(async () => makeTable('en'));
        const { root } = makeView({ loadEnglish });
        flush();
        type(root, 'hand');
        await flushPromises();
        expect(loadEnglish).not.toHaveBeenCalled();

        document.body.replaceChildren();
        const english = makeView({ loadEnglish, table: makeTable('en') });
        flush();
        type(english.root, 'zzzz');
        await flushPromises();
        expect(loadEnglish).not.toHaveBeenCalled();
    });

    test('ignores an English answer that arrives after the query changed', async () => {
        let resolveEnglish;
        const loadEnglish = () => new Promise((resolve) => {
            resolveEnglish = resolve;
        });
        const { root } = makeView({ loadEnglish });
        flush();
        type(root, 'chemistry');
        type(root, 'hand');
        const english = makeTable('en', { rows: [['🧪', 'test tube', 'chemistry', 0, 1]] });
        english.getIndex = () => buildSearchIndex(english.rows);
        resolveEnglish(english);
        await flushPromises();
        expect([...root.querySelectorAll('.sb-emoji-cell')].map(cell => cell.dataset.emoji)).toEqual(['🤝', '👋', '🙏']);
    });

    test('caps the results', () => {
        const rows = Array.from({ length: 260 }, (_, index) => ['😀', `smile ${index}`, '', 0, 1]);
        const table = makeTable('de', { rows });
        table.getIndex = () => buildSearchIndex(rows);
        const { root } = makeView({ table });
        flush();
        type(root, 'smile');
        flush();
        expect(root.querySelectorAll('[role="group"] .sb-emoji-cell')).toHaveLength(200);
    });
});

describe('skin tones', () => {
    const openVariants = root => root.querySelector('.sb-emoji-variants');

    test('open on the secondary click of an emoji that has them, as a listbox of the plain emoji and its tones', () => {
        const { root } = makeView();
        flush();
        const wave = cellOf(root, '👋');
        wave.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const panel = openVariants(root);
        expect(panel.getAttribute('role')).toBe('listbox');
        expect(panel.getAttribute('aria-label')).toBe('winkende Hand');
        const options = [...panel.querySelectorAll('[role="option"]')];
        expect(options.map(option => option.dataset.emoji)).toEqual(['👋', ...WAVE_VARIANTS]);
        expect(options.map(option => option.getAttribute('aria-label'))).toEqual(['winkende Hand', ...TONES.map(tone => `winkende Hand: ${tone}`)]);
        expect(document.activeElement).toBe(options[0]);
    });

    test('open on Shift+F10 and the Menu key, and not for an emoji that has none', () => {
        const { root } = makeView();
        flush();
        const thumbs = cellOf(root, '👍');
        thumbs.focus();
        expect(key(thumbs, 'F10', { shiftKey: true }).defaultPrevented).toBe(true);
        expect(openVariants(root)).not.toBeNull();
        key(document.activeElement, 'Escape');
        expect(openVariants(root)).toBeNull();

        const person = cellOf(root, '🧑');
        person.focus();
        key(person, 'ContextMenu');
        expect(openVariants(root)).toBeNull();
        thumbs.focus();
        key(thumbs, 'ContextMenu');
        expect(openVariants(root)).not.toBeNull();
    });

    test('pick the exact string and name it by the base name and the tone', () => {
        const { root, calls } = makeView();
        flush();
        cellOf(root, '👋').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const option = [...openVariants(root).querySelectorAll('[role="option"]')].find(item => item.dataset.emoji === '👋🏽');
        option.click();
        expect(calls.recorded).toEqual([{ e: '👋🏽', n: 'winkende Hand: mittel' }]);
        expect(calls.picked).toEqual([['👋🏽', { name: 'winkende Hand: mittel', keepOpen: false }]]);
    });

    test('are walked with the arrow keys, and Escape closes them first and gives the focus back to the emoji', () => {
        const { root, calls } = makeView();
        flush();
        const wave = cellOf(root, '👋');
        wave.focus();
        key(wave, 'ContextMenu');
        const options = [...openVariants(root).querySelectorAll('[role="option"]')];
        key(options[0], 'ArrowRight');
        expect(document.activeElement).toBe(options[1]);
        key(options[1], 'ArrowLeft');
        expect(document.activeElement).toBe(options[0]);
        const escape = key(options[0], 'Escape');
        expect(escape.defaultPrevented).toBe(true);
        expect(openVariants(root)).toBeNull();
        expect(document.activeElement).toBe(wave);
        expect(calls.closed).toBe(0);
    });

    test('open on a long press by touch, and the click that ends it does not pick the plain emoji', () => {
        jest.useFakeTimers();
        const { root, calls } = makeView();
        flush();
        const wave = cellOf(root, '👋');
        const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 });
        Object.defineProperty(down, 'pointerType', { value: 'touch' });
        wave.dispatchEvent(down);
        jest.advanceTimersByTime(400);
        expect(openVariants(root)).not.toBeNull();
        wave.click();
        expect(calls.picked).toEqual([]);
    });

    test('do not open when the finger moves before the long press, or lifts early', () => {
        jest.useFakeTimers();
        const { root } = makeView();
        flush();
        const wave = cellOf(root, '👋');
        const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 });
        Object.defineProperty(down, 'pointerType', { value: 'touch' });
        wave.dispatchEvent(down);
        const move = new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 10 });
        Object.defineProperty(move, 'pointerType', { value: 'touch' });
        wave.dispatchEvent(move);
        jest.advanceTimersByTime(400);
        expect(openVariants(root)).toBeNull();

        const again = new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 });
        Object.defineProperty(again, 'pointerType', { value: 'touch' });
        wave.dispatchEvent(again);
        wave.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        jest.advanceTimersByTime(400);
        expect(openVariants(root)).toBeNull();
    });

    test('lay out two people with two tones as a grid of five columns', () => {
        const pair = Array.from({ length: 25 }, (_, index) => `🤝${index}`);
        const table = makeTable('de', { rows: [['🤝', 'Händedruck', '', 0, 1, pair]] });
        table.getIndex = () => buildSearchIndex(table.rows);
        const { root } = makeView({ table });
        flush();
        cellOf(root, '🤝').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        expect(openVariants(root).dataset.count).toBe('25');
    });
});

describe('where the focus starts', () => {
    test('is the search entry with a mouse, and the first cell with touch', () => {
        const mouse = makeView();
        flush();
        mouse.view.focusInitial();
        expect(document.activeElement).toBe(search(mouse.root));

        document.body.replaceChildren();
        const touch = makeView({ touch: true });
        flush();
        touch.view.focusInitial();
        expect(document.activeElement).toBe(cells(touch.root)[0]);
    });
});
