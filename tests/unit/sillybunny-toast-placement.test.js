/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    BOTTOM_INSET_PROPERTY,
    FRAME_BOTTOM_PROPERTY,
    FRAME_LEFT_PROPERTY,
    FRAME_WIDTH_PROPERTY,
    IN_DIALOG_ATTRIBUTE,
    STACK_OFFSET_PROPERTY,
    bottomInset,
    composerInset,
    dialogSurfaceOf,
    edgeOf,
    keyboardInset,
    stackOffset,
    updateToastPlacement,
} from '../../public/scripts/sillybunny-toast-placement.js';

describe('the software keyboard', () => {
    test('covers the part of the layout viewport that the visual viewport does not reach', () => {
        expect(keyboardInset({ height: 400, offsetTop: 0 }, 800)).toBe(400);
        expect(keyboardInset({ height: 400, offsetTop: 100 }, 800)).toBe(300);
    });

    test('covers nothing when the visual viewport fills the layout viewport, and never goes negative', () => {
        expect(keyboardInset({ height: 800, offsetTop: 0 }, 800)).toBe(0);
        expect(keyboardInset({ height: 900, offsetTop: 0 }, 800)).toBe(0);
    });

    test('covers nothing when the browser has no visual viewport or gives no numbers', () => {
        expect(keyboardInset(null, 800)).toBe(0);
        expect(keyboardInset(undefined, 800)).toBe(0);
        expect(keyboardInset({ height: Number.NaN, offsetTop: 0 }, 800)).toBe(0);
        expect(keyboardInset({ height: 400, offsetTop: 0 }, 0)).toBe(0);
    });
});

describe('the composer', () => {
    test('covers the bottom of the window from its top edge', () => {
        expect(composerInset({ top: 700, bottom: 800, height: 100 }, 800)).toBe(100);
    });

    test('covers nothing while it has no box, as on Home, or lies outside the window', () => {
        expect(composerInset({ top: 0, bottom: 0, height: 0 }, 800)).toBe(0);
        expect(composerInset({ top: 900, bottom: 1000, height: 100 }, 800)).toBe(0);
        expect(composerInset({ top: -200, bottom: -100, height: 100 }, 800)).toBe(0);
        expect(composerInset(null, 800)).toBe(0);
    });
});

describe('the space that a bottom toast keeps clear', () => {
    test('is the composer or the keyboard, whichever reaches higher', () => {
        const composerBox = { top: 700, bottom: 800, height: 100 };
        expect(bottomInset({ layoutHeight: 800, composerBox })).toBe(100);
        expect(bottomInset({ layoutHeight: 800, viewport: { height: 500, offsetTop: 0 } })).toBe(300);
        expect(bottomInset({ layoutHeight: 800, viewport: { height: 500, offsetTop: 0 }, composerBox })).toBe(300);
        expect(bottomInset({ layoutHeight: 800, viewport: { height: 780, offsetTop: 0 }, composerBox })).toBe(100);
    });

    test('is nothing with no composer and no keyboard', () => {
        expect(bottomInset({ layoutHeight: 800, viewport: { height: 800, offsetTop: 0 } })).toBe(0);
    });
});

describe('the edge a toast sits at', () => {
    test('follows the position class, and is the bottom edge in a dialog whatever the class says', () => {
        expect(edgeOf('toast-bottom-center', false)).toBe('bottom');
        expect(edgeOf('toast-bottom-left', false)).toBe('bottom');
        expect(edgeOf('toast-top-right', false)).toBe('top');
        expect(edgeOf('toast-top-center', true)).toBe('bottom');
    });
});

describe('the offset of the notifications at the position of the toasts', () => {
    test('at a top position it is the height that the toasts take', () => {
        expect(stackOffset({ edge: 'top', layoutHeight: 900, overlayBox: { top: 54, height: 82 } })).toBe(82);
    });

    test('at a bottom position it is the space from the window edge to the top of the toasts, which keeps the composer clear', () => {
        expect(stackOffset({ edge: 'bottom', layoutHeight: 900, overlayBox: { top: 645, height: 82 } })).toBe(255);
        expect(stackOffset({ edge: 'bottom', layoutHeight: 900, overlayBox: { top: 818, height: 82 } })).toBe(82);
    });

    test('is nothing while no toast is on screen', () => {
        expect(stackOffset({ edge: 'bottom', layoutHeight: 900, overlayBox: { top: 727, height: 0 } })).toBe(0);
        expect(stackOffset({ edge: 'top', layoutHeight: 900, overlayBox: { top: 54, height: 0 } })).toBe(0);
    });
});

