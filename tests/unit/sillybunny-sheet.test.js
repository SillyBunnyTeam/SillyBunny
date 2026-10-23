/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { setImmediate as nextTurn } from 'node:timers/promises';

const animateIn = jest.fn();
const animateOut = jest.fn((_element, _frames, hide) => hide());
const stopMotion = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    MOTION_FAST: 0,
    SPRING_SHEET: {},
    animateIn,
    animateOut,
    stopMotion,
}));

const { createSheetController } = await import('../../public/scripts/sillybunny-sheet.js');
let controllers;

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    controllers = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    for (const controller of controllers) controller.close({ animate: false, restoreFocus: false, force: true });
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

function makeSheet(options = {}) {
    const sheet = document.createElement('section');
    const backdrop = document.createElement('div');
    const initialFocus = document.createElement('button');
    const returnFocus = document.createElement('button');
    sheet.hidden = true;
    backdrop.hidden = true;
    sheet.append(initialFocus);
    document.body.append(returnFocus, backdrop, sheet);
    jest.spyOn(returnFocus, 'getClientRects').mockReturnValue([{ width: 20, height: 20 }]);
    const onClose = jest.fn();
    const controller = createSheetController({
        sheet,
        backdrop,
        getInitialFocus: () => initialFocus,
        getReturnFocus: () => returnFocus,
        onClose,
        ...options,
    });
    controllers.push(controller);
    return { controller, sheet, backdrop, initialFocus, returnFocus, onClose };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

describe('sheet close guards', () => {
    test('close without canClose stays synchronous, hides both layers, restores focus and notifies once', () => {
        const { controller, sheet, backdrop, initialFocus, returnFocus, onClose } = makeSheet();
        controller.open();
        expect(document.activeElement).toBe(initialFocus);

        const result = controller.close();

        expect(result).toBe(true);
        expect(result).not.toBeInstanceOf(Promise);
        expect(sheet.hidden).toBe(true);
        expect(backdrop.hidden).toBe(true);
        expect(document.activeElement).toBe(returnFocus);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(animateOut).toHaveBeenCalledTimes(2);
        expect(animateOut).toHaveBeenCalledWith(sheet, expect.any(Array), expect.any(Function), { enabled: true });
        expect(controller.close()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('preserves animate and restoreFocus options without a guard', () => {
        const { controller, sheet, initialFocus } = makeSheet();
        controller.open();

        expect(controller.close({ animate: false, restoreFocus: false })).toBe(true);
        expect(document.activeElement).toBe(initialFocus);
        expect(animateOut).toHaveBeenCalledWith(sheet, expect.any(Array), expect.any(Function), { enabled: false });
    });

    test('a synchronous veto leaves visibility, motion, focus and onClose untouched', () => {
        const canClose = jest.fn(() => false);
        const { controller, sheet, backdrop, initialFocus, onClose } = makeSheet({ canClose });
        controller.open();

        expect(controller.close()).toBe(false);
        expect(canClose).toHaveBeenCalledWith('programmatic');
        expect(sheet.hidden).toBe(false);
        expect(backdrop.hidden).toBe(false);
        expect(document.activeElement).toBe(initialFocus);
        expect(onClose).not.toHaveBeenCalled();
        expect(animateOut).not.toHaveBeenCalled();
    });

    test('a synchronous approval closes synchronously', () => {
        const { controller, onClose } = makeSheet({ canClose: () => true });
        controller.open();

        expect(controller.close()).toBe(true);
        expect(controller.isOpen()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('an asynchronous veto waits and leaves the sheet open', async () => {
        const pending = deferred();
        const { controller, sheet, backdrop, onClose } = makeSheet({ canClose: () => pending.promise });
        controller.open();
        const result = controller.close();

        expect(result).toBeInstanceOf(Promise);
        expect(controller.isOpen()).toBe(true);
        expect(animateOut).not.toHaveBeenCalled();
        pending.resolve(false);
        expect(await result).toBe(false);
        expect(sheet.hidden).toBe(false);
        expect(backdrop.hidden).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
    });

    test('an asynchronous approval closes only after the promise resolves', async () => {
        const pending = deferred();
        const { controller, onClose } = makeSheet({ canClose: () => pending.promise });
        controller.open();
        const result = controller.close();
        expect(onClose).not.toHaveBeenCalled();
        pending.resolve(true);

        expect(await result).toBe(true);
        expect(controller.isOpen()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('force bypasses a synchronous veto', () => {
        const canClose = jest.fn(() => false);
        const { controller, onClose } = makeSheet({ canClose });
        controller.open();

        expect(controller.close({ force: true })).toBe(true);
        expect(canClose).not.toHaveBeenCalled();
        expect(controller.isOpen()).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('Escape and scrim click forward their reason without closing on a veto', () => {
        const canClose = jest.fn(() => false);
        const { controller, sheet, backdrop } = makeSheet({ canClose });
        controller.open();
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        sheet.dispatchEvent(escape);
        backdrop.click();

        expect(canClose.mock.calls).toEqual([['escape'], ['scrim']]);
        expect(escape.defaultPrevented).toBe(true);
        expect(controller.isOpen()).toBe(true);
    });

    test('programmatic close may supply an explicit reason', () => {
        const canClose = jest.fn(() => true);
        const { controller } = makeSheet({ canClose });
        controller.open();

        expect(controller.close({ reason: 'escape' })).toBe(true);
        expect(canClose).toHaveBeenCalledWith('escape');
    });

    test.each(['escape', 'scrim'])('logs a canClose rejection from %s without an unhandled rejection or closing', async reason => {
        const pending = deferred();
        const error = new Error('guard failed');
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        const unhandled = jest.fn();
        const canClose = jest.fn(() => pending.promise);
        const { controller, sheet, backdrop, onClose } = makeSheet({ canClose });
        window.addEventListener('unhandledrejection', unhandled);
        try {
            controller.open();
            if (reason === 'escape') {
                sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            } else {
                backdrop.click();
            }
            pending.reject(error);
            await nextTurn();

            expect(canClose).toHaveBeenCalledWith(reason);
            expect(logged).toHaveBeenCalledWith(expect.any(String), error);
            expect(unhandled).not.toHaveBeenCalled();
            expect(controller.isOpen()).toBe(true);
            expect(backdrop.hidden).toBe(false);
            expect(onClose).not.toHaveBeenCalled();
            expect(animateOut).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('unhandledrejection', unhandled);
        }
    });

    test('replacement closes the previous sheet synchronously without consulting its veto or returning focus', () => {
        const canClose = jest.fn(() => false);
        const first = makeSheet({ canClose });
        const second = makeSheet();
        const restoreFocus = jest.spyOn(first.returnFocus, 'focus');
        first.controller.open();

        second.controller.open();

        expect(first.controller.isOpen()).toBe(false);
        expect(first.backdrop.hidden).toBe(true);
        expect(first.onClose).toHaveBeenCalledTimes(1);
        expect(canClose).not.toHaveBeenCalled();
        expect(restoreFocus).not.toHaveBeenCalled();
        expect(animateOut).toHaveBeenCalledWith(first.sheet, expect.any(Array), expect.any(Function), { enabled: false });
        expect(second.controller.isOpen()).toBe(true);
        expect(document.activeElement).toBe(second.initialFocus);
    });

    test('ignores a second close while a veto is pending and permits another after rejection', async () => {
        const pending = deferred();
        const canClose = jest.fn().mockReturnValueOnce(pending.promise).mockReturnValue(true);
        const { controller, onClose } = makeSheet({ canClose });
        controller.open();
        const first = controller.close();

        expect(controller.close({ reason: 'scrim' })).toBe(false);
        expect(canClose).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        pending.resolve(false);
        expect(await first).toBe(false);
        expect(controller.close()).toBe(true);
        expect(canClose).toHaveBeenCalledTimes(2);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('force invalidates a pending approval so it cannot close a reopened sheet', async () => {
        const pending = deferred();
        const { controller, onClose } = makeSheet({ canClose: () => pending.promise });
        controller.open();
        const first = controller.close();

        expect(controller.close({ force: true, animate: false })).toBe(true);
        controller.open();
        pending.resolve(true);
        expect(await first).toBe(false);
        expect(controller.isOpen()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('replacement invalidates the previous pending veto', async () => {
        const pending = deferred();
        const first = makeSheet({ canClose: () => pending.promise });
        first.controller.open();
        const closing = first.controller.close();
        const second = makeSheet();
        second.controller.open();
        pending.resolve(true);

        expect(await closing).toBe(false);
        expect(first.onClose).toHaveBeenCalledTimes(1);
        expect(second.controller.isOpen()).toBe(true);
    });

    test('a rejected guard releases the pending lock for the next close request', async () => {
        const pending = deferred();
        const canClose = jest.fn().mockReturnValueOnce(pending.promise).mockReturnValue(true);
        const { controller } = makeSheet({ canClose });
        controller.open();
        const closing = controller.close();
        const error = new Error('guard failed');
        pending.reject(error);

        await expect(closing).rejects.toThrow(error);
        expect(controller.isOpen()).toBe(true);
        expect(controller.close()).toBe(true);
    });
});
