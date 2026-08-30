import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('core message transparency wiring', () => {
    const chatStylesSource = readSource('public', 'css', 'sillybunny-chat-styles.css');
    const backgroundsSource = readSource('public', 'css', 'backgrounds.css');
    const styleSource = readSource('public', 'style.css');
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');
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

    test('loads the native chat stylesheet during chat-display setup so default chat styles get core transparency', () => {
        expect(indexSource).not.toContain('id="sillybunny-native-chat-styles"');
        expect(powerUserSource).toContain("const NATIVE_CHAT_STYLE_STYLESHEET_HREF = 'css/sillybunny-chat-styles.css?v=20260606a';");
        expect(powerUserSource).toContain('ensureNativeChatStyleStylesheet();');
    });

    test('paints default and document message blocks without double-painting bubble or native styles', () => {
        expect(chatStylesSource).toContain('body:not(.bubblechat):not(.echostyle):not(.whisperstyle):not(.hushstyle):not(.ripplestyle):not(.tidestyle) #chat .mes:not(.smallSysMes) .mes_block');
        expect(chatStylesSource).toContain('background-color: var(--SmartThemeBotMesBlurTintColor);');
        expect(chatStylesSource).toContain('body:not(.bubblechat):not(.echostyle):not(.whisperstyle):not(.hushstyle):not(.ripplestyle):not(.tidestyle) #chat .mes[is_user="true"]:not(.smallSysMes) .mes_block');
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
        expect(styleSource).toContain('@import url(css/backgrounds.css?v=20260606a);');
    });

    test('keeps zero-strength theme blur and Fast UI free of backdrop-filter layers', () => {
        expect(powerUserSource).toContain('document.body.classList.toggle(\'sb-theme-blur\', Number(power_user.blur_strength) > 0);');
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

    test('persists and applies the three core visual sliders', () => {
        expect(indexSource).toContain('id="background_blur"');
        expect(indexSource).toContain('aria-label="Background blur"');
        expect(indexSource).toContain('aria-label="Background blur value"');
        expect(indexSource).toContain('id="background_opacity"');
        expect(indexSource).toContain('aria-label="Background opacity"');
        expect(indexSource).toContain('aria-label="Background opacity value"');
        expect(indexSource).toContain('id="sheld_blur_strength"');
        expect(indexSource).toContain('aria-label="Chat field blur"');
        expect(indexSource).toContain('aria-label="Chat field blur value"');
        expect(powerUserSource).toContain('const THEME_EFFECT_PROPERTIES = Object.freeze([');
        expect(powerUserSource).toContain("{ key: 'customCSS-bg-blur', selector: '#background_blur'");
        expect(powerUserSource).toContain("{ key: 'customCSS-bg-opacity', selector: '#background_opacity'");
        expect(powerUserSource).toContain("{ key: 'sheldBlurStrength', selector: '#sheld_blur_strength'");
        expect(powerUserSource).toContain("linkedCssVars: ['--mobileSheldBlurStrength']");
        expect(powerUserSource).not.toContain("key: 'mobileSheldBlurStrength'");
        expect(powerUserSource).toContain('function applyThemeEffects()');
        expect(powerUserSource).toContain('for (const cssVar of property.linkedCssVars || [])');
        expect(powerUserSource).toContain('theme[key] = power_user[key];');
        expect(powerUserSource).toContain('applyThemeEffects();');
    });
});
