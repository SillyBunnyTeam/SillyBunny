/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const { createHelpKeyHandler, hasOtherModalOpen, isHelpKey, isShortcutsKey, registerHelpKeys } = await import('../../public/scripts/sillybunny-help/help-keys.js');
const { HELP_DIALOG_CLASS, SHORTCUTS_DIALOG_CLASS } = await import('../../public/scripts/sillybunny-help/dialog-classes.js');

const press = (key, modifiers = {}) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });

/** An open dialog host, with the surface classes that the Help and Shortcuts windows put on it. */
function openDialog({ surfaceClass = '', closing = false } = {}) {
    const host = document.createElement('dialog');
    host.setAttribute('open', '');
    if (closing) {
        host.setAttribute('closing', '');
    }
    const surface = document.createElement('section');
    surface.className = surfaceClass;
    host.append(surface);
    document.body.append(host);
    return host;
}

beforeEach(() => {
    document.body.replaceChildren();
});

describe('the Keyboard Shortcuts key', () => {
    test('is a question mark with Control, whatever the layout needs to type it', () => {
        expect(isShortcutsKey(press('?', { ctrlKey: true }), { apple: false })).toBe(true);
        expect(isShortcutsKey(press('?', { ctrlKey: true, shiftKey: true }), { apple: false })).toBe(true);
    });

    test('is a question mark with Command on an Apple platform, and Control does nothing there', () => {
        expect(isShortcutsKey(press('?', { metaKey: true }), { apple: true })).toBe(true);
        expect(isShortcutsKey(press('?', { metaKey: true, shiftKey: true }), { apple: true })).toBe(true);
        expect(isShortcutsKey(press('?', { ctrlKey: true }), { apple: true })).toBe(false);
    });

    test('leaves Super, which Windows and Linux report as Meta', () => {
        expect(isShortcutsKey(press('?', { metaKey: true }), { apple: false })).toBe(false);
        expect(isShortcutsKey(press('?', { metaKey: true, shiftKey: true }), { apple: false })).toBe(false);
    });

    test('follows the platform of the browser when it is not told', () => {
        const platform = jest.spyOn(globalThis.navigator, 'platform', 'get');
        try {
            platform.mockReturnValue('MacIntel');
            expect(isShortcutsKey(press('?', { metaKey: true }))).toBe(true);
            expect(isShortcutsKey(press('?', { ctrlKey: true }))).toBe(false);
            platform.mockReturnValue('Linux x86_64');
            expect(isShortcutsKey(press('?', { metaKey: true }))).toBe(false);
            expect(isShortcutsKey(press('?', { ctrlKey: true }))).toBe(true);
        } finally {
            platform.mockRestore();
        }
    });

    test('is not a plain question mark, another key, or a modifier on its own', () => {
        expect(isShortcutsKey(press('?'), { apple: false })).toBe(false);
        expect(isShortcutsKey(press('/', { ctrlKey: true }), { apple: false })).toBe(false);
        expect(isShortcutsKey(press('Control', { ctrlKey: true }), { apple: false })).toBe(false);
    });

    test('leaves a question mark that a layout types with AltGr, which reports Control and Alt together', () => {
        expect(isShortcutsKey(press('?', { ctrlKey: true, altKey: true }), { apple: false })).toBe(false);
        expect(isShortcutsKey(press('?', { metaKey: true, altKey: true }), { apple: true })).toBe(false);
    });

    test('leaves a key that an input method is composing', () => {
        expect(isShortcutsKey(press('?', { ctrlKey: true, isComposing: true }), { apple: false })).toBe(false);
    });
});

describe('the Help key', () => {
    test('is F1 with no modifier', () => {
        expect(isHelpKey(press('F1'))).toBe(true);
    });

    test.each(['ctrlKey', 'altKey', 'metaKey', 'shiftKey'])('is not F1 with %s, which belongs to the browser or the system', (modifier) => {
        expect(isHelpKey(press('F1', { [modifier]: true }))).toBe(false);
    });

    test('is not another function key', () => {
        expect(isHelpKey(press('F2'))).toBe(false);
    });
});

describe('a modal that blocks the keys', () => {
    test('is any open dialog other than the Help and Keyboard Shortcuts windows', () => {
        expect(hasOtherModalOpen()).toBe(false);

        openDialog({ surfaceClass: `sb-dialog ${HELP_DIALOG_CLASS}` });
        openDialog({ surfaceClass: `sb-dialog ${SHORTCUTS_DIALOG_CLASS}` });
        expect(hasOtherModalOpen()).toBe(false);

        openDialog({ surfaceClass: 'sb-dialog sb-dialog--alert' });
        expect(hasOtherModalOpen()).toBe(true);
    });

    test('is not a dialog that is closing', () => {
        openDialog({ surfaceClass: 'sb-dialog', closing: true });

        expect(hasOtherModalOpen()).toBe(false);
    });

    test('is not a closed dialog', () => {
        const host = openDialog({ surfaceClass: 'sb-dialog' });
        host.removeAttribute('open');

        expect(hasOtherModalOpen()).toBe(false);
    });
});

