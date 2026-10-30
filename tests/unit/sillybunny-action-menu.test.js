/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ translate: value => value }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(), animateOut: (_node, _frames, hide) => hide(), play: jest.fn(), stopMotion: jest.fn(),
    MOTION_FAST: 0, MOTION_POPOVER_CLOSE: 0, MOTION_EASE_OUT_CUBIC: 'linear', SPRING_SHEET: {},
}));
const createSheetController = jest.fn(options => ({
    open() {
        options.sheet.hidden = false;
        options.backdrop.hidden = false;
        options.getInitialFocus()?.focus();
    },
    close({ restoreFocus = true } = {}) {
        options.sheet.hidden = true;
        options.backdrop.hidden = true;
        if (restoreFocus) options.getReturnFocus()?.focus();
        options.onClose();
        // The real controller calls onHidden once the exit motion has ended, which is at once without motion.
        if (exitMotion) {
            pendingExits.push(options.onHidden);
        } else {
            options.onHidden?.();
        }
    },
}));
let exitMotion = false;
const pendingExits = [];
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(), createSheetController,
}));
const { openActionMenu, openPopover, closeActionMenu, isActionMenuOpen, positionPopover, getRevealScrollTop } = await import('../../public/scripts/sillybunny-action-menu.js');
let mobileMatches = false;

