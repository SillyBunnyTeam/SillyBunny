import { describe, expect, test } from '@jest/globals';

import {
    clampMobileShellText,
    createMobileShellLifecycle,
    createMobileShellNavDragState,
    MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS,
    MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX,
    MOBILE_SHELL_NAV_SCROLL_BEHAVIOR,
    normalizeMobileShellText,
    resolveMobileModalA11yState,
    resolveMobileShellNavPageScroll,
    resolveMobileShellNavScrollIndicators,
    resolveMobileShellNavDragEnd,
    resolveMobileShellNavDragMove,
    shouldBlockMobileDocumentPan,
    shouldSuppressMobileShellNavClick,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

describe('mobile shell lifecycle helper', () => {
    test('shares text normalization with shell consumers', () => {
        expect(normalizeMobileShellText('  World   Info ')).toBe('world info');
        expect(clampMobileShellText('  long   label  ', 8)).toBe('long la…');
        expect(clampMobileShellText('label', Number.NaN)).toBe('label');
    });

    test('keeps current mobile shell timing constants explicit', () => {
        expect(MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX).toBe(6);
        expect(MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS).toBe(350);
    });

    test('captures mobile rail drag start only for mobile touch input', () => {
        expect(createMobileShellNavDragState({
            isMobileViewport: true,
            touch: { clientX: 20, clientY: 10 },
            scrollLeft: 42,
        })).toEqual({
            startX: 20,
            startY: 10,
            scrollLeft: 42,
            dragging: false,
        });

        expect(createMobileShellNavDragState({
            isMobileViewport: false,
            touch: { clientX: 20, clientY: 10 },
            scrollLeft: 42,
        })).toBeNull();
        expect(createMobileShellNavDragState({ isMobileViewport: true, touch: null })).toBeNull();
    });

    test('leaves rail touch movement alone while under drag threshold', () => {
        const dragState = createMobileShellNavDragState({
            isMobileViewport: true,
            touch: { clientX: 100, clientY: 100 },
            scrollLeft: 80,
        });

        expect(resolveMobileShellNavDragMove({
            dragState,
            touch: { clientX: 96, clientY: 100 },
        })).toEqual({
            dragState: {
                ...dragState,
                dragging: false,
            },
            shouldPreventDefault: false,
            shouldStopPropagation: false,
            nextScrollLeft: null,
        });
    });

    test('turns rail touch movement into controlled horizontal scroll after threshold', () => {
        const dragState = createMobileShellNavDragState({
            isMobileViewport: true,
            touch: { clientX: 100, clientY: 20 },
            scrollLeft: 120,
        });

        expect(resolveMobileShellNavDragMove({
            dragState,
            touch: { clientX: 90, clientY: 21 },
        })).toEqual({
            dragState: {
                ...dragState,
                dragging: true,
            },
            shouldPreventDefault: true,
            shouldStopPropagation: true,
            nextScrollLeft: 130,
        });
    });

    test('clears drag state when touch stream disappears', () => {
        expect(resolveMobileShellNavDragMove({
            dragState: { startX: 10, startY: 10, scrollLeft: 0, dragging: false },
            touch: null,
        })).toEqual({
            dragState: null,
            shouldPreventDefault: false,
            shouldStopPropagation: false,
            nextScrollLeft: null,
        });
    });

    test('suppresses click after completed rail drag only', () => {
        expect(resolveMobileShellNavDragEnd({
            dragState: { startX: 0, startY: 0, scrollLeft: 0, dragging: true },
            nowMs: 1000,
        })).toEqual({
            dragState: null,
            shouldStopPropagation: true,
            suppressClickUntil: 1350,
        });

        expect(resolveMobileShellNavDragEnd({
            dragState: { startX: 0, startY: 0, scrollLeft: 0, dragging: false },
            nowMs: 1000,
        })).toEqual({
            dragState: null,
            shouldStopPropagation: false,
            suppressClickUntil: 0,
        });

        expect(shouldSuppressMobileShellNavClick({ nowMs: 1200, suppressClickUntil: 1350 })).toBe(true);
        expect(shouldSuppressMobileShellNavClick({ nowMs: 1350, suppressClickUntil: 1350 })).toBe(false);
    });

    test('resolves shell rail page scroll distance and motion preference', () => {
        expect(resolveMobileShellNavPageScroll({
            direction: 1,
            clientWidth: 100,
            prefersReducedMotion: false,
        })).toEqual({
            left: 160,
            behavior: MOBILE_SHELL_NAV_SCROLL_BEHAVIOR.SMOOTH,
        });

        expect(resolveMobileShellNavPageScroll({
            direction: -1,
            clientWidth: 400,
            prefersReducedMotion: true,
        })).toEqual({
            left: -288,
            behavior: MOBILE_SHELL_NAV_SCROLL_BEHAVIOR.AUTO,
        });
    });

    test('resolves shell rail scroll affordances from measured dimensions', () => {
        expect(resolveMobileShellNavScrollIndicators({
            scrollLeft: 0,
            clientWidth: 300,
            scrollWidth: 800,
        })).toEqual({
            canScrollLeft: false,
            canScrollRight: true,
        });

        expect(resolveMobileShellNavScrollIndicators({
            scrollLeft: 500,
            clientWidth: 300,
            scrollWidth: 800,
        })).toEqual({
            canScrollLeft: true,
            canScrollRight: false,
        });
    });

    test('inerts the shell for any active mobile modal and never the top bar', () => {
        expect(resolveMobileModalA11yState({
            activeRootIds: [],
        })).toEqual({
            hasActiveMobileModal: false,
            shouldInertShell: false,
        });

        expect(resolveMobileModalA11yState({
            activeRootIds: ['left-nav-panel'],
        })).toEqual({
            hasActiveMobileModal: true,
            shouldInertShell: true,
        });

        expect(resolveMobileModalA11yState({
            activeRootIds: ['left-nav-panel', 'right-nav-panel'],
        })).toEqual({
            hasActiveMobileModal: true,
            shouldInertShell: true,
        });
    });

    test('blocks mobile document pan from body background gaps', () => {
        const matchesBackgroundSelector = selector => selector.split(',').map(value => value.trim()).includes('#bg1');
        const closestBackgroundSelector = selector => [null, target][Number(matchesBackgroundSelector(selector))];
        const target = {
            matches: matchesBackgroundSelector,
            closest: closestBackgroundSelector,
        };
        const event = {
            cancelable: true,
            defaultPrevented: false,
            target,
            touches: [{ identifier: 1, clientX: 120, clientY: 790 }],
        };

        expect(shouldBlockMobileDocumentPan(event, {
            touchStart: { identifier: 1, clientX: 120, clientY: 800 },
        })).toBe(true);
    });

    test('creates a stable lifecycle seam for future runtime wiring', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.nav.scrollBehavior).toBe(MOBILE_SHELL_NAV_SCROLL_BEHAVIOR);
        expect(lifecycle.nav.createDragState).toBe(createMobileShellNavDragState);
        expect(lifecycle.nav.resolveDragMove).toBe(resolveMobileShellNavDragMove);
        expect(lifecycle.nav.resolveDragEnd).toBe(resolveMobileShellNavDragEnd);
        expect(lifecycle.nav.shouldSuppressClick).toBe(shouldSuppressMobileShellNavClick);
        expect(lifecycle.nav.resolvePageScroll).toBe(resolveMobileShellNavPageScroll);
        expect(lifecycle.nav.resolveScrollIndicators).toBe(resolveMobileShellNavScrollIndicators);
        expect(lifecycle.modal.resolveA11yState).toBe(resolveMobileModalA11yState);
        expect(lifecycle.timings.navDragThresholdPx).toBe(MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX);
        expect(lifecycle.timings.navClickSuppressionMs).toBe(MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS);
    });
});
