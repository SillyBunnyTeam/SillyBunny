import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    MOBILE_SHELL_CLOSE_ALL_SURFACES,
    MOBILE_SHELL_SURFACE,
    resolveMobileShellExclusiveOpen,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

const EXPECTED_CLOSE_SURFACES = Object.freeze({
    [MOBILE_SHELL_SURFACE.NAV]: [
        MOBILE_SHELL_SURFACE.LEFT_SHELL,
        MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        MOBILE_SHELL_SURFACE.CHAT_TOOLS,
        MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
    ],
    [MOBILE_SHELL_SURFACE.LEFT_SHELL]: [
        MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        MOBILE_SHELL_SURFACE.NAV,
        MOBILE_SHELL_SURFACE.CHAT_TOOLS,
        MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
    ],
    [MOBILE_SHELL_SURFACE.RIGHT_SHELL]: [
        MOBILE_SHELL_SURFACE.LEFT_SHELL,
        MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        MOBILE_SHELL_SURFACE.NAV,
        MOBILE_SHELL_SURFACE.CHAT_TOOLS,
        MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
    ],
    [MOBILE_SHELL_SURFACE.CHARACTER_PANEL]: [
        MOBILE_SHELL_SURFACE.LEFT_SHELL,
        MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        MOBILE_SHELL_SURFACE.NAV,
        MOBILE_SHELL_SURFACE.CHAT_TOOLS,
        MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
    ],
    [MOBILE_SHELL_SURFACE.CHAT_TOOLS]: [
        MOBILE_SHELL_SURFACE.NAV,
        MOBILE_SHELL_SURFACE.LEFT_SHELL,
        MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
    ],
    [MOBILE_SHELL_SURFACE.CONNECTION_STRIP]: [
        MOBILE_SHELL_SURFACE.NAV,
        MOBILE_SHELL_SURFACE.LEFT_SHELL,
        MOBILE_SHELL_SURFACE.RIGHT_SHELL,
        MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
        MOBILE_SHELL_SURFACE.CHAT_TOOLS,
    ],
});

describe('mobile shell overlay exclusion lifecycle', () => {
    test('keeps the shell surface constants explicit', () => {
        expect(MOBILE_SHELL_SURFACE).toEqual({
            NAV: 'mobile-nav',
            LEFT_SHELL: 'left-shell',
            RIGHT_SHELL: 'right-shell',
            CHARACTER_PANEL: 'character-panel',
            CHAT_TOOLS: 'chat-tools',
            CONNECTION_STRIP: 'connection-strip',
        });
    });

    test('pins the ordered close-all surface list', () => {
        expect(MOBILE_SHELL_CLOSE_ALL_SURFACES).toEqual([
            MOBILE_SHELL_SURFACE.LEFT_SHELL,
            MOBILE_SHELL_SURFACE.RIGHT_SHELL,
            MOBILE_SHELL_SURFACE.CHARACTER_PANEL,
            MOBILE_SHELL_SURFACE.NAV,
            MOBILE_SHELL_SURFACE.CHAT_TOOLS,
            MOBILE_SHELL_SURFACE.CONNECTION_STRIP,
        ]);
    });

    test('pins every exclusive-open close list for mobile and desktop states', () => {
        for (const isMobileViewport of [true, false]) {
            for (const [surface, closeSurfaces] of Object.entries(EXPECTED_CLOSE_SURFACES)) {
                expect(resolveMobileShellExclusiveOpen({
                    surface,
                    isMobileViewport,
                })).toEqual({ closeSurfaces });
            }
        }
    });

    test('never closes the surface being opened', () => {
        for (const surface of Object.values(MOBILE_SHELL_SURFACE)) {
            for (const isMobileViewport of [true, false]) {
                const decision = resolveMobileShellExclusiveOpen({
                    surface,
                    isMobileViewport,
                });

                expect(decision.closeSurfaces).not.toContain(surface);
            }
        }
    });

    test('returns an empty close list for unknown surfaces', () => {
        expect(resolveMobileShellExclusiveOpen({
            surface: 'unknown-surface',
            isMobileViewport: true,
        })).toEqual({ closeSurfaces: [] });
    });

    test('exposes overlay decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.overlays.surface).toBe(MOBILE_SHELL_SURFACE);
        expect(lifecycle.overlays.closeAllSurfaces).toBe(MOBILE_SHELL_CLOSE_ALL_SURFACES);
        expect(lifecycle.overlays.resolveExclusiveOpen).toBe(resolveMobileShellExclusiveOpen);
    });
});
