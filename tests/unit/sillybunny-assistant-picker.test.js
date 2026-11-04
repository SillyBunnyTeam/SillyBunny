/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a DOM helper. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HOME_COPY } from '../helpers/copy-home.js';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
jest.unstable_mockModule('../../public/scripts/sillybunny-window-styles.js', () => ({ ensureWindowStyles: jest.fn(async () => {}) }));
const openDialog = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog }));
const { openAssistantPickerWindow } = await import('../../public/scripts/sillybunny-home/assistant-picker.js');

const ENTRIES = [
    { avatar: 'alice.png', name: 'Alice', selected: false },
    { avatar: 'bob.png', name: 'Bob', selected: true },
    { avatar: 'carol.png', name: 'Carol', selected: false },
];

/** A frame that records how it was opened and lets a test close it the way a user does. */
function installFrame() {
    const frame = { options: null, body: document.createElement('div'), report: jest.fn() };
    frame.closed = new Promise((resolve) => {
        frame.close = jest.fn(async (response) => {
            resolve({ response });
            return true;
        });
    });
    frame.search = { report: frame.report };
    openDialog.mockImplementation((options) => {
        frame.options = options;
        options.content(frame.body);
        return frame;
    });
    return frame;
}

const rowsOf = frame => [...frame.body.querySelectorAll('.ds-row')];
const rowOf = (frame, name) => rowsOf(frame).find(row => row.querySelector('.ds-row-label').textContent === name);

const opened = [];

async function open(overrides = {}) {
    const frame = installFrame();
    const choose = jest.fn();
    const handle = await openAssistantPickerWindow({ getEntries: () => ENTRIES, getThumbnailUrl: avatar => `/thumb/${avatar}`, choose, ...overrides });
    opened.push({ frame, promise: handle.closed });
    return { frame, choose, promise: handle.closed };
}

beforeEach(() => {
    openDialog.mockReset();
});

afterEach(async () => {
    for (const { frame, promise } of opened.splice(0)) {
        await frame.close('close');
        await promise;
    }
    document.body.innerHTML = '';
});

describe('the picker window', () => {
    test('is a Window named Choose Assistant, with a search that is named for what it searches', async () => {
        const { frame } = await open();

        expect(frame.options).toMatchObject({ tier: 'window', title: 'Choose Assistant' });
        expect(frame.options.search).toMatchObject({ label: 'Search Characters', toggleLabel: 'Search Characters', escapeClearsFirst: true });
        expect(frame.options.search.label).not.toBe('Search');
    });

    test('lists a row for each entry, in the order given, with the name and the thumbnail of the character', async () => {
        const { frame } = await open();

        expect(rowsOf(frame).map(row => row.querySelector('.ds-row-label').textContent)).toEqual(['Alice', 'Bob', 'Carol']);
        const thumbnails = rowsOf(frame).map(row => row.querySelector('img.sbAssistantPickerThumb'));
        expect(thumbnails.map(image => image.getAttribute('src'))).toEqual(['/thumb/alice.png', '/thumb/bob.png', '/thumb/carol.png']);
        expect(thumbnails.every(image => image.getAttribute('alt') === '')).toBe(true);
    });

    test('has a button for each row, so a keyboard activates it', async () => {
        const { frame } = await open();

        expect(rowsOf(frame).every(row => row.tagName === 'BUTTON' && row.type === 'button')).toBe(true);
    });

    test('marks the current choice as selected, for the eye and for assistive technology, and no other row', async () => {
        const { frame } = await open();

        expect(rowsOf(frame).map(row => row.getAttribute('aria-current'))).toEqual([null, 'true', null]);
        expect(rowOf(frame, 'Bob').querySelector('.sbAssistantPickerSelected').getAttribute('aria-hidden')).toBe('true');
        expect(frame.body.querySelectorAll('.sbAssistantPickerSelected')).toHaveLength(1);
    });

    test('puts focus on the selected row when it opens, scrolled to the middle of the list', async () => {
        const scrollIntoView = jest.fn();
        window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
        const { frame } = await open();

        expect(frame.options.initialFocus()).toBe(rowOf(frame, 'Bob'));
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    });

    test('leaves the focus to the dialog when no row is selected', async () => {
        const entries = ENTRIES.map(entry => ({ ...entry, selected: false }));
        const { frame } = await open({ getEntries: () => entries });

        expect(frame.options.initialFocus).toBeUndefined();
    });

    test('reads the entries when it opens, not before', async () => {
        const getEntries = jest.fn(() => ENTRIES);

        expect(getEntries).not.toHaveBeenCalled();
        await open({ getEntries });

        expect(getEntries).toHaveBeenCalledTimes(1);
    });
});

