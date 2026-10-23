/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const { createListHeader } = await import('../../public/scripts/sillybunny-editor/list-header.js');

beforeEach(() => {
    document.body.replaceChildren();
});

function actions() {
    return [
        { id: 'search', label: 'Search', icon: 'magnifying-glass', toggle: true, overflowPriority: 1, onActivate: jest.fn() },
        { id: 'sort', label: 'Sort', icon: 'arrow-down-wide-short', menu: true, overflowPriority: 0, onActivate: jest.fn() },
        { id: 'more', label: 'Actions', icon: 'ellipsis-vertical', menu: true, onActivate: jest.fn() },
    ];
}

describe('createListHeader', () => {
    test('builds the shared header structure and preserves supplied title text', () => {
        const header = createListHeader({ title: 'Characters', subtitle: '3 characters', className: 'character-header custom-header' });
        const { element } = header;
        const titles = element.querySelector('.sb-list-header__titles');
        const title = titles.querySelector('.sb-list-header__title');
        const subtitle = titles.querySelector('.sb-list-header__subtitle');
        const spacer = element.querySelector('.sb-list-header__spacer');

        expect(element.matches('header.sb-list-header.character-header.custom-header')).toBe(true);
        expect(titles.tagName).toBe('DIV');
        expect(title.tagName).toBe('SPAN');
        expect(subtitle.tagName).toBe('SPAN');
        expect(title.textContent).toBe('Characters');
        expect(subtitle.textContent).toBe('3 characters');
        expect([...titles.children]).toEqual([title, subtitle]);
        expect(spacer.tagName).toBe('SPAN');
        expect(spacer.getAttribute('aria-hidden')).toBe('true');
        expect([...element.children]).toEqual([titles, spacer]);
        expect(header.button('missing')).toBeNull();
    });

    test('creates ordered flat icon buttons with caller-provided labels and priorities', () => {
        const controls = actions();
        const header = createListHeader({ title: 'Characters', actions: controls });
        const buttons = [...header.element.querySelectorAll('button')];

        expect(buttons.map(button => button.dataset.actionId)).toEqual(['search', 'sort', 'more']);
        expect([...header.element.children].slice(2)).toEqual(buttons);
        for (const [index, button] of buttons.entries()) {
            expect(header.button(controls[index].id)).toBe(button);
            expect(button.matches('button.sb-list-header__button[type="button"]')).toBe(true);
            expect(button.getAttribute('aria-label')).toBe(controls[index].label);
            expect(button.title).toBe(controls[index].label);
            expect(button.children).toHaveLength(1);
            expect(button.firstChild.matches(`i.fa-solid.fa-${controls[index].icon}[aria-hidden="true"]`)).toBe(true);
            expect(button.textContent).toBe('');
        }
        expect(buttons[0].dataset.overflowPriority).toBe('1');
        expect(buttons[1].dataset.overflowPriority).toBe('0');
        expect(buttons[2].hasAttribute('data-overflow-priority')).toBe(false);
    });

    test('sets menu and toggle accessibility attributes only when requested', () => {
        const header = createListHeader({
            title: 'Characters',
            actions: [
                ...actions(),
                { id: 'selected', label: 'Selected', icon: 'check', toggle: true, pressed: true, onActivate: jest.fn() },
                { id: 'new', label: 'New', icon: 'plus', onActivate: jest.fn() },
            ],
        });

        expect(header.button('search').getAttribute('aria-pressed')).toBe('false');
        expect(header.button('search').hasAttribute('aria-haspopup')).toBe(false);
        expect(header.button('search').hasAttribute('aria-expanded')).toBe(false);
        expect(header.button('sort').getAttribute('aria-haspopup')).toBe('menu');
        expect(header.button('sort').getAttribute('aria-expanded')).toBe('false');
        expect(header.button('sort').hasAttribute('aria-pressed')).toBe(false);
        expect(header.button('selected').getAttribute('aria-pressed')).toBe('true');
        expect(header.button('new').hasAttribute('aria-haspopup')).toBe(false);
        expect(header.button('new').hasAttribute('aria-expanded')).toBe(false);
        expect(header.button('new').hasAttribute('aria-pressed')).toBe(false);
    });

    test('passes the action button to onActivate, including clicks on its icon', () => {
        const controls = actions();
        const header = createListHeader({ title: 'Characters', actions: controls });

        header.button('search').click();
        header.button('sort').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(controls[0].onActivate).toHaveBeenCalledWith(header.button('search'));
        expect(controls[0].onActivate).toHaveBeenCalledTimes(1);
        expect(controls[1].onActivate).toHaveBeenCalledWith(header.button('sort'));
        expect(controls[2].onActivate).not.toHaveBeenCalled();
        expect(header.button('search').getAttribute('aria-pressed')).toBe('false');
        expect(header.button('sort').getAttribute('aria-expanded')).toBe('false');
    });

    test('updates toggle pressed state without adding it to other controls', () => {
        const header = createListHeader({ title: 'Characters', actions: actions() });

        header.setPressed('search', true);
        expect(header.button('search').getAttribute('aria-pressed')).toBe('true');
        header.setPressed('search', false);
        expect(header.button('search').getAttribute('aria-pressed')).toBe('false');
        header.setPressed('sort', true);
        expect(header.button('sort').hasAttribute('aria-pressed')).toBe(false);
        expect(() => header.setPressed('missing', true)).not.toThrow();
    });

    test('updates title and subtitle text without replacing their elements or action buttons', () => {
        const header = createListHeader({ title: 'Characters', actions: actions() });
        const title = header.element.querySelector('.sb-list-header__title');
        const subtitle = header.element.querySelector('.sb-list-header__subtitle');
        const search = header.button('search');

        expect(subtitle.textContent).toBe('');
        header.setTitle('Groups');
        header.setSubtitle('2 groups');

        expect(header.element.querySelector('.sb-list-header__title')).toBe(title);
        expect(header.element.querySelector('.sb-list-header__subtitle')).toBe(subtitle);
        expect(title.textContent).toBe('Groups');
        expect(subtitle.textContent).toBe('2 groups');
        expect(header.button('search')).toBe(search);
        header.setSubtitle('');
        expect(subtitle.textContent).toBe('');
    });

    test('renders updated title and subtitle strings as text rather than HTML', () => {
        const header = createListHeader({ title: 'Characters' });

        header.setTitle('<strong>Groups</strong>');
        header.setSubtitle('<img src=x>');

        expect(header.element.querySelector('.sb-list-header__title').textContent).toBe('<strong>Groups</strong>');
        expect(header.element.querySelector('.sb-list-header__subtitle').textContent).toBe('<img src=x>');
        expect(header.element.querySelector('strong, img')).toBeNull();
    });

    test('hides exactly the overflowed actions and restores them without reordering', () => {
        const header = createListHeader({ title: 'Characters', actions: actions() });
        const order = [...header.element.children];

        header.setOverflowed(['sort', 'search', 'missing']);

        expect(header.button('sort').hidden).toBe(true);
        expect(header.button('search').hidden).toBe(true);
        expect(header.button('more').hidden).toBe(false);
        expect([...header.element.children]).toEqual(order);

        header.setOverflowed(['more']);

        expect(header.button('sort').hidden).toBe(false);
        expect(header.button('search').hidden).toBe(false);
        expect(header.button('more').hidden).toBe(true);
        header.setOverflowed([]);
        expect([...header.element.querySelectorAll('button')].every(button => !button.hidden)).toBe(true);
        expect([...header.element.children]).toEqual(order);
    });

    test('destroy removes every action listener without removing the header', () => {
        const controls = actions();
        const header = createListHeader({ title: 'Characters', actions: controls });
        document.body.append(header.element);
        for (const action of controls) header.button(action.id).click();

        header.destroy();
        header.destroy();
        for (const action of controls) header.button(action.id).click();

        for (const action of controls) expect(action.onActivate).toHaveBeenCalledTimes(1);
        expect(header.element.isConnected).toBe(true);
        expect(header.element.querySelectorAll('button')).toHaveLength(3);
    });
});
