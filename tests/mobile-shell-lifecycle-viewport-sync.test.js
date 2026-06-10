import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP,
    resolveDrawerBoundsSyncSchedule,
    resolveMobileViewportSyncPlan,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

const MOBILE_VIEWPORT_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_RAIL_ACTIONS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_DESKTOP_SHELL_SIZING,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
];

const DESKTOP_VIEWPORT_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_NAV,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_CHAT_TOOLS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_RAIL_ACTIONS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_DESKTOP_SHELL_SIZING,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
];

describe('mobile shell viewport sync lifecycle', () => {
    test('keeps the viewport sync step constants explicit', () => {
        expect(MOBILE_SHELL_VIEWPORT_SYNC_STEP).toEqual({
            SYNC_SHELL_VIEWPORT_BOUNDS: 'sync-shell-viewport-bounds',
            SYNC_MOBILE_SHELL_DRAWER_BOUNDS: 'sync-mobile-shell-drawer-bounds',
            CLOSE_MOBILE_NAV: 'close-mobile-nav',
            CLOSE_MOBILE_CHAT_TOOLS: 'close-mobile-chat-tools',
            SYNC_MOBILE_SHELL_RAIL_ACTIONS: 'sync-mobile-shell-rail-actions',
            SYNC_DESKTOP_SHELL_SIZING: 'sync-desktop-shell-sizing',
            APPLY_TOPBAR_OFFSET: 'apply-topbar-offset',
            SYNC_CHATBAR_VISIBILITY_STATE: 'sync-chatbar-visibility-state',
            UPDATE_TOP_BAR_BRAND: 'update-top-bar-brand',
            SCHEDULE_TOPBAR_CONTEXT_REFRESH: 'schedule-topbar-context-refresh',
            SYNC_MOBILE_MODAL_STATE: 'sync-mobile-modal-state',
        });
    });

    test('resolves the exact mobile viewport sync order', () => {
        expect(resolveMobileViewportSyncPlan({ isMobileViewport: true })).toEqual({
            steps: MOBILE_VIEWPORT_SYNC_STEPS,
        });
    });

    test('resolves the exact desktop viewport sync order with mobile closures', () => {
        expect(resolveMobileViewportSyncPlan({ isMobileViewport: false })).toEqual({
            steps: DESKTOP_VIEWPORT_SYNC_STEPS,
        });
    });

    test('defaults viewport sync planning to the desktop close sequence', () => {
        expect(resolveMobileViewportSyncPlan()).toEqual({
            steps: DESKTOP_VIEWPORT_SYNC_STEPS,
        });
    });

    test('resolves drawer bounds sync scheduling for every mobile and rAF state', () => {
        const cases = [
            {
                input: { isMobileViewport: false, hasAnimationFrame: false },
                expected: { shouldSchedule: false, useAnimationFrame: false, followupDelayMs: 123 },
            },
            {
                input: { isMobileViewport: false, hasAnimationFrame: true },
                expected: { shouldSchedule: false, useAnimationFrame: false, followupDelayMs: 123 },
            },
            {
                input: { isMobileViewport: true, hasAnimationFrame: false },
                expected: { shouldSchedule: true, useAnimationFrame: false, followupDelayMs: 123 },
            },
            {
                input: { isMobileViewport: true, hasAnimationFrame: true },
                expected: { shouldSchedule: true, useAnimationFrame: true, followupDelayMs: 123 },
            },
        ];

        for (const { input, expected } of cases) {
            expect(resolveDrawerBoundsSyncSchedule({
                ...input,
                followupDelayMs: 123,
            })).toEqual(expected);
        }
    });

    test('defaults drawer bounds sync scheduling to skipped with the standard follow-up delay', () => {
        expect(resolveDrawerBoundsSyncSchedule()).toEqual({
            shouldSchedule: false,
            useAnimationFrame: false,
            followupDelayMs: 350,
        });
    });

    test('normalizes invalid drawer bounds follow-up delays to the standard delay', () => {
        expect(resolveDrawerBoundsSyncSchedule({
            isMobileViewport: true,
            hasAnimationFrame: true,
            followupDelayMs: 'not-a-delay',
        })).toEqual({
            shouldSchedule: true,
            useAnimationFrame: true,
            followupDelayMs: 350,
        });
    });

    test('exposes viewport sync decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.viewportSync.step).toBe(MOBILE_SHELL_VIEWPORT_SYNC_STEP);
        expect(lifecycle.viewportSync.resolveSyncPlan).toBe(resolveMobileViewportSyncPlan);
        expect(lifecycle.viewportSync.resolveDrawerBoundsSchedule).toBe(resolveDrawerBoundsSyncSchedule);
    });
});
