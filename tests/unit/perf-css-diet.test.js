/* eslint-disable playwright/no-standalone-expect -- Jest unit tests for CSS diet and dynamic-styles batching. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readPublic(...segments) {
    return readFileSync(path.join(repoRoot, 'public', ...segments), 'utf8');
}

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractRuleBlock(css, selectorPattern) {
    const clean = stripComments(css);
    const match = clean.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
    return match ? match[1] : null;
}

describe('PR 10 CSS diet regressions', () => {
    const styleCss = readPublic('style.css');
    const tabsCss = readPublic('css', 'sillybunny-tabs.css');
    const themeCss = readPublic('css', 'sillybunny-theme.css');
    const mobileShellCss = readPublic('css', 'sillybunny-mobile-shell.css');
    const bgGalleryCss = readPublic('css', 'sillybunny-background-gallery.css');
    const wiEditorCss = readPublic('css', 'sillybunny-world-info-editor.css');
    const promptEditorCss = readPublic('css', 'sillybunny-prompt-editor.css');
    const personaEditorCss = readPublic('css', 'sillybunny-persona-editor.css');
    const streamingDisplayCss = readPublic('css', 'streaming-display.css');

    test('removes universal * pointer-events: auto rules and narrows #top-bar to direct children', () => {
        const cleanTabs = stripComments(tabsCss);
        expect(cleanTabs).not.toMatch(/#top-bar\s+\*\s*\{/);
        expect(cleanTabs).not.toMatch(/\.drawer-content\s+\*/);
        expect(cleanTabs).not.toMatch(/\.popup\s+\*/);
        expect(cleanTabs).not.toMatch(/\.sb-shell-panel\s+\*/);
        expect(extractRuleBlock(tabsCss, '#top-bar\\s*>\\s*\\*')).toContain('pointer-events: auto');
    });

    test('replaces O(N^2) :has(~ ...) last-visible-row selectors with forward sibling borders', () => {
        expect(stripComments(tabsCss)).not.toMatch(/:has\(\s*~/);
        expect(stripComments(wiEditorCss)).not.toMatch(/:has\(\s*~/);

        expect(tabsCss).toContain('.sb-data-security-group > .ds-pref-group > .ds-row:not([hidden]) ~ .ds-row:not([hidden])');
        expect(tabsCss).toContain('.sb-sampling-control-card:not([hidden]) ~ .sb-sampling-control-card:not([hidden])');
        expect(tabsCss).toContain('.sb-subpage-row:not([hidden]) ~ .sb-subpage-row:not([hidden])');
        expect(wiEditorCss).toContain('.sb-wi-settings-book:not([hidden]) ~ .sb-wi-settings-book:not([hidden])');
        expect(wiEditorCss).toContain('.sb-wi-property:not([hidden]) ~ .sb-wi-property:not([hidden])');
    });

    test('replaces body:has(...) with explicit body classes and drops :root interpolate-size', () => {
        expect(stripComments(styleCss)).not.toMatch(/body:has\(/);
        expect(stripComments(mobileShellCss)).not.toMatch(/body:has\(/);
        expect(stripComments(styleCss)).not.toMatch(/interpolate-size\s*:\s*allow-keywords/);

        expect(styleCss).toContain('body.sb-drawer-maximized #top-settings-holder');
        expect(styleCss).toContain('body.sb-drawer-open #top-settings-holder');
        expect(mobileShellCss).toContain('body.sb-slide-toggle-shown #send_form');
    });

    test('removes backdrop-filter from .sb-bg-cell-menu and .streaming-display and avoids #chat double-blur', () => {
        const bgMenuRule = extractRuleBlock(bgGalleryCss, '\\.sb-bg-cell-menu');
        expect(bgMenuRule).not.toBeNull();
        expect(bgMenuRule).toContain('background: var(--sb-osd-bg)');
        expect(bgMenuRule).not.toMatch(/backdrop-filter/);

        expect(stripComments(streamingDisplayCss)).not.toMatch(/backdrop-filter/);

        const chatBlurReset = extractRuleBlock(themeCss, 'body\\.sb-sheld-blur\\s+#chat');
        expect(chatBlurReset).not.toBeNull();
        expect(chatBlurReset).toContain('backdrop-filter: none');
        expect(chatBlurReset).toContain('-webkit-backdrop-filter: none');
    });

    test('applies layout/paint containment and content-visibility to large-list rows with drag overrides', () => {
        for (const [css, selector] of [
            [wiEditorCss, '\\.sb-wi-row'],
            [promptEditorCss, '\\.sb-prompt-row'],
            [bgGalleryCss, '\\.bg_example'],
            [personaEditorCss, '\\.sb-persona-row'],
        ]) {
            const block = extractRuleBlock(css, selector);
            expect(block).not.toBeNull();
            expect(block).toContain('contain: layout style paint');
            expect(block).toContain('content-visibility: auto');
            expect(block).toMatch(/contain-intrinsic-size:\s*auto\s+\d+px/);
        }

        for (const [css, cls] of [
            [wiEditorCss, 'sb-wi-row'],
            [promptEditorCss, 'sb-prompt-row'],
        ]) {
            expect(css).toContain(`.${cls}.ui-sortable-helper`);
            expect(css).toContain(`.${cls}.ui-sortable-placeholder`);
            expect(css).toMatch(new RegExp(`\\.${cls}[^{]*\\{[^}]*content-visibility:\\s*visible`, 's'));
        }

        expect(extractRuleBlock(tabsCss, '\\.ds-pref-group')).toContain('contain: layout style');
        expect(extractRuleBlock(tabsCss, '\\.sb-settings-mounted-shell\\s+\\.sb-settings-flat-section')).toContain('contain: layout style');

        for (const css of [styleCss, tabsCss, themeCss, mobileShellCss]) {
            expect(stripComments(css)).not.toMatch(/#chat\s+\.mes[^{]*\{[^}]*content-visibility/);
        }
    });

    test('isolates #sheld when settings page is open and contains inactive shell panels', () => {
        const sheldIsolation = extractRuleBlock(tabsCss, 'body\\.sb-settings-page-open\\s+#sheld');
        expect(sheldIsolation).not.toBeNull();
        expect(sheldIsolation).toContain('contain: layout style paint');
        expect(sheldIsolation).toContain('content-visibility: hidden');

        const inactivePanel = extractRuleBlock(tabsCss, '\\.sb-shell-panel:not\\(\\.sb-shell-panel-active\\)');
        expect(inactivePanel).not.toBeNull();
        expect(inactivePanel).toContain('contain: content');
    });
});

describe('dynamic-styles.js deferral, batching, and hover-free skipping', () => {
    function createMockBrowser() {
        class MockCSSStyleRule {
            constructor(selectorText, cssText) {
                this.selectorText = selectorText;
                this.style = { cssText };
            }
        }
        class MockCSSImportRule {}
        class MockCSSMediaRule {}
        class MockCSSSupportsRule {}

        class MockStyleElement {
            constructor() {
                this.tagName = 'STYLE';
                this.id = '';
                this.isConnected = false;
                this.textWrites = 0;
                this._textContent = '';
            }
            setAttribute(name, value) {
                if (name === 'id') this.id = value;
            }
            get textContent() {
                return this._textContent;
            }
            set textContent(val) {
                this.textWrites += 1;
                this._textContent = String(val);
            }
        }

        class MockLinkElement {
            constructor(href, sheet) {
                this.tagName = 'LINK';
                this.rel = 'stylesheet';
                this.href = href;
                this.sheet = sheet;
                this.dataset = {};
                this.listeners = new Map();
            }
            addEventListener(type, fn) {
                const list = this.listeners.get(type) ?? [];
                list.push(fn);
                this.listeners.set(type, list);
            }
            dispatch(type) {
                for (const fn of this.listeners.get(type) ?? []) fn();
            }
        }

        const idleCallbacks = new Map();
        let nextIdleId = 1;
        const docListeners = new Map();
        const headChildren = [];
        const observers = [];

        class MockMutationObserver {
            constructor(callback) {
                this.callback = callback;
                this.observeCalls = [];
                observers.push(this);
            }
            observe(target, options) {
                this.observeCalls.push({ target, options });
            }
            emit(records) {
                this.callback(records);
            }
        }

        const mockHead = {
            appendChild(el) {
                el.isConnected = true;
                headChildren.push(el);
                return el;
            },
        };

        const mockDocument = {
            baseURI: 'http://localhost:8000/',
            head: mockHead,
            styleSheets: [],
            createElement(tag) {
                if (tag === 'style') return new MockStyleElement();
                return new MockLinkElement('', null);
            },
            addEventListener(type, fn) {
                const list = docListeners.get(type) ?? [];
                list.push(fn);
                docListeners.set(type, list);
            },
            removeEventListener(type, fn) {
                const list = docListeners.get(type) ?? [];
                docListeners.set(type, list.filter(item => item !== fn));
            },
            dispatchKeydown(key) {
                for (const fn of [...(docListeners.get('keydown') ?? [])]) {
                    fn({ key });
                }
            },
        };

        const mockWindow = {
            requestIdleCallback(fn) {
                const id = nextIdleId++;
                idleCallbacks.set(id, fn);
                return id;
            },
            cancelIdleCallback(id) {
                idleCallbacks.delete(id);
            },
        };

        const runIdle = () => {
            for (const [id, fn] of [...idleCallbacks.entries()]) {
                idleCallbacks.delete(id);
                fn();
            }
        };

        return {
            MockCSSStyleRule,
            MockCSSImportRule,
            MockCSSMediaRule,
            MockCSSSupportsRule,
            MockStyleElement,
            MockLinkElement,
            MockMutationObserver,
            mockDocument,
            mockWindow,
            headChildren,
            observers,
            idleCallbacks,
            runIdle,
        };
    }

    test('defers initial scan, skips fontawesome/webfonts, batches into one style write, and coalesces tab switches', async () => {
        const env = createMockBrowser();
        const saved = {
            window: global.window,
            document: global.document,
            MutationObserver: global.MutationObserver,
            HTMLLinkElement: global.HTMLLinkElement,
            HTMLStyleElement: global.HTMLStyleElement,
            CSSStyleRule: global.CSSStyleRule,
            CSSImportRule: global.CSSImportRule,
            CSSMediaRule: global.CSSMediaRule,
            CSSSupportsRule: global.CSSSupportsRule,
        };

        Object.assign(global, {
            window: env.mockWindow,
            document: env.mockDocument,
            MutationObserver: env.MockMutationObserver,
            HTMLLinkElement: env.MockLinkElement,
            HTMLStyleElement: env.MockStyleElement,
            CSSStyleRule: env.MockCSSStyleRule,
            CSSImportRule: env.MockCSSImportRule,
            CSSMediaRule: env.MockCSSMediaRule,
            CSSSupportsRule: env.MockCSSSupportsRule,
        });

        try {
            const fontAwesomeRulesGetter = jest.fn(() => []);
            const fontAwesomeSheet = {
                href: 'http://localhost:8000/css/fontawesome.min.css',
                get cssRules() {
                    return fontAwesomeRulesGetter();
                },
            };
            const webfontRulesGetter = jest.fn(() => []);
            const webfontSheet = {
                href: 'http://localhost:8000/webfonts/AdwaitaSans/stylesheet.css',
                get cssRules() {
                    return webfontRulesGetter();
                },
            };
            const appRulesGetter = jest.fn(() => [
                new env.MockCSSStyleRule('.btn:hover', 'color: red;'),
                new env.MockCSSStyleRule('.chip:hover', 'opacity: 1;'),
                new env.MockCSSStyleRule('.already:hover', 'color: blue;'),
                new env.MockCSSStyleRule('.already:focus-visible', 'color: blue;'),
            ]);
            const appSheet = {
                href: 'http://localhost:8000/css/sillybunny-theme.css',
                get cssRules() {
                    return appRulesGetter();
                },
            };

            env.mockDocument.styleSheets = [fontAwesomeSheet, webfontSheet, appSheet];

            const mod = await import(`../../public/scripts/dynamic-styles.js?test=${Date.now()}`);
            expect(typeof mod.initDynamicStyles).toBe('function');
            expect(typeof mod.loadStylesheetAsync).toBe('function');
            expect(typeof mod.prefetchAsset).toBe('function');

            mod.initDynamicStyles();

            // Observer watches direct <head> children only (no subtree thrash).
            expect(env.observers[0].observeCalls).toEqual([
                { target: env.mockDocument.head, options: { childList: true, subtree: false } },
            ]);
            // Initial scan is deferred until idle or first Tab keydown.
            expect(appRulesGetter).not.toHaveBeenCalled();
            expect(env.headChildren).toHaveLength(0);
            expect(env.idleCallbacks.size).toBe(1);

            // First Tab keydown flushes immediately in a single textContent write.
            env.mockDocument.dispatchKeydown('Tab');
            expect(fontAwesomeRulesGetter).not.toHaveBeenCalled();
            expect(webfontRulesGetter).not.toHaveBeenCalled();
            expect(appRulesGetter).toHaveBeenCalledTimes(1);
            expect(env.headChildren).toHaveLength(1);

            const styleEl = env.headChildren[0];
            expect(styleEl.id).toBe('dynamic-styles');
            expect(styleEl.textWrites).toBe(1);
            expect(styleEl.textContent).toContain('.btn:focus-visible { color: red; }');
            expect(styleEl.textContent).toContain('.chip:focus-visible { opacity: 1; }');
            expect(styleEl.textContent).not.toContain('.already:focus-visible');

            // Multiple lazy sheets added during a Settings tab switch coalesce into one write.
            const tabSheetA = {
                href: 'http://localhost:8000/css/sillybunny-prompt-editor.css',
                cssRules: [new env.MockCSSStyleRule('.row-a:hover', 'background: green;')],
            };
            const tabSheetB = {
                href: 'http://localhost:8000/css/sillybunny-world-info-editor.css',
                cssRules: [new env.MockCSSStyleRule('.row-b:hover', 'background: yellow;')],
            };
            const linkA = new env.MockLinkElement(tabSheetA.href, tabSheetA);
            const linkB = new env.MockLinkElement(tabSheetB.href, tabSheetB);

            env.observers[0].emit([
                { type: 'childList', target: styleEl, addedNodes: [styleEl] },
                { type: 'childList', target: env.mockDocument.head, addedNodes: [linkA, linkB] },
            ]);
            expect(styleEl.textWrites).toBe(1);

            env.runIdle();
            expect(styleEl.textWrites).toBe(2);
            expect(styleEl.textContent).toContain('.row-a:focus-visible { background: green; }');
            expect(styleEl.textContent).toContain('.row-b:focus-visible { background: yellow; }');
        } finally {
            Object.assign(global, saved);
        }
    });
});
