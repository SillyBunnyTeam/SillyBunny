/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const play = jest.fn();
const stopMotion = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    MOTION_FAST: 0,
    SPRING_SHEET: {},
    play,
    stopMotion,
}));

const { presentMenuAsSheet, adoptComposerMenus } = await import('../../public/scripts/sillybunny-editor/sheet-gestures.js');
const { MENU_SHEET_QUERY } = await import('../../public/scripts/sillybunny-editor/breakpoints.js');
const { readFileSync } = await import('node:fs');

const ATTRIBUTE = 'data-sb-menu-sheet';
let narrow;
let mediaListeners;
let presenters;

function installMatchMedia() {
    mediaListeners = new Set();
    window.matchMedia = jest.fn(() => ({
        get matches() {
            return narrow;
        },
        addEventListener: (type, listener) => mediaListeners.add(listener),
        removeEventListener: (type, listener) => mediaListeners.delete(listener),
    }));
}

function setNarrow(value) {
    narrow = value;
    for (const listener of [...mediaListeners]) listener({ matches: value });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** A menu node as upstream builds it: hidden by inline display, rows in a wrapper, Popper's inline styles on it. */
function makeMenu({ title = 'Extensions' } = {}) {
    const trigger = document.createElement('div');
    trigger.id = 'menu_trigger';
    trigger.tabIndex = 0;
    // jsdom matches :focus-visible for any focus; a pointer opening does not.
    trigger.matches = () => false;
    if (title) trigger.title = title;
    const node = document.createElement('div');
    node.id = 'menu_node';
    node.style.display = 'none';
    node.style.position = 'absolute';
    node.style.transform = 'translate(10px, 20px)';
    node.style.inset = '0px auto auto 0px';
    const wrapper = document.createElement('div');
    wrapper.className = 'options-content';
    for (const label of ['One', 'Two']) {
        const row = document.createElement('a');
        row.tabIndex = 0;
        row.textContent = label;
        wrapper.append(row);
    }
    node.append(wrapper);
    document.body.append(trigger, node);
    // The upstream toggle: a click on the trigger shows or hides the node.
    const click = jest.fn(() => {
        node.style.display = node.style.display === 'none' ? 'block' : 'none';
    });
    trigger.addEventListener('click', click);
    return { trigger, node, wrapper, click };
}

function present(parts, options = {}) {
    const presenter = presentMenuAsSheet({ node: parts.node, getTrigger: () => parts.trigger, ...options });
    presenters.push(presenter);
    return presenter;
}

async function show(node) {
    node.style.display = 'block';
    await flush();
}

async function hide(node) {
    node.style.display = 'none';
    await flush();
}

function pointer(target, type, clientY, timeStamp) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerId: { value: 1 },
        clientY: { value: clientY },
        button: { value: 0 },
        timeStamp: { value: timeStamp },
    });
    target.dispatchEvent(event);
    return event;
}

function escape(target = document.body) {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    narrow = true;
    presenters = [];
    installMatchMedia();
    window.requestAnimationFrame = callback => {
        callback(0);
        return 0;
    };
    // jsdom lays nothing out, so every element counts as rendered.
    Element.prototype.getClientRects = () => [{}];
});

afterEach(() => {
    for (const presenter of presenters) presenter.dispose();
});

describe('the presentation condition', () => {
    test('is the mobile layout or a short window, and the presenter asks for it', async () => {
        const parts = makeMenu();
        present(parts);

        expect(MENU_SHEET_QUERY).toBe('(max-width: 768px), (max-height: 360px)');
        expect(window.matchMedia).toHaveBeenCalledWith(MENU_SHEET_QUERY);
    });

    test('the sheet rules sit under the same condition in a stylesheet that every width loads', () => {
        const css = readFileSync(new URL('../../public/css/sillybunny-theme.css', import.meta.url), 'utf8');
        const block = css.slice(css.indexOf('Composer menus presented as bottom sheets'));
        const index = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

        expect(block).toContain('@media screen and (max-width: 768px), screen and (max-height: 360px) {');
        expect(index).toMatch(/<link [^>]*href="css\/sillybunny-theme\.css\?v=[^"]+">/);
        const mobileShell = readFileSync(new URL('../../public/css/sillybunny-mobile-shell.css', import.meta.url), 'utf8');
        expect(mobileShell).not.toContain('data-sb-menu-sheet');
    });
});

