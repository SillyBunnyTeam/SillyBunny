import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const loginHtml = readFileSync(path.join(repoRoot, 'public', 'login.html'), 'utf8');

describe('mobile keyboard focused-input scroll wiring', () => {
    test('keeps virtual keyboards from resizing the layout viewport', () => {
        for (const html of [indexHtml, loginHtml]) {
            expect(html).toContain('interactive-widget=resizes-visual');
            expect(html).not.toContain('interactive-widget=resizes-content');
            expect(html).not.toContain('interactive-widget=overlays-content');
        }
    });

    test('adds iOS keyboard bottom inset without locking document scroll', () => {
        expect(tabsSource).toContain('function syncIOSKeyboardBottomInset(');
        expect(tabsSource).toContain('--sb-ios-keyboard-bottom-inset');
        expect(tabsSource).toMatch(/layoutViewport\.height - visualViewportSize\.top - visualViewportSize\.height/);
        expect(tabsSource).not.toContain('sb-ios-keyboard-locked');
        expect(tabsSource).not.toContain('window.scrollTo(0, 0)');
        expect(tabsSource).not.toMatch(/window\.addEventListener\('scroll', syncIOSKeyboardBottomInset/);
    });

    test('applies the iOS keyboard inset to mobile drawer scroller padding', () => {
        const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

        expect(mobileShellCss).toContain('var(--sb-ios-keyboard-bottom-inset, 0px)');
        expect(mobileShellCss).not.toContain('body.sb-ios-keyboard-locked');
    });

    test('defines the focusin scroll helper', () => {
        expect(tabsSource).toContain('function scrollMobileFocusedInputIntoView(');
    });

    test('only runs inside the mobile viewport', () => {
        expect(tabsSource).toMatch(/function scrollMobileFocusedInputIntoView\([\s\S]*?if \(!isMobileViewport\(\)\)/);
    });

    test('targets shell panel and drawer scrollers', () => {
        expect(tabsSource).toMatch(/\.closest\('\.sb-shell-panel-scroller, \.scrollableInner, \.scrollableInnerFull'\)/);
    });

    test('scrolls against the visual-viewport bottom so the input clears the keyboard', () => {
        // The visible area ends at (visualViewport.offsetTop + height); the helper
        // must push the scroller so the focused input's rect.bottom clears it.
        expect(tabsSource).toContain('function getVisualViewportSize(');
        expect(tabsSource).toContain('function isVisualViewportKeyboardOpen(');
        expect(tabsSource).toMatch(/const viewportSize = getVisualViewportSize\(layoutViewport\);/);
        expect(tabsSource).toMatch(/if \(!isVisualViewportKeyboardOpen\(layoutViewport, viewportSize\)\) \{/);
        expect(tabsSource).toMatch(/viewportSize\.top \+ viewportSize\.height/);
        expect(tabsSource).toMatch(/scroller\.scrollTop \+= overflow/);
    });

    test('wires the helper on a document focusin listener inside initAll', () => {
        expect(tabsSource).toContain('document.addEventListener(\'focusin\', scrollMobileFocusedInputIntoView)');
    });
});
