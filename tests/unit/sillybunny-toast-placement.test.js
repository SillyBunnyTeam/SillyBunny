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
    ACTION_ROW_SELECTOR,
    STACK_OFFSET_PROPERTY,
    actionRowTop,
    bottomInset,
    composerInset,
    dialogSurfaceOf,
    dialogToastBottom,
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

describe('the space that a toast in a dialog keeps clear', () => {
    test('is the space under the action row when the dialog has one, and under the surface when it has none', () => {
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 700, rowTop: null })).toBe(100);
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 700, rowTop: 640 })).toBe(160);
    });

    test('never goes under the surface, and never below nothing', () => {
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 700, rowTop: 760 })).toBe(100);
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 900, rowTop: null })).toBe(0);
    });
});

describe('the action row of a dialog', () => {
    function surfaceWith(...rows) {
        const surface = document.createElement('div');
        Object.defineProperty(surface, 'offsetHeight', { configurable: true, value: 600 });
        surface.getBoundingClientRect = () => ({ left: 0, top: 100, width: 500, height: 600, right: 500, bottom: 700 });
        for (const { className, top, height, visible = true, visibility = 'visible' } of rows) {
            const row = document.createElement('div');
            row.className = className;
            row.style.visibility = visibility;
            row.getBoundingClientRect = () => ({ left: 0, top, width: 500, height, right: 500, bottom: top + height });
            row.getClientRects = () => (visible ? [row.getBoundingClientRect()] : []);
            surface.append(row);
        }
        document.body.append(surface);
        return surface;
    }

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('is found by the classes of the responses of an alert, the extra responses and the controls of a Popup', () => {
        for (const className of ['sb-dialog__responses', 'sb-dialog__bottom-bar', 'popup-controls']) {
            expect(ACTION_ROW_SELECTOR).toContain(`.${className}`);
            expect(actionRowTop(surfaceWith({ className, top: 600, height: 80 }))).toBe(500);
            document.body.innerHTML = '';
        }
    });

    test('is the highest of the rows at the bottom, and a row in the upper half is a header, not an action row', () => {
        const surface = surfaceWith(
            { className: 'popup-controls', top: 110, height: 50 },
            { className: 'sb-dialog__bottom-bar', top: 640, height: 50 },
            { className: 'sb-dialog__responses', top: 580, height: 60 },
        );
        expect(actionRowTop(surface)).toBe(480);
    });

    test('is not a row that has no box or is hidden, as the controls of a Popup that are laid out with display: contents', () => {
        const surface = surfaceWith(
            { className: 'popup-controls', top: 600, height: 80, visible: false },
            { className: 'sb-dialog__responses', top: 620, height: 60, visibility: 'hidden' },
            { className: 'sb-dialog__bottom-bar', top: 650, height: 0 },
        );
        expect(actionRowTop(surface)).toBeNull();
    });

    test('is none in a dialog that has no such row', () => {
        expect(actionRowTop(surfaceWith())).toBeNull();
    });

    test('is read at its layout size, though the surface is drawn smaller', () => {
        const surface = surfaceWith({ className: 'sb-dialog__responses', top: 592, height: 48 });
        // Drawn at 0.8 from y=160, while it is laid out 600px high: the row's top is 540px below the surface's top.
        surface.getBoundingClientRect = () => ({ left: 100, top: 160, width: 400, height: 480, right: 500, bottom: 640 });
        expect(actionRowTop(surface)).toBe(540);
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

    /** Gives an element the boxes that jsdom does not lay out: its drawn rectangle and its layout offsets. */
    function lay(element, { rect, offset = {}, client = {}, visible = true }) {
        element.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height });
        element.getClientRects = () => (visible ? [element.getBoundingClientRect()] : []);
        for (const [name, value] of Object.entries({ ...offset, ...client })) {
            Object.defineProperty(element, name, { configurable: true, value });
        }
    }

    function frameInHost() {
        const host = document.createElement('dialog');
        host.className = 'sb-dialog-host';
        const frame = document.createElement('div');
        frame.className = 'sb-dialog';
        host.append(frame);
        document.body.append(host);
        lay(host, { rect: { left: 0, top: 0, width: 1000, height: 800 }, offset: { offsetHeight: 800 }, client: { clientHeight: 800, clientTop: 0 } });
        return { host, frame };
    }

    test('in a shared dialog host, writes the box of the frame inside the host', () => {
        const { host, frame } = frameInHost();
        lay(frame, { rect: { left: 250, top: 100, width: 500, height: 600 }, offset: { offsetLeft: 250, offsetWidth: 500, offsetTop: 100, offsetHeight: 600 } });
        const overlay = overlayWith('toast-top-center', host);
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(FRAME_LEFT_PROPERTY)).toBe('250px');
        expect(overlay.style.getPropertyValue(FRAME_WIDTH_PROPERTY)).toBe('500px');
        expect(overlay.style.getPropertyValue(FRAME_BOTTOM_PROPERTY)).toBe('100px');
    });

    test('takes the left of the frame from its layout while it opens, when a scale makes the drawn box smaller and off to one side', () => {
        const { host, frame } = frameInHost();
        // Scaled to 0.8 about its centre: drawn from 350 to 650 wide, though it is laid out from 250 to 750.
        lay(frame, { rect: { left: 300, top: 140, width: 400, height: 480 }, offset: { offsetLeft: 250, offsetWidth: 500, offsetTop: 100, offsetHeight: 600 } });
        const overlay = overlayWith('toast-top-center', host);
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(FRAME_LEFT_PROPERTY)).toBe('250px');
        expect(overlay.style.getPropertyValue(FRAME_WIDTH_PROPERTY)).toBe('500px');
        expect(overlay.style.getPropertyValue(FRAME_BOTTOM_PROPERTY)).toBe('100px');
    });

    test('keeps the toast above the action row of a frame, read at its layout size while the frame is scaled', () => {
        const { host, frame } = frameInHost();
        // The frame is laid out 600px high from y=100, and drawn at 0.8: 480px from y=160. Its responses are 60px high at its foot.
        lay(frame, { rect: { left: 300, top: 160, width: 400, height: 480 }, offset: { offsetLeft: 250, offsetWidth: 500, offsetTop: 100, offsetHeight: 600 } });
        const responses = document.createElement('div');
        responses.className = 'sb-dialog__responses';
        frame.append(responses);
        // Laid out at y=640 to 700 inside the host, so drawn at 160 + (640 - 100) * 0.8 = 592.
        lay(responses, { rect: { left: 300, top: 592, width: 400, height: 48 } });
        const overlay = overlayWith('toast-top-center', host);
        updateToastPlacement();
        // The row starts 540px below the frame's top, so at y=640 in the host, 160px above the bottom of the host.
        expect(overlay.style.getPropertyValue(FRAME_BOTTOM_PROPERTY)).toBe('160px');
    });

    test('in a Popup, keeps the toast above its action row, counting from the inside of its border', () => {
        const popup = document.createElement('dialog');
        popup.className = 'popup sb-dialog sb-dialog--alert';
        document.body.append(popup);
        lay(popup, { rect: { left: 300, top: 200, width: 400, height: 300 }, offset: { offsetHeight: 300 }, client: { clientHeight: 298, clientTop: 1 } });
        const controls = document.createElement('div');
        controls.className = 'popup-controls';
        popup.append(controls);
        lay(controls, { rect: { left: 301, top: 420, width: 398, height: 79 } });
        const overlay = overlayWith('toast-top-left', popup);
        updateToastPlacement();
        // The row starts 220px below the popup's top edge, 219px below the inside of its border, and the inside is 298px high.
        expect(overlay.style.getPropertyValue(FRAME_BOTTOM_PROPERTY)).toBe('79px');
        expect(overlay.style.getPropertyValue(FRAME_LEFT_PROPERTY)).toBe('');
        expect(overlay.style.getPropertyValue(FRAME_WIDTH_PROPERTY)).toBe('');
    });

    test('in a Popup with no action row at the bottom, keeps the toast at the dialog edge', () => {
        const popup = document.createElement('dialog');
        popup.className = 'popup';
        document.body.append(popup);
        lay(popup, { rect: { left: 300, top: 200, width: 400, height: 300 }, offset: { offsetHeight: 300 }, client: { clientHeight: 298, clientTop: 1 } });
        const overlay = overlayWith('toast-top-left', popup);
        updateToastPlacement();
        expect(overlay.style.getPropertyValue(FRAME_BOTTOM_PROPERTY)).toBe('0px');
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

    describe('an in-app notification at a bottom position, with no toast at its place', () => {
        function notificationsAt(positionClass) {
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = positionClass;
            document.body.append(notifications);
            return notifications;
        }

        test('sits above the composer and, when it reaches higher, above the keyboard, as a toast does', () => {
            const notifications = notificationsAt('toast-bottom-right');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
            visualViewport.height = 450;
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('350px');
        });

        test('keeps the window edge when the composer has no box, and a top position takes no inset', () => {
            composer.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 });
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            notifications.className = 'toast-top-center';
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('');
        });

        test('with jump, writes the place with its transition off and gives the transition back', () => {
            const overlay = overlayWith('toast-top-center');
            overlay.getBoundingClientRect = () => ({ top: 54, bottom: 124, height: 70, left: 0, right: 1000, width: 1000 });
            const notifications = notificationsAt('toast-top-center');
            const seen = [];
            const original = notifications.style.setProperty.bind(notifications.style);
            notifications.style.setProperty = (name, value, ...rest) => {
                seen.push([name, name === 'transition' ? value : notifications.style.getPropertyValue('transition')]);
                return original(name, value, ...rest);
            };
            updateToastPlacement({ jump: true });
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('70px');
            // The offset is written while the transition is off, and the transition is back after it.
            expect(seen.find(([name]) => name === STACK_OFFSET_PROPERTY)?.[1]).toBe('none');
            expect(notifications.style.getPropertyValue('transition')).toBe('');
        });

        test('takes no inset of its own where it shares the stack of the toasts, because the stack offset holds it', () => {
            const overlay = overlayWith('toast-bottom-center');
            overlay.getBoundingClientRect = () => ({ top: 640, bottom: 700, height: 60, left: 0, right: 1000, width: 1000 });
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('');
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('160px');
        });

        test('keeps its window position while a dialog is open, with the composer and the keyboard as before', () => {
            const dialog = document.createElement('dialog');
            dialog.className = 'popup';
            document.body.append(dialog);
            overlayWith('toast-top-left', dialog);
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });
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
