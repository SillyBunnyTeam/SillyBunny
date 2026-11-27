/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importTabsModule } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('mobile shell button scale', () => {
    test('defines mobile rail scale variables and touch target floor in CSS', () => {
        expect(cssSource).toContain('--sb-mobile-toggle-min-size:');
        expect(cssSource).toContain('--sb-mobile-button-scale');
        expect(cssSource).toContain('--sb-mobile-toggle-min-size: var(--sb-mobile-touch-target, 44px);');
        expect(cssSource).toContain('--sb-mobile-button-scale: 1;');
        expect(cssSource).toContain('--sb-mobile-toggle-size: clamp(var(--sb-mobile-toggle-min-size), calc(var(--sb-mobile-toggle-size-base) * var(--sb-mobile-button-scale)), 56px);');
        expect(cssSource).not.toContain('data-sb-mobile-nav-layout=\'vertical\'');
        expect(cssSource).not.toContain('data-sb-desktop-nav-layout=\'vertical\'');
        expect(cssSource).not.toContain('data-sb-mobile-nav-mode=\'icon-only\'');
        expect(cssSource).not.toContain('data-sb-desktop-nav-mode=\'icon-only\'');
        expect(mobileCssSource).not.toContain('data-sb-mobile-nav-layout=\'vertical\'');
    });

    test('sets mobile and desktop button scale independently via the shell API and settings sliders', async () => {
        loaded = await importTabsModule();
        loaded.shell.openTab('right', 'appearance');
        await loaded.flush();
        loaded.shell.openTab('right', 'interface');
        await loaded.flush();

        const mobileSlider = /** @type {HTMLInputElement} */ (document.getElementById('sb-mobile-button-scale-input'));
        const desktopSlider = /** @type {HTMLInputElement} */ (document.getElementById('sb-desktop-button-scale-input'));
        expect(mobileSlider).toBeInstanceOf(HTMLInputElement);
        expect(desktopSlider).toBeInstanceOf(HTMLInputElement);

        mobileSlider.value = '120';
        mobileSlider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(loaded.shell.getMobileButtonScale()).toBe(120);
        expect(document.documentElement.style.getPropertyValue('--sb-mobile-button-scale')).toBe('1.2');
        expect(loaded.shell.getDesktopButtonScale()).toBe(100);

        desktopSlider.value = '85';
        desktopSlider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(loaded.shell.getDesktopButtonScale()).toBe(85);
        expect(loaded.shell.getMobileButtonScale()).toBe(120);
    });

    test('clears retired vertical/icon-only navigation data attributes on boot and exposes no legacy layout setters', async () => {
        const retiredAttrs = [
            'data-sb-mobile-nav-layout',
            'data-sb-desktop-nav-layout',
            'data-sb-mobile-nav-mode',
            'data-sb-desktop-nav-mode',
        ];
        loaded = await importTabsModule({ autoInit: false });
        for (const attr of retiredAttrs) {
            document.documentElement.setAttribute(attr, 'vertical');
        }

        await loaded.eventSource.emit(loaded.event_types.APP_READY);

        for (const attr of retiredAttrs) {
            expect(document.documentElement.hasAttribute(attr)).toBe(false);
        }
        expect(loaded.shell).not.toHaveProperty('setMobileNavLayout');
        expect(loaded.shell).not.toHaveProperty('setDesktopNavLayout');
        expect(loaded.shell).not.toHaveProperty('setMobileNavIconOnly');
        expect(loaded.shell).not.toHaveProperty('setDesktopNavIconOnly');
    });
});