describe('choosing in the picker', () => {
    test('closes the window and then applies the choice with the avatar of the row', async () => {
        const { frame, choose, promise } = await open();

        rowOf(frame, 'Carol').click();
        await promise;

        expect(frame.close).toHaveBeenCalledWith('choose');
        expect(choose).toHaveBeenCalledTimes(1);
        expect(choose).toHaveBeenCalledWith('carol.png');
    });

    test('applies nothing when the window closes without a choice', async () => {
        const { frame, choose, promise } = await open();

        await frame.close('close');
        await promise;

        expect(choose).not.toHaveBeenCalled();
    });

    test('applies nothing when the row of the current choice is activated', async () => {
        const { frame, choose, promise } = await open();

        rowOf(frame, 'Bob').click();
        await promise;

        expect(frame.close).toHaveBeenCalledWith('choose');
        expect(choose).not.toHaveBeenCalled();
    });

    test('applies the first row that was activated when a second one is activated before the window has closed', async () => {
        const { frame, choose, promise } = await open();

        rowOf(frame, 'Carol').click();
        rowOf(frame, 'Alice').click();
        await promise;

        expect(frame.close).toHaveBeenCalledTimes(1);
        expect(choose).toHaveBeenCalledTimes(1);
        expect(choose).toHaveBeenCalledWith('carol.png');
    });

    test('settles only after the choice has been applied', async () => {
        let applied = false;
        const { frame, promise } = await open({ choose: async () => { await new Promise(resolve => setTimeout(resolve, 0)); applied = true; } });

        rowOf(frame, 'Alice').click();
        await promise;

        expect(applied).toBe(true);
    });

    test('hands back a handle whose closed promise settles after the window closed, not before', async () => {
        let settled = false;
        const { frame, promise } = await open();
        void promise.then(() => { settled = true; });

        await Promise.resolve();
        expect(settled).toBe(false);
        await frame.close('close');
        await promise;
        expect(settled).toBe(true);
    });
});

describe('searching the picker', () => {
    test('hides the rows whose name does not hold the query, in any case, and shows them again when it is cleared', async () => {
        const { frame } = await open();
        const hiddenRows = () => rowsOf(frame).filter(row => row.hidden).map(row => row.querySelector('.ds-row-label').textContent);

        frame.options.search.onChange('  CA ');
        expect(hiddenRows()).toEqual(['Alice', 'Bob']);
        frame.options.search.onChange('');
        expect(hiddenRows()).toEqual([]);
    });

    test('tells the search how many rows are shown of how many, for the announcement', async () => {
        const { frame } = await open();

        frame.options.search.onChange('b');

        expect(frame.report).toHaveBeenLastCalledWith(1, 3);
    });

    test('shows No results only while no row matches', async () => {
        const { frame } = await open();
        const noResults = () => [...frame.body.querySelectorAll('.sb-status-page')].find(page => page.textContent === 'No results');

        expect(noResults().hidden).toBe(true);
        frame.options.search.onChange('zzz');
        expect(noResults().hidden).toBe(false);
        frame.options.search.onChange('al');
        expect(noResults().hidden).toBe(true);
    });
});

describe('a library with no character to offer', () => {
    test('shows its status and no list', async () => {
        const { frame } = await open({ getEntries: () => [] });

        const [status] = [...frame.body.querySelectorAll('.sb-status-page')].filter(page => !page.hidden);
        const title = status.querySelector('.sb-status-page__title');
        expect(title.textContent).toBe(HOME_COPY.pickerEmptyHead);
        expect(title.hasAttribute('data-sb-copy-placeholder')).toBe(false);
        expect(frame.body.querySelector('.sb-editor-section').hidden).toBe(true);
    });

    test('shows no placeholder status when there are characters', async () => {
        const { frame } = await open();

        expect([...frame.body.querySelectorAll('.sb-status-page')].filter(page => !page.hidden)).toEqual([]);
    });

    test('does not show No results for a search, because there is nothing to find', async () => {
        const { frame } = await open({ getEntries: () => [] });

        frame.options.search.onChange('x');

        expect([...frame.body.querySelectorAll('.sb-status-page')].filter(page => !page.hidden && page.textContent === 'No results')).toEqual([]);
    });
});

/** Frames that a test runs by hand, so it can look at the picker between two chunks. */
function installFrames() {
    const queue = new Map();
    let lastId = 0;
    window.requestAnimationFrame = (callback) => {
        lastId += 1;
        queue.set(lastId, callback);
        return lastId;
    };
    window.cancelAnimationFrame = (id) => { queue.delete(id); };
    return {
        pending: () => queue.size,
        run() {
            const [id, callback] = queue.entries().next().value;
            queue.delete(id);
            callback(0);
        },
        flush() {
            while (queue.size > 0) this.run();
        },
    };
}

