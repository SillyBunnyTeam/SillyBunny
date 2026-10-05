import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP,
    resolveMobileViewportSyncPlan,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

const MOBILE_VIEWPORT_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
];

const DESKTOP_VIEWPORT_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_NAV,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_CHAT_TOOLS,
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
            CLOSE_MOBILE_NAV: 'close-mobile-nav',
            CLOSE_MOBILE_CHAT_TOOLS: 'close-mobile-chat-tools',
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

    test('exposes viewport sync decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.viewportSync.step).toBe(MOBILE_SHELL_VIEWPORT_SYNC_STEP);
        expect(lifecycle.viewportSync.resolveSyncPlan).toBe(resolveMobileViewportSyncPlan);
    });
});
