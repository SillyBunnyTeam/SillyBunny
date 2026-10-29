/* eslint-disable playwright/no-standalone-expect, jest/no-conditional-expect -- Jest assertions run inside Jest tests, and gap rows assert only when the gap fits. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join(''), translate: value => value }));
const { computeSidePanelLayout } = await import('../../public/scripts/sillybunny-editor/side-panel.js');

function panel(id, side = 'left') {
    return { id, side };
}

function layout({ width, height = 900, chatWidth, topBarHeight = 60, panels = [panel('panel')] }) {
    return computeSidePanelLayout({
        viewport: { width, height },
        chat: { width: chatWidth },
        topBarHeight,
        panels,
    });
}

describe('computeSidePanelLayout', () => {
    test.each([
        [1024, 229, 280],
        [1280, 287, 287],
        [1440, 323, 323],
        [1920, 431, 420],
    ])('uses the §2.6 gap row at %i px', (width, gap, expectedPanelWidth) => {
        const result = layout({ width, chatWidth: width - gap * 2 });

        expect(result.mode).toBe('docked');
        expect(result.panelWidth).toBe(expectedPanelWidth);
        expect(result.panelRects.panel.width).toBe(expectedPanelWidth);
        expect(result.panelRects.panel.x + result.panelRects.panel.width).toBeLessThanOrEqual(result.chatRect.x);
        if (gap >= expectedPanelWidth) {
            expect(result.chatRect.x).toBe(gap);
        }
    });

    test('handles the 769–1180 px full-width chat rule without overlap', () => {
        const result = layout({ width: 1024, chatWidth: 1024 });

        expect(result.mode).toBe('docked');
        expect(result.chatRect).toMatchObject({ x: 280, width: 744 });
        expect(result.panelRects.panel.x + result.panelRects.panel.width).toBe(result.chatRect.x);
    });

    test('compresses a 100% chat column only as much as needed to make room', () => {
        const result = layout({ width: 1920, chatWidth: 1920, panels: [panel('right-panel', 'right')] });

        expect(result.mode).toBe('docked');
        expect(result.panelWidth).toBe(280);
        expect(result.chatRect).toMatchObject({ x: 0, width: 1640 });
        expect(result.panelRects['right-panel'].x).toBe(1640);
    });

    test('splits two panels on one side into equal-height rectangles', () => {
        const result = layout({
            width: 1440,
            chatWidth: 792,
            panels: [panel('first'), panel('second')],
        });

        expect(result.mode).toBe('docked');
        expect(result.panelRects.first).toMatchObject({ x: 0, y: 60, width: 324, height: 420 });
        expect(result.panelRects.second).toMatchObject({ x: 0, y: 480, width: 324, height: 420 });
    });

    test('reserves both sides while keeping the configured chat width', () => {
        const result = layout({
            width: 1440,
            chatWidth: 792,
            panels: [panel('left-panel', 'left'), panel('right-panel', 'right')],
        });

        expect(result.mode).toBe('docked');
        expect(result.panelRects['left-panel'].x + result.panelRects['left-panel'].width).toBe(result.chatRect.x);
        expect(result.chatRect.x + result.chatRect.width).toBe(result.panelRects['right-panel'].x);
        expect(result.chatRect.width).toBe(792);
    });

    test('switches to one active sheet below 360 px and docks at exactly 360 px', () => {
        const sheet = layout({
            width: 639,
            chatWidth: 400,
            panels: [panel('older'), panel('active', 'right')],
        });
        const docked = layout({ width: 640, chatWidth: 400 });

        expect(sheet.mode).toBe('sheet');
        expect(sheet.sheetPanelId).toBe('active');
        expect(sheet.panelModes).toEqual({ older: 'hidden', active: 'sheet' });
        expect(sheet.chatRect).toMatchObject({ x: 119.5, width: 400 });
        expect(docked.mode).toBe('docked');
        expect(docked.chatRect.width).toBe(360);
    });

    test('rejects invalid geometry and duplicate panels', () => {
        expect(() => layout({ width: 0, chatWidth: 0 })).toThrow('viewport.width');
        expect(() => layout({ width: 800, chatWidth: -1 })).toThrow('chat.width');
        expect(() => layout({ width: 800, chatWidth: 400, panels: [panel('same'), panel('same')] })).toThrow('Duplicate');
    });
});