describe('presentMenuAsSheet on a phone', () => {
    test('presents the shown node with a handle, a scrim and the trigger tooltip as its name, and moves no child', async () => {
        const parts = makeMenu();
        const rows = [...parts.wrapper.children];
        const presenter = present(parts);

        expect(presenter.isPresented).toBe(false);
        await show(parts.node);

        expect(presenter.isOpen).toBe(true);
        expect(presenter.isPresented).toBe(true);
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(true);
        expect(parts.node.getAttribute('role')).toBe('group');
        expect(parts.node.getAttribute('aria-label')).toBe('Extensions');
        expect(parts.node.firstElementChild.className).toBe('sb-dialog__handle');
        expect(parts.node.children).toHaveLength(2);
        expect(parts.node.lastElementChild).toBe(parts.wrapper);
        expect([...parts.wrapper.children]).toEqual(rows);
        const scrim = parts.node.previousElementSibling;
        expect(scrim.className).toBe('sb-menu-sheet-scrim');
        expect(scrim.getAttribute('aria-hidden')).toBe('true');
    });

    test('reads the tooltip from a child of the trigger and leaves a menu without one unnamed', async () => {
        const named = makeMenu({ title: '' });
        const icon = document.createElement('i');
        icon.title = 'Trigger Stable Diffusion';
        named.trigger.append(icon);
        present(named);
        await show(named.node);
        expect(named.node.getAttribute('aria-label')).toBe('Trigger Stable Diffusion');
        expect(named.node.getAttribute('role')).toBe('group');

        const unnamed = makeMenu({ title: '' });
        unnamed.node.id = 'other_node';
        present(unnamed);
        await show(unnamed.node);
        expect(unnamed.node.hasAttribute('aria-label')).toBe(false);
        expect(unnamed.node.hasAttribute('role')).toBe(false);
    });

    test('keeps the role of a node that has one, so that its rows keep their list parent, and names it with aria-label only', async () => {
        const parts = makeMenu();
        parts.node.setAttribute('role', 'list');
        present(parts);
        await show(parts.node);

        expect(parts.node.getAttribute('role')).toBe('list');
        expect(parts.node.getAttribute('aria-label')).toBe('Extensions');

        await hide(parts.node);
        expect(parts.node.getAttribute('role')).toBe('list');
        expect(parts.node.hasAttribute('aria-label')).toBe(false);
    });

    test('hiding the node removes everything the presenter added and restores earlier attributes', async () => {
        const parts = makeMenu();
        parts.node.setAttribute('role', 'menu');
        parts.node.setAttribute('aria-label', 'Original');
        present(parts);
        await show(parts.node);
        const scrim = parts.node.previousElementSibling;

        await hide(parts.node);

        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
        expect(parts.node.getAttribute('role')).toBe('menu');
        expect(parts.node.getAttribute('aria-label')).toBe('Original');
        expect(parts.node.querySelector('.sb-dialog__handle')).toBeNull();
        expect(scrim.isConnected).toBe(false);
        expect(parts.node.style.getPropertyValue('--sb-menu-sheet-level')).toBe('');
        expect(stopMotion).toHaveBeenCalledWith(parts.node);
    });

    test('a row an extension adds while the sheet is open is in the sheet, after the handle and before nothing else', async () => {
        const parts = makeMenu();
        present(parts);
        await show(parts.node);

        const row = document.createElement('div');
        row.textContent = 'Added by an extension';
        parts.node.append(row);
        await flush();

        expect(row.parentElement).toBe(parts.node);
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(true);
        expect(parts.node.firstElementChild.className).toBe('sb-dialog__handle');
        expect([...parts.node.children].filter(child => child !== parts.node.firstElementChild)).toEqual([parts.wrapper, row]);
    });
});

