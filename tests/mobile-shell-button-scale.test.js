import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');
const jsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

describe('mobile shell button scale', () => {
    test('defines mobile rail scale variables in :root', () => {
        expect(cssSource).toContain('--sb-mobile-toggle-min-size:');
        expect(cssSource).toContain('--sb-mobile-button-scale');
    });

    test('keeps shared mobile navigation controls at the documented touch target floor', () => {
        expect(cssSource).toContain('--sb-mobile-toggle-min-size: var(--sb-mobile-touch-target, 44px);');
    });

    test('mobile button scale feeds the shared mobile control size tokens', () => {
        expect(cssSource).toContain('--sb-mobile-button-scale: 1;');
        expect(cssSource).toContain('--sb-mobile-toggle-size: clamp(var(--sb-mobile-toggle-min-size), calc(var(--sb-mobile-toggle-size-base) * var(--sb-mobile-button-scale)), 56px);');
        expect(cssSource).toContain('--sb-mobile-tools-button-size: clamp(var(--sb-mobile-tools-min-size), calc(var(--sb-mobile-tools-button-size-base) * var(--sb-topbar-scale-active) * var(--sb-mobile-button-scale)), 56px);');
    });

    test('exposes a per-device scale setter driven by the settings slider', () => {
        expect(jsSource).toContain('function setMobileButtonScale(');
        expect(jsSource).toContain('function setDesktopButtonScale(');
        expect(jsSource).toContain('document.documentElement.style.setProperty(\'--sb-mobile-button-scale\', scaleFactor);');
    });

    test('no longer ships the removed vertical rail layout', () => {
        expect(cssSource).not.toContain('data-sb-mobile-nav-layout=\'vertical\'');
        expect(cssSource).not.toContain('data-sb-desktop-nav-layout=\'vertical\'');
        expect(cssSource).not.toContain('data-sb-mobile-nav-mode=\'icon-only\'');
        expect(cssSource).not.toContain('data-sb-desktop-nav-mode=\'icon-only\'');
        expect(mobileCssSource).not.toContain('data-sb-mobile-nav-layout=\'vertical\'');
        expect(jsSource).toContain('SB_LEGACY_NAVIGATION_DATA_ATTRIBUTES');
        expect(jsSource).toContain('migrateLegacyNavigationState');
    });

    test('mobile nav mode is fixed to the labelled layout', () => {
        expect(jsSource).not.toContain('setMobileNavLayout');
        expect(jsSource).not.toContain('setDesktopNavLayout');
        expect(jsSource).not.toContain('setMobileNavIconOnly');
        expect(jsSource).not.toContain('setDesktopNavIconOnly');
    });
});
