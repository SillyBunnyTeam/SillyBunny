/** @jest-environment jsdom */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));

const { createListPagination } = await import('../../public/scripts/sillybunny-editor/list-pagination.js');

beforeEach(() => {
    document.body.replaceChildren();
});

function makePagination(options = {}) {
    const pagination = createListPagination({
        pageSizes: [2, 4],
        readPageSize: () => 2,
        ...options,
    });
    document.body.append(pagination.element);
    return pagination;
}

describe('createListPagination', () => {
    test('a transaction expired during its guard cannot mutate the page or notify', async () => {
        let approve;
        let current = true;
        const onChange = jest.fn();
        const pagination = makePagination({ guard: () => new Promise(resolve => { approve = resolve; }), onChange });
        pagination.setTotal(10);
        const paging = pagination.goTo(2, { isCurrent: () => current });
        current = false;
        approve(true);
        await paging;
        expect(pagination.page).toBe(1);
        expect(onChange).not.toHaveBeenCalled();
    });
    test('computes totals, pages, hidden state, and live status', () => {
        const pagination = makePagination();
        expect(pagination.element.hidden).toBe(true);
        pagination.setTotal(5);

        expect(pagination.pages).toBe(3);
        expect(pagination.element.hidden).toBe(false);
        expect(pagination.element.querySelector('.sb-list-pagination__status').textContent).toBe('Page 1 of 3');

        pagination.setTotal(2);
        expect(pagination.pages).toBe(1);
        expect(pagination.element.hidden).toBe(true);
    });

    test('clamps navigation and disables buttons at bounds', async () => {
        const pagination = makePagination();
        pagination.setTotal(5);
        const previous = pagination.element.querySelector('.sb-list-pagination__prev');
        const next = pagination.element.querySelector('.sb-list-pagination__next');
        expect(previous.disabled).toBe(true);
        expect(next.disabled).toBe(false);

        await pagination.goTo(99);
        expect(pagination.page).toBe(3);
        expect(next.disabled).toBe(true);
        await pagination.next();
        expect(pagination.page).toBe(3);
        await pagination.goTo(-1);
        expect(pagination.page).toBe(1);
        expect(previous.disabled).toBe(true);
    });

    test('aborts navigation when the guard returns false', async () => {
        const guard = jest.fn(() => false);
        const onChange = jest.fn();
        const pagination = makePagination({ guard, onChange });
        pagination.setTotal(10);

        await pagination.goTo(2);

        expect(guard).toHaveBeenCalledTimes(1);
        expect(pagination.page).toBe(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('changes page size while keeping the first visible item on screen', async () => {
        const writePageSize = jest.fn();
        const onChange = jest.fn();
        const pagination = makePagination({ writePageSize, onChange });
        pagination.setTotal(10);
        await pagination.goTo(3);
        onChange.mockClear();

        const select = pagination.element.querySelector('.sb-list-pagination__size');
        select.value = '4';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();

        expect(writePageSize).toHaveBeenCalledWith(4);
        expect(pagination.pageSize).toBe(4);
        expect(pagination.page).toBe(2);
        expect(pagination.offset).toBe(4);
        expect(onChange).toHaveBeenCalledWith({ page: 2, pageSize: 4, offset: 4 });
    });

    test('falls back when readPageSize is not one of the available sizes', () => {
        const pagination = makePagination({ readPageSize: () => 3 });
        expect(pagination.pageSize).toBe(2);
        expect(pagination.element.querySelector('select').value).toBe('2');
    });

    test('maps indexes to pages, shows an index, and slices the current page', async () => {
        const pagination = makePagination();
        const items = ['zero', 'one', 'two', 'three', 'four'];
        pagination.setTotal(items.length);

        expect(pagination.pageOf(0)).toBe(1);
        expect(pagination.pageOf(2)).toBe(2);
        expect(pagination.slice(items)).toEqual(['zero', 'one']);
        await pagination.showIndex(4);
        expect(pagination.page).toBe(3);
        expect(pagination.slice(items)).toEqual(['four']);
    });

    test('destroy removes control listeners', async () => {
        const pagination = makePagination();
        pagination.setTotal(10);
        pagination.destroy();
        pagination.element.querySelector('.sb-list-pagination__next').click();
        await Promise.resolve();
        expect(pagination.page).toBe(1);
    });

    test('renders semantic navigation, native controls, labels, and an initial status', () => {
        const pagination = makePagination();
        expect(pagination.element.matches('nav[aria-label="Pages"]')).toBe(true);
        expect(pagination.element.querySelectorAll('button[type="button"]')).toHaveLength(2);
        expect(pagination.element.querySelector('button[aria-label="Previous page"] i[aria-hidden="true"]')).not.toBeNull();
        expect(pagination.element.querySelector('button[aria-label="Next page"] i[aria-hidden="true"]')).not.toBeNull();
        expect(pagination.element.querySelector('[aria-live="polite"]').textContent).toBe('Page 1 of 1');
        expect(pagination.element.querySelector('select[aria-label="Items per page"]')).not.toBeNull();
    });

    test('uses the default page sizes and accepts stored numeric strings', () => {
        const pagination = createListPagination({ readPageSize: () => '100' });
        expect(pagination.pageSize).toBe(100);
        expect([...pagination.element.querySelector('select').options].map(option => option.value)).toEqual(['25', '50', '100', '250']);
    });

    test('clamps the page when totals shrink without notifying or invoking the guard', async () => {
        const guard = jest.fn(() => true);
        const onChange = jest.fn();
        const pagination = makePagination({ guard, onChange });
        pagination.setTotal(9);
        await pagination.goTo(5);
        onChange.mockClear();
        guard.mockClear();

        pagination.setTotal(3);
        expect(pagination.page).toBe(2);
        expect(pagination.pages).toBe(2);
        expect(pagination.offset).toBe(2);
        expect(pagination.element.querySelector('[aria-live]').textContent).toBe('Page 2 of 2');
        expect(onChange).not.toHaveBeenCalled();
        expect(guard).not.toHaveBeenCalled();
        pagination.setTotal(0);
        expect(pagination.page).toBe(1);
        expect(pagination.pages).toBe(1);
        expect(pagination.offset).toBe(0);
    });

    test('waits for asynchronous approval and emits the new page state afterward', async () => {
        let approve;
        const guard = () => new Promise(resolve => { approve = resolve; });
        const onChange = jest.fn();
        const pagination = makePagination({ guard, onChange });
        pagination.setTotal(10);
        const navigation = pagination.next();

        expect(pagination.page).toBe(1);
        expect(onChange).not.toHaveBeenCalled();
        approve(true);
        await navigation;
        expect(pagination.page).toBe(2);
        expect(onChange).toHaveBeenLastCalledWith({ page: 2, pageSize: 2, offset: 2 });
        const backwards = pagination.prev();
        approve(true);
        await backwards;
        expect(pagination.page).toBe(1);
    });

    test('does not persist or apply a rejected page-size change', async () => {
        const writePageSize = jest.fn();
        const onChange = jest.fn();
        const pagination = makePagination({ guard: async () => false, writePageSize, onChange });
        pagination.setTotal(10);
        const select = pagination.element.querySelector('select');
        select.value = '4';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(pagination.pageSize).toBe(2);
        expect(pagination.page).toBe(1);
        expect(select.value).toBe('2');
        expect(writePageSize).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    test('keeps a previously visible offset in its new page even when not aligned to the new size', async () => {
        const pagination = makePagination();
        pagination.setTotal(10);
        await pagination.goTo(4);
        expect(pagination.offset).toBe(6);
        const select = pagination.element.querySelector('select');
        select.value = '4';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(pagination.page).toBe(2);
        expect(pagination.offset).toBe(4);
        expect(pagination.slice(Array.from({ length: 10 }, (_, index) => index))).toContain(6);
    });

    test('applies the simple hidden rule against the current page size', () => {
        const pagination = makePagination({ readPageSize: () => 4 });
        pagination.setTotal(3);
        expect(pagination.element.hidden).toBe(true);
        pagination.setTotal(5);
        expect(pagination.element.hidden).toBe(false);
    });

    test('guards showIndex, then uses the current page size for pageOf and slice', async () => {
        const guard = jest.fn(() => false);
        const pagination = makePagination({ guard, readPageSize: () => 4 });
        pagination.setTotal(10);
        expect(pagination.pageOf(7)).toBe(2);
        await pagination.showIndex(7);
        expect(pagination.page).toBe(1);
        guard.mockReturnValue(true);
        await pagination.showIndex(7);
        expect(pagination.page).toBe(2);
        expect(pagination.pageOf(-1)).toBe(1);
        expect(pagination.slice(Array.from({ length: 10 }, (_, index) => index))).toEqual([4, 5, 6, 7]);
    });

    test('ignores stale guard approvals when newer navigation overtakes them', async () => {
        const approvals = [];
        const guard = () => new Promise(resolve => approvals.push(resolve));
        const onChange = jest.fn();
        const pagination = makePagination({ guard, onChange });
        pagination.setTotal(10);
        const first = pagination.goTo(2);
        const second = pagination.goTo(3);
        approvals[1](true);
        await second;
        approvals[0](true);
        await first;

        expect(pagination.page).toBe(3);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('does not apply an in-flight navigation after destruction', async () => {
        let approve;
        const guard = () => new Promise(resolve => { approve = resolve; });
        const onChange = jest.fn();
        const pagination = makePagination({ guard, onChange });
        pagination.setTotal(10);
        const navigation = pagination.next();
        pagination.destroy();
        approve(true);
        await navigation;

        expect(pagination.page).toBe(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('keepSizeVisible retains only the size control for nonempty single-page totals', () => {
        const pagination = makePagination({ keepSizeVisible: true });
        for (const total of [1, 2]) {
            pagination.setTotal(total);

            expect(pagination.element.hidden).toBe(false);
            expect(pagination.element.querySelector('.sb-list-pagination__prev').hidden).toBe(true);
            expect(pagination.element.querySelector('.sb-list-pagination__next').hidden).toBe(true);
            expect(pagination.element.querySelector('.sb-list-pagination__status').hidden).toBe(true);
            expect(pagination.element.querySelector('select').hidden).toBe(false);
        }
    });

    test('keepSizeVisible still hides an empty nav and restores navigation for multiple pages', () => {
        const pagination = makePagination({ keepSizeVisible: true });
        expect(pagination.element.hidden).toBe(true);
        pagination.setTotal(2);
        expect(pagination.element.hidden).toBe(false);
        pagination.setTotal(5);

        expect(pagination.element.querySelector('.sb-list-pagination__prev').hidden).toBe(false);
        expect(pagination.element.querySelector('.sb-list-pagination__next').hidden).toBe(false);
        expect(pagination.element.querySelector('.sb-list-pagination__status').hidden).toBe(false);
        pagination.setTotal(0);
        expect(pagination.element.hidden).toBe(true);
    });

    test('keepSizeVisible responds to size changes without hiding the size control', async () => {
        const pagination = makePagination({ keepSizeVisible: true });
        pagination.setTotal(3);
        const select = pagination.element.querySelector('select');
        select.value = '4';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(pagination.element.hidden).toBe(false);
        expect(pagination.element.querySelector('.sb-list-pagination__status').hidden).toBe(true);
        select.value = '2';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(pagination.element.querySelector('.sb-list-pagination__status').hidden).toBe(false);
        expect(select.hidden).toBe(false);
    });

    test('keepSizeVisible false preserves the original hidden nav and unhidden child controls', () => {
        const pagination = makePagination({ keepSizeVisible: false });
        pagination.setTotal(1);

        expect(pagination.element.hidden).toBe(true);
        expect(pagination.element.querySelector('.sb-list-pagination__prev').hidden).toBe(false);
        expect(pagination.element.querySelector('.sb-list-pagination__next').hidden).toBe(false);
        expect(pagination.element.querySelector('.sb-list-pagination__status').hidden).toBe(false);
    });
});
