/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const { createEntityRow, ENTITY_ROW_SELECTOR, entityKey, entityRowMotionKey, limitTagChips } = await import('../../public/scripts/sillybunny-editor/entity-row.js');
const { reconcileRows, rowEntry } = await import('../../public/scripts/sillybunny-editor/list-rows.js');

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    jest.restoreAllMocks();
});

function node(tag, text = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
}

function makeRow(options = {}) {
    return createEntityRow({ key: 'character:Alice.png', label: 'Alice', ...options });
}

describe('createEntityRow', () => {
    test('creates the existing entity slots in order with valid nested controls', () => {
        const badge = node('span', '1');
        const control = node('button');
        const { row, slots } = makeRow({
            grip: true,
            avatar: { src: '/avatars/Alice.png' },
            subtitle: 'Version 1',
            tags: true,
            badges: [badge],
            suffix: [control],
            activation: 'navigate',
        });

        expect(row.tagName).toBe('DIV');
        expect(row.matches(ENTITY_ROW_SELECTOR)).toBe(true);
        expect(row.getAttribute('role')).toBe('listitem');
        expect(row.getAttribute('aria-label')).toBe('Alice');
        expect(row.dataset.sbListKey).toBe('character:Alice.png');
        expect([...row.children]).toEqual([slots.grip, slots.avatar, slots.text, slots.badge, slots.suffix, slots.chevron]);
        expect([...slots.text.children]).toEqual([slots.title, slots.subtitle, slots.tags]);
        for (const name of ['grip', 'avatar', 'text', 'title', 'subtitle', 'tags', 'badge', 'suffix', 'chevron']) {
            expect(slots[name].classList.contains(`ds-entity-row__${name}`)).toBe(true);
        }
        expect(slots.tags.classList.contains('ds-tag-chips')).toBe(true);
        expect(slots.grip.getAttribute('aria-hidden')).toBe('true');
        expect(slots.badge.firstChild).toBe(badge);
        expect(slots.suffix.firstChild).toBe(control);
        expect(control.closest('button')).toBe(control);
    });

    test('omits optional slots but always creates text and title', () => {
        const { row, slots } = makeRow();

        expect([...row.children]).toEqual([slots.text]);
        expect([...slots.text.children]).toEqual([slots.title]);
        expect(slots.title.textContent).toBe('Alice');
        for (const name of ['grip', 'avatar', 'img', 'subtitle', 'tags', 'badge', 'suffix', 'chevron']) {
            expect(slots[name]).toBeNull();
        }
    });

    test('treats null content and empty control arrays as omitted optional slots', () => {
        const { slots } = makeRow({ title: null, subtitle: null, avatar: null, badges: [], suffix: [] });

        expect(slots.title.textContent).toBe('');
        expect(slots.subtitle).toBeNull();
        expect(slots.avatar).toBeNull();
        expect(slots.badge).toBeNull();
        expect(slots.suffix).toBeNull();
    });

    test('adds compatibility classes and caller attributes without retaining null attributes', () => {
        const { row, slots, update } = makeRow({
            avatar: { src: 'Alice.png' },
            subtitle: 'Version 1',
            tags: true,
            badges: [node('span')],
            suffix: [node('button')],
            compatClasses: {
                row: ['character_select', 'entity_block'],
                avatar: ['avatar'],
                text: ['character_select_container'],
                title: ['ch_name'],
                subtitle: ['ch_additional_info'],
                tags: ['tags', 'tags_inline'],
                badge: ['queue_position'],
                suffix: ['group_member_icon'],
            },
            attributes: { id: 'CharID3', 'data-chid': '3', chid: '3', title: null },
        });

        expect(row.classList.contains('character_select')).toBe(true);
        expect(row.classList.contains('entity_block')).toBe(true);
        expect(slots.avatar.classList.contains('avatar')).toBe(true);
        expect(slots.text.classList.contains('character_select_container')).toBe(true);
        expect(slots.title.classList.contains('ch_name')).toBe(true);
        expect(slots.subtitle.classList.contains('ch_additional_info')).toBe(true);
        expect(slots.tags.classList.contains('tags')).toBe(true);
        expect(slots.tags.classList.contains('tags_inline')).toBe(true);
        expect(slots.badge.classList.contains('queue_position')).toBe(true);
        expect(slots.suffix.classList.contains('group_member_icon')).toBe(true);
        expect(row.id).toBe('CharID3');
        expect(row.getAttribute('chid')).toBe('3');
        expect(row.dataset.chid).toBe('3');
        expect(row.hasAttribute('title')).toBe(false);

        update({ attributes: { chid: null, 'data-chid': '4', 'data-selected': 'true' } });

        expect(row.hasAttribute('chid')).toBe(false);
        expect(row.dataset.chid).toBe('4');
        expect(row.dataset.selected).toBe('true');
        expect(row.id).toBe('CharID3');
    });

    test('creates a lazy, asynchronously decoded image with caller alt text', () => {
        const { slots } = makeRow({ avatar: { src: '/avatars/Alice.png', alt: 'Alice portrait' } });

        expect(slots.img.tagName).toBe('IMG');
        expect(slots.avatar.firstChild).toBe(slots.img);
        expect(slots.img.getAttribute('loading')).toBe('lazy');
        expect(slots.img.getAttribute('decoding')).toBe('async');
        expect(slots.img.getAttribute('src')).toBe('/avatars/Alice.png');
        expect(slots.img.alt).toBe('Alice portrait');
        expect(makeRow({ avatar: { src: 'Alice.png' } }).slots.img.alt).toBe('');
    });

    test('inserts a Node avatar as supplied without cloning or changing its classes', () => {
        const avatar = node('div');
        avatar.className = 'group-collage';
        avatar.append(node('img'), node('img'));
        const { slots, update } = makeRow({ avatar });

        expect(slots.avatar.firstChild).toBe(avatar);
        expect(avatar.className).toBe('group-collage');
        expect(slots.img).toBeNull();

        update({ avatar });

        expect(slots.avatar.firstChild).toBe(avatar);
        expect(avatar.children).toHaveLength(2);
    });

    test('keeps non-activatable rows unfocusable without a chevron', () => {
        const { row, slots } = makeRow({ activation: 'none' });

        expect(row.tabIndex).toBe(-1);
        expect(row.hasAttribute('tabindex')).toBe(false);
        expect(row.classList.contains('ds-entity-row--activatable')).toBe(false);
        expect(slots.chevron).toBeNull();
    });

    test('makes activate rows focusable without adding a navigation chevron', () => {
        const { row, slots } = makeRow({ activation: 'activate' });

        expect(row.tabIndex).toBe(0);
        expect(row.classList.contains('ds-entity-row--activatable')).toBe(true);
        expect(slots.chevron).toBeNull();
    });

    test('adds a decorative trailing chevron only to navigate rows', () => {
        const { row, slots } = makeRow({ activation: 'navigate', suffix: [node('button')] });

        expect(row.tabIndex).toBe(0);
        expect(row.classList.contains('ds-entity-row--activatable')).toBe(true);
        expect(row.lastElementChild).toBe(slots.chevron);
        expect(slots.chevron.matches('i.fa-solid.fa-chevron-right[aria-hidden="true"]')).toBe(true);
        expect(slots.chevron.previousElementSibling).toBe(slots.suffix);
    });

    test('does not bind activation or sorting event listeners', () => {
        const addEventListener = jest.spyOn(EventTarget.prototype, 'addEventListener');

        makeRow({ activation: 'navigate', grip: true });

        expect(addEventListener).not.toHaveBeenCalled();
    });

    test('warns once per key for excess suffix controls without dropping controls', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const controls = [node('button'), node('button'), node('button')];
        const { slots, update } = makeRow({ key: 'character:suffix-warning.png', suffix: controls });

        expect([...slots.suffix.children]).toEqual(controls);
        expect(warn).toHaveBeenCalledTimes(1);

        update({ suffix: [...controls] });
        makeRow({ key: 'character:suffix-warning.png', suffix: [node('button'), node('button'), node('button')] });
        expect(warn).toHaveBeenCalledTimes(1);

        makeRow({ key: 'group:suffix-warning', suffix: [node('button'), node('button'), node('button')] });
        expect(warn).toHaveBeenCalledTimes(2);
    });

    test('patches labels, content, images and attributes while retaining row and slot identity', () => {
        const entity = makeRow({ avatar: { src: 'Alice.png' }, subtitle: 'Version 1', tags: true });
        const { row, slots, update } = entity;
        document.body.append(row);
        const originalSlots = { ...slots };
        const titleText = slots.title.firstChild;
        const subtitleText = slots.subtitle.firstChild;
        const setImageAttribute = jest.spyOn(slots.img, 'setAttribute');

        update({ label: 'Alicia', subtitle: 'Version 2', avatar: { src: 'Alicia.png', alt: 'Portrait' }, attributes: { chid: '5' } });

        expect(entity.row).toBe(row);
        expect(document.body.firstChild).toBe(row);
        for (const name of ['avatar', 'img', 'text', 'title', 'subtitle', 'tags']) {
            expect(slots[name]).toBe(originalSlots[name]);
        }
        expect(slots.title.firstChild).toBe(titleText);
        expect(slots.subtitle.firstChild).toBe(subtitleText);
        expect(slots.title.textContent).toBe('Alicia');
        expect(row.getAttribute('aria-label')).toBe('Alicia');
        expect(slots.subtitle.textContent).toBe('Version 2');
        expect(slots.img.getAttribute('src')).toBe('Alicia.png');
        expect(slots.img.alt).toBe('Portrait');
        expect(row.getAttribute('chid')).toBe('5');
        expect(setImageAttribute.mock.calls).toEqual([['src', 'Alicia.png'], ['alt', 'Portrait']]);
    });

    test('leaves unchanged DOM untouched during repeated updates', () => {
        const badge = node('span', '1');
        const control = node('button');
        const subtitle = [node('span', 'Version 1'), node('small', 'Model')];
        const title = node('strong', 'Alice');
        const options = {
            title, subtitle, avatar: { src: '/avatars/Alice.png' }, grip: true, tags: true,
            badges: [badge], suffix: [control], compatClasses: { row: ['character_select'] }, attributes: { chid: '3' },
        };
        const { row, slots, update } = makeRow(options);
        document.body.append(row);
        slots.tags.append(node('span', 'Tag'));
        const before = row.outerHTML;
        const observer = new MutationObserver(() => {});
        observer.observe(row, { attributes: true, childList: true, characterData: true, subtree: true });
        control.focus();

        update({ ...options, subtitle: [...subtitle], badges: [badge], suffix: [control], avatar: { ...options.avatar } });
        update({});

        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
        expect(row.outerHTML).toBe(before);
        expect(document.activeElement).toBe(control);
        expect(slots.title.firstChild).toBe(title);
    });

    test('keeps an explicit title independent of label changes and restores the default with undefined', () => {
        const { row, slots, update } = makeRow({ title: 'Custom title' });

        update({ label: 'Alicia' });
        expect(slots.title.textContent).toBe('Custom title');
        expect(row.getAttribute('aria-label')).toBe('Alicia');

        const title = node('strong', 'Node title');
        update({ title });
        expect(slots.title.firstChild).toBe(title);
        update({ title: null });
        expect(slots.title.childNodes).toHaveLength(0);
        update({ title: undefined });
        expect(slots.title.textContent).toBe('Alicia');
    });

    test('inserts string titles and subtitles as text rather than HTML', () => {
        const { slots } = makeRow({ title: '<strong>Alice</strong>', subtitle: '<img src=x>' });

        expect(slots.title.textContent).toBe('<strong>Alice</strong>');
        expect(slots.title.children).toHaveLength(0);
        expect(slots.subtitle.textContent).toBe('<img src=x>');
        expect(slots.subtitle.children).toHaveLength(0);
    });

    test('updates subtitle Nodes and ordered arrays without replacing unchanged nodes', () => {
        const first = node('span', 'Version');
        const second = node('small', 'Model');
        const third = node('small', 'Context');
        const { slots, update } = makeRow({ subtitle: first });
        const subtitle = slots.subtitle;

        expect(subtitle.firstChild).toBe(first);
        update({ subtitle: [second, first] });
        expect(slots.subtitle).toBe(subtitle);
        expect([...subtitle.children]).toEqual([second, first]);
        update({ subtitle: [first, third] });
        expect([...subtitle.children]).toEqual([first, third]);
        expect(second.parentElement).toBeNull();
        update({ subtitle: 'Plain text' });
        expect(subtitle.textContent).toBe('Plain text');
        expect(subtitle.children).toHaveLength(0);
    });

    test('keeps existing suffix controls focused when other controls are added or removed', () => {
        const control = node('button');
        const other = node('button');
        const badge = node('span', '1');
        const nextBadge = node('span', '2');
        const { row, slots, update } = makeRow({ suffix: [control], badges: [badge] });
        document.body.append(row);
        control.focus();
        const suffix = slots.suffix;
        const badgeSlot = slots.badge;

        update({ suffix: [control, other], badges: [badge, nextBadge] });

        expect(slots.suffix).toBe(suffix);
        expect(slots.badge).toBe(badgeSlot);
        expect([...suffix.children]).toEqual([control, other]);
        expect([...badgeSlot.children]).toEqual([badge, nextBadge]);
        expect(document.activeElement).toBe(control);

        update({ suffix: [control], badges: [nextBadge] });

        expect(suffix.firstChild).toBe(control);
        expect(badgeSlot.firstChild).toBe(nextBadge);
        expect(other.parentElement).toBeNull();
        expect(badge.parentElement).toBeNull();
        expect(document.activeElement).toBe(control);
    });

    test('adds and removes optional slots while preserving canonical order', () => {
        const { row, slots, update } = makeRow({ activation: 'navigate' });
        const text = slots.text;
        const title = slots.title;
        const chevron = slots.chevron;

        update({ suffix: [node('button')], tags: true, badges: [node('span')], subtitle: '', avatar: { src: 'Alice.png' }, grip: true });

        expect([...row.children]).toEqual([slots.grip, slots.avatar, text, slots.badge, slots.suffix, chevron]);
        expect([...text.children]).toEqual([title, slots.subtitle, slots.tags]);
        expect(slots.grip.getAttribute('aria-hidden')).toBe('true');

        update({ grip: false, avatar: null, subtitle: null, tags: false, badges: [], suffix: [] });

        expect([...row.children]).toEqual([text, chevron]);
        expect([...text.children]).toEqual([title]);
        for (const name of ['grip', 'avatar', 'img', 'subtitle', 'tags', 'badge', 'suffix']) {
            expect(slots[name]).toBeNull();
        }
    });

    test('updates avatar content between image objects, Nodes and omission', () => {
        const { slots, update } = makeRow({ avatar: { src: 'Alice.png' } });
        const avatarSlot = slots.avatar;
        const image = slots.img;
        const collage = node('div');

        update({ avatar: { src: 'Alicia.png' } });
        expect(slots.img).toBe(image);
        update({ avatar: collage });
        expect(slots.avatar).toBe(avatarSlot);
        expect(avatarSlot.firstChild).toBe(collage);
        expect(slots.img).toBeNull();
        expect(image.parentElement).toBeNull();
        update({ avatar: { src: 'Alice.png' } });
        expect(slots.avatar).toBe(avatarSlot);
        expect(slots.img.getAttribute('loading')).toBe('lazy');
        expect(slots.img.getAttribute('decoding')).toBe('async');
        expect(collage.parentElement).toBeNull();
        update({ avatar: null });
        expect(slots.avatar).toBeNull();
        expect(slots.img).toBeNull();
    });

    test('replaces compatibility classes without removing base classes or caller state', () => {
        const { row, slots, update } = makeRow({
            compatClasses: { row: ['character_select', 'ds-entity-row'], title: ['ch_name'], tags: ['tags'] },
        });
        row.classList.add('is-selected');

        update({ compatClasses: { row: ['entity_block'], tags: ['tags_inline'] }, tags: true });

        expect(row.classList.contains('character_select')).toBe(false);
        expect(row.classList.contains('ds-entity-row')).toBe(true);
        expect(row.classList.contains('entity_block')).toBe(true);
        expect(row.classList.contains('is-selected')).toBe(true);
        expect(slots.title.classList.contains('ch_name')).toBe(false);
        expect(slots.title.classList.contains('ds-entity-row__title')).toBe(true);
        expect(slots.tags.classList.contains('tags_inline')).toBe(true);
        expect(slots.tags.classList.contains('tags')).toBe(false);
        expect(slots.tags.classList.contains('ds-tag-chips')).toBe(true);
    });

    test('reconciles shared rows through create and update passes without replacing them', () => {
        const container = node('div');
        document.body.append(container);
        const cache = new Map();
        const controllers = new WeakMap();
        const create = jest.fn(entry => {
            const entity = createEntityRow({ key: entityKey('character', entry.id), label: entry.label });
            controllers.set(entity.row, entity);
            return entity.row;
        });
        const render = entries => reconcileRows({
            container, cache, entries, key: entry => entityKey('character', entry.id), signature: entry => entry.id, create,
            update: (row, entry) => controllers.get(row).update({ label: entry.label, subtitle: entry.subtitle }),
        });
        const alice = { id: 'Alice.png', label: 'Alice', subtitle: 'Version 1' };
        const bob = { id: 'Bob.png', label: 'Bob', subtitle: null };

        render([alice, bob]);
        const [aliceRow, bobRow] = container.children;
        const changedAlice = { ...alice, label: 'Alicia', subtitle: 'Version 2' };
        const keys = render([bob, changedAlice]);

        expect([...keys]).toEqual(['character:Bob.png', 'character:Alice.png']);
        expect([...container.children]).toEqual([bobRow, aliceRow]);
        expect(aliceRow.getAttribute('aria-label')).toBe('Alicia');
        expect(controllers.get(aliceRow).slots.title.textContent).toBe('Alicia');
        expect(controllers.get(aliceRow).slots.subtitle.textContent).toBe('Version 2');
        expect(rowEntry(aliceRow)).toBe(changedAlice);
        expect(entityRowMotionKey(aliceRow)).toBe('character:Alice.png');
        expect(create).toHaveBeenCalledTimes(2);

        render([changedAlice]);

        expect(container.firstElementChild).toBe(aliceRow);
        expect(cache.has('character:Bob.png')).toBe(false);
        expect(bobRow.parentElement).toBeNull();
    });
});

