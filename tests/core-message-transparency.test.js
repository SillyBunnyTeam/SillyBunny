import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('core message transparency wiring', () => {
    const chatStylesSource = readSource('public', 'css', 'sillybunny-chat-styles.css');
    const backgroundsSource = readSource('public', 'css', 'backgrounds.css');
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');
    const indexSource = readSource('public', 'index.html');

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
        expect(chatStylesSource).toContain('--mobileSheldBlurStrength: 0;');
        expect(chatStylesSource).toContain('#sheld::before');
        expect(chatStylesSource).toContain('backdrop-filter: blur(calc(var(--sheldBlurStrength, 0) * 1px));');
        expect(backgroundsSource).toContain('opacity: var(--customCSS-bg-opacity, 1);');
        expect(backgroundsSource).toContain('filter: blur(calc(var(--customCSS-bg-blur, 0) * 1px));');
    });

    test('persists and applies the three core visual sliders', () => {
        expect(indexSource).toContain('id="background_blur"');
        expect(indexSource).toContain('id="background_opacity"');
        expect(indexSource).toContain('id="sheld_blur_strength"');
        expect(powerUserSource).toContain('const THEME_EFFECT_PROPERTIES = Object.freeze([');
        expect(powerUserSource).toContain("{ key: 'customCSS-bg-blur', selector: '#background_blur'");
        expect(powerUserSource).toContain("{ key: 'customCSS-bg-opacity', selector: '#background_opacity'");
        expect(powerUserSource).toContain("{ key: 'sheldBlurStrength', selector: '#sheld_blur_strength'");
        expect(powerUserSource).toContain('function applyThemeEffects()');
        expect(powerUserSource).toContain('theme[key] = power_user[key];');
        expect(powerUserSource).toContain('applyThemeEffects();');
    });
});
