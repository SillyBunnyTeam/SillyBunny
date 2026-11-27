/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockPositionPopover = jest.fn(() => '0px 0');

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    SPRING_SHEET: {},
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: mockPositionPopover,
}));

await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { openPicker, mountPicker, closePicker, isPickerOpen } = await import('../../public/scripts/sillybunny-editor/picker.js');

const OPTION = '.sb-picker__option:not(.sb-picker__more)';
const MORE = '.sb-picker__more';

beforeEach(() => {
    jest.useFakeTimers();
    closePicker({ animate: false });
    jest.clearAllMocks();
    document.body.replaceChildren();
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: jest.fn(() => ({ matches: false })) });
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    closePicker({ animate: false });
    jest.restoreAllMocks();
    jest.useRealTimers();
    document.body.replaceChildren();
});

function makeItems(count, { prefix = 'Name' } = {}) {
    return Array.from({ length: count }, (_, index) => ({
        value: `card-${index}.png`,
        label: `${prefix} ${String(index).padStart(4, '0')}`,
        searchText: `${prefix} ${String(index).padStart(4, '0')}`.toLowerCase(),
        tagIds: index % 3 === 0 ? ['t-a'] : index % 3 === 1 ? ['t-a', 't-b'] : [],
    }));
}

function open(options = {}) {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const onSelect = jest.fn();
    const picker = openPicker({ trigger, title: 'Characters', items: makeItems(120), pageSize: 50, searchDelay: 0, onSelect, ...options });
    const surface = document.querySelector('.sb-picker');
    return { picker, trigger, onSelect, surface, input: surface.querySelector('.sb-picker__search'), list: surface.querySelector('.sb-picker__list') };
}

function type(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(target, name) {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

/** The rows that the user can see: a paged list keeps the rows that it built and hides the ones that are not shown. */
const isHidden = element => element.classList.contains('is-hidden');
const shownOptions = list => [...list.querySelectorAll(OPTION)].filter(option => !isHidden(option));
const shownMore = list => [...list.querySelectorAll(MORE)].find(more => !isHidden(more)) ?? null;
const labels = list => shownOptions(list).map(option => option.querySelector('.sb-picker__label').textContent);

describe('batches', () => {
    test('show the first 50 matches and a Show More row, whatever the size of the library', () => {
        const { list } = open({ items: makeItems(3000) });

        expect(shownOptions(list)).toHaveLength(50);
        expect(list.querySelectorAll('.sb-picker__option')).toHaveLength(51);
        expect(list.lastElementChild.matches(MORE)).toBe(true);
        expect(isHidden(list.lastElementChild)).toBe(false);
        expect(list.lastElementChild.getAttribute('role')).toBe('option');
        expect(list.lastElementChild.textContent).toBe('Show More');
    });

    test('show no Show More row when everything fits in one batch', () => {
        const { list } = open({ items: makeItems(50) });

        expect(shownOptions(list)).toHaveLength(50);
        expect(shownMore(list)).toBeNull();
    });

    test('add 50 rows for each press of Show More, and drop the row after the last batch', () => {
        const { list } = open();

        shownMore(list).click();
        expect(shownOptions(list)).toHaveLength(100);
        expect(labels(list).slice(48, 52)).toEqual(['Name 0048', 'Name 0049', 'Name 0050', 'Name 0051']);
        shownMore(list).click();
        expect(shownOptions(list)).toHaveLength(120);
        expect(shownMore(list)).toBeNull();
    });

    test('are each one element of the list, so that adding a batch is one insertion', () => {
        const { list } = open({ items: makeItems(120) });
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true });

        shownMore(list).click();

        const added = observer.takeRecords().flatMap(record => [...record.addedNodes]);
        observer.disconnect();
        expect(added.filter(node => node.classList.contains('sb-picker__page'))).toHaveLength(1);
        expect(added.filter(node => node.classList.contains('sb-picker__option') && !node.classList.contains('sb-picker__more'))).toHaveLength(0);
        expect(shownOptions(list)).toHaveLength(100);
    });

    test('keep the rows that are shown: a batch only adds', () => {
        const { list } = open();
        const before = shownOptions(list);

        shownMore(list).click();

        expect(shownOptions(list).slice(0, 50).every((row, index) => row === before[index])).toBe(true);
    });

    test('are all one picker without a page size: every match is rendered and nothing is batched', () => {
        const { list } = open({ pageSize: undefined, items: makeItems(120) });

        expect(shownOptions(list)).toHaveLength(120);
        expect(shownMore(list)).toBeNull();
    });

    test('show a search\'s matches in the same batches, and go back to the first 50 on a new query', () => {
        const { list, input } = open({ items: makeItems(300) });
        shownMore(list).click();
        shownMore(list).click();
        expect(shownOptions(list)).toHaveLength(150);

        type(input, 'name 00');
        expect(shownOptions(list)).toHaveLength(50);
        expect(shownMore(list)).not.toBeNull();
        shownMore(list).click();
        expect(shownOptions(list)).toHaveLength(100);

        type(input, '');
        expect(shownOptions(list)).toHaveLength(50);
    });

    test('search the whole library, not only the rows that are shown', () => {
        const { list, input } = open({ items: makeItems(3000) });

        type(input, 'name 2999');

        expect(labels(list)).toEqual(['Name 2999']);
        expect(shownMore(list)).toBeNull();
    });

    test('are reached by the arrow keys: Show More is the last option, Enter loads the next batch and the first new row is the active one', () => {
        const { list, input } = open();

        key(input, 'End');
        const more = shownMore(list);
        expect(more.classList.contains('is-active')).toBe(true);
        expect(input.getAttribute('aria-activedescendant')).toBe(more.id);

        key(input, 'Enter');
        const options = shownOptions(list);
        expect(options).toHaveLength(100);
        expect(options[50].classList.contains('is-active')).toBe(true);
        expect(input.getAttribute('aria-activedescendant')).toBe(options[50].id);
        expect(options.filter(option => option.classList.contains('is-active'))).toHaveLength(1);
    });

    test('are reached with ArrowDown from the first row, and a pick on Show More does not choose a value', () => {
        const { list, input, onSelect } = open();

        for (let step = 0; step < 50; step++) key(input, 'ArrowDown');
        expect(shownMore(list).classList.contains('is-active')).toBe(true);
        key(input, 'Enter');

        expect(onSelect).not.toHaveBeenCalled();
        expect(shownOptions(list)).toHaveLength(100);
    });

    test('keep the input\'s focus when Show More is pressed with a pointer', () => {
        const { list, input } = open();
        input.focus();

        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        shownMore(list).dispatchEvent(down);

        expect(down.defaultPrevented).toBe(true);
    });
});

