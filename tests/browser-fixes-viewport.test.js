/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    getParsedUA: () => ({ browser: { name: 'Safari' }, os: { name: 'iOS' }, platform: { type: 'mobile' } }),
    isMobile: () => true,
}));
await jest.unstable_mockModule('../public/scripts/mobile-shell-lifecycle/index.js', () => ({
    shouldBlockMobileDocumentPan: () => false,
}));
await jest.unstable_mockModule('../public/scripts/mobile-send-button.js', () => ({
    isIOSWebKitPlatform: () => true,
    isLegacyIOSWebKitPlatform: () => false,
}));

const { applyBrowserFixes } = await import('../public/scripts/browser-fixes.js');
const { resetDefaultViewportCoordinator } = await import('../public/scripts/viewport-coordinator.js');

/** The mobile viewport workaround re-lays out the page by putting the root at `position: fixed` for one frame. */
describe('the mobile viewport re-layout workaround of browser-fixes.js', () => {
    let visualViewport;
    let frames;

    const rootPosition = () => document.documentElement.style.position;

    /** Runs the frame callbacks that are queued now; callbacks they queue wait for the next call. */
    function runFrame() {
        const due = frames.splice(0);
        for (const callback of due) callback(0);
    }

    function setHeights(height) {
        visualViewport.height = height;
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    }

    beforeEach(() => {
        frames = [];
        jest.spyOn(console, 'debug').mockImplementation(() => {});
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
        jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        visualViewport = Object.assign(new EventTarget(), { width: 390, height: 800, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        document.body.replaceChildren();
        document.documentElement.style.position = '';
        applyBrowserFixes();
    });

    afterEach(() => {
        resetDefaultViewportCoordinator();
        jest.restoreAllMocks();
        delete window.visualViewport;
        document.body.replaceChildren();
        document.documentElement.style.position = '';
    });

    test.each([
        ['a visual viewport resize', () => visualViewport.dispatchEvent(new Event('resize'))],
        ['a visual viewport scroll', () => visualViewport.dispatchEvent(new Event('scroll'))],
        ['a window resize', () => window.dispatchEvent(new Event('resize'))],
    ])('%s that changes the height by 24px or more flips the root to fixed for one frame', (_name, fire) => {
        setHeights(700);
        fire();
        runFrame();
        expect(rootPosition()).toBe('fixed');
        runFrame();
        expect(rootPosition()).toBe('');
    });

    test('a height change under 24px leaves the root alone', () => {
        setHeights(790);
        visualViewport.dispatchEvent(new Event('resize'));
        runFrame();
        expect(rootPosition()).toBe('');
        runFrame();
        expect(rootPosition()).toBe('');
    });

    test('a resize does not touch the root while a text field has focus', () => {
        const field = document.createElement('textarea');
        document.body.append(field);
        field.focus();
        expect(document.activeElement).toBe(field);

        setHeights(500);
        visualViewport.dispatchEvent(new Event('resize'));
        runFrame();
        expect(rootPosition()).toBe('');
    });

    test('a rotation flips the root', () => {
        window.dispatchEvent(new Event('orientationchange'));
        runFrame();
        expect(rootPosition()).toBe('fixed');
        runFrame();
        expect(rootPosition()).toBe('');
    });

    test('a rotation flips the root while a text field has focus', () => {
        const field = document.createElement('textarea');
        document.body.append(field);
        field.focus();

        window.dispatchEvent(new Event('orientationchange'));
        runFrame();
        expect(rootPosition()).toBe('fixed');
        runFrame();
        expect(rootPosition()).toBe('');
    });

    test('one frame that carries a resize and a rotation flips the root once', () => {
        setHeights(390);
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('orientationchange'));
        runFrame();
        expect(rootPosition()).toBe('fixed');
        runFrame();
        expect(rootPosition()).toBe('');
        expect(frames).toHaveLength(0);
    });
});
