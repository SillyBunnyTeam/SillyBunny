import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    MOBILE_SHELL_DRAWER_BOUND_ACTION,
    MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES,
    resolveMobileDrawerBounds,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

describe('mobile shell drawer bounds lifecycle', () => {
    test('keeps the bound style property list explicit', () => {
        expect(MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES).toEqual([
            'top',
            'bottom',
            'height',
            'max-height',
            'box-sizing',
        ]);
    });

    test('binds an open drawer on mobile with important viewport styles', () => {
        const decision = resolveMobileDrawerBounds({
            isMobileViewport: true,
            isOpen: true,
            isViewportBound: false,
            viewportHeight: 844,
            baseTopOffset: 56,
            shellGap: 3,
        });

        expect(decision.action).toBe(MOBILE_SHELL_DRAWER_BOUND_ACTION.BIND);
        expect(decision.styleRemovals).toEqual([]);
        expect(decision.styleWrites).toEqual([
            { property: 'top', value: '59px', priority: 'important' },
            { property: 'bottom', value: 'auto', priority: 'important' },
            { property: 'box-sizing', value: 'border-box', priority: 'important' },
            { property: 'height', value: '785px', priority: 'important' },
            { property: 'max-height', value: '785px', priority: 'important' },
        ]);
    });

    test('clamps the top offset to the viewport and never yields negative height', () => {
        const decision = resolveMobileDrawerBounds({
            isMobileViewport: true,
            isOpen: true,
            viewportHeight: 500,
            baseTopOffset: 480,
            shellGap: 200,
        });

        expect(decision.action).toBe(MOBILE_SHELL_DRAWER_BOUND_ACTION.BIND);
        expect(decision.styleWrites).toContainEqual({ property: 'top', value: '500px', priority: 'important' });
        expect(decision.styleWrites).toContainEqual({ property: 'height', value: '0px', priority: 'important' });
    });

    test('rounds fractional offsets and tolerates non-finite inputs', () => {
        const decision = resolveMobileDrawerBounds({
            isMobileViewport: true,
            isOpen: true,
            viewportHeight: 844,
            baseTopOffset: 55.6,
            shellGap: Number.NaN,
        });

        expect(decision.styleWrites).toContainEqual({ property: 'top', value: '56px', priority: 'important' });
        expect(decision.styleWrites).toContainEqual({ property: 'height', value: '788px', priority: 'important' });
    });

    test('clears a previously bound drawer that is closed or off-mobile', () => {
        const closedOnMobile = resolveMobileDrawerBounds({
            isMobileViewport: true,
            isOpen: false,
            isViewportBound: true,
        });
        const openOnDesktop = resolveMobileDrawerBounds({
            isMobileViewport: false,
            isOpen: true,
            isViewportBound: true,
        });

        for (const decision of [closedOnMobile, openOnDesktop]) {
            expect(decision.action).toBe(MOBILE_SHELL_DRAWER_BOUND_ACTION.CLEAR);
            expect(decision.styleWrites).toEqual([]);
            expect(decision.styleRemovals).toEqual([...MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES]);
        }
    });

    test('skips drawers that were never bound instead of touching their styles', () => {
        const decision = resolveMobileDrawerBounds({
            isMobileViewport: false,
            isOpen: false,
            isViewportBound: false,
        });

        expect(decision.action).toBe(MOBILE_SHELL_DRAWER_BOUND_ACTION.SKIP);
        expect(decision.styleWrites).toEqual([]);
        expect(decision.styleRemovals).toEqual([]);
    });

    test('exposes drawer bound decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.drawerBounds.action).toBe(MOBILE_SHELL_DRAWER_BOUND_ACTION);
        expect(lifecycle.drawerBounds.boundStyleProperties).toBe(MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES);
        expect(lifecycle.drawerBounds.resolveBounds).toBe(resolveMobileDrawerBounds);
    });
});