beforeEach(() => {
    document.body.replaceChildren();
    mobileMatches = false;
    exitMotion = false;
    pendingExits.length = 0;
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
    test('opens custom content in the anchored shared popover host', () => {
        const button = trigger();
        const content = document.createElement('form');
        const label = document.createElement('strong');
        label.textContent = 'Create';
        const input = document.createElement('input');
        content.append(label, input);
        openPopover({ trigger: button, content, title: 'Create', titleLabel: label, titleInput: input, initialFocus: () => input });

        const popover = document.querySelector('.sb-custom-popover');
        expect(popover.contains(content)).toBe(true);
        expect(popover.getAttribute('role')).toBe('dialog');
        expect(document.activeElement).toBe(input);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(label.id).toBe('sb-custom-popover-title');
        expect(input.getAttribute('aria-labelledby')).toBe(label.id);
    });

    test('the same trigger closes an open custom popover', () => {
        const button = trigger();
        const firstContent = document.createElement('div');
        openPopover({ trigger: button, content: firstContent });

        const secondContent = document.createElement('div');
        const second = openPopover({ trigger: button, content: secondContent });

        expect(second.isOpen).toBe(false);
        expect(isActionMenuOpen(button)).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('.sb-custom-popover')).toBeNull();
    });

    test('custom popovers cycle Tab and Shift+Tab through enabled controls', () => {
        const button = trigger();
        const content = document.createElement('div');
        const input = document.createElement('input');
        const create = document.createElement('button');
        create.textContent = 'Create';
        content.append(input, create);
        openPopover({ trigger: button, content, initialFocus: () => input });

        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(create);
        create.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(create);
    });

    test('popover sheets focus the surface, expose the shared grab handle, and allow a handle swipe', () => {
        mobileMatches = true;
        const button = trigger();
        const content = document.createElement('form');
        const input = document.createElement('input');
        content.append(input);
        openPopover({ trigger: button, content, title: 'Create' });

        const sheet = document.querySelector('.sb-action-sheet');
        const title = sheet.querySelector('.sb-action-sheet-title');
        const handle = sheet.querySelector('.sb-dialog__handle');
        expect(sheet).not.toBeNull();
        expect(document.activeElement).toBe(sheet);
        expect(document.activeElement).not.toBe(title);
        expect(handle).not.toBeNull();
        const down = new Event('pointerdown', { bubbles: true });
        const up = new Event('pointerup', { bubbles: true });
        for (const [event, clientY] of [[down, 0], [up, 120]]) {
            Object.defineProperties(event, { pointerId: { value: 1 }, clientY: { value: clientY }, button: { value: 0 } });
        }
        handle.dispatchEvent(down);
        handle.dispatchEvent(up);
        expect(sheet.hidden).toBe(true);
        expect(document.activeElement).toBe(button);
    });

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
        expect(radioItems[0].querySelector('.sb-action-menu-indicator')).not.toBeNull();
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

    test('writes an item\'s data entries to its dataset and leaves other items alone', () => {
        openActionMenu({
            trigger: trigger(), keyboard: true,
            sections: [{ items: [
                { label: 'Marked', data: { sbStub: 'true' }, onSelect() {} },
                { label: 'Plain', onSelect() {} },
            ] }],
        });
        const [marked, plain] = [...document.querySelectorAll('[role="menuitem"]')];
        expect(marked.dataset.sbStub).toBe('true');
        expect('sbStub' in plain.dataset).toBe(false);
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

describe('a closed bottom sheet leaves nothing behind', () => {
    const itemSections = [{ items: [{ label: 'One', onSelect() {} }, { label: 'Two', onSelect() {} }] }];

    test('removes the sheet, its backdrop and its menu once the sheet has hidden', () => {
        mobileMatches = true;
        const button = trigger();
        openActionMenu({ trigger: button, sections: itemSections });
        expect(document.querySelectorAll('.sb-action-sheet, .sb-action-sheet-backdrop, #sb-action-menu')).toHaveLength(3);

        closeActionMenu({ restoreFocus: true });

        expect(document.querySelectorAll('.sb-action-sheet, .sb-action-sheet-backdrop, #sb-action-menu')).toHaveLength(0);
        expect(button.hasAttribute('aria-controls')).toBe(false);
    });

    test('closing by choosing an item removes it too, and the next menu opens in a fresh sheet', () => {
        mobileMatches = true;
        const onSelect = jest.fn();
        openActionMenu({ trigger: trigger(), sections: [{ items: [{ label: 'Pick', onSelect }] }] });
        const first = document.querySelector('.sb-action-sheet');
        document.querySelector('[role="menuitem"]').click();
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.sb-action-sheet')).toBeNull();

        openActionMenu({ trigger: trigger(), sections: itemSections });

        expect(document.querySelectorAll('.sb-action-sheet')).toHaveLength(1);
        expect(document.querySelector('.sb-action-sheet')).not.toBe(first);
        expect(document.querySelectorAll('#sb-action-menu')).toHaveLength(1);
        expect(document.querySelector('.sb-action-sheet').hidden).toBe(false);
    });

    test('the sheet does not carry a caller marker over to the next menu', () => {
        mobileMatches = true;
        openActionMenu({ trigger: trigger(), sections: itemSections });
        document.querySelector('.sb-action-sheet').dataset.sbPromptMenu = 'true';
        closeActionMenu();

        openActionMenu({ trigger: trigger(), sections: itemSections });

        expect(document.querySelector('.sb-action-sheet').dataset.sbPromptMenu).toBeUndefined();
    });

    test('opening a different menu while a sheet is open replaces the sheet', () => {
        mobileMatches = true;
        openActionMenu({ trigger: trigger(), sections: itemSections });
        openActionMenu({ trigger: trigger(), sections: itemSections });

        expect(document.querySelectorAll('.sb-action-sheet')).toHaveLength(1);
        expect(document.querySelectorAll('.sb-action-sheet-backdrop')).toHaveLength(1);
        expect(document.querySelectorAll('#sb-action-menu')).toHaveLength(1);
    });

    test('a popover opened after a sheet is the only menu with the id its trigger controls', () => {
        mobileMatches = true;
        openActionMenu({ trigger: trigger(), sections: itemSections });
        closeActionMenu();

        mobileMatches = false;
        const button = trigger();
        openActionMenu({ trigger: button, sections: itemSections });

        expect(document.querySelectorAll('#sb-action-menu')).toHaveLength(1);
        expect(document.getElementById(button.getAttribute('aria-controls')).closest('.sb-action-popover')).not.toBeNull();
    });

    test('a sheet that is still leaving does not share its ids with the menu that opens next', () => {
        mobileMatches = true;
        exitMotion = true;
        openActionMenu({ trigger: trigger(), sections: itemSections });
        const leaving = document.querySelector('.sb-action-sheet');
        closeActionMenu();
        expect(document.querySelector('.sb-action-sheet')).toBe(leaving);

        openActionMenu({ trigger: trigger(), sections: itemSections });

        expect(document.querySelectorAll('.sb-action-sheet')).toHaveLength(2);
        expect(document.querySelectorAll('#sb-action-menu')).toHaveLength(1);
        expect(document.querySelectorAll('#sb-action-sheet-title')).toHaveLength(1);
        expect(document.querySelector('#sb-action-menu').closest('.sb-action-sheet')).not.toBe(leaving);
        expect(leaving.hasAttribute('aria-labelledby')).toBe(false);
        for (const hidden of pendingExits.splice(0)) hidden();
        expect(document.querySelectorAll('.sb-action-sheet')).toHaveLength(1);
    });

    test('a custom popover sheet releases the caller content when it closes', () => {
        mobileMatches = true;
        const content = document.createElement('form');
        openPopover({ trigger: trigger(), content, title: 'Create' });
        expect(content.isConnected).toBe(true);

        closeActionMenu();

        expect(document.querySelector('.sb-action-sheet')).toBeNull();
        expect(content.isConnected).toBe(false);
    });
});

describe('popover placement inside its bounds', () => {
    function place({ anchor, bounds, scrollHeight = 335 }) {
        const button = trigger();
        jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 700, right: 740, ...anchor });
        const surface = document.createElement('div');
        Object.defineProperty(surface, 'offsetWidth', { value: 220 });
        Object.defineProperty(surface, 'scrollHeight', { value: scrollHeight });
        const boundsElement = { getBoundingClientRect: () => ({ left: 0, right: 800, width: 800, ...bounds }) };
        positionPopover(surface, button, null, boundsElement);
        const top = Number.parseInt(surface.style.top, 10);
        return { top, bottom: top + Number.parseInt(surface.style.maxBlockSize, 10), maxBlockSize: Number.parseInt(surface.style.maxBlockSize, 10) };
    }

    test('opens below the trigger and caps its height to the room that is left', () => {
        const placed = place({ anchor: { top: 20, bottom: 60 }, bounds: { top: 0, bottom: 300 } });

        expect(placed.top).toBe(66);
        expect(placed.maxBlockSize).toBe(226);
        expect(placed.bottom).toBeLessThanOrEqual(292);
    });

    test('flips above the trigger when that side has more room', () => {
        const placed = place({ anchor: { top: 340, bottom: 380 }, bounds: { top: 0, bottom: 390 } });

        expect(placed.bottom).toBeLessThanOrEqual(340);
        expect(placed.top).toBeGreaterThanOrEqual(8);
    });

    test('stays inside bounds that are shorter than the minimum height on both sides of the trigger', () => {
        const placed = place({ anchor: { top: 70, bottom: 110 }, bounds: { top: 0, bottom: 200 } });

        expect(placed.top).toBeGreaterThanOrEqual(8);
        expect(placed.bottom).toBeLessThanOrEqual(192);
    });

    test('stays inside bounds that do not start at the top of the window', () => {
        const placed = place({ anchor: { top: 260, bottom: 300 }, bounds: { top: 200, bottom: 330 } });

        expect(placed.top).toBeGreaterThanOrEqual(208);
        expect(placed.bottom).toBeLessThanOrEqual(322);
    });
});

describe('revealing a focused row in a scrolling menu', () => {
    const view = { scrollTop: 100, viewTop: 50, viewBottom: 300 };

    test.each([
        ['leaves a row that is fully visible where it is', { itemTop: 120, itemBottom: 152 }, 100],
        ['scrolls up by the part of the row that is above the view', { itemTop: 20, itemBottom: 52 }, 70],
        ['scrolls down by the part of the row that is below the view', { itemTop: 290, itemBottom: 322 }, 122],
    ])('%s', (_name, item, expected) => {
        expect(getRevealScrollTop({ ...view, ...item })).toBe(expected);
    });
});

describe('popover placement inside the visual viewport', () => {
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    afterEach(() => {
        if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
        else delete window.visualViewport;
    });

    function placeIn(viewport, { anchor, bounds = null, scrollHeight = 335 }) {
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        const button = trigger();
        jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 700, right: 740, ...anchor });
        const surface = document.createElement('div');
        Object.defineProperty(surface, 'offsetWidth', { value: 220 });
        Object.defineProperty(surface, 'scrollHeight', { value: scrollHeight });
        const boundsElement = bounds && { getBoundingClientRect: () => ({ left: 0, right: 800, width: 800, ...bounds }) };
        positionPopover(surface, button, null, boundsElement);
        const top = Number.parseInt(surface.style.top, 10);
        const height = Math.min(scrollHeight, Number.parseInt(surface.style.maxBlockSize, 10));
        return { top, left: Number.parseInt(surface.style.left, 10), height, bottom: top + height };
    }

    test('caps the menu to a visual viewport that is shorter than the window, with no bounds element', () => {
        const placed = placeIn({ width: 1024, height: 200, offsetLeft: 0, offsetTop: 0 }, { anchor: { top: 20, bottom: 60 } });

        expect(placed.bottom).toBeLessThanOrEqual(192);
    });

    test('caps the menu to the part of tall bounds that the visual viewport shows', () => {
        const placed = placeIn({ width: 1024, height: 200, offsetLeft: 0, offsetTop: 0 }, { anchor: { top: 20, bottom: 60 }, bounds: { top: -400, bottom: 1700 } });

        expect(placed.top).toBeGreaterThanOrEqual(8);
        expect(placed.bottom).toBeLessThanOrEqual(192);
    });

    test('keeps the menu below the top of a visual viewport that is scrolled down inside the window', () => {
        const placed = placeIn({ width: 1024, height: 300, offsetLeft: 0, offsetTop: 100 }, { anchor: { top: 120, bottom: 160 } });

        expect(placed.top).toBeGreaterThanOrEqual(108);
        expect(placed.bottom).toBeLessThanOrEqual(392);
    });

    test('places the menu in a zoomed and panned visual viewport whose size WebKit reports as the window size', () => {
        const original = { width: window.innerWidth, height: window.innerHeight };
        const reportWindowSize = (width, height) => {
            Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
            Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
        };
        try {
            reportWindowSize(422, 300);
            const placed = placeIn({ width: 422, height: 300, offsetLeft: 422, offsetTop: 200 }, { anchor: { top: 220, bottom: 260, left: 450, right: 490 } });

            expect(placed.left).toBeGreaterThanOrEqual(430);
            expect(placed.left + 220).toBeLessThanOrEqual(836);
            expect(placed.top).toBeGreaterThanOrEqual(208);
            expect(placed.bottom).toBeLessThanOrEqual(492);
            expect(placed.height).toBeGreaterThan(0);
        } finally {
            reportWindowSize(original.width, original.height);
        }
    });

    test('uses the window when the browser has no visual viewport', () => {
        const placed = placeIn(undefined, { anchor: { top: 20, bottom: 60 } });

        expect(placed.top).toBe(66);
        expect(placed.bottom).toBe(401);
    });
});