const nameOf = index => `Name ${String(index).padStart(3, '0')}`;
const manyEntries = (count, selectedIndex = -1) => Array.from({ length: count }, (_, index) => ({ avatar: `c${index}.png`, name: nameOf(index), selected: index === selectedIndex }));
const labelsOf = frame => rowsOf(frame).map(row => row.querySelector('.ds-row-label').textContent);

describe('a library with many characters', () => {
    const { requestAnimationFrame: realRequest, cancelAnimationFrame: realCancel } = window;
    let frames;

    beforeEach(() => {
        frames = installFrames();
    });

    afterEach(() => {
        window.requestAnimationFrame = realRequest;
        window.cancelAnimationFrame = realCancel;
    });

    test('builds the first screenful at once and the rest a chunk per frame, always in the order of the list', async () => {
        const entries = manyEntries(300);
        const { frame } = await open({ getEntries: () => entries });

        const first = rowsOf(frame).length;
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(300);
        expect(labelsOf(frame)).toEqual(entries.slice(0, first).map(entry => entry.name));

        frames.run();
        const second = rowsOf(frame).length;
        expect(second).toBeGreaterThan(first);
        expect(second).toBeLessThan(300);
        expect(labelsOf(frame)).toEqual(entries.slice(0, second).map(entry => entry.name));

        frames.flush();
        expect(labelsOf(frame)).toEqual(entries.map(entry => entry.name));
        expect(frames.pending()).toBe(0);
    });

    test('needs only a few frames for a very long list, because a chunk grows with the list', async () => {
        const entries = manyEntries(3000);
        const { frame } = await open({ getEntries: () => entries });
        let ran = 0;

        for (; frames.pending() > 0; ran++) frames.run();

        expect(labelsOf(frame)).toHaveLength(3000);
        expect(ran).toBeLessThanOrEqual(12);
    });

    test('never builds more than a few hundred rows in one frame, however long the list is', async () => {
        const { frame } = await open({ getEntries: () => manyEntries(5000) });
        let largest = 0;

        while (frames.pending() > 0) {
            const before = rowsOf(frame).length;
            frames.run();
            largest = Math.max(largest, rowsOf(frame).length - before);
        }

        expect(rowsOf(frame)).toHaveLength(5000);
        expect(largest).toBeLessThanOrEqual(500);
    });

    test('asks for no frame when every row is built at once', async () => {
        await open();

        expect(frames.pending()).toBe(0);
    });

    test('searches every character, also those whose row is not built yet, and filters the rows that arrive later', async () => {
        const entries = manyEntries(300);
        const { frame } = await open({ getEntries: () => entries });
        const built = rowsOf(frame).length;
        expect(built).toBeLessThan(290);

        frame.options.search.onChange('name 29');

        expect(frame.report).toHaveBeenLastCalledWith(10, 300);
        frames.flush();
        expect(labelsOf(frame)).toHaveLength(300);
        expect(rowsOf(frame).filter(row => !row.hidden).map(row => row.querySelector('.ds-row-label').textContent)).toEqual(entries.slice(290).map(entry => entry.name));

        frame.options.search.onChange('');
        expect(rowsOf(frame).some(row => row.hidden)).toBe(false);
    });

    test('shows No results for a query that only matches nothing, though rows are still to come', async () => {
        const { frame } = await open({ getEntries: () => manyEntries(300) });
        const noResults = [...frame.body.querySelectorAll('.sb-status-page')].find(page => page.textContent === 'No results');

        frame.options.search.onChange('zzz');

        expect(noResults.hidden).toBe(false);
        frames.flush();
        expect(noResults.hidden).toBe(false);
    });

    test('builds the rows down to the selected one and below it, so the selected row has the focus and the rows after it only add to the end', async () => {
        const scrollIntoView = jest.fn();
        window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
        const entries = manyEntries(300, 250);
        const { frame } = await open({ getEntries: () => entries });

        const built = rowsOf(frame).length;
        expect(built).toBeGreaterThan(251);
        expect(built).toBeLessThan(300);
        expect(labelsOf(frame)).toEqual(entries.slice(0, built).map(entry => entry.name));
        expect(frame.options.initialFocus()).toBe(rowOf(frame, nameOf(250)));
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });

        frames.flush();
        expect(labelsOf(frame)).toEqual(entries.map(entry => entry.name));
        expect(rowsOf(frame).filter(row => row.getAttribute('aria-current') === 'true').map(row => row.querySelector('.ds-row-label').textContent)).toEqual([nameOf(250)]);
        expect(frame.body.querySelectorAll('.sbAssistantPickerSelected')).toHaveLength(1);
    });

    test('builds no more rows once the window has closed', async () => {
        const { frame, promise } = await open({ getEntries: () => manyEntries(300) });
        const built = rowsOf(frame).length;

        await frame.close('close');
        await promise;

        expect(frames.pending()).toBe(0);
        expect(rowsOf(frame)).toHaveLength(built);
    });
});