describe('search', () => {
    test('filters on the input event itself when the delay is 0', () => {
        const { list, input } = open();

        type(input, 'name 0007');

        expect(labels(list)).toEqual(['Name 0007']);
    });

    test('still waits for its delay by default, as every other picker does', () => {
        const { list, input } = open({ searchDelay: undefined });

        type(input, 'name 0007');
        expect(shownOptions(list)).toHaveLength(50);
        jest.advanceTimersByTime(300);
        expect(labels(list)).toEqual(['Name 0007']);
    });

    test('matches against the key that the item carries, so a typed query is lower-cased once and not each item\'s text', () => {
        const items = [{ value: 'a', label: 'Seraphina', searchText: 'key-only-xyz' }, { value: 'b', label: 'Bea', searchText: 'bea' }];
        const { list, input } = open({ items });

        type(input, 'key-only');
        expect(labels(list)).toEqual(['Seraphina']);
        type(input, 'seraphina');
        expect(shownOptions(list)).toHaveLength(0);
    });

    test('shows the empty state for a query that matches nothing, and the library again when it is cleared', () => {
        const { list, input } = open({ emptyText: 'No matching characters found.' });

        type(input, 'zzzz');
        expect(list.querySelector('.sb-picker__empty .sb-status-page__title').textContent).toBe('No matching characters found.');
        type(input, '');
        expect(shownOptions(list)).toHaveLength(50);
    });

    test('does not read the surface\'s scroll position, which would force layout of every row', () => {
        const { surface, input } = open();
        let reads = 0;
        Object.defineProperty(surface, 'scrollTop', { configurable: true, get: () => { reads++; return 0; }, set: () => {} });

        type(input, 'name 00');
        type(input, '');

        expect(reads).toBe(0);
    });
});

