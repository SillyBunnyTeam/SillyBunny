/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { MenuItem } from '../public/scripts/extensions/quick-reply/src/ui/ctx/MenuItem.js';
import { SubMenu } from '../public/scripts/extensions/quick-reply/src/ui/ctx/SubMenu.js';

let originalWindow;

beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = {
        innerWidth: 1000,
        innerHeight: 800,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    };
});

afterEach(() => {
    if (originalWindow === undefined) {
        delete globalThis.window;
    } else {
        globalThis.window = originalWindow;
    }
});

describe('Quick Reply context menu activation', () => {
    test('toggles an active desktop-hover submenu closed on click', () => {
        const item = new MenuItem(null, true, 'Nested', null, {}, null, [{}]);
        const hide = jest.fn();
        item.subMenu = {
            isActive: true,
            hide,
            show: jest.fn(),
        };

        item.toggle();

        expect(hide).toHaveBeenCalledTimes(1);
    });

    test('expands from mouse hover and ignores touch pointer entry', () => {
        const item = new MenuItem(null, true, 'Nested', null, {}, null, [{}]);
        const show = jest.fn();
        item.root = {};
        item.subMenu = {
            isActive: false,
            hide: jest.fn(),
            show,
        };
        item.onExpand = jest.fn();

        item.expandFromHover({ pointerType: 'touch' });

        expect(show).not.toHaveBeenCalled();
        expect(item.onExpand).not.toHaveBeenCalled();

        item.expandFromHover({ pointerType: 'mouse' });

        expect(show).toHaveBeenCalledWith(item.root);
        expect(item.onExpand).toHaveBeenCalledTimes(1);
    });
});

describe('Quick Reply portaled submenu placement', () => {
    test('hides a submenu after its trigger scrolls outside the parent menu', () => {
        const submenu = new SubMenu([]);
        const remove = jest.fn();
        submenu.isActive = true;
        submenu.parent = {
            isConnected: true,
            getBoundingClientRect: () => ({ left: 20, right: 220, top: 600, bottom: 640 }),
        };
        submenu.layer = { isConnected: true };
        submenu.scrollParent = {
            getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 500 }),
        };
        submenu.root = {
            isConnected: true,
            remove,
            style: {},
        };

        submenu.place();

        expect(remove).toHaveBeenCalledTimes(1);
        expect(submenu.isActive).toBe(false);
    });

    test('cleans listeners when initial placement hides the submenu', () => {
        const submenu = new SubMenu([]);
        const layer = {
            isConnected: true,
            append: jest.fn(),
        };
        const scrollParent = {
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 500 }),
        };
        const closestElements = new Map([
            ['.ctx-blocker', layer],
            ['.ctx-menu', scrollParent],
        ]);
        submenu.parent = null;
        submenu.root = {
            isConnected: true,
            remove: jest.fn(),
            style: {},
        };
        const parent = {
            isConnected: true,
            closest: selector => closestElements.get(selector),
            getBoundingClientRect: () => ({ left: 20, right: 220, top: 600, bottom: 640 }),
        };

        submenu.show(parent);

        expect(globalThis.window.addEventListener).toHaveBeenCalledTimes(1);
        expect(globalThis.window.removeEventListener).toHaveBeenCalledTimes(1);
        expect(scrollParent.addEventListener).toHaveBeenCalledTimes(1);
        expect(scrollParent.removeEventListener).toHaveBeenCalledTimes(1);
        expect(submenu.viewportResizeHandler).toBeNull();
        expect(submenu.isActive).toBe(false);
    });

    test('repositions active descendants after the parent submenu moves', () => {
        const placeDescendant = jest.fn();
        const submenu = new SubMenu([{ subMenu: { place: placeDescendant } }]);
        submenu.isActive = true;
        submenu.parent = {
            isConnected: true,
            getBoundingClientRect: () => ({ left: 100, right: 200, top: 100, bottom: 140 }),
        };
        submenu.layer = {
            isConnected: true,
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
        };
        submenu.scrollParent = {
            getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 500 }),
        };
        submenu.root = {
            isConnected: true,
            clientHeight: 200,
            clientWidth: 200,
            scrollHeight: 200,
            scrollWidth: 200,
            style: {},
            getBoundingClientRect: () => ({ width: 200, height: 200 }),
        };

        submenu.place();

        expect(placeDescendant).toHaveBeenCalledTimes(1);
        expect(submenu.root.style.visibility).toBe('visible');
    });
});
