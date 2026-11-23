/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    BOTTOM_INSET_PROPERTY,
    ACTION_ROW_SELECTOR,
    BAR_END_PROPERTY,
    BAR_SHIFT_PROPERTY,
    BAR_START_PROPERTY,
    STACK_OFFSET_PROPERTY,
    actionRowTop,
    barEdges,
    barShift,
    bottomInset,
    composerCovered,
    composerDocked,
    composerInset,
    dialogSurfaceOf,
    dialogToastBottom,
    edgeOf,
    keyboardInset,
    sheetToastInset,
    sheetsAbove,
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
    test('follows the position class', () => {
        expect(edgeOf('toast-bottom-center')).toBe('bottom');
        expect(edgeOf('toast-bottom-left')).toBe('bottom');
        expect(edgeOf('toast-top-right')).toBe('top');
        expect(edgeOf('toast-top-center')).toBe('top');
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

describe('the space that a toast over a sheet keeps clear at its foot', () => {
    test('is the space under the action row when the dialog has one, and under the surface when it has none', () => {
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 700, rowTop: null })).toBe(100);
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 700, rowTop: 640 })).toBe(160);
    });

    test('never goes under the surface, and never below nothing', () => {
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 700, rowTop: 760 })).toBe(100);
        expect(dialogToastBottom({ hostHeight: 800, surfaceBottom: 900, rowTop: null })).toBe(0);
    });
});