describe('Popper and the sheet', () => {
    test('the presenter never writes or removes the inline position, inset or transform', async () => {
        const parts = makeMenu();
        const setProperty = jest.spyOn(parts.node.style, 'setProperty');
        const removeProperty = jest.spyOn(parts.node.style, 'removeProperty');
        present(parts);
        await show(parts.node);

        // Popper rewrites its styles on every update while the sheet is presented.
        parts.node.style.transform = 'translate(5px, 6px)';
        parts.node.style.inset = 'auto auto 0px 0px';
        await flush();
        await hide(parts.node);

        const touched = [...setProperty.mock.calls, ...removeProperty.mock.calls].map(([name]) => name);
        expect(touched).not.toEqual(expect.arrayContaining(['transform']));
        expect(touched).not.toEqual(expect.arrayContaining(['position']));
        expect(touched).not.toEqual(expect.arrayContaining(['inset']));
        expect(parts.node.style.transform).toBe('translate(5px, 6px)');
        expect(parts.node.style.position).toBe('absolute');
    });

    test('a swipe moves translate, closes through the trigger, and the offset is cleared when the node hides', async () => {
        const parts = makeMenu();
        parts.node.getBoundingClientRect = () => ({ height: 400 });
        const setProperty = jest.spyOn(parts.node.style, 'setProperty');
        const removeProperty = jest.spyOn(parts.node.style, 'removeProperty');
        parts.node.style.display = 'block';
        present(parts);
        await flush();
        const handle = parts.node.querySelector('.sb-dialog__handle');

        pointer(handle, 'pointerdown', 100, 0);
        pointer(handle, 'pointermove', 260, 100);
        expect(setProperty).toHaveBeenCalledWith('translate', '0 160px');
        expect(setProperty).not.toHaveBeenCalledWith('transform', expect.anything());
        pointer(handle, 'pointerup', 260, 100);

        expect(parts.click).toHaveBeenCalledTimes(1);
        expect(parts.node.style.display).toBe('none');
        await flush();
        expect(removeProperty).toHaveBeenCalledWith('translate');
        expect(parts.node.style.transform).toBe('translate(10px, 20px)');
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
    });

    test('a swipe that starts in the rows does nothing', async () => {
        const parts = makeMenu();
        parts.node.style.display = 'block';
        present(parts);
        await flush();

        pointer(parts.wrapper.firstElementChild, 'pointerdown', 100, 0);
        pointer(parts.wrapper.firstElementChild, 'pointermove', 300, 100);
        pointer(parts.wrapper.firstElementChild, 'pointerup', 300, 100);

        expect(parts.click).not.toHaveBeenCalled();
    });

    test('the width crossing back closes the menu and drops the sheet, leaving Popper to place the next open', async () => {
        const parts = makeMenu();
        parts.node.style.display = 'block';
        present(parts);
        await flush();
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(true);

        setNarrow(false);

        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
        expect(parts.node.querySelector('.sb-dialog__handle')).toBeNull();
        expect(parts.click).toHaveBeenCalledTimes(1);
        await flush();
        expect(parts.node.style.transform).toBe('translate(10px, 20px)');

        await show(parts.node);
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
    });
});

describe('presentMenuAsSheet above the breakpoint', () => {
    test('adds no chrome, but focus moves in and Escape closes and returns it', async () => {
        narrow = false;
        const parts = makeMenu();
        const presenter = present(parts);
        parts.trigger.focus();
        await show(parts.node);

        expect(presenter.isOpen).toBe(true);
        expect(presenter.isPresented).toBe(false);
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
        expect(parts.node.querySelector('.sb-dialog__handle')).toBeNull();
        expect(parts.node.previousElementSibling).toBe(parts.trigger);
        expect(document.activeElement).toBe(parts.node);

        const event = escape(parts.node);

        expect(event.defaultPrevented).toBe(true);
        expect(parts.click).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(parts.trigger);
        await flush();
        expect(parts.node.hasAttribute('tabindex')).toBe(false);
    });
});

describe('focus and Escape', () => {
    test('focus moves into the sheet when it opens and back to the trigger when it closes', async () => {
        const parts = makeMenu();
        present(parts);
        parts.trigger.focus();

        await show(parts.node);
        expect(document.activeElement).toBe(parts.node);

        await hide(parts.node);
        expect(document.activeElement).toBe(parts.trigger);
    });

    test('a menu opened from the keyboard focuses its first row', async () => {
        const parts = makeMenu();
        parts.trigger.matches = selector => selector === ':focus-visible';
        present(parts);
        parts.trigger.focus();

        await show(parts.node);

        expect(document.activeElement).toBe(parts.wrapper.firstElementChild);
    });

    test('focus that moved to another surface is left there when the menu hides', async () => {
        const parts = makeMenu();
        const other = document.createElement('button');
        document.body.append(other);
        present(parts);
        await show(parts.node);
        other.focus();

        await hide(parts.node);

        expect(document.activeElement).toBe(other);
    });

    test('Escape closes through the close path, returns focus at once, and one Escape closes once', async () => {
        const parts = makeMenu();
        present(parts);
        await show(parts.node);
        const reach = jest.fn();
        document.addEventListener('keydown', reach);

        const first = escape(parts.node.firstElementChild);
        escape(parts.node.firstElementChild);

        expect(first.defaultPrevented).toBe(true);
        expect(reach).not.toHaveBeenCalled();
        expect(parts.click).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(parts.trigger);
        document.removeEventListener('keydown', reach);
    });

    test('Escape pressed in a control outside the menu is left alone', async () => {
        const parts = makeMenu();
        const input = document.createElement('textarea');
        document.body.append(input);
        present(parts);
        await show(parts.node);

        const event = escape(input);

        expect(event.defaultPrevented).toBe(false);
        expect(parts.click).not.toHaveBeenCalled();
    });

    test('a menu that upstream is already fading out is not reopened by Escape', async () => {
        const parts = makeMenu();
        present(parts);
        await show(parts.node);
        parts.node.style.opacity = '1';
        await flush();
        parts.node.style.opacity = '0.4';
        await flush();

        escape(parts.node);

        expect(parts.click).not.toHaveBeenCalled();
    });

    test('with two menus open Escape closes the one that opened last', async () => {
        const first = makeMenu();
        const second = makeMenu({ title: 'Second' });
        second.trigger.id = 'second_trigger';
        second.node.id = 'second_node';
        present(first);
        present(second);
        await show(first.node);
        await show(second.node);

        expect(second.node.style.getPropertyValue('--sb-menu-sheet-level')).toBe('1');
        escape(document.body);
        expect(second.click).toHaveBeenCalledTimes(1);
        expect(first.click).not.toHaveBeenCalled();
        await flush();

        escape(document.body);
        expect(first.click).toHaveBeenCalledTimes(1);
    });
});