describe('rows are kept', () => {
    test('a row that goes out of a search and comes back is the same element', () => {
        const { list, input } = open();
        const first = shownOptions(list)[0];

        type(input, 'name 0030');
        expect(isHidden(first)).toBe(true);
        type(input, '');

        expect(shownOptions(list)[0] === first).toBe(true);
    });

    test('a render with nothing to change touches no node of the list', () => {
        const { picker, list } = open();
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true, subtree: true, attributes: true, characterData: true });

        picker.refresh();

        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
    });

    test('a refresh with a changed item rebuilds only that row', () => {
        const items = makeItems(120);
        const { picker, list } = open({ items });
        const before = shownOptions(list);

        picker.refresh(items.map((item, index) => (index === 3 ? { ...item, label: 'Renamed' } : item)));

        const after = shownOptions(list);
        expect(after[3]).not.toBe(before[3]);
        expect(after[3].textContent).toContain('Renamed');
        expect(after.filter((option, index) => option === before[index])).toHaveLength(49);
    });

    test('an icon is made by its factory only for a row that is built, once', () => {
        const factory = jest.fn(() => Object.assign(document.createElement('img'), { alt: '' }));
        const items = makeItems(3000).map(item => ({ ...item, icon: factory }));
        const { list, input } = open({ items });
        expect(factory).toHaveBeenCalledTimes(50);

        type(input, 'name 0070');
        type(input, '');
        expect(factory).toHaveBeenCalledTimes(51);
        shownMore(list).click();
        expect(factory).toHaveBeenCalledTimes(100);
    });

    test('an icon that is an element is still copied for each row', () => {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-user';
        icon.id = 'original';
        const { list } = open({ items: makeItems(3).map(item => ({ ...item, icon })) });

        const icons = [...list.querySelectorAll('.sb-picker__option > i:not(.sb-picker__check)')];
        expect(icons).toHaveLength(3);
        expect(icons.every(copy => copy !== icon && !copy.id)).toBe(true);
    });
});

describe('rows are retained and hidden in a paged list', () => {
    const itemOrder = list => [...list.querySelectorAll(OPTION)].map(option => option.querySelector('.sb-picker__label').textContent);

    test('filtering and clearing the search change attributes and no node of the tree', () => {
        const { list, input } = open({ items: makeItems(300) });
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true, subtree: true });

        type(input, 'name 003');
        type(input, '');

        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
        expect(shownOptions(list)).toHaveLength(50);
    });

    test('hides a row that the query leaves out, and the row is still in the list', () => {
        const { list, input } = open();

        type(input, 'name 0007');

        const row = [...list.querySelectorAll(OPTION)][3];
        expect(isHidden(row)).toBe(true);
        expect(row.isConnected).toBe(true);
    });

    test('builds a row that was never shown, and puts it in item order among the rows that exist', () => {
        const { list, input } = open({ items: makeItems(300) });
        type(input, 'name 0280');
        type(input, '');
        for (let batch = 0; batch < 4; batch++) shownMore(list).click();

        const order = itemOrder(list);
        const wanted = [...makeItems(250).map(item => item.label), 'Name 0280'];
        expect(order).toEqual(wanted);
        expect(shownOptions(list)).toHaveLength(250);
    });

    test('puts a row between two rows of one page without moving them', () => {
        const { list, input } = open({ items: makeItems(300) });
        type(input, 'name 02');
        type(input, 'name 0250|');
        type(input, '');
        type(input, 'name 0100');
        type(input, 'name 0');
        const before = [...list.querySelectorAll(OPTION)];
        type(input, 'name 01');

        const after = [...list.querySelectorAll(OPTION)];
        const labelsInOrder = after.map(option => option.querySelector('.sb-picker__label').textContent);
        expect(labelsInOrder).toEqual([...labelsInOrder].sort());
        expect(before.every(row => after.includes(row))).toBe(true);
    });

    test('removes the rows that were shown longest ago when too many are hidden', () => {
        const { list, input } = open({ items: makeItems(1200) });
        for (let batch = 0; batch < 13; batch++) shownMore(list).click();
        expect(shownOptions(list)).toHaveLength(700);

        type(input, 'name 0001');

        expect(list.querySelectorAll(OPTION).length).toBeLessThan(400);
        expect(labels(list)).toEqual(['Name 0001']);
        type(input, '');
        expect(shownOptions(list)).toHaveLength(50);
        expect(labels(list)[0]).toBe('Name 0000');
    });

    test('rebuilds the rows in the new order when a refresh reorders the items', () => {
        const items = makeItems(60);
        const { picker, list } = open({ items });

        picker.refresh([...items].reverse());

        expect(labels(list).slice(0, 3)).toEqual(['Name 0059', 'Name 0058', 'Name 0057']);
        expect(shownMore(list)).not.toBeNull();
        expect(shownOptions(list)).toHaveLength(50);
        expect(list.querySelectorAll(OPTION)).toHaveLength(50);
    });

    test('resets selection and excluded state cleanly when reordering or evicting retained rows', () => {
        const items = makeItems(1200);
        const states = new Map([
            ['card-0.png', 'selected'],
            ['card-1.png', 'excluded'],
        ]);
        const { picker, list, input } = open({
            items,
            multiple: true,
            getItemState: value => states.get(value) ?? null,
        });

        // Verify initial selection and excluded indicators on row 0 and row 1.
        expect(shownOptions(list)[0].getAttribute('aria-selected')).toBe('true');
        expect(isHidden(shownOptions(list)[0].querySelector('.sb-picker__check'))).toBe(false);
        expect(shownOptions(list)[1].querySelector('.sb-picker__excluded')).not.toBeNull();

        // Reorder items so retained rows are discarded and rebuilt.
        picker.refresh([...items].reverse());
        type(input, 'name 0000');
        expect(shownOptions(list)[0].getAttribute('aria-selected')).toBe('true');
        expect(isHidden(shownOptions(list)[0].querySelector('.sb-picker__check'))).toBe(false);
        type(input, 'name 0001');
        expect(shownOptions(list)[0].querySelector('.sb-picker__excluded')).not.toBeNull();

        // Restore order, build > 600 rows, evict oldest hidden rows (including card-1.png), then show card-1.png again.
        type(input, '');
        picker.refresh(items);
        for (let batch = 0; batch < 13; batch++) shownMore(list).click();
        type(input, 'name 0650');
        type(input, 'name 0001');
        expect(shownOptions(list)[0].querySelector('.sb-picker__excluded')).not.toBeNull();
    });

    test('keeps the rows that are hidden out of the keyboard order and the screen reader', () => {
        const { list, input } = open();

        type(input, 'name 0007');
        key(input, 'End');

        expect(shownOptions(list)).toHaveLength(1);
        expect(input.getAttribute('aria-activedescendant')).toBe(shownOptions(list)[0].id);
    });
});

