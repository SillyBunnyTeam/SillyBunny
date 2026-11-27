/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static CSS/HTML contracts. */
import { beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importPowerUserModule } from './util/power-user-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

document.body.innerHTML = `
    <input id="background_blur" type="range" value="0" />
    <input id="background_blur_counter" type="number" value="0" />
    <input id="background_opacity" type="range" value="1" />
    <input id="background_opacity_counter" type="number" value="1" />
    <input id="sheld_blur_strength" type="range" value="0" />
    <input id="sheld_blur_strength_counter" type="number" value="0" />
    <input id="blur_strength" type="range" value="0" />
    <input id="blur_strength_counter" type="number" value="0" />
`;

const { powerUser, runReady } = await importPowerUserModule();
const initialDefaults = structuredClone(powerUser.power_user);
await runReady();

const emptyData = { themes: [], context: [], instruct: [], sysprompt: [], reasoning: [] };

describe('core message transparency wiring', () => {
    const chatStylesSource = readSource('public', 'css', 'sillybunny-chat-styles.css');
    const backgroundsSource = readSource('public', 'css', 'backgrounds.css');
    const styleSource = readSource('public', 'style.css');
    const indexSource = readSource('public', 'index.html');
    const toggleDependentSource = readSource('public', 'css', 'toggle-dependent.css');
    const themeBlurSources = [
        styleSource,
        readSource('public', 'css', 'character-group-overlay.css'),
        readSource('public', 'css', 'mobile-styles.css'),
        readSource('public', 'css', 'popup.css'),
        readSource('public', 'css', 'select2-overrides.css'),
        readSource('public', 'css', 'sillybunny-chat-styles.css'),
        readSource('public', 'css', 'sillybunny-theme.css'),
        readSource('public', 'scripts', 'extensions', 'quick-reply', 'style.css'),
        readSource('public', 'scripts', 'extensions', 'stable-diffusion', 'style.css'),
    ].join('\n');

    beforeEach(() => {
        Object.assign(powerUser.power_user, structuredClone(initialDefaults));
        document.body.className = '';
        document.documentElement.style.cssText = '';
    });

    test('loads the native chat stylesheet during chat-display setup so default chat styles get core transparency', async () => {
        expect(indexSource).not.toContain('id="sillybunny-native-chat-styles"');
        document.getElementById('sillybunny-native-chat-styles')?.remove();

        await powerUser.loadPowerUserSettings(
            { power_user: { chat_display: powerUser.chat_styles.DEFAULT } },
            emptyData,
        );

        const link = document.getElementById('sillybunny-native-chat-styles');
        expect(link).not.toBeNull();
        expect(link.tagName).toBe('LINK');
        expect(link.getAttribute('href')).toMatch(/^css\/sillybunny-chat-styles\.css\?v=/);
    });

    test('paints document message blocks without double-painting bubble, native or flat styles', () => {
        expect(chatStylesSource).toContain('body:not(.bubblechat):not(.echostyle):not(.whisperstyle):not(.hushstyle):not(.ripplestyle):not(.tidestyle):not(.flatchat) #chat .mes:not(.smallSysMes) .mes_block');
        expect(chatStylesSource).toContain('background-color: var(--SmartThemeBotMesBlurTintColor);');
        expect(chatStylesSource).toContain('body:not(.bubblechat):not(.echostyle):not(.whisperstyle):not(.hushstyle):not(.ripplestyle):not(.tidestyle):not(.flatchat) #chat .mes[is_user="true"]:not(.smallSysMes) .mes_block');
        expect(chatStylesSource).toContain('background-color: var(--SmartThemeUserMesBlurTintColor);');
    });

    test('migrates background and sheld transparency variables with no-op defaults', () => {
        expect(chatStylesSource).toContain('--customCSS-bg-opacity: 1;');
        expect(chatStylesSource).toContain('--customCSS-bg-blur: 0;');
        expect(chatStylesSource).toContain('--sheldBackgroundColor: transparent;');
        expect(chatStylesSource).toContain('--sheldBlurStrength: 0;');
        expect(chatStylesSource).toContain('--mobileSheldBlurStrength: var(--sheldBlurStrength, 0);');
        expect(chatStylesSource).toContain('#sheld::before');
        expect(chatStylesSource).toContain('backdrop-filter: blur(calc(var(--sheldBlurStrength, 0) * 1px));');
        expect(backgroundsSource).toContain('opacity: var(--customCSS-bg-opacity, 1);');
        expect(backgroundsSource).toContain('filter: blur(calc(var(--customCSS-bg-blur, 0) * 1px));');
        expect(styleSource).toContain('@import url(css/backgrounds.css?v=20261118s);');
    });

    test('keeps zero-strength theme blur and Fast UI free of backdrop-filter layers', () => {
        powerUser.power_user.blur_strength = 0;
        powerUser.applyPowerUserSettings();
        expect(document.body.classList.contains('sb-theme-blur')).toBe(false);

        powerUser.power_user.blur_strength = 6;
        powerUser.applyPowerUserSettings();
        expect(document.body.classList.contains('sb-theme-blur')).toBe(true);

        expect(styleSource).toContain('--SmartThemeBackdropFilter: none;');
        expect(styleSource).toContain('body.sb-theme-blur {');
        expect(themeBlurSources).not.toMatch(/backdrop-filter:\s*blur\((?:calc\()?var\(--SmartThemeBlurStrength\)/);
        expect(toggleDependentSource).toContain('body.no-blur *::before,');
        expect(toggleDependentSource).toContain('body.no-blur *::backdrop {');
        expect(backgroundsSource).not.toContain('filter var(--sb-transition-slow)');
    });

    test('keeps theme blur descendants outside a root 3D raster layer', () => {
        const htmlRule = styleSource.match(/html\s*\{([\s\S]*?)\n\}/)?.[1];
        expect(htmlRule).toBeDefined();
        expect(htmlRule).not.toMatch(/(?:-webkit-)?transform\s*:/);
        expect(htmlRule).not.toMatch(/(?:-webkit-)?perspective\s*:/);
        expect(htmlRule).not.toMatch(/(?:-webkit-)?backface-visibility\s*:/);
    });

    test('persists and applies the three core visual sliders and mirrors sheld blur to the mobile CSS variable', async () => {
        expect(indexSource).toContain('id="background_blur"');
        expect(indexSource).toContain('aria-label="Background Blur"');
        expect(indexSource).toContain('aria-label="Background Blur Value"');
        expect(indexSource).toContain('id="background_opacity"');
        expect(indexSource).toContain('aria-label="Background Opacity"');
        expect(indexSource).toContain('aria-label="Background Opacity Value"');
        expect(indexSource).toContain('id="sheld_blur_strength"');
        expect(indexSource).toContain('aria-label="Chat Field Blur"');
        expect(indexSource).toContain('aria-label="Chat Field Blur Value"');

        $('#background_blur').val('8').trigger('input');
        $('#background_opacity').val('0.75').trigger('input');
        $('#sheld_blur_strength').val('7').trigger('input');

        expect(powerUser.power_user['customCSS-bg-blur']).toBe(8);
        expect(powerUser.power_user['customCSS-bg-opacity']).toBe(0.75);
        expect(powerUser.power_user.sheldBlurStrength).toBe(7);

        expect(document.documentElement.style.getPropertyValue('--customCSS-bg-blur')).toBe('8');
        expect(document.documentElement.style.getPropertyValue('--customCSS-bg-opacity')).toBe('0.75');
        expect(document.documentElement.style.getPropertyValue('--sheldBlurStrength')).toBe('7');
        expect(document.documentElement.style.getPropertyValue('--mobileSheldBlurStrength')).toBe('7');

        const snapshot = powerUser.getThemeObject('VisualTest');
        expect(snapshot['customCSS-bg-blur']).toBe(8);
        expect(snapshot['customCSS-bg-opacity']).toBe(0.75);
        expect(snapshot.sheldBlurStrength).toBe(7);
        expect(snapshot).not.toHaveProperty('mobileSheldBlurStrength');
    });
});