describe('popover inline alignment', () => {
    function placeAt(direction, alignment, anchor = { left: 300, right: 340 }) {
        const button = trigger();
        button.style.direction = direction;
        jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, ...anchor });
        const surface = document.createElement('div');
        Object.defineProperty(surface, 'offsetWidth', { value: 220 });
        Object.defineProperty(surface, 'scrollHeight', { value: 120 });
        positionPopover(surface, button, null, null, alignment);
        return Number.parseInt(surface.style.left, 10);
    }

    test.each([['ltr', 120], ['rtl', 300]])('aligns the inline end of the menu with the inline end of a %s trigger', (direction, expectedLeft) => {
        expect(placeAt(direction, 'end')).toBe(expectedLeft);
    });

    test('still keeps an end-aligned menu inside the bounds of the window', () => {
        expect(placeAt('ltr', 'end', { left: 10, right: 50 })).toBe(8);
    });

    test('an action menu keeps its alignment when the page scrolls under it', () => {
        const button = trigger();
        const rect = jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, left: 700, right: 740 });
        jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
        openActionMenu({ trigger: button, alignment: 'end', sections: [{ items: [{ label: 'One', onSelect() {} }] }] });
        const popover = document.querySelector('.sb-action-popover');
        const placedAtOpen = popover.style.left;

        // A trigger in the start half would align to its start edge on its own, so only the stored alignment gives 20px.
        rect.mockReturnValue({ top: 100, bottom: 140, left: 200, right: 240 });
        document.dispatchEvent(new Event('scroll'));

        expect(placedAtOpen).toBe('520px');
        expect(popover.style.left).toBe('20px');
    });
});