describe('a pick in a multiple picker', () => {
    function pickerWithSelection(options = {}) {
        const selected = new Set();
        const getItemState = jest.fn(value => (selected.has(value) ? 'selected' : null));
        const onSelect = jest.fn(value => {
            if (selected.has(value)) selected.delete(value);
            else selected.add(value);
        });
        return { ...open({ multiple: true, getItemState, onSelect, selectionCount: () => `${selected.size} selected`, ...options }), selected, getItemState, onSelect };
    }

    test('hands the item\'s value, which is the avatar and not an index, to onSelect', () => {
        const { list, onSelect } = pickerWithSelection();

        shownOptions(list)[2].click();

        expect(onSelect).toHaveBeenCalledWith('card-2.png');
    });

    test('toggles one row and leaves every other row element as it was', () => {
        const { list } = pickerWithSelection();
        const rows = shownOptions(list);
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true, subtree: true, attributes: true });

        rows[4].click();

        expect(rows[4].getAttribute('aria-selected')).toBe('true');
        expect(isHidden(rows[4].querySelector('.sb-picker__check'))).toBe(false);
        expect(shownOptions(list).every((row, index) => row === rows[index])).toBe(true);
        const touched = new Set(observer.takeRecords().map(record => record.target.closest?.(OPTION) ?? record.target));
        expect([...touched].length === 1 && [...touched][0] === rows[4]).toBe(true);
        expect(rows.filter(row => row.getAttribute('aria-selected') === 'true').map(row => row.id)).toEqual([rows[4].id]);
        observer.disconnect();

        rows[4].click();
        expect(rows[4].getAttribute('aria-selected')).toBe('false');
        expect(isHidden(rows[4].querySelector('.sb-picker__check'))).toBe(true);
    });

    test('reads the state of the rows that are on the screen, not of the whole library', () => {
        const { list, getItemState } = pickerWithSelection({ items: makeItems(3000) });
        getItemState.mockClear();

        shownOptions(list)[0].click();

        expect(getItemState.mock.calls.length).toBeLessThanOrEqual(60);
    });

    test('keeps the batches, the scroll and the active row', () => {
        const { list, input } = pickerWithSelection();
        shownMore(list).click();
        list.scrollTop = 120;
        key(input, 'ArrowDown');
        key(input, 'ArrowDown');

        key(input, 'Enter');

        expect(shownOptions(list)).toHaveLength(100);
        expect(list.scrollTop).toBe(120);
        expect(list.querySelectorAll('.is-active')).toHaveLength(1);
        expect(shownOptions(list)[52].classList.contains('is-active')).toBe(true);
    });

    test('shows the state of an item that scrolled in later', () => {
        const { list, selected } = pickerWithSelection();
        selected.add('card-70.png');

        shownMore(list).click();

        expect(shownOptions(list)[70].getAttribute('aria-selected')).toBe('true');
    });

    test('updates the count line and the footer\'s disabled state without a render', () => {
        const footerDisabled = jest.fn(() => false);
        const { surface, list } = pickerWithSelection({ footer: [{ label: 'Create', onSelect: () => {}, disabled: footerDisabled }] });
        shownOptions(list)[0].click();

        expect(surface.querySelector('.sb-picker__count').textContent).toBe('1 selected');
        expect(footerDisabled).toHaveBeenCalled();
    });

    test('dims and disables a row by the state it has now: a disabled item that is selected can still be removed', () => {
        const { list, selected } = pickerWithSelection({ items: [{ value: 'a', label: 'Alpha', disabled: true }, { value: 'b', label: 'Beta' }] });
        const [alpha] = shownOptions(list);
        expect(alpha.getAttribute('aria-disabled')).toBe('true');

        selected.add('a');
        shownOptions(list)[1].click();
        expect(alpha.getAttribute('aria-disabled')).toBeNull();
        expect(alpha.getAttribute('aria-selected')).toBe('true');
    });
});

