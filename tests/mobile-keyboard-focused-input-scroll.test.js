/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importTabsModule } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const loginHtml = readFileSync(path.join(repoRoot, 'public', 'login.html'), 'utf8');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

let loaded = null;

afterEach(() => {
    jest.useRealTimers();
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('mobile keyboard focused-input scroll wiring', () => {
    test('keeps virtual keyboards from resizing the layout viewport and applies iOS inset CSS', () => {
        for (const html of [indexHtml, loginHtml]) {
            expect(html).toContain('interactive-widget=resizes-visual');
            expect(html).not.toContain('interactive-widget=resizes-content');
            expect(html).not.toContain('interactive-widget=overlays-content');
        }
        expect(mobileShellCss).toContain('var(--sb-ios-keyboard-bottom-inset, 0px)');
        expect(mobileShellCss).toContain('html.sb-ios-keyboard-inset-active #right-nav-panel.openDrawer > .scrollableInner,');
        expect(mobileShellCss).toContain('html.sb-ios-keyboard-inset-active .sb-shell-root.openDrawer .sb-shell-panel-scroller,');
        expect(mobileShellCss).not.toContain('body.sb-ios-keyboard-locked');
    });

    test('adds iOS keyboard bottom inset on iPad/legacy iOS without locking document scroll', async () => {
        const scrollToSpy = jest.fn();
        window.scrollTo = scrollToSpy;

        // Wide iOS WebKit viewport (iPadOS desktop-mode Safari): inset still activates even though not mobile width.
        loaded = await importTabsModule({
            width: 1024,
            height: 768,
            mocks: {
                'scripts/mobile-send-button.js': {
                    isIOSWebKitPlatform: () => true,
                    isLegacyIOSWebKitPlatform: () => false,
                },
            },
        });

        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        loaded.setViewport({ width: 1024, height: 768, vvHeight: 420, vvTop: 28 });
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        expect(document.documentElement.style.getPropertyValue('--sb-ios-keyboard-bottom-inset')).toBe('320px');
        expect(document.documentElement.classList.contains('sb-ios-keyboard-inset-active')).toBe(true);
        expect(document.body.classList.contains('sb-ios-keyboard-locked')).toBe(false);
        expect(scrollToSpy).not.toHaveBeenCalled();

        // Closing the keyboard clears the inset and class.
        loaded.setViewport({ width: 1024, height: 768, vvHeight: 768, vvTop: 0 });
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        expect(document.documentElement.style.getPropertyValue('--sb-ios-keyboard-bottom-inset')).toBe('0px');
        expect(document.documentElement.classList.contains('sb-ios-keyboard-inset-active')).toBe(false);
    });

    test('scrolls the shell panel scroller ahead of compatibility wrappers on mobile so a focused input clears the keyboard', async () => {
        jest.useFakeTimers();
        loaded = await importTabsModule({ mobile: true, width: 390, height: 844 });

        const shellScroller = document.createElement('div');
        shellScroller.className = 'sb-shell-panel-scroller';
        const innerScroller = document.createElement('div');
        innerScroller.className = 'scrollableInner';
        const input = document.createElement('input');
        input.type = 'text';
        innerScroller.append(input);
        shellScroller.append(innerScroller);
        document.body.append(shellScroller);

        let rectBottom = 600;
        input.getBoundingClientRect = () => ({ top: rectBottom - 40, bottom: rectBottom, left: 0, right: 200, width: 200, height: 40 });

        // Open keyboard: visible bottom = 20 + 460 = 480; overflow = 600 - 480 + 16 = 136.
        loaded.setViewport({ width: 390, height: 844, vvHeight: 460, vvTop: 20 });
        input.focus();

        expect(shellScroller.scrollTop).toBe(136);
        expect(innerScroller.scrollTop).toBe(0);

        // Safari shrinks the visual viewport further after initial focus; resync runs on visualViewport resize + 360ms timer.
        rectBottom = 520;
        loaded.setViewport({ width: 390, height: 844, vvHeight: 420, vvTop: 20 });
        loaded.visualViewport.dispatchEvent(new Event('resize'));
        expect(shellScroller.scrollTop).toBe(136 + (520 - 440 + 16));

        // Simulate late animation settling: 360ms timer re-checks.
        rectBottom = 460;
        jest.advanceTimersByTime(360);
        expect(shellScroller.scrollTop).toBe(136 + 96 + (460 - 440 + 16));
    });

    test('does not scroll focused inputs when on a desktop viewport or when no keyboard is open', async () => {
        loaded = await importTabsModule({ mobile: false, width: 1440, height: 900 });

        const scroller = document.createElement('div');
        scroller.className = 'scrollableInner';
        const input = document.createElement('input');
        scroller.append(input);
        document.body.append(scroller);
        input.getBoundingClientRect = () => ({ top: 700, bottom: 740, left: 0, right: 200, width: 200, height: 40 });

        loaded.setViewport({ width: 1440, height: 900, vvHeight: 500, vvTop: 0 });
        input.focus();
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(scroller.scrollTop).toBe(0);

        // Mobile viewport without a keyboard open does not scroll either.
        loaded.setViewport({ width: 390, height: 844, vvHeight: 844, vvTop: 0 });
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(scroller.scrollTop).toBe(0);
    });
});

describe('mobile popup keyboard shift wiring', () => {
    test('anchors open legacy popup dialogs to the visual viewport safe area and restores styles on blur/close', async () => {
        jest.useFakeTimers();
        loaded = await importTabsModule({ mobile: true, width: 390, height: 844 });

        const dialog = document.createElement('dialog');
        dialog.className = 'popup';
        dialog.open = true;
        dialog.style.opacity = '0.95';
        const body = document.createElement('div');
        body.className = 'popup-body';
        const input = document.createElement('input');
        input.type = 'text';
        body.append(input);
        dialog.append(body);
        document.body.append(dialog);

        input.getBoundingClientRect = () => ({ top: 520, bottom: 560, left: 10, right: 200, width: 190, height: 40 });
        const setPropertySpy = jest.spyOn(dialog.style, 'setProperty');
        const removeBodyPropSpy = jest.spyOn(body.style, 'removeProperty');

        // Open keyboard: vvHeight = 450, vvTop = 10 -> viewportBottom = 460.
        loaded.setViewport({ width: 390, height: 844, vvHeight: 450, vvTop: 10 });
        input.focus();

        expect(dialog.dataset.sbKeyboardAdjusted).toBe('true');
        expect(setPropertySpy).toHaveBeenCalledWith('min-height', '0', 'important');
        expect(setPropertySpy).toHaveBeenCalledWith('bottom', 'auto', 'important');
        expect(setPropertySpy).toHaveBeenCalledWith('top', 'calc(10px + max(16px, env(safe-area-inset-top, 0px)))', 'important');
        expect(setPropertySpy).toHaveBeenCalledWith(
            'max-height',
            'calc(450px - max(16px, env(safe-area-inset-top, 0px)) - max(16px, env(safe-area-inset-bottom, 0px)))',
            'important',
        );
        // overflow = 560 + 16 - 460 = 116
        expect(body.scrollTop).toBe(116);

        // When keyboard closes and visualViewport resizes back, styles and dataset restore cleanly.
        loaded.setViewport({ width: 390, height: 844, vvHeight: 844, vvTop: 0 });
        loaded.visualViewport.dispatchEvent(new Event('resize'));
        expect(dialog.dataset.sbKeyboardAdjusted).toBeUndefined();
        expect(dialog.dataset.sbKeyboardStyle).toBeUndefined();
        expect(dialog.style.opacity).toBe('0.95');
        expect(removeBodyPropSpy).toHaveBeenCalledWith('max-height');
    });

    test('ignores framed .sb-dialog popups and closed dialogs', async () => {
        loaded = await importTabsModule({ mobile: true, width: 390, height: 844 });

        const framed = document.createElement('dialog');
        framed.className = 'popup sb-dialog';
        framed.open = true;
        const framedInput = document.createElement('input');
        framed.append(framedInput);

        const closed = document.createElement('dialog');
        closed.className = 'popup';
        closed.open = false;
        const closedInput = document.createElement('input');
        closed.append(closedInput);

        document.body.append(framed, closed);
        loaded.setViewport({ width: 390, height: 844, vvHeight: 450, vvTop: 0 });

        framedInput.focus();
        framedInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(framed.dataset.sbKeyboardAdjusted).toBeUndefined();

        closedInput.focus();
        closedInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(closed.dataset.sbKeyboardAdjusted).toBeUndefined();
    });
});