describe('an open popover follows the visual viewport', () => {
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    let visual;
    let frames;
    let rect;

    beforeEach(() => {
        visual = Object.assign(new EventTarget(), { width: 1024, height: 768, offsetLeft: 0, offsetTop: 0 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
        frames = [];
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
        jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames[id - 1] = null; });
        jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
    });
    afterEach(() => {
        if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
        else delete window.visualViewport;
    });

    function openAt(options = {}) {
        const button = trigger();
        rect = jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, left: 700, right: 740 });
        openActionMenu({ trigger: button, sections: [{ items: [{ label: 'One', onSelect() {} }] }], ...options });
        flushFrames();
        rect.mockClear();
        return button;
    }
    function flushFrames() {
        const due = frames.splice(0);
        for (const callback of due) callback?.();
    }

    test('moves once per frame however many resize and scroll events arrive', () => {
        openAt({ alignment: 'end' });
        const popover = document.querySelector('.sb-action-popover');
        expect(popover.style.left).toBe('520px');

        visual.height = 200;
        visual.dispatchEvent(new Event('resize'));
        visual.dispatchEvent(new Event('scroll'));
        visual.dispatchEvent(new Event('resize'));

        expect(rect).not.toHaveBeenCalled();
        flushFrames();
        expect(rect).toHaveBeenCalledTimes(1);
        expect(Number.parseInt(popover.style.maxBlockSize, 10)).toBeLessThanOrEqual(200);
        expect(popover.style.left).toBe('520px');

        visual.dispatchEvent(new Event('scroll'));
        flushFrames();
        expect(rect).toHaveBeenCalledTimes(2);
    });

    test('stops following when the menu closes, whichever way it closes', () => {
        const button = openAt();
        visual.dispatchEvent(new Event('resize'));
        closeActionMenu({ animate: false });
        flushFrames();
        expect(rect).not.toHaveBeenCalled();

        openActionMenu({ trigger: button, sections: [{ items: [{ label: 'One', onSelect() {} }] }] });
        flushFrames();
        rect.mockClear();
        openActionMenu({ trigger: trigger(), sections: [{ items: [{ label: 'Two', onSelect() {} }] }] });
        closeActionMenu({ animate: false });
        flushFrames();
        visual.dispatchEvent(new Event('resize'));
        flushFrames();

        expect(rect).not.toHaveBeenCalled();
    });

    test('a custom popover follows too, and a sheet does not listen', () => {
        const custom = trigger();
        const customRect = jest.spyOn(custom, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, left: 700, right: 740 });
        openPopover({ trigger: custom, content: document.createElement('form') });
        flushFrames();
        customRect.mockClear();
        visual.dispatchEvent(new Event('resize'));
        flushFrames();
        expect(customRect).toHaveBeenCalledTimes(1);
        closeActionMenu({ animate: false });

        mobileMatches = true;
        const sheetTrigger = trigger();
        const sheetRect = jest.spyOn(sheetTrigger, 'getBoundingClientRect');
        openActionMenu({ trigger: sheetTrigger, sections: [{ items: [{ label: 'One', onSelect() {} }] }] });
        visual.dispatchEvent(new Event('resize'));
        flushFrames();
        expect(sheetRect).not.toHaveBeenCalled();
    });

    test('a pending move is dropped when the menu closes first', () => {
        openAt();
        visual.dispatchEvent(new Event('resize'));
        closeActionMenu({ animate: false });
        flushFrames();

        expect(rect).not.toHaveBeenCalled();
    });
});