describe('the place of a toast above a bottom sheet', () => {
    const measures = { layoutWidth: 400, layoutHeight: 800, contentTop: 44, extent: 82 };
    const sheet = { top: 500, bottom: 800, left: 0, right: 400, width: 400, height: 300 };

    test('with room above it, is the top of the sheet, which the toast clears by its own margin', () => {
        expect(sheetToastInset({ ...measures, box: sheet, rowTop: 740 })).toBe(300);
    });

    test('has room when the top bar and the sheet are a toast and its margins apart, and not when they are closer', () => {
        expect(sheetToastInset({ ...measures, box: { ...sheet, top: 126 }, rowTop: null })).toBe(674);
        expect(sheetToastInset({ ...measures, box: { ...sheet, top: 125 }, rowTop: null })).toBe(0);
    });

    test('with no room, is the foot of the sheet: the top of its bottom action row, or its bottom edge when it has none', () => {
        const tall = { ...sheet, top: 60, height: 740 };
        expect(sheetToastInset({ ...measures, box: tall, rowTop: 700 })).toBe(100);
        expect(sheetToastInset({ ...measures, box: tall, rowTop: null })).toBe(0);
        expect(sheetToastInset({ ...measures, box: tall, rowTop: 810 })).toBe(0);
    });

    test('is not a sheet when it floats above the bottom of the window, as a centred dialog does', () => {
        expect(sheetToastInset({ ...measures, box: { ...sheet, top: 300, bottom: 560, height: 260 }, rowTop: null })).toBeNull();
    });

    test('is not a sheet when it is narrower than half the window, or has no box', () => {
        expect(sheetToastInset({ ...measures, box: { ...sheet, left: 0, right: 150, width: 150 }, rowTop: null })).toBeNull();
        expect(sheetToastInset({ ...measures, box: { ...sheet, left: 0, right: 200, width: 200 }, rowTop: null })).toBe(300);
        expect(sheetToastInset({ ...measures, box: null, rowTop: null })).toBeNull();
        expect(sheetToastInset({ ...measures, box: { ...sheet, height: 0, top: 800 }, rowTop: null })).toBeNull();
    });

    test('allows the few px that a fraction of a height leaves at the bottom of the window', () => {
        expect(sheetToastInset({ ...measures, box: { ...sheet, bottom: 797 }, rowTop: null })).toBe(300);
        expect(sheetToastInset({ ...measures, box: { ...sheet, bottom: 790 }, rowTop: null })).toBeNull();
    });

    describe('with the software keyboard open, which lifts the foot of the sheet to its own top', () => {
        const lifted = { ...sheet, top: 200, bottom: 500 };

        test('is a sheet when its bottom is at the top of the keyboard, and the toast sits above its top edge', () => {
            expect(sheetToastInset({ ...measures, keyboard: 300, box: lifted, rowTop: 440 })).toBe(600);
            expect(sheetToastInset({ ...measures, keyboard: 300, box: { ...lifted, bottom: 498 }, rowTop: null })).toBe(600);
        });

        test('keeps the toast above the action row of a lifted sheet that leaves no room above it', () => {
            const tall = { ...lifted, top: 50, height: 450 };
            expect(sheetToastInset({ ...measures, keyboard: 300, box: tall, rowTop: 440 })).toBe(360);
            expect(sheetToastInset({ ...measures, keyboard: 300, box: tall, rowTop: null })).toBe(300);
        });

        test('is not a sheet when its bottom is at neither the keyboard nor the window, and without a keyboard the top of the keyboard is no edge', () => {
            expect(sheetToastInset({ ...measures, keyboard: 300, box: { ...lifted, bottom: 400, top: 100 }, rowTop: null })).toBeNull();
            expect(sheetToastInset({ ...measures, keyboard: 0, box: lifted, rowTop: null })).toBeNull();
            expect(sheetToastInset({ ...measures, box: lifted, rowTop: null })).toBeNull();
        });

        test('is still a sheet that the keyboard did not lift', () => {
            expect(sheetToastInset({ ...measures, keyboard: 300, box: sheet, rowTop: null })).toBe(300);
        });
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

describe('whether the composer is docked', () => {
    test('is docked when its bottom edge is on the bottom of the window, give or take the few px that a fraction of a height leaves', () => {
        expect(composerDocked({ top: 727, bottom: 900, height: 173 }, 900)).toBe(true);
        expect(composerDocked({ top: 727, bottom: 899.4, height: 172.4 }, 900)).toBe(true);
        expect(composerDocked({ top: 727, bottom: 897, height: 170 }, 900)).toBe(true);
    });

    test('is not docked when it floats above the bottom of the window, as a composer that MovingUI has moved does', () => {
        expect(composerDocked({ top: 464, bottom: 636, height: 172 }, 900)).toBe(false);
        expect(composerDocked({ top: 700, bottom: 890, height: 190 }, 900)).toBe(false);
    });

    test('is not docked with no box, as on Home', () => {
        expect(composerDocked({ top: 0, bottom: 0, height: 0 }, 900)).toBe(false);
        expect(composerDocked(null, 900)).toBe(false);
    });
});

describe('the shift of a bar from the middle of the window', () => {
    test('is the distance of the middle of the bar from the middle of the window', () => {
        expect(barShift({ left: 280, right: 1000 }, 1000)).toBe(140);
        expect(barShift({ left: 0, right: 600 }, 1000)).toBe(-200);
        expect(barShift({ left: 100, right: 900 }, 1000)).toBe(0);
    });

    test('counts only the part of the bar that is in the window', () => {
        expect(barShift({ left: -200, right: 1400 }, 1000)).toBe(0);
        expect(barShift({ left: 800, right: 1600 }, 1000)).toBe(400);
    });

    test('is nothing with no bar', () => {
        expect(barShift(null, 1000)).toBe(0);
    });
});

describe('the edges of a bar from the sides of the window', () => {
    test('are the distance of its start from the left of the window, and of its end from the right, the end counted backwards', () => {
        expect(barEdges({ left: 280, right: 1000 }, 1000)).toEqual({ start: 280, end: 0 });
        expect(barEdges({ left: 100, right: 900 }, 1000)).toEqual({ start: 100, end: -100 });
        expect(barEdges({ left: 0, right: 1000 }, 1000)).toEqual({ start: 0, end: 0 });
    });

    test('count only the part of the bar that is in the window', () => {
        expect(barEdges({ left: -200, right: 1400 }, 1000)).toEqual({ start: 0, end: 0 });
        expect(barEdges({ left: 800, right: 1600 }, 1000)).toEqual({ start: 800, end: 0 });
    });

    test('are nothing with no bar', () => {
        expect(barEdges(null, 1000)).toEqual({ start: 0, end: 0 });
    });
});

describe('the sheets docked above an edge', () => {
    let composer;
    let sheet;
    let row;

    function place(element, box) {
        element.getBoundingClientRect = () => ({ ...box, width: box.right - box.left, height: box.bottom - box.top });
    }

    /** A page with the composer, a top bar, a sheet that holds a row, a dialog and one message of each form. */
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="top-bar"></div>
            <div id="sheld"><div id="chat"></div><div id="form_sheld"><div id="bar"></div></div></div>
            <div id="sheet"><div id="row"></div></div>
            <dialog id="dialog" open><div id="dialog-row"></div></dialog>
            <div id="toast-container"><div id="note"></div></div>`;
        composer = document.getElementById('form_sheld');
        sheet = document.getElementById('sheet');
        row = document.getElementById('row');
        sheet.style.position = 'fixed';
        place(sheet, { top: 500, bottom: 800, left: 0, right: 1000 });
    });

    const find = (overrides = {}) => sheetsAbove({
        edge: 800,
        layoutWidth: 1000,
        contentTop: 44,
        composer,
        elementsAt: () => [row, sheet, document.body],
        ...overrides,
    });

    test('finds a fixed element that ends on the edge, from a point inside it', () => {
        expect(find()).toEqual([{ top: 500, bottom: 800, left: 0, right: 1000 }]);
    });

    test('finds one that rests on the top of the composer when the composer is the edge', () => {
        place(sheet, { top: 300, bottom: 700, left: 0, right: 1000 });
        expect(find({ edge: 700 })).toEqual([{ top: 300, bottom: 700, left: 0, right: 1000 }]);
    });

    test('allows the gap that a bar keeps under a sheet, and a few px the other way, and no more', () => {
        place(sheet, { top: 500, bottom: 794, left: 0, right: 1000 });
        expect(find()).toHaveLength(1);
        place(sheet, { top: 500, bottom: 790, left: 0, right: 1000 });
        expect(find()).toHaveLength(1);
        place(sheet, { top: 500, bottom: 780, left: 0, right: 1000 });
        expect(find()).toEqual([]);
        place(sheet, { top: 500, bottom: 803, left: 0, right: 1000 });
        expect(find()).toHaveLength(1);
        place(sheet, { top: 500, bottom: 810, left: 0, right: 1000 });
        expect(find()).toEqual([]);
    });

    test('finds the sheets that stand on one another, from the lowest', () => {
        const upper = document.createElement('div');
        const upperRow = document.createElement('div');
        upper.append(upperRow);
        upper.style.position = 'fixed';
        document.body.append(upper);
        place(upper, { top: 300, bottom: 500, left: 0, right: 1000 });
        const found = find({ elementsAt: (x, y) => (y >= 500 ? [row, sheet] : [upperRow, upper]) });
        expect(found.map(box => box.top)).toEqual([500, 300]);
    });

    test('reads a few points just above the edge, across the window, and none where a message lies', () => {
        const points = [];
        // Nothing answers, so that the edge stays where it is and only its points are read.
        find({
            elementsAt: (x, y) => {
                points.push([x, y]);
                return [];
            },
        });
        expect(points.length).toBeGreaterThanOrEqual(2);
        for (const [x, y] of points) {
            expect(y).toBeGreaterThan(780);
            expect(y).toBeLessThan(800);
            expect(x).toBeGreaterThan(0);
            expect(x).toBeLessThan(1000);
        }
        expect(new Set(points.map(([x]) => x)).size).toBe(points.length);
    });

    test('takes the topmost element that is not a message, and the elements that hold it', () => {
        const note = document.getElementById('note');
        expect(find({ elementsAt: () => [note, row, sheet] })).toHaveLength(1);
    });

    test('is not a sheet when it is not fixed to the window', () => {
        sheet.style.position = 'absolute';
        expect(find()).toEqual([]);
    });

    test('is not a sheet when it is narrower than half the window, as a panel that is docked at one side', () => {
        place(sheet, { top: 500, bottom: 800, left: 0, right: 400 });
        expect(find()).toEqual([]);
        place(sheet, { top: 500, bottom: 800, left: 0, right: 500 });
        expect(find()).toHaveLength(1);
    });

    test('is not a sheet when it leaves no room under the top bar, which is a page that covers the window', () => {
        place(sheet, { top: 44, bottom: 800, left: 0, right: 1000 });
        expect(find()).toEqual([]);
        place(sheet, { top: 60, bottom: 800, left: 0, right: 1000 });
        expect(find()).toEqual([]);
        place(sheet, { top: 80, bottom: 800, left: 0, right: 1000 });
        expect(find()).toHaveLength(1);
    });

    test('is not a sheet when it is a dialog, or in one: the toasts of a dialog are placed by the dialog', () => {
        const dialog = document.getElementById('dialog');
        dialog.style.position = 'fixed';
        place(dialog, { top: 500, bottom: 800, left: 0, right: 1000 });
        const dialogRow = document.getElementById('dialog-row');
        expect(find({ elementsAt: () => [dialogRow, dialog] })).toEqual([]);
    });

    test('is not a sheet when it holds the composer or is part of it', () => {
        const shell = document.getElementById('sheld');
        shell.style.position = 'fixed';
        place(shell, { top: 500, bottom: 800, left: 0, right: 1000 });
        const bar = document.getElementById('bar');
        composer.style.position = 'fixed';
        place(composer, { top: 700, bottom: 800, left: 0, right: 1000 });
        expect(find({ elementsAt: () => [bar, composer, shell] })).toEqual([]);
    });

    test('is not a sheet when it is a message', () => {
        const messages = document.getElementById('toast-container');
        messages.style.position = 'fixed';
        place(messages, { top: 500, bottom: 800, left: 0, right: 1000 });
        expect(find({ elementsAt: () => [document.getElementById('note'), messages] })).toEqual([]);
    });

    test('finds nothing when no point answers', () => {
        expect(find({ elementsAt: () => [] })).toEqual([]);
    });
});

describe('whether the composer is covered', () => {
    let composer;
    let bar;
    let panel;
    let sheld;
    let overlayToast;
    let notification;

    /** A tree with the composer in the chat shell, a panel that is a sibling of the shell, and one message of each form. */
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="sheld"><div id="chat"></div><div id="form_sheld"><div id="bar"></div></div></div>
            <div id="panel"></div>
            <div id="sb-toast-overlay"><div id="a-toast"></div></div>
            <div id="toast-container"><div id="a-notification"></div></div>`;
        composer = document.getElementById('form_sheld');
        bar = document.getElementById('bar');
        panel = document.getElementById('panel');
        sheld = document.getElementById('sheld');
        overlayToast = document.getElementById('a-toast');
        notification = document.getElementById('a-notification');
        composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 100, right: 900, width: 800 });
    });

    const cover = elementsAt => composerCovered(composer, { elementsAt, layoutWidth: 1000, layoutHeight: 800 });

    test('is not covered when the topmost element at its top edge is in it', () => {
        expect(cover(() => [bar, composer, sheld, document.body])).toBe(false);
    });

    test('is covered when another surface is the topmost element at its top edge, whichever surface it is', () => {
        expect(cover(() => [panel, bar, composer])).toBe(true);
        const child = document.createElement('span');
        panel.append(child);
        expect(cover(() => [child, panel, bar, composer])).toBe(true);
    });

    test('ignores a message of either form, which is drawn above whatever it sits over', () => {
        expect(cover(() => [overlayToast, notification, bar, composer])).toBe(false);
        expect(cover(() => [overlayToast, notification, panel, bar, composer])).toBe(true);
    });

    test('is not covered by an element that holds it, such as the chat shell where a gap of the composer lets the pointer through', () => {
        expect(cover(() => [sheld, document.body])).toBe(false);
    });

    test('is covered only when most of the points on its edge are, so that a small menu over a part of it does not move a toast', () => {
        const left = x => (x < 100 + 800 * 0.25 ? [panel, bar] : [bar]);
        expect(cover(left)).toBe(false);
        const most = x => (x < 100 + 800 * 0.65 ? [panel, bar] : [bar]);
        expect(cover(most)).toBe(true);
    });

    test('reads a few points just inside the top edge, across its width', () => {
        const points = [];
        cover((x, y) => {
            points.push([x, y]);
            return [bar];
        });
        expect(points.length).toBeGreaterThanOrEqual(3);
        for (const [x, y] of points) {
            expect(y).toBeGreaterThan(700);
            expect(y).toBeLessThan(710);
            expect(x).toBeGreaterThan(100);
            expect(x).toBeLessThan(900);
        }
        expect(new Set(points.map(([x]) => x)).size).toBe(points.length);
    });

    test('is not covered when there is nothing to hit: no box, a box below the window, or points that no element answers', () => {
        expect(cover(() => [])).toBe(false);
        composer.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 });
        expect(cover(() => [panel])).toBe(false);
        composer.getBoundingClientRect = () => ({ top: 900, bottom: 1000, height: 100, left: 100, right: 900, width: 800 });
        expect(cover(() => [panel])).toBe(false);
    });

    test('keeps the points inside the window when the composer is wider than it', () => {
        composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: -200, right: 1400, width: 1600 });
        const xs = [];
        cover((x) => {
            xs.push(x);
            return [bar];
        });
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...xs)).toBeLessThanOrEqual(999);
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
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
        visualViewport = { height: 800, offsetTop: 0, addEventListener: jest.fn(), removeEventListener: jest.fn() };
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete document.documentElement.clientHeight;
        delete document.documentElement.clientWidth;
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

    /** Gives an element the boxes that jsdom does not lay out: its drawn rectangle and its layout offsets. */
    function lay(element, { rect, offset = {}, client = {}, visible = true }) {
        element.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height });
        element.getClientRects = () => (visible ? [element.getBoundingClientRect()] : []);
        for (const [name, value] of Object.entries({ ...offset, ...client })) {
            Object.defineProperty(element, name, { configurable: true, value });
        }
    }

    describe('while a modal dialog is open', () => {
        let dialog;

        /** A dialog in the top layer. Its dimming covers the page, so what answers at the composer is the dialog. */
        function openDialog({ className = 'popup', rect = null } = {}) {
            dialog = document.createElement('dialog');
            dialog.className = className;
            dialog.setAttribute('open', '');
            dialog.setAttribute('data-sb-modal', '');
            document.body.append(dialog);
            if (rect) {
                lay(dialog, { rect });
            }
            document.elementsFromPoint = jest.fn(() => [dialog]);
            return dialog;
        }

        function notificationsAt(positionClass) {
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = positionClass;
            document.body.append(notifications);
            return notifications;
        }

        /** A toast of a given height in the overlay, which the room above a sheet is measured against. */
        function toastIn(overlay, height = 46) {
            const toast = document.createElement('div');
            toast.className = 'toast sb-form-toast';
            lay(toast, { rect: { left: 300, top: 0, width: 400, height } });
            overlay.append(toast);
            return toast;
        }

        let frames;

        beforeEach(() => {
            // A toast in the overlay starts the watch of the surfaces, and a frame that stays pending would keep the next test from asking for one.
            frames = [];
            jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
                frames.push(callback);
                return frames.length;
            });
        });

        afterEach(() => {
            while (frames.length > 0) {
                frames.shift()(0);
            }
            jest.restoreAllMocks();
            delete document.elementsFromPoint;
        });

        test('a bottom toast in the dialog sits at its place in the window: at the window edge, since the dimming covers the composer', () => {
            openDialog({ rect: { left: 300, top: 200, width: 400, height: 300 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(overlay.hasAttribute('data-sb-toast-in-dialog')).toBe(false);
            expect(overlay.style.getPropertyValue('--sb-toast-frame-bottom')).toBe('');
        });

        test('a toast at a top position is placed as without a dialog, whatever the dialog is', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            const overlay = overlayWith('toast-top-left', dialog);
            overlay.getBoundingClientRect = () => ({ top: 54, bottom: 124, height: 70, left: 0, right: 1000, width: 1000 });
            const notifications = notificationsAt('toast-top-left');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('70px');
        });

        test('a dialog that does not reach the bottom of the window, such as a centred one, is not a sheet', () => {
            openDialog({ rect: { left: 300, top: 300, width: 400, height: 260 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });

        test('a bottom sheet with room above it carries the toast above its top edge', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
        });

        test('a bottom sheet that the software keyboard lifts carries the toast above its top edge, not over its action row', () => {
            visualViewport.height = 500;
            openDialog({ rect: { left: 0, top: 200, width: 1000, height: 300 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            // The keyboard alone would lift the toast by 300px, to the foot of the sheet.
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('600px');
        });

        test('a tall sheet, which leaves no room above it, carries the toast above its bottom action row', () => {
            openDialog({ className: 'sb-dialog-host', rect: { left: 0, top: 0, width: 1000, height: 800 } });
            const frame = document.createElement('div');
            frame.className = 'sb-dialog';
            dialog.append(frame);
            lay(frame, { rect: { left: 0, top: 20, width: 1000, height: 780 } });
            const responses = document.createElement('div');
            responses.className = 'sb-dialog__responses';
            frame.append(responses);
            lay(responses, { rect: { left: 0, top: 700, width: 1000, height: 100 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('a tall sheet with no action row carries the toast above its bottom edge', () => {
            openDialog({ rect: { left: 0, top: 20, width: 1000, height: 780 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });

        test('the room that a sheet must leave is the height of the tallest toast with its margins', () => {
            openDialog({ rect: { left: 0, top: 100, width: 1000, height: 700 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            const toast = toastIn(overlay, 60);
            toast.style.marginTop = '12px';
            toast.style.marginBottom = '24px';
            updateToastPlacement();
            // 60px and its 36px of margins fit between the top at 0 and the sheet at 100.
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('700px');
            lay(toast, { rect: { left: 300, top: 0, width: 400, height: 70 } });
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });

        test('the sheet is read at its layout size while it moves in, so the toast does not follow the spring', () => {
            openDialog({ rect: { left: 0, top: 640, width: 1000, height: 300 } });
            // Laid out at 500 and drawn 140px lower while it slides up: its layout offsets are what count.
            Object.defineProperty(dialog, 'offsetTop', { configurable: true, value: 500 });
            Object.defineProperty(dialog, 'offsetLeft', { configurable: true, value: 0 });
            Object.defineProperty(dialog, 'offsetHeight', { configurable: true, value: 300 });
            Object.defineProperty(dialog, 'offsetWidth', { configurable: true, value: 1000 });
            dialog.style.transform = 'translateY(140px)';
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
        });

        test('a bottom notification with no toast at its place keeps the window edge under the sheet, as before', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });

        test('a notification beyond a toast at one position starts above the place of the toast', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            overlay.getBoundingClientRect = () => ({ top: 300, bottom: 500, height: 60, left: 0, right: 1000, width: 1000 });
            toastIn(overlay);
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('360px');
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('');
        });

        test('the keyboard lifts the toast above a sheet when it reaches higher', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            visualViewport.height = 150;
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('650px');
        });

        test('a toast is above the composer again when the dialog has gone', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            const overlay = overlayWith('toast-bottom-center', dialog);
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
            document.body.append(overlay);
            dialog.remove();
            document.elementsFromPoint = jest.fn(() => [composer]);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('a dialog that is closing is no sheet any more', () => {
            openDialog({ rect: { left: 0, top: 500, width: 1000, height: 300 } });
            dialog.setAttribute('closing', '');
            const overlay = overlayWith('toast-bottom-center');
            toastIn(overlay);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });
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

        test('keeps its window position while a toast is in a dialog, and the composer and the keyboard lift it as before', () => {
            const dialog = document.createElement('dialog');
            dialog.className = 'popup';
            document.body.append(dialog);
            overlayWith('toast-top-left', dialog);
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });
    });

    describe('while the composer is covered', () => {
        let elementsFromPoint;

        function coveredBy(element) {
            elementsFromPoint.mockImplementation(() => [element, composer]);
        }

        function uncovered() {
            elementsFromPoint.mockImplementation(() => [composer]);
        }

        beforeEach(() => {
            elementsFromPoint = jest.fn(() => [composer]);
            document.elementsFromPoint = elementsFromPoint;
        });

        afterEach(() => {
            delete document.elementsFromPoint;
        });

        function panel() {
            const element = document.createElement('div');
            document.body.append(element);
            return element;
        }

        test('a bottom overlay sits at the window edge, and above the composer again when it is not covered', () => {
            const overlay = overlayWith('toast-bottom-center');
            coveredBy(panel());
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            uncovered();
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('a bottom notification sits at the window edge too', () => {
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-right';
            document.body.append(notifications);
            coveredBy(panel());
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            uncovered();
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('the keyboard still lifts it, because the keyboard is a docked bottom bar that no panel covers', () => {
            const overlay = overlayWith('toast-bottom-center');
            coveredBy(panel());
            visualViewport.height = 450;
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('350px');
        });

        test('the notifications in the stack with the toasts sit beyond the place the toasts are going to, and not beyond where they are while they move', () => {
            const overlay = overlayWith('toast-bottom-center');
            // A toast that is still gliding to the edge: its box is where it was, 100px higher than where it goes.
            overlay.getBoundingClientRect = () => ({ top: 640, bottom: 700, height: 60, left: 0, right: 1000, width: 1000 });
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-center';
            document.body.append(notifications);
            coveredBy(panel());
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('60px');
            uncovered();
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('160px');
        });

        test('a modal dialog covers the composer with its dimming, so a bottom notification sits at the window edge', () => {
            const dialog = document.createElement('dialog');
            dialog.setAttribute('open', '');
            dialog.setAttribute('data-sb-modal', '');
            document.body.append(dialog);
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-center';
            document.body.append(notifications);
            coveredBy(dialog);
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(elementsFromPoint).toHaveBeenCalled();
        });

        test('a dialog that closes leaves the composer to the page again', () => {
            const dialog = document.createElement('dialog');
            dialog.setAttribute('open', '');
            document.body.append(dialog);
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-center';
            document.body.append(notifications);
            coveredBy(dialog);
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            dialog.remove();
            uncovered();
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('a browser without elementsFromPoint leaves the composer uncovered', () => {
            delete document.elementsFromPoint;
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });
    });

    describe('a composer that is not docked at the bottom edge', () => {
        beforeEach(() => {
            document.elementsFromPoint = jest.fn(() => [composer]);
        });

        afterEach(() => {
            delete document.elementsFromPoint;
        });

        test('is not a bottom bar: a toast and a notification sit at the window edge', () => {
            // MovingUI has moved it up, and it floats with 328px under it.
            composer.getBoundingClientRect = () => ({ top: 300, bottom: 472, height: 172, left: 100, right: 900, width: 800 });
            const overlay = overlayWith('toast-bottom-center');
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-right';
            document.body.append(notifications);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });

        test('is a bottom bar again when it is back at the bottom edge', () => {
            composer.getBoundingClientRect = () => ({ top: 300, bottom: 472, height: 172, left: 100, right: 900, width: 800 });
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 100, right: 900, width: 800 });
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('leaves the keyboard to lift the toast', () => {
            composer.getBoundingClientRect = () => ({ top: 300, bottom: 472, height: 172, left: 100, right: 900, width: 800 });
            const overlay = overlayWith('toast-bottom-center');
            visualViewport.height = 450;
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('350px');
        });
    });

    describe('a sheet that is docked at the bottom', () => {
        let sheet;
        let row;

        function dock(box) {
            sheet = document.createElement('div');
            row = document.createElement('div');
            sheet.append(row);
            sheet.style.position = 'fixed';
            sheet.getBoundingClientRect = () => ({ ...box, width: box.right - box.left, height: box.bottom - box.top });
            document.body.append(sheet);
            return sheet;
        }

        afterEach(() => {
            delete document.elementsFromPoint;
        });

        test('over the composer, like the action menu of a phone, is the bar that a toast and a notification sit above', () => {
            dock({ top: 500, bottom: 800, left: 0, right: 1000 });
            document.elementsFromPoint = jest.fn(() => [row, sheet, composer]);
            const overlay = overlayWith('toast-bottom-center');
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-right';
            document.body.append(notifications);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
        });

        test('on top of the composer, like the sheet of a side panel, is the bar when it reaches higher than the composer', () => {
            dock({ top: 300, bottom: 700, left: 0, right: 1000 });
            document.elementsFromPoint = jest.fn((x, y) => (y >= 700 ? [composer] : [row, sheet]));
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('500px');
        });

        test('with two docked surfaces, a toast sits above the highest', () => {
            dock({ top: 500, bottom: 800, left: 0, right: 1000 });
            const lower = sheet;
            const lowerRow = row;
            dock({ top: 300, bottom: 500, left: 0, right: 1000 });
            const upper = sheet;
            const upperRow = row;
            document.elementsFromPoint = jest.fn((x, y) => (y >= 500 ? [lowerRow, lower, composer] : [upperRow, upper]));
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('500px');
        });

        test('is not lower than the keyboard when the keyboard reaches higher', () => {
            dock({ top: 500, bottom: 800, left: 0, right: 1000 });
            document.elementsFromPoint = jest.fn(() => [row, sheet, composer]);
            visualViewport.height = 150;
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('650px');
        });

        test('goes with the stack: the notifications beyond the toasts start above the sheet', () => {
            dock({ top: 500, bottom: 800, left: 0, right: 1000 });
            document.elementsFromPoint = jest.fn(() => [row, sheet, composer]);
            const overlay = overlayWith('toast-bottom-center');
            overlay.getBoundingClientRect = () => ({ top: 440, bottom: 500, height: 60, left: 0, right: 1000, width: 1000 });
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-center';
            document.body.append(notifications);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
            expect(notifications.style.getPropertyValue(STACK_OFFSET_PROPERTY)).toBe('360px');
        });

        test('is not a bar when it covers the window under the top bar, as a page of the top bar does', () => {
            document.body.insertAdjacentHTML('afterbegin', '<div id="top-bar"></div>');
            document.getElementById('top-bar').getBoundingClientRect = () => ({ top: 0, bottom: 44, height: 44, left: 0, right: 1000, width: 1000 });
            dock({ top: 44, bottom: 800, left: 0, right: 1000 });
            document.elementsFromPoint = jest.fn(() => [row, sheet, composer]);
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
        });
    });

    describe('where a bottom message is centred', () => {
        let elementsFromPoint;

        beforeEach(() => {
            elementsFromPoint = jest.fn(() => [composer]);
            document.elementsFromPoint = elementsFromPoint;
            // A side panel docks at the left and pushes the composer to the right.
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 280, right: 1000, width: 720 });
        });

        afterEach(() => {
            delete document.elementsFromPoint;
        });

        function notificationsAt(positionClass) {
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = positionClass;
            document.body.append(notifications);
            return notifications;
        }

        test('is the middle of the composer while the message sits above it', () => {
            const overlay = overlayWith('toast-bottom-center');
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('140px');
            expect(notifications.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('140px');
        });

        test('is the middle of the window at the window edge, where nothing is docked', () => {
            const panelElement = document.createElement('div');
            document.body.append(panelElement);
            elementsFromPoint.mockImplementation(() => [panelElement, composer]);
            const overlay = overlayWith('toast-bottom-center');
            const notifications = notificationsAt('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
            expect(notifications.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
        });

        test('is the middle of the window when the keyboard reaches higher than the composer', () => {
            visualViewport.height = 450;
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
        });

        test('is the middle of the sheet that the message sits above', () => {
            const sheet = document.createElement('div');
            sheet.style.position = 'fixed';
            sheet.getBoundingClientRect = () => ({ top: 500, bottom: 800, height: 300, left: 0, right: 600, width: 600 });
            document.body.append(sheet);
            elementsFromPoint.mockImplementation(() => [sheet, composer]);
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('300px');
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('-200px');
        });

        test('are the start and the end of the composer for a message at the left or the right, which the side positions align to', () => {
            const left = overlayWith('toast-bottom-left');
            const right = notificationsAt('toast-bottom-right');
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 280, right: 900, width: 620 });
            updateToastPlacement();
            expect(left.style.getPropertyValue(BAR_START_PROPERTY)).toBe('280px');
            expect(left.style.getPropertyValue(BAR_END_PROPERTY)).toBe('-100px');
            expect(right.style.getPropertyValue(BAR_START_PROPERTY)).toBe('280px');
            expect(right.style.getPropertyValue(BAR_END_PROPERTY)).toBe('-100px');
        });

        test('are nothing at the window edge, where the side positions align to the window, and nothing where the bar fills the window', () => {
            const panelElement = document.createElement('div');
            document.body.append(panelElement);
            elementsFromPoint.mockImplementation(() => [panelElement, composer]);
            const overlay = overlayWith('toast-bottom-left');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('');
            expect(overlay.style.getPropertyValue(BAR_END_PROPERTY)).toBe('');

            elementsFromPoint.mockImplementation(() => [composer]);
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 0, right: 1000, width: 1000 });
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('');
            expect(overlay.style.getPropertyValue(BAR_END_PROPERTY)).toBe('');
        });

        test('are written for a bottom position only, like the shift', () => {
            const top = overlayWith('toast-top-left');
            updateToastPlacement();
            expect(top.style.getPropertyValue(BAR_START_PROPERTY)).toBe('');
            expect(top.style.getPropertyValue(BAR_END_PROPERTY)).toBe('');
            expect(top.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
        });

        test('are nothing under a modal dialog, whose dimming covers the composer, so the message is where the window puts it', () => {
            const overlay = overlayWith('toast-bottom-left');
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('280px');
            const dialog = document.createElement('dialog');
            dialog.setAttribute('open', '');
            dialog.setAttribute('data-sb-modal', '');
            document.body.append(dialog);
            dialog.append(overlay);
            elementsFromPoint.mockImplementation(() => [dialog]);
            updateToastPlacement();
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('');
            expect(overlay.style.getPropertyValue(BAR_END_PROPERTY)).toBe('');
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
        });
    });

    describe('the watch of the surfaces', () => {
        let frames;
        let elementsFromPoint;
        let hit;
        let reducedMotion;

        beforeEach(() => {
            frames = [];
            reducedMotion = false;
            jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
                frames.push(callback);
                return frames.length;
            });
            window.matchMedia = jest.fn(() => ({ matches: reducedMotion }));
            hit = [composer];
            elementsFromPoint = jest.fn((x, y) => (typeof hit === 'function' ? hit(x, y) : hit));
            document.elementsFromPoint = elementsFromPoint;
        });

        afterEach(() => {
            // A frame that is still waiting would keep the next test from asking for one.
            runFrames();
            jest.useRealTimers();
            delete window.matchMedia;
            delete document.elementsFromPoint;
            jest.restoreAllMocks();
        });

        function runFrames() {
            while (frames.length > 0) {
                frames.shift()(0);
            }
        }
        const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

        function showMessage(positionClass = 'toast-bottom-center') {
            const overlay = overlayWith(positionClass);
            const toast = document.createElement('div');
            toast.className = 'toast';
            overlay.append(toast);
            updateToastPlacement();
            return { overlay, toast };
        }

        function openPanel() {
            const panelElement = document.createElement('div');
            document.body.append(panelElement);
            hit = [panelElement, composer];
            return panelElement;
        }

        test('moves a toast that is on screen to the edge when a panel opens over the composer, and back when it closes, one check per burst', async () => {
            const { overlay } = showMessage();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
            elementsFromPoint.mockClear();

            const panelElement = openPanel();
            panelElement.className = 'open';
            panelElement.setAttribute('style', 'display: block');
            await settle();
            expect(frames).toHaveLength(1);
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');

            hit = [composer];
            panelElement.className = '';
            await settle();
            expect(frames).toHaveLength(1);
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('moves a notification at the edge the same way, with the transition of its margin kept for the stack', async () => {
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-right';
            notifications.append(document.createElement('div'));
            document.body.append(notifications);
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');

            openPanel().className = 'open';
            await settle();
            runFrames();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(notifications.style.getPropertyValue('transition')).toMatch(/margin.*bottom/);
        });

        test('eases a message that is on screen to its new place, and takes the transition off when it has got there', () => {
            jest.useFakeTimers({ doNotFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
            const { overlay } = showMessage();
            expect(overlay.style.getPropertyValue('transition')).toBe('');
            openPanel();
            document.body.dispatchEvent(new Event('transitionend', { bubbles: true }));
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(overlay.style.getPropertyValue('transition')).toContain('bottom');
            jest.advanceTimersByTime(400);
            expect(overlay.style.getPropertyValue('transition')).toBe('');
        });

        test('lifts a toast that is on screen to the top of a sheet that opens, and drops it when the sheet goes, easing both ways', async () => {
            const { overlay } = showMessage();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
            const sheet = document.createElement('div');
            const row = document.createElement('div');
            sheet.append(row);
            sheet.style.position = 'fixed';
            sheet.getBoundingClientRect = () => ({ top: 300, bottom: 700, height: 400, left: 0, right: 1000, width: 1000 });
            document.body.append(sheet);
            hit = (x, y) => (y >= 700 ? [composer] : [row, sheet]);
            await settle();
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('500px');
            expect(overlay.style.getPropertyValue('transition')).toContain('bottom');

            sheet.remove();
            hit = [composer];
            await settle();
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('100px');
        });

        test('follows a composer that grows with no glide, because it is the same bar', async () => {
            const { overlay } = showMessage();
            composer.getBoundingClientRect = () => ({ top: 650, bottom: 800, height: 150, left: 0, right: 1000, width: 1000 });
            document.body.className = 'typing';
            await settle();
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('150px');
            expect(overlay.style.getPropertyValue('transition')).toBe('');
        });

        test('follows a composer that moves sideways without a new size, which no resize observer reports', async () => {
            const { overlay } = showMessage();
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 280, right: 1000, width: 720 });
            document.body.className = 'docked';
            await settle();
            runFrames();
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('140px');
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('280px');
            expect(overlay.style.getPropertyValue('transition')).toBe('');
        });

        test('follows a composer that narrows from one side, which moves its edge and leaves its middle where it was', async () => {
            const { overlay } = showMessage('toast-bottom-left');
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 100, right: 900, width: 800 });
            document.body.className = 'narrowed';
            await settle();
            runFrames();
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('100px');
            composer.getBoundingClientRect = () => ({ top: 700, bottom: 800, height: 100, left: 300, right: 700, width: 400 });
            document.body.className = 'narrower';
            await settle();
            runFrames();
            expect(overlay.style.getPropertyValue(BAR_START_PROPERTY)).toBe('300px');
            expect(overlay.style.getPropertyValue(BAR_SHIFT_PROPERTY)).toBe('');
        });

        test('looks again when an animation that the Web Animations API runs on a surface has finished', async () => {
            const { overlay } = showMessage();
            const panelElement = document.createElement('div');
            document.body.append(panelElement);
            let finish;
            const animation = { playState: 'running', effect: { target: panelElement }, finished: new Promise((resolve) => { finish = resolve; }) };
            document.getAnimations = () => [animation];
            document.body.className = 'sheet-opening';
            await settle();
            runFrames();
            expect(frames).toHaveLength(0);

            // The sheet has got to its place, and nothing in the page changed but the end of its motion.
            hit = [panelElement, composer];
            finish();
            await settle();
            expect(frames).toHaveLength(1);
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            delete document.getAnimations;
        });

        test('follows a notification under a sheet when only the notification moves, because the sheet keeps the place of the toasts', async () => {
            const dialog = document.createElement('dialog');
            dialog.setAttribute('open', '');
            dialog.setAttribute('data-sb-modal', '');
            document.body.append(dialog);
            lay(dialog, { rect: { left: 0, top: 500, width: 1000, height: 300 } });
            hit = [dialog];
            const notifications = document.createElement('div');
            notifications.id = 'toast-container';
            notifications.className = 'toast-bottom-center';
            notifications.append(document.createElement('div'));
            dialog.append(notifications);
            updateToastPlacement();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');

            // The keyboard reaches 200px up, below the sheet's 300px, so the toasts stay where they are and the notification lifts.
            visualViewport.height = 600;
            document.body.className = 'keyboard';
            await settle();
            runFrames();
            expect(notifications.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('200px');
        });

        test('does not ease under reduced motion', () => {
            reducedMotion = true;
            const { overlay } = showMessage();
            openPanel();
            document.body.dispatchEvent(new Event('transitionend', { bubbles: true }));
            runFrames();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(overlay.style.getPropertyValue('transition')).toBe('');
        });

        test('puts a message that is shown while a panel is open at the edge at once', () => {
            openPanel();
            const { overlay } = showMessage();
            expect(overlay.style.getPropertyValue(BOTTOM_INSET_PROPERTY)).toBe('0px');
            expect(overlay.style.getPropertyValue('transition')).toBe('');
        });

        test('writes nothing when the page changes and the composer stays as it was', async () => {
            const { overlay } = showMessage();
            const writes = [];
            const original = overlay.style.setProperty.bind(overlay.style);
            overlay.style.setProperty = (name, value) => {
                writes.push(name);
                return original(name, value);
            };
            document.body.className = 'changed';
            await settle();
            // The check was made, and found the composer as it was.
            expect(frames).toHaveLength(1);
            elementsFromPoint.mockClear();
            runFrames();
            expect(elementsFromPoint).toHaveBeenCalled();
            expect(writes).toEqual([]);
        });

        test('ignores what the messages do to themselves', async () => {
            const { toast } = showMessage();
            toast.className = 'toast shown';
            toast.setAttribute('style', 'opacity: 0.5');
            await settle();
            expect(frames).toHaveLength(0);
            toast.dispatchEvent(new Event('transitionend', { bubbles: true }));
            expect(frames).toHaveLength(0);
        });

        test('does not watch while no message is on screen, and stops when the last one has gone', async () => {
            const overlay = overlayWith('toast-bottom-center');
            updateToastPlacement();
            document.body.className = 'one';
            await settle();
            expect(frames).toHaveLength(0);

            const toast = document.createElement('div');
            overlay.append(toast);
            updateToastPlacement();
            document.body.className = 'two';
            await settle();
            expect(frames).toHaveLength(1);
            runFrames();

            toast.remove();
            updateToastPlacement();
            document.body.className = 'three';
            await settle();
            expect(frames).toHaveLength(0);
            document.body.dispatchEvent(new Event('transitionend', { bubbles: true }));
            expect(frames).toHaveLength(0);
        });

        test('does not count a toast that is only being measured as a message', async () => {
            const overlay = overlayWith('toast-bottom-center');
            const measured = document.createElement('div');
            measured.className = 'sb-toast-measure';
            overlay.append(measured);
            updateToastPlacement();
            document.body.className = 'changed';
            await settle();
            expect(frames).toHaveLength(0);
        });

        test('looks again when a transition or an animation of a surface ends', () => {
            showMessage();
            elementsFromPoint.mockClear();
            document.body.dispatchEvent(new Event('transitionend', { bubbles: true }));
            document.body.dispatchEvent(new Event('animationend', { bubbles: true }));
            expect(frames).toHaveLength(1);
        });
    });
});