describe('the handler of the two keys', () => {
    /** @param {{ blocked?: boolean, apple?: boolean }} [options] */
    function create({ blocked = false, apple = false } = {}) {
        const openHelp = jest.fn();
        const openShortcuts = jest.fn();
        const handle = createHelpKeyHandler({ openHelp, openShortcuts, isBlocked: () => blocked, apple });
        return { handle, openHelp, openShortcuts };
    }

    test('opens Help on F1 and holds back the browser\'s own help page', () => {
        const { handle, openHelp, openShortcuts } = create();
        const event = press('F1');

        handle(event);

        expect(openHelp).toHaveBeenCalledTimes(1);
        expect(openShortcuts).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    test('opens Keyboard Shortcuts on Control and a question mark', () => {
        const { handle, openHelp, openShortcuts } = create();
        const event = press('?', { ctrlKey: true });

        handle(event);

        expect(openShortcuts).toHaveBeenCalledTimes(1);
        expect(openHelp).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    test('opens Keyboard Shortcuts on Command and a question mark on an Apple platform', () => {
        const { handle, openShortcuts } = create({ apple: true });
        const command = press('?', { metaKey: true });
        const control = press('?', { ctrlKey: true });

        handle(command);
        handle(control);

        expect(openShortcuts).toHaveBeenCalledTimes(1);
        expect(command.defaultPrevented).toBe(true);
        expect(control.defaultPrevented).toBe(false);
    });

    test('does nothing on Super and a question mark, and does not hold the key back', () => {
        const { handle, openHelp, openShortcuts } = create({ apple: false });
        const event = press('?', { metaKey: true });

        handle(event);

        expect(openShortcuts).not.toHaveBeenCalled();
        expect(openHelp).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    test('ignores every other key and does not hold it back', () => {
        const { handle, openHelp, openShortcuts } = create();
        const event = press('a', { ctrlKey: true });

        handle(event);

        expect(openHelp).not.toHaveBeenCalled();
        expect(openShortcuts).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    test('opens nothing while another modal is open, but still holds F1 back from the browser', () => {
        const { handle, openHelp, openShortcuts } = create({ blocked: true });
        const help = press('F1');
        const shortcuts = press('?', { ctrlKey: true });

        handle(help);
        handle(shortcuts);

        expect(openHelp).not.toHaveBeenCalled();
        expect(openShortcuts).not.toHaveBeenCalled();
        expect(help.defaultPrevented).toBe(true);
        expect(shortcuts.defaultPrevented).toBe(true);
    });

    test('opens nothing for a key that is held down, and holds it back all the same', () => {
        const { handle, openHelp } = create();
        const event = press('F1', { repeat: true });

        handle(event);

        expect(openHelp).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    test('leaves a key that another handler already took', () => {
        const { handle, openHelp } = create();
        const event = press('F1');
        event.preventDefault();

        handle(event);

        expect(openHelp).not.toHaveBeenCalled();
    });
});

describe('registering the handler', () => {
    function createEvents() {
        const listeners = [];
        return {
            eventSource: { once: jest.fn((name, listener) => listeners.push([name, listener])) },
            eventTypes: { APP_READY: 'app_ready' },
            // `once` listeners run for the event and are then gone.
            ready: () => listeners.splice(0, listeners.length).filter(([name]) => name === 'app_ready').forEach(([, listener]) => listener()),
        };
    }

    test('waits for the app to be ready before it listens, and then listens once for the whole session', () => {
        const target = document.createElement('div');
        const add = jest.spyOn(target, 'addEventListener');
        const events = createEvents();
        const openers = { openHelp: jest.fn(), openShortcuts: jest.fn() };

        registerHelpKeys({ ...events, ...openers, target });
        expect(add).not.toHaveBeenCalled();

        events.ready();
        expect(add).toHaveBeenCalledTimes(1);
        expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), true);

        registerHelpKeys({ ...events, ...openers, target });
        events.ready();
        expect(add).toHaveBeenCalledTimes(1);
    });

    test('opens the windows on keys at the target once it listens', () => {
        const target = document.createElement('div');
        const openers = { openHelp: jest.fn(), openShortcuts: jest.fn() };
        const events = createEvents();

        registerHelpKeys({ ...events, ...openers, target });
        events.ready();
        target.dispatchEvent(press('F1'));
        target.dispatchEvent(press('?', { ctrlKey: true }));

        expect(openers.openHelp).toHaveBeenCalledTimes(1);
        expect(openers.openShortcuts).toHaveBeenCalledTimes(1);
    });
});