describe('the dialog surface', () => {
    test('is the Popup itself, and the frame inside a shared dialog host', () => {
        const popup = document.createElement('dialog');
        popup.className = 'popup sb-dialog';
        const host = document.createElement('dialog');
        host.className = 'sb-dialog-host';
        const scrim = document.createElement('div');
        scrim.className = 'sb-dialog-scrim';
        const frame = document.createElement('div');
        frame.className = 'sb-dialog';
        host.append(scrim, frame);
        expect(dialogSurfaceOf(popup)).toBe(popup);
        expect(dialogSurfaceOf(host)).toBe(frame);
    });

    test('is the host when no frame has been built yet', () => {
        const host = document.createElement('dialog');
        host.className = 'sb-dialog-host';
        expect(dialogSurfaceOf(host)).toBe(host);
    });
});

describe('writing the placement', () => {
    let visualViewport;
    let composer;

    beforeEach(() => {
        document.body.innerHTML = '<div id="form_sheld"></div>';
        composer = document.getElementById('form_sheld');
        composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 0, right: 1000, width: 1000 });
        Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
        visualViewport = { height: 800, offsetTop: 0, addEventListener: jest.fn(), removeEventListener: jest.fn() };
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete document.documentElement.clientHeight;
    });

    function overlayWith(positionClass, parent = document.body) {
        const overlay = document.createElement('div');
        overlay.id = 'sb-toast-overlay';
        overlay.className = positionClass;
        parent.append(overlay);
        return overlay;
    }

    test('lifts a bottom overlay by the composer and by the keyboard when the keyboard is higher', () => {
        const overlay = overlayWith('toast-bottom-center');
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        expect(overlay.hasAttribute(IN_DIALOG_ATTRIBUTE)).toBe(false);

        visualViewport.height = 450;
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('350px');
    });

    test('keeps the overlay at the window edge once the composer has no box', () => {
        const overlay = overlayWith('toast-bottom-center');
        composer.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 });
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
    });

    test('in a Popup, is marked as in a dialog and writes no window offset and no frame box', () => {
        const dialog = document.createElement('dialog');
        dialog.className = 'popup';
        document.body.append(dialog);
        const overlay = overlayWith('toast-top-left', dialog);
        overlay.style.setProperty(BOTTOM_INSET_PROPERTY, '100px');
        updateToastPlacement();
        expect(overlay.hasAttribute(IN_DIALOG_ATTRIBUTE)).toBe(true);
        expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('');
        expect(overlay.style.getPropertyValue(FRAME_WIDTH_PROPERTY)).toBe('');
    });

    test('in a shared dialog host, writes the box of the frame inside the host', () => {
        const host = document.createElement('dialog');
        host.className = 'sb-dialog-host';
        const frame = document.createElement('div');
        frame.className = 'sb-dialog';
        host.append(frame);
        document.body.append(host);
        host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 });
        frame.getBoundingClientRect = () => ({ left: 250, top: 100, width: 500, height: 600 });
        Object.defineProperties(frame, {
            offsetWidth: { configurable: true, value: 500 },
            offsetTop: { configurable: true, value: 100 },
            offsetHeight: { configurable: true, value: 600 },
        });
        Object.defineProperty(host, 'clientHeight', { configurable: true, value: 800 });
        const overlay = overlayWith('toast-top-center', host);
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(FRAME_LEFT_PROPERTY)).toBe('250px');
        expect(overlay.style.getPropertyValue(FRAME_WIDTH_PROPERTY)).toBe('500px');
        expect(overlay.style.getPropertyValue(FRAME_BOTTOM_PROPERTY)).toBe('100px');
    });

    test('puts the notifications beyond the toasts when both sit at the same position, and only then', () => {
        const overlay = overlayWith('toast-bottom-center');
        overlay.getBoundingClientRect = () => ({ top: 640, bottom: 700, height: 60, left: 0, right: 1000, width: 1000 });
        const notifications = document.createElement('div');
        notifications.id = 'toast-container';
        notifications.className = 'toast-bottom-center';
        document.body.append(notifications);

        updateToastPlacement();
        // The layout viewport is 800px high here: the toasts start 160px above its bottom edge.
        expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('160px');

        overlay.className = 'toast-top-center';
        notifications.className = 'toast-top-center';
        updateToastPlacement();
        expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('60px');

        overlay.className = 'toast-bottom-center';

        notifications.className = 'toast-top-center';
        updateToastPlacement();
        expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('');
    });

    test('puts no notification beyond a toast that sits in a dialog, where the two are not at one place', () => {
        const dialog = document.createElement('dialog');
        dialog.className = 'popup';
        document.body.append(dialog);
        const overlay = overlayWith('toast-bottom-center', dialog);
        overlay.getBoundingClientRect = () => ({ top: 640, bottom: 700, height: 60, left: 0, right: 1000, width: 1000 });
        const notifications = document.createElement('div');
        notifications.id = 'toast-container';
        notifications.className = 'toast-bottom-center';
        document.body.append(notifications);
        updateToastPlacement();
        expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('');
    });
});
