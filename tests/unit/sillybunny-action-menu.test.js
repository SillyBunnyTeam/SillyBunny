/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ translate: value => value }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(), animateOut: (_node, _frames, hide) => hide(), stopMotion: jest.fn(),
    MOTION_FAST: 0, MOTION_POPOVER_CLOSE: 0, MOTION_EASE_OUT_CUBIC: 'linear',
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(), createSheetController: jest.fn(),
}));
const { openActionMenu, closeActionMenu, isActionMenuOpen, positionPopover } = await import('../../public/scripts/sillybunny-action-menu.js');
let mobileMatches = false;

beforeEach(() => {
    document.body.replaceChildren();
    mobileMatches = false;
    window.matchMedia = () => ({ get matches() { return mobileMatches; }, addEventListener: jest.fn() });
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(); return 1; });
});
afterEach(() => {
    closeActionMenu({ animate: false });
    jest.restoreAllMocks();
});

function trigger() {
    const button = document.createElement('button');
    document.body.append(button);
    return button;
}

describe('action menu optional sections', () => {
    test('can keep a nested action menu as a popover on mobile', () => {
        mobileMatches = true;
        openActionMenu({
            trigger: trigger(),
            forcePopover: true,
            sections: [{ items: [{ label: 'Delete', onSelect() {} }] }],
        });

        expect(document.querySelector('.sb-action-popover')).not.toBeNull();
        expect(document.querySelector('.sb-action-sheet')).toBeNull();
    });

    test('radio and checkbox items render state indicators instead of caller icons', () => {
        openActionMenu({
            trigger: trigger(),
            sections: [{ items: [
                { label: 'Selected sort', icon: 'fa-solid fa-check', kind: 'radio', checked: true, onSelect() {} },
                { label: 'Other sort', icon: 'fa-solid fa-check', kind: 'radio', checked: false, onSelect() {} },
                { label: 'Favorite', icon: 'fa-solid fa-star', kind: 'check', checked: true, onSelect() {} },
                { label: 'Not favorite', icon: 'fa-solid fa-star', kind: 'check', checked: false, onSelect() {} },
            ] }],
        });

        const menu = document.querySelector('[role="menu"]');
        const radioItems = [...menu.querySelectorAll('[role="menuitemradio"]')];
        const checkboxItems = [...menu.querySelectorAll('[role="menuitemcheckbox"]')];
        expect(radioItems.map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
        expect(checkboxItems.map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
        expect(radioItems.map(item => item.querySelector('.sb-action-menu-indicator').dataset.kind)).toEqual(['radio', 'radio']);
        expect(radioItems[0].querySelector('.sb-action-menu-indicator-dot')).not.toBeNull();
        expect(radioItems[1].querySelector('.sb-action-menu-indicator-dot')).toBeNull();
        expect(checkboxItems[0].querySelector('.sb-action-menu-indicator-check')).not.toBeNull();
        expect(checkboxItems[1].querySelector('.sb-action-menu-indicator-check')).toBeNull();
        expect(menu.querySelectorAll('.sb-action-menu-item > .fa-check, .sb-action-menu-item > .fa-star')).toHaveLength(0);
    });

    test('titles label groups without becoming keyboard stops and radio items expose checked state', () => {
        openActionMenu({
            trigger: trigger(), title: 'Entries', keyboard: true,
            sections: [
                { title: 'Show', items: [{ label: 'All', checked: true, onSelect() {} }, { label: 'Active', checked: false, onSelect() {} }] },
                { title: 'Sort by', items: [{ label: 'Title', onSelect() {} }] },
                { title: 'Empty', items: [] },
            ],
        });
        const menu = document.querySelector('[role="menu"]');
        const headings = [...menu.querySelectorAll('h3')];
        expect(headings.map(node => node.textContent)).toEqual(['Show', 'Sort by']);
        expect(headings.every(node => node.tabIndex === -1)).toBe(true);
        expect(menu.querySelector('[role="group"]').getAttribute('aria-labelledby')).toBe(headings[0].id);
        expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
        const radios = menu.querySelectorAll('[role="menuitemradio"]');
        expect([...radios].map(node => node.getAttribute('aria-checked'))).toEqual(['true', 'false']);
        expect(document.activeElement).toBe(radios[0]);
        radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(radios[1]);
        radios[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement.textContent).toContain('Title');
    });

    test('untitled sections retain direct items and the same trigger toggles closed after pointerdown', () => {
        const button = trigger();
        const options = { trigger: button, sections: [{ items: [{ label: 'Edit', onSelect() {} }] }] };
        openActionMenu(options);
        expect(document.querySelector('[role="menu"]').firstElementChild.getAttribute('role')).toBe('menuitem');
        button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(isActionMenuOpen(button)).toBe(true);
        openActionMenu(options);
        expect(isActionMenuOpen()).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    test('disabled items expose their state, reject activation and are skipped by arrow navigation', () => {
        const disabledAction = jest.fn();
        const button = trigger();
        openActionMenu({
            trigger: button, keyboard: true,
            sections: [{ items: [
                { label: 'Settings', onSelect() {} },
                { label: 'Rename', disabled: true, onSelect: disabledAction },
                { label: 'Import', onSelect() {} },
            ] }],
        });
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        expect(items[1].getAttribute('aria-disabled')).toBe('true');
        items[1].click();
        expect(disabledAction).not.toHaveBeenCalled();
        expect(isActionMenuOpen(button)).toBe(true);
        items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(items[2]);
    });

    test.each([['ltr', '300px'], ['rtl', '780px']])('explicit inline-start placement supports %s triggers in the trailing half', (direction, expectedLeft) => {
        const button = trigger();
        button.style.direction = direction;
        jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 1000, top: 100, bottom: 140 });
        const surface = document.createElement('div');
        Object.defineProperty(surface, 'offsetWidth', { value: 220 });
        Object.defineProperty(surface, 'scrollHeight', { value: 120 });
        positionPopover(surface, button, null, null, 'start');
        expect(surface.style.left).toBe(expectedLeft);
    });
});