describe('limitTagChips', () => {
    function tags(names) {
        const container = makeRow({ tags: true }).slots.tags;
        for (const name of names) {
            const chip = node('span');
            chip.className = 'tag';
            const label = node('span', name);
            label.className = 'tag_name';
            chip.append(label);
            container.append(chip);
        }
        return container;
    }

    test('keeps three chips and adds an unfocusable count with the hidden tag names', () => {
        const container = tags(['One', 'Two', 'Three', 'Four', 'Five']);
        const chips = [...container.children];
        limitTagChips(container);

        expect(chips.map(chip => chip.hidden)).toEqual([false, false, false, true, true]);
        const overflow = container.lastElementChild;
        expect(overflow.matches('span.tag.sb-tag-overflow')).toBe(true);
        expect(overflow.textContent).toBe('+2');
        expect(overflow.title).toBe('Four, Five');
        expect(overflow.getAttribute('aria-label')).toBe('Four, Five');
        expect(overflow.hasAttribute('tabindex')).toBe(false);
        expect(overflow.tabIndex).toBe(-1);
    });

    test.each([0, 1, 3])('has no overflow when %i chips fit', count => {
        const container = tags(['One', 'Two', 'Three'].slice(0, count));
        limitTagChips(container);

        expect(container.querySelector('.sb-tag-overflow')).toBeNull();
        expect([...container.children].every(chip => !chip.hidden)).toBe(true);
    });

    test('always hides the upstream expander and excludes it from the count', () => {
        const container = tags(['One', 'Two', 'Three', 'Four']);
        const expander = node('span', '...');
        expander.className = 'tag placeholder-expander';
        container.prepend(expander);
        limitTagChips(container);

        expect(expander.hidden).toBe(true);
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+1');
        expect(container.querySelector('.sb-tag-overflow').title).toBe('Four');
    });

    test('recomputes after removals, additions, renames and a changed limit without accumulating counts', () => {
        const container = tags(['One', 'Two', 'Three', 'Four', 'Five']);
        limitTagChips(container);
        const firstResult = container.innerHTML;
        limitTagChips(container);
        expect(container.innerHTML).toBe(firstResult);

        container.firstElementChild.remove();
        container.querySelector('.tag_name').textContent = 'Renamed';
        const last = node('span', 'Six');
        last.className = 'tag';
        container.append(last);
        limitTagChips(container, { max: 1 });

        expect(container.querySelectorAll('.sb-tag-overflow')).toHaveLength(1);
        expect(container.querySelector('.sb-tag-overflow').title).toBe('Three, Four, Five, Six');
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+4');
        expect(container.firstElementChild.textContent).toBe('Renamed');
        limitTagChips(container, { max: 5 });
        expect(container.querySelector('.sb-tag-overflow')).toBeNull();
        expect([...container.children].every(chip => !chip.hidden)).toBe(true);
    });

    test('supports a zero limit and treats tag names as plain text', () => {
        const container = tags(['<img src=x>', ' A & B ']);
        limitTagChips(container, { max: 0 });

        expect(container.querySelectorAll('.tag[hidden]')).toHaveLength(2);
        expect(container.lastElementChild.textContent).toBe('+2');
        expect(container.lastElementChild.title).toBe('<img src=x>, A & B');
        expect(container.querySelector('img')).toBeNull();
    });

    test('counts all 60 names despite the upstream 50-chip render limit', () => {
        const allNames = Array.from({ length: 60 }, (_, index) => `Tag ${index + 1}`);
        const container = tags(allNames.slice(0, 50));
        const expander = node('span', '...');
        expander.className = 'tag placeholder-expander';
        container.append(expander);
        limitTagChips(container, { allNames });

        expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(3);
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+57');
        expect(container.querySelector('.sb-tag-overflow').title).toBe(allNames.slice(3).join(', '));
        expect(container.querySelector('.sb-tag-overflow').getAttribute('aria-label')).toBe(allNames.slice(3).join(', '));
        expect(expander.hidden).toBe(true);

        limitTagChips(container, { max: 100, allNames });
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+10');
        expect(container.querySelector('.sb-tag-overflow').title).toBe(allNames.slice(50).join(', '));
        limitTagChips(container, { max: 0, allNames });
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+60');
        expect(container.querySelector('.sb-tag-overflow').title).toBe(allNames.join(', '));
    });

    test('counts names even when no chips were rendered and does not retain a mutable caller array', () => {
        const allNames = ['One', 'Two'];
        const container = tags([]);
        limitTagChips(container, { allNames });
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+2');
        expect(container.querySelector('.sb-tag-overflow').title).toBe('One, Two');
        allNames.push('Three');
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+2');
        limitTagChips(container, { allNames });
        expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+3');
        expect(container.querySelectorAll('.sb-tag-overflow')).toHaveLength(1);
    });

    test('rejects invalid containers and limits at the boundary', () => {
        expect(() => limitTagChips(null)).toThrow(TypeError);
        for (const max of [-1, 1.5, NaN, Infinity, '3']) {
            expect(() => limitTagChips(tags(['One']), { max })).toThrow(RangeError);
        }
        for (const allNames of [null, 'One', [1]]) {
            expect(() => limitTagChips(tags(['One']), { allNames })).toThrow(TypeError);
        }
    });

    describe('width fitting', () => {
        const targets = new Set();
        const observe = jest.fn(container => targets.add(container));
        const unobserve = jest.fn(container => targets.delete(container));
        let onResize;
        let widths;
        let readWidth;
        const ResizeObserverMock = jest.fn(function (callback) {
            onResize = callback;
            this.observe = observe;
            this.unobserve = unobserve;
        });

        function resize(containers = [...targets]) {
            onResize(containers.map(container => ({ target: container, contentRect: { width: widths.get(container) ?? 0 } })));
        }

        function strip(names, width, chipWidths = []) {
            const container = tags(names);
            container.style.columnGap = '6px';
            widths.set(container, width);
            [...container.children].forEach((chip, index) => widths.set(chip, chipWidths[index] ?? 40));
            document.body.append(container.closest('.ds-entity-row'));
            return container;
        }

        beforeEach(() => {
            widths = new WeakMap();
            observe.mockClear();
            unobserve.mockClear();
            globalThis.ResizeObserver = ResizeObserverMock;
            readWidth = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
                const width = this.matches('.sb-tag-overflow--measure')
                    ? (this.textContent.length > 2 ? 36 : 28)
                    : widths.get(this) ?? 0;
                return { width, height: 28, top: 0, left: 0, right: width, bottom: 28 };
            });
        });

        afterEach(() => {
            for (const container of targets) container.closest('.ds-entity-row')?.remove();
            if (onResize) resize();
            delete globalThis.ResizeObserver;
        });

        test('lazily shares one observer and fits leading whole chips with the overflow count', () => {
            expect(ResizeObserverMock).not.toHaveBeenCalled();
            const container = strip(['One', 'Two', 'Three', 'Four', 'Five'], 130, [50, 40, 60]);
            const other = strip(['Other'], 100);
            limitTagChips(container);
            limitTagChips(other);

            expect(ResizeObserverMock).toHaveBeenCalledTimes(1);
            expect(observe.mock.calls).toEqual([[container], [other]]);
            expect(readWidth).not.toHaveBeenCalled();
            resize();

            expect([...container.querySelectorAll('.tag:not(.sb-tag-overflow)')].map(chip => chip.hidden)).toEqual([false, false, true, true, true]);
            const overflow = container.querySelector('.sb-tag-overflow');
            expect(overflow.textContent).toBe('+3');
            expect(overflow.title).toBe('Three, Four, Five');
            expect(overflow.getAttribute('aria-label')).toBe('Three, Four, Five');
            expect(overflow.hasAttribute('tabindex')).toBe(false);
            expect(container.querySelectorAll('.sb-tag-overflow')).toHaveLength(1);
            expect(other.querySelector('.sb-tag-overflow')).toBeNull();
        });

        test('shows only the total count when the first chip cannot fit', () => {
            const container = strip(['One', 'Two', 'Three'], 40, [50]);
            limitTagChips(container);
            resize();

            expect(container.querySelectorAll('.tag[hidden]')).toHaveLength(3);
            const overflow = container.querySelector('.sb-tag-overflow');
            expect(overflow.textContent).toBe('+3');
            expect(overflow.title).toBe('One, Two, Three');
            expect(overflow.getAttribute('aria-label')).toBe('One, Two, Three');
        });

        test('resizes in both directions without exceeding max or repeating work for height-only notifications', () => {
            const container = strip(['One', 'Two', 'Three', 'Four', 'Five'], 130, [50, 40, 60]);
            limitTagChips(container);
            resize();
            widths.set(container, 100);
            resize();
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+4');
            widths.set(container, 1000);
            resize();
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(3);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+2');
            readWidth.mockClear();
            resize();
            expect(readWidth).not.toHaveBeenCalled();
        });

        test('removes overflow when all chips fit and restores it when the strip narrows', () => {
            const container = strip(['One', 'Two'], 96, [50, 40]);
            limitTagChips(container);
            resize();
            expect(container.querySelector('.sb-tag-overflow')).toBeNull();
            widths.set(container, 95);
            resize();
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+1');
            expect(container.querySelector('.sb-tag-overflow').title).toBe('Two');
        });

        test('uses the actual overflow count width across a digit boundary', () => {
            const container = strip(Array.from({ length: 12 }, (_, index) => `Tag ${index + 1}`), 146, [30, 30, 40]);
            limitTagChips(container);
            resize();
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(3);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+9');
        });

        test('fits and resizes using all 60 names rather than only the 50 rendered chips', () => {
            const allNames = Array.from({ length: 60 }, (_, index) => `Tag ${index + 1}`);
            const container = strip(allNames.slice(0, 50), 130, [50, 40, 60]);
            limitTagChips(container, { allNames });
            resize();
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(1);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+59');
            expect(container.querySelector('.sb-tag-overflow').title).toBe(allNames.slice(1).join(', '));

            widths.set(container, 138);
            resize();
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+58');
            expect(container.querySelector('.sb-tag-overflow').getAttribute('aria-label')).toBe(allNames.slice(2).join(', '));
            widths.set(container, 40);
            resize();
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+60');
            expect(container.querySelector('.sb-tag-overflow').title).toBe(allNames.join(', '));
        });

        test('waits for a content-visibility row to receive a laid-out width', () => {
            const container = strip(['One', 'Two', 'Three', 'Four'], 0, [50]);
            container.closest('.ds-entity-row').style.contentVisibility = 'auto';
            limitTagChips(container);
            resize();
            expect(readWidth).not.toHaveBeenCalled();
            expect(targets.has(container)).toBe(true);
            widths.set(container, 84);
            resize();
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(1);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+3');
        });

        test('re-limiting unobserves and recomputes changed chips even at the same width', () => {
            const container = strip(['One', 'Two', 'Three', 'Four'], 130, [50, 40, 60]);
            limitTagChips(container);
            resize();
            container.firstElementChild.remove();
            container.querySelector('.tag_name').textContent = 'Renamed';
            const added = node('span', 'Added');
            added.className = 'tag';
            widths.set(added, 40);
            container.append(added);
            limitTagChips(container, { max: 1 });
            expect(unobserve).toHaveBeenCalledWith(container);
            expect(observe).toHaveBeenCalledTimes(2);
            resize();
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(1);
            expect(container.firstElementChild.textContent).toBe('Renamed');
            expect(container.querySelector('.sb-tag-overflow').title).toBe('Three, Four, Added');
            expect(container.querySelectorAll('.sb-tag-overflow')).toHaveLength(1);
        });

        test('releases disconnected strips before measurement and allows a fresh observation', () => {
            const container = strip(['One', 'Two', 'Three', 'Four'], 84, [50]);
            limitTagChips(container);
            const row = container.closest('.ds-entity-row');
            row.remove();
            resize();
            expect(unobserve).toHaveBeenCalledWith(container);
            expect(targets.has(container)).toBe(false);
            expect(readWidth).not.toHaveBeenCalled();

            document.body.append(row);
            resize([container]);
            expect(readWidth).not.toHaveBeenCalled();
            limitTagChips(container);
            resize();
            expect(targets.has(container)).toBe(true);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+3');
        });

        test('empty re-limits and fit:false release previous observation and keep fixed-max behavior', () => {
            const container = strip(['One', 'Two', 'Three', 'Four'], 10);
            limitTagChips(container);
            resize();
            limitTagChips(container, { max: 2, fit: false });
            expect(targets.has(container)).toBe(false);
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(2);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+2');
            limitTagChips(container);
            container.replaceChildren();
            limitTagChips(container);
            expect(targets.has(container)).toBe(false);
            expect(container.children).toHaveLength(0);
        });

        test('falls back to fixed max without ResizeObserver, even after an observer was previously available', () => {
            delete globalThis.ResizeObserver;
            const container = strip(['One', 'Two', 'Three', 'Four'], 1);
            limitTagChips(container);
            expect(observe).not.toHaveBeenCalled();
            expect(readWidth).not.toHaveBeenCalled();
            expect(container.querySelectorAll('.tag:not([hidden], .sb-tag-overflow)')).toHaveLength(3);
            expect(container.querySelector('.sb-tag-overflow').textContent).toBe('+1');
        });

        test('batches width reads for every strip before writing final hidden states', () => {
            const first = strip(['One', 'Two', 'Three'], 84, [50]);
            const second = strip(['A', 'B', 'C'], 84, [50]);
            limitTagChips(first);
            limitTagChips(second);
            const operations = [];
            const hiddenSetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden').set;
            jest.spyOn(HTMLElement.prototype, 'hidden', 'set').mockImplementation(function (value) {
                operations.push('write');
                hiddenSetter.call(this, value);
            });
            const measureWidth = readWidth.getMockImplementation();
            readWidth.mockImplementation(function () {
                operations.push('read');
                return measureWidth.call(this);
            });
            resize();

            const firstRead = operations.indexOf('read');
            const lastRead = operations.lastIndexOf('read');
            expect(firstRead).toBeGreaterThan(0);
            expect(operations.slice(firstRead, lastRead + 1).every(operation => operation === 'read')).toBe(true);
            expect(operations.slice(lastRead + 1).every(operation => operation === 'write')).toBe(true);
            expect(first.querySelector('.sb-tag-overflow').textContent).toBe('+2');
            expect(second.querySelector('.sb-tag-overflow').textContent).toBe('+2');
        });
    });
});