describe('the scrim and the close path', () => {
    test('a press on the scrim closes through a supplied close path and does not reach upstream outside-click handlers', async () => {
        const parts = makeMenu();
        const close = jest.fn(() => {
            parts.node.style.display = 'none';
        });
        present(parts, { close });
        await show(parts.node);
        const outside = jest.fn();
        document.addEventListener('click', outside);

        parts.node.previousElementSibling.click();
        await flush();

        expect(close).toHaveBeenCalledTimes(1);
        expect(parts.click).not.toHaveBeenCalled();
        expect(outside).not.toHaveBeenCalled();
        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
        document.removeEventListener('click', outside);
    });

    test('the scrim follows the opacity that upstream fades the node with', async () => {
        const parts = makeMenu();
        present(parts);
        await show(parts.node);
        const scrim = parts.node.previousElementSibling;

        parts.node.style.opacity = '0.5';
        await flush();
        expect(scrim.style.opacity).toBe('0.5');

        parts.node.style.opacity = '';
        await flush();
        expect(scrim.style.opacity).toBe('');
    });

    test('a tap on the handle, or the click that a drag from it leaves on the node, does not reach upstream outside-click handlers', async () => {
        const parts = makeMenu();
        present(parts);
        await show(parts.node);
        const outside = jest.fn();
        document.addEventListener('click', outside);

        parts.node.querySelector('.sb-dialog__handle').click();
        parts.node.click();
        expect(outside).not.toHaveBeenCalled();
        expect(parts.click).not.toHaveBeenCalled();

        // A click on a row is the menu's own and passes.
        parts.wrapper.firstElementChild.click();
        expect(outside).toHaveBeenCalledTimes(1);
        document.removeEventListener('click', outside);
    });

    test('a node that upstream already closed ignores the late scrim press', async () => {
        const parts = makeMenu();
        present(parts);
        await show(parts.node);
        const scrim = parts.node.previousElementSibling;
        await hide(parts.node);

        scrim.click();

        expect(parts.click).not.toHaveBeenCalled();
    });

    test('dispose releases the node and the Escape key', async () => {
        const parts = makeMenu();
        const presenter = present(parts);
        await show(parts.node);

        presenter.dispose();

        expect(parts.node.hasAttribute(ATTRIBUTE)).toBe(false);
        expect(escape(parts.node).defaultPrevented).toBe(false);
    });
});

describe('adoptComposerMenus', () => {
    function add(id) {
        const node = document.createElement('div');
        node.id = id;
        node.style.display = 'none';
        document.body.append(node);
        return node;
    }

    test('adopts the menus that are there and the ones that are added later', async () => {
        const options = add('options');
        const trigger = document.createElement('div');
        trigger.id = 'options_button';
        document.body.append(trigger);
        const stop = adoptComposerMenus();

        await show(options);
        expect(options.hasAttribute(ATTRIBUTE)).toBe(true);

        const wand = add('extensionsMenu');
        await flush();
        await show(wand);
        expect(wand.hasAttribute(ATTRIBUTE)).toBe(true);

        stop();
        expect(options.hasAttribute(ATTRIBUTE)).toBe(false);
        expect(wand.hasAttribute(ATTRIBUTE)).toBe(false);
    });
});
