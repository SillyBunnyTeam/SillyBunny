import { describe, expect, test } from '@jest/globals';

import {
    createPresetSelectTouchGuardState,
    markPresetSelectTouchGuardDragging,
    PRESET_SELECT_TOUCH_GUARD_DRAG_THRESHOLD_PX,
    resolvePresetSelectTouchGuardEnd,
    resolvePresetSelectTouchGuardMove,
    shouldSuppressPresetSelectTouchClick,
} from '../public/scripts/preset-select-touch-guard.js';

describe('preset select touch guard helper', () => {
    test('keeps the mobile drag threshold explicit', () => {
        expect(PRESET_SELECT_TOUCH_GUARD_DRAG_THRESHOLD_PX).toBe(4);
    });

    test('captures state only for mobile touch or pen input', () => {
        expect(createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 20,
            clientY: 40,
        })).toEqual({
            pointerId: 7,
            startX: 20,
            startY: 40,
            dragging: false,
        });

        expect(createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'pen',
            pointerId: 8,
            clientX: 10,
            clientY: 12,
        })).toEqual({
            pointerId: 8,
            startX: 10,
            startY: 12,
            dragging: false,
        });

        expect(createPresetSelectTouchGuardState({
            isMobileViewport: false,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 20,
            clientY: 40,
        })).toBeNull();
    });

    test('does not guard mouse input', () => {
        expect(createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'mouse',
            pointerId: 1,
            clientX: 20,
            clientY: 40,
        })).toBeNull();
    });

    test('allows deliberate taps under the drag threshold', () => {
        const touchGuardState = createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 100,
            clientY: 100,
        });
        const movedState = resolvePresetSelectTouchGuardMove({
            touchGuardState,
            pointerId: 7,
            clientX: 104,
            clientY: 103,
        });

        expect(movedState).toEqual({
            ...touchGuardState,
            dragging: false,
        });
        expect(resolvePresetSelectTouchGuardEnd({
            touchGuardState: movedState,
            pointerId: 7,
        })).toEqual({
            touchGuardState: null,
            shouldSuppressClick: false,
        });
    });

    test('suppresses the next mobile click after scroll movement', () => {
        const touchGuardState = createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 100,
            clientY: 100,
        });
        const movedState = resolvePresetSelectTouchGuardMove({
            touchGuardState,
            pointerId: 7,
            clientX: 100,
            clientY: 108,
        });

        expect(movedState).toEqual({
            ...touchGuardState,
            dragging: true,
        });
        expect(resolvePresetSelectTouchGuardEnd({
            touchGuardState: movedState,
            pointerId: 7,
        })).toEqual({
            touchGuardState: null,
            shouldSuppressClick: true,
        });
        expect(shouldSuppressPresetSelectTouchClick({
            isMobileViewport: true,
            suppressClick: true,
        })).toBe(true);
        expect(shouldSuppressPresetSelectTouchClick({
            isMobileViewport: false,
            suppressClick: true,
        })).toBe(false);
    });

    test('can mark active mobile guard state as dragging', () => {
        const touchGuardState = createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 100,
            clientY: 100,
        });
        const movedState = markPresetSelectTouchGuardDragging({
            touchGuardState,
            pointerId: 7,
        });

        expect(movedState).toEqual({
            ...touchGuardState,
            dragging: true,
        });
        expect(resolvePresetSelectTouchGuardEnd({
            touchGuardState: movedState,
            pointerId: 7,
        })).toEqual({
            touchGuardState: null,
            shouldSuppressClick: true,
        });
    });

    test('suppresses the next click when mobile panning cancels the pointer stream', () => {
        const touchGuardState = createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 100,
            clientY: 100,
        });

        expect(resolvePresetSelectTouchGuardEnd({
            touchGuardState,
            pointerId: 7,
            forceSuppress: true,
        })).toEqual({
            touchGuardState: null,
            shouldSuppressClick: true,
        });
    });

    test('suppresses the next click when mobile panning leaves the select', () => {
        const touchGuardState = createPresetSelectTouchGuardState({
            isMobileViewport: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: 100,
            clientY: 100,
        });

        expect(resolvePresetSelectTouchGuardEnd({
            touchGuardState,
            pointerId: 7,
            forceSuppress: true,
        })).toEqual({
            touchGuardState: null,
            shouldSuppressClick: true,
        });
    });
});