describe('entity keys', () => {
    test('builds saved agent keys without changing the persisted ID', () => {
        expect(entityKey('agent', 'saved:helper')).toBe('agent:saved:helper');
        expect(entityKey('agent', 0)).toBe('agent:0');
    });

    test('uses a distinct namespace for unused agent templates even when IDs collide', () => {
        expect(entityKey('agent-template', 'tpl-helper')).toBe('agent-template:tpl-helper');
        expect(entityKey('agent-template', 'tpl-helper')).not.toBe(entityKey('agent', 'tpl-helper'));
    });

    test('builds keys for each supported kind and preserves numeric zero', () => {
        for (const kind of ['character', 'group', 'tag', 'persona']) {
            expect(entityKey(kind, 'stable:id')).toBe(`${kind}:stable:id`);
        }
        expect(entityKey('group', 0)).toBe('group:0');
    });

    test('rejects unsupported entity kinds with a TypeError', () => {
        for (const kind of ['', 'world-info', 'Character', undefined, null, 0]) {
            expect(() => entityKey(kind, 'id')).toThrow(TypeError);
        }
    });

    test('uses the namespaced list key rather than legacy motion keys', () => {
        const { row } = makeRow({ attributes: { 'data-avatar': 'legacy.png', 'data-id': 'legacy' } });

        expect(ENTITY_ROW_SELECTOR).toBe('.ds-entity-row');
        expect(entityRowMotionKey(row)).toBe('character:Alice.png');
        expect(entityRowMotionKey(node('div'))).toBeUndefined();
    });
});