describe('the tag filter', () => {
    const filter = {
        label: 'Tags',
        items: [{ value: 't-a', label: 'Alpha tag', color: '#ff0000' }, { value: 't-b', label: 'Beta tag' }],
        match: (item, selected) => [...selected].every(id => item.tagIds.includes(id)),
    };

    test('is a button with a count and a panel of toggle chips, closed at first', () => {
        const { surface } = open({ filter });
        const toggle = surface.querySelector('.sb-picker__filter-toggle');
        const panel = surface.querySelector('.sb-picker__filters');

        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
        expect(toggle.getAttribute('aria-label')).toBe('Tags');
        expect(isHidden(panel)).toBe(true);
        toggle.click();
        expect(isHidden(panel)).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        const chips = [...panel.querySelectorAll('.sb-picker__chip')];
        expect(chips.map(chip => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([['Alpha tag', 'false'], ['Beta tag', 'false']]);
        expect(chips[0].querySelector('.sb-picker__chip-dot').style.backgroundColor).not.toBe('');
    });

    test('keeps a character only when it has every ticked tag, in batches, and resets to the first batch', () => {
        const { surface, list } = open({ filter, items: makeItems(300) });
        shownMore(list).click();
        const [alpha, beta] = surface.querySelectorAll('.sb-picker__chip');

        alpha.click();
        expect(alpha.getAttribute('aria-pressed')).toBe('true');
        expect(shownOptions(list)).toHaveLength(50);
        expect(shownMore(list)).not.toBeNull();
        beta.click();
        expect(labels(list).slice(0, 3)).toEqual(['Name 0001', 'Name 0004', 'Name 0007']);
        expect(surface.querySelector('.sb-picker__filter-count').textContent).toBe('2');
        alpha.click();
        beta.click();
        expect(shownOptions(list)).toHaveLength(50);
        expect(isHidden(surface.querySelector('.sb-picker__filter-count'))).toBe(true);
    });

    test('combines with the search', () => {
        const { surface, list, input } = open({ filter, items: makeItems(300) });
        surface.querySelector('.sb-picker__chip').click();

        type(input, 'name 001');

        expect(labels(list)).toEqual(['Name 0010', 'Name 0012', 'Name 0013', 'Name 0015', 'Name 0016', 'Name 0018', 'Name 0019']);
    });

    test('shows the empty state when no character has the ticked tags, and a Clear Filters button brings them back', () => {
        const { surface, list } = open({ filter, items: makeItems(300).filter(item => !item.tagIds.includes('t-b')) });
        const [, beta] = surface.querySelectorAll('.sb-picker__chip');

        beta.click();
        expect(isHidden(list.querySelector('.sb-picker__empty'))).toBe(false);
        surface.querySelector('.sb-picker__filter-clear').click();
        expect(shownOptions(list)).toHaveLength(50);
        expect(beta.getAttribute('aria-pressed')).toBe('false');
    });

    test('is absent from a picker that does not ask for it', () => {
        const { surface } = open();

        expect(surface.querySelector('.sb-picker__filter-toggle')).toBeNull();
        expect(surface.querySelector('.sb-picker__search').parentElement.classList.contains('sb-picker__search-row')).toBe(false);
    });
});

describe('a picker mounted in a page', () => {
    function mount(options = {}) {
        const host = document.createElement('section');
        document.body.append(host);
        const onSelect = jest.fn();
        const mounted = mountPicker(host, { items: makeItems(120), multiple: true, pageSize: 50, searchDelay: 0, onSelect, getItemState: () => null, ...options });
        return { host, mounted, onSelect };
    }

    test('builds the search field and the list into the host, and is not the popover\'s picker', () => {
        const { host, mounted } = mount();

        expect(host.querySelector('.sb-picker__search')).toBe(mounted.input);
        expect(host.querySelector('.sb-picker__list')).toBe(mounted.list);
        expect(shownOptions(mounted.list)).toHaveLength(50);
        expect(isPickerOpen()).toBe(false);
        expect(document.querySelector('.sb-action-popover')).toBeNull();
    });

    test('searches, picks and shows more, like the popover', () => {
        const { mounted, onSelect } = mount();

        type(mounted.input, 'name 0007');
        shownOptions(mounted.list)[0].click();
        type(mounted.input, '');
        shownMore(mounted.list).click();

        expect(onSelect).toHaveBeenCalledWith('card-7.png');
        expect(shownOptions(mounted.list)).toHaveLength(100);
    });

    test('answers the keys of its own search field, and Escape is left to the page', () => {
        const { mounted } = mount();

        key(mounted.input, 'ArrowDown');
        expect(shownOptions(mounted.list)[1].classList.contains('is-active')).toBe(true);
        expect(key(mounted.input, 'Escape').defaultPrevented).toBe(false);
    });

    test('is not closed by a popover picker opening beside it, and does not close it', () => {
        const { mounted } = mount();
        const { picker } = open();

        expect(picker.isOpen).toBe(true);
        expect(shownOptions(mounted.list)).toHaveLength(50);
        type(mounted.input, 'name 0007');
        expect(picker.isOpen).toBe(true);
    });

    test('two mounted pickers keep their own queries', () => {
        const first = mount();
        const second = mount();

        type(first.mounted.input, 'name 0007');

        expect(labels(first.mounted.list)).toEqual(['Name 0007']);
        expect(shownOptions(second.mounted.list)).toHaveLength(50);
    });

    test('stops answering after destroy, and refresh swaps the items', () => {
        const { mounted, onSelect } = mount();
        mounted.refresh(makeItems(3, { prefix: 'New' }));
        expect(labels(mounted.list)).toEqual(['New 0000', 'New 0001', 'New 0002']);

        mounted.destroy();
        type(mounted.input, 'x');
        shownOptions(mounted.list)[0]?.click();

        expect(onSelect).not.toHaveBeenCalled();
    });
});

describe('the other callers keep their picker', () => {
    test('a picker without the new options renders every item, as before', () => {
        const trigger = document.createElement('button');
        document.body.append(trigger);

        openPicker({ trigger, title: 'Old', items: makeItems(120), onSelect: () => {} });

        const list = document.querySelector('.sb-picker__list');
        expect(shownOptions(list)).toHaveLength(120);
        expect(shownMore(list)).toBeNull();
    });

    test('grouped items still render under their headings, with the same rows reused', () => {
        const trigger = document.createElement('button');
        document.body.append(trigger);
        const items = [{ value: 1, label: 'One', group: 'A' }, { value: 2, label: 'Two', group: 'B' }, { value: 3, label: 'Three', group: 'A' }];
        openPicker({ trigger, title: 'Grouped', items, onSelect: () => {}, searchDelay: 0 });
        const list = document.querySelector('.sb-picker__list');
        const one = shownOptions(list)[0];

        const input = document.querySelector('.sb-picker__search');
        type(input, 'o');
        type(input, '');

        expect([...list.querySelectorAll('.sb-picker__group-heading')].map(heading => heading.textContent)).toEqual(['A', 'B']);
        expect(shownOptions(list)[0] === one).toBe(true);
    });
});
