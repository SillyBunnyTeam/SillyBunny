import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    createMobileShellNavDragState,
    MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS,
    MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX,
    MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS,
    MOBILE_SHELL_NAV_SCROLL_BEHAVIOR,
    MOBILE_SHELL_NAV_TOGGLE_ACTION,
    resolveMobileModalA11yState,
    resolveMobileNavOpenState,
    resolveMobileShellNavPageScroll,
    resolveMobileShellNavScrollIndicators,
    resolveMobileNavToggleIntent,
    resolveMobileShellNavDragEnd,
    resolveMobileShellNavDragMove,
    shouldAutoCloseMobileNav,
    shouldSuppressMobileShellNavClick,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

describe('mobile shell lifecycle helper', () => {
    test('keeps current mobile shell timing constants explicit', () => {
        expect(MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS).toBe(450);
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

    test('resolves hamburger replacement route before overlay toggling', () => {
        expect(resolveMobileNavToggleIntent({
            isMobileViewport: true,
            isReplacementEnabled: true,
            isOpen: false,
        })).toEqual({
            action: MOBILE_SHELL_NAV_TOGGLE_ACTION.ACTIVATE_PAGE_TARGET,
            shouldCloseCompetingPanels: false,
        });
    });

    test('opens mobile nav by closing competing panels and closes without extra cleanup', () => {
        expect(resolveMobileNavToggleIntent({
            isMobileViewport: true,
            isReplacementEnabled: false,
            isOpen: false,
        })).toEqual({
            action: MOBILE_SHELL_NAV_TOGGLE_ACTION.OPEN_NAV,
            shouldCloseCompetingPanels: true,
        });

        expect(resolveMobileNavToggleIntent({
            isMobileViewport: true,
            isReplacementEnabled: false,
            isOpen: true,
        })).toEqual({
            action: MOBILE_SHELL_NAV_TOGGLE_ACTION.CLOSE_NAV,
            shouldCloseCompetingPanels: false,
        });
    });

    test('keeps nav closed when open is requested outside mobile viewport', () => {
        expect(resolveMobileNavOpenState({
            requestedOpen: true,
            isMobileViewport: false,
            wasOpen: false,
            focusedInside: false,
        })).toEqual(expect.objectContaining({
            shouldOpen: false,
            overlayHidden: true,
            overlayAriaHidden: 'true',
            overlayInert: true,
            buttonExpanded: 'false',
            buttonIcon: 'menu',
            shouldRecordOpenedAt: false,
            shouldRefreshQuickActions: false,
            shouldFocusTitle: false,
            shouldRestoreButtonFocus: false,
        }));
    });

    test('announces and focuses mobile nav when opened', () => {
        expect(resolveMobileNavOpenState({
            requestedOpen: true,
            isMobileViewport: true,
            wasOpen: false,
            focusedInside: false,
        })).toEqual(expect.objectContaining({
            shouldOpen: true,
            overlayHidden: false,
            overlayAriaHidden: 'false',
            overlayInert: false,
            buttonExpanded: 'true',
            buttonIcon: 'close',
            shouldRecordOpenedAt: true,
            shouldRefreshQuickActions: true,
            shouldFocusTitle: true,
            shouldRestoreButtonFocus: false,
        }));
    });

    test('restores hamburger focus when closing nav from inside overlay', () => {
        expect(resolveMobileNavOpenState({
            requestedOpen: false,
            isMobileViewport: true,
            wasOpen: true,
            focusedInside: true,
        })).toEqual(expect.objectContaining({
            shouldOpen: false,
            shouldRestoreButtonFocus: true,
        }));
    });

    test('auto-closes mobile nav only for trusted content clicks after grace window', () => {
        expect(shouldAutoCloseMobileNav({
            isNavOpen: true,
            isTrusted: true,
            elapsedSinceOpenedMs: 450,
            isAutoCloseArea: true,
        })).toBe(true);

        expect(shouldAutoCloseMobileNav({
            isNavOpen: true,
            isTrusted: true,
            elapsedSinceOpenedMs: 449,
            isAutoCloseArea: true,
        })).toBe(false);
        expect(shouldAutoCloseMobileNav({
            isNavOpen: true,
            isTrusted: false,
            elapsedSinceOpenedMs: 600,
            isAutoCloseArea: true,
        })).toBe(false);
        expect(shouldAutoCloseMobileNav({
            isNavOpen: true,
            isTrusted: true,
            elapsedSinceOpenedMs: 600,
            isHamburgerTarget: true,
            isAutoCloseArea: true,
        })).toBe(false);
        expect(shouldAutoCloseMobileNav({
            isNavOpen: true,
            isTrusted: true,
            elapsedSinceOpenedMs: 600,
            isInsideNav: true,
            isAutoCloseArea: true,
        })).toBe(false);
    });

    test('inerts shell for any active mobile modal and top bar for non-nav modals', () => {
        expect(resolveMobileModalA11yState({
            activeRootIds: [],
        })).toEqual({
            hasActiveMobileModal: false,
            shouldInertShell: false,
            shouldInertTopBar: false,
        });

        expect(resolveMobileModalA11yState({
            activeRootIds: ['sb-mobile-nav'],
        })).toEqual({
            hasActiveMobileModal: true,
            shouldInertShell: true,
            shouldInertTopBar: false,
        });

        expect(resolveMobileModalA11yState({
            activeRootIds: ['sb-mobile-nav', 'right-nav-panel'],
        })).toEqual({
            hasActiveMobileModal: true,
            shouldInertShell: true,
            shouldInertTopBar: true,
        });
    });

    test('creates a stable lifecycle seam for future runtime wiring', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.nav.action).toBe(MOBILE_SHELL_NAV_TOGGLE_ACTION);
        expect(lifecycle.nav.scrollBehavior).toBe(MOBILE_SHELL_NAV_SCROLL_BEHAVIOR);
        expect(lifecycle.nav.createDragState).toBe(createMobileShellNavDragState);
        expect(lifecycle.nav.resolveDragMove).toBe(resolveMobileShellNavDragMove);
        expect(lifecycle.nav.resolveDragEnd).toBe(resolveMobileShellNavDragEnd);
        expect(lifecycle.nav.shouldSuppressClick).toBe(shouldSuppressMobileShellNavClick);
        expect(lifecycle.nav.resolvePageScroll).toBe(resolveMobileShellNavPageScroll);
        expect(lifecycle.nav.resolveScrollIndicators).toBe(resolveMobileShellNavScrollIndicators);
        expect(lifecycle.nav.resolveToggleIntent).toBe(resolveMobileNavToggleIntent);
        expect(lifecycle.nav.resolveOpenState).toBe(resolveMobileNavOpenState);
        expect(lifecycle.nav.shouldAutoClose).toBe(shouldAutoCloseMobileNav);
        expect(lifecycle.modal.resolveA11yState).toBe(resolveMobileModalA11yState);
        expect(lifecycle.timings.navOpenGraceMs).toBe(MOBILE_SHELL_LIFECYCLE_NAV_OPEN_GRACE_MS);
        expect(lifecycle.timings.navDragThresholdPx).toBe(MOBILE_SHELL_LIFECYCLE_NAV_DRAG_THRESHOLD_PX);
        expect(lifecycle.timings.navClickSuppressionMs).toBe(MOBILE_SHELL_LIFECYCLE_NAV_CLICK_SUPPRESSION_MS);
    });
});
