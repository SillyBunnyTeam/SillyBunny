import { describe, expect, test } from '@jest/globals';

import { resolveIOSComposerKeyboardInset } from '../public/scripts/mobile-composer-keyboard.js';

const portraitViewport = {
    layoutWidth: 390,
    layoutHeight: 844,
    visualHeight: 844,
    visualTop: 0,
};

describe('iOS composer keyboard inset', () => {
    test('pre-shrinks the shell on first focus without a measured keyboard height', () => {
        const decision = resolveIOSComposerKeyboardInset({
            ...portraitViewport,
            composerFocused: true,
            preShiftActive: true,
        });

        expect(decision.inset).toBe(354);
        expect(decision.rememberedKeyboardHeight).toBe(0);
    });

    test('keeps the composer inset active when Safari pans the visual viewport', () => {
        const measuredPan = resolveIOSComposerKeyboardInset({
            ...portraitViewport,
            visualHeight: 500,
            visualTop: 260,
            composerFocused: true,
            preShiftActive: false,
        });
        const panBeforeResize = resolveIOSComposerKeyboardInset({
            ...portraitViewport,
            visualTop: 260,
            composerFocused: true,
            preShiftActive: false,
        });

        expect(measuredPan.inset).toBe(360);
        expect(panBeforeResize.inset).toBe(354);
    });

    test('reuses the measured keyboard height on refocus', () => {
        const measured = resolveIOSComposerKeyboardInset({
            ...portraitViewport,
            visualHeight: 500,
            composerFocused: true,
            preShiftActive: false,
        });
        const refocused = resolveIOSComposerKeyboardInset({
            ...portraitViewport,
            composerFocused: true,
            preShiftActive: true,
            rememberedKeyboardHeight: measured.rememberedKeyboardHeight,
            rememberedLayoutWidth: measured.rememberedLayoutWidth,
        });

        expect(measured.rememberedKeyboardHeight).toBe(344);
        expect(refocused.inset).toBe(360);
        expect(refocused.rememberedKeyboardHeight).toBe(344);
    });

    test('discards the remembered portrait height after orientation changes', () => {
        const landscape = resolveIOSComposerKeyboardInset({
            layoutWidth: 844,
            layoutHeight: 390,
            visualHeight: 390,
            visualTop: 0,
            composerFocused: true,
            preShiftActive: true,
            rememberedKeyboardHeight: 344,
            rememberedLayoutWidth: 390,
        });

        expect(landscape.inset).toBe(176);
        expect(landscape.rememberedKeyboardHeight).toBe(0);
        expect(landscape.rememberedLayoutWidth).toBe(844);
    });
});
