import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const styleCssPath = path.join(repoRoot, 'public', 'style.css');
const mobileShellCssPath = path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css');
const tabsJsPath = path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js');

function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extracts declaration blocks whose trimmed selector list contains `targetSelector`.
 * Walks braces directly so nested rules and media blocks are handled reliably.
 * @param {string} css
 * @param {string} targetSelector
 * @returns {string[]}
 */
function findDeclarationBlocksForSelector(css, targetSelector) {
    const clean = stripCssComments(css);
    const blocks = [];
    let index = 0;

    while (index < clean.length) {
        const openBrace = clean.indexOf('{', index);
        if (openBrace === -1) {
            break;
        }

        const prelude = clean.slice(index, openBrace).trim();
        let depth = 1;
        let cursor = openBrace + 1;

        while (cursor < clean.length && depth > 0) {
            if (clean[cursor] === '{') {
                depth++;
            } else if (clean[cursor] === '}') {
                depth--;
            }
            cursor++;
        }

        const body = clean.slice(openBrace + 1, cursor - 1);

        if (prelude.startsWith('@')) {
            blocks.push(...findDeclarationBlocksForSelector(body, targetSelector));
        } else {
            const selectors = prelude.split(',').map(selector => selector.trim());
            if (selectors.includes(targetSelector)) {
                blocks.push(body);
            }
        }

        index = cursor;
    }

    return blocks;
}

class FakeHTMLElement {
    constructor({ id = '', rect = { top: 0, bottom: 0, left: 0, right: 0 }, hasClientRects = true } = {}) {
        this.id = id;
        this._rect = rect;
        this._hasClientRects = hasClientRects;
        this._styles = new Map();
        this._classes = new Set();
        this.style = {
            setProperty: (property, value) => {
                this._styles.set(property, String(value));
            },
            getPropertyValue: (property) => this._styles.get(property) ?? '',
        };
        this.classList = {
            toggle: (name, force) => {
                const enabled = force === undefined ? !this._classes.has(name) : Boolean(force);
                if (enabled) {
                    this._classes.add(name);
                } else {
                    this._classes.delete(name);
                }
                return enabled;
            },
            contains: name => this._classes.has(name),
        };
        this.clientWidth = 390;
        this.clientHeight = 844;
    }

    getClientRects() {
        return this._hasClientRects ? [this._rect] : [];
    }

    getBoundingClientRect() {
        return this._rect;
    }
}

/**
 * Loads the real viewport and topbar-offset functions from public/scripts/sillybunny-tabs.js
 * into a controlled VM sandbox so overscroll and visual-viewport behaviours can be exercised
 * directly without loading the full browser shell.
 */
function createTabsViewportSandbox({
    innerWidth = 390,
    innerHeight = 844,
    visualViewport = { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 },
    docTop = 0,
    sheldTop = 56,
    topBarBottom = 56,
    topbarCssVar = '56px',
    isMobile = true,
    isTouchOnlyDesktop = false,
    isIOS = true,
    isLegacyIOS = false,
} = {}) {
    const source = readFileSync(tabsJsPath, 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const declarations = ast.body.map(node => node.declaration ?? node);

    const functionNames = [
        'readFiniteViewportNumber',
        'getLayoutViewportSize',
        'getVisualViewportSize',
        'isEditableElement',
        'isMobileShellPanelEditableElement',
        'isChatComposerEditableElement',
        'hasOpenMobileShellDrawer',
        'shouldUseStableIOSPanelViewport',
        'isVisualViewportKeyboardOpen',
        'getComposerKeyboardInset',
        'getShellViewportSize',
        'syncShellViewportBounds',
        'getResolvedShellTopbarOffset',
    ];
    const variableNames = [
        'MOBILE_COMPOSER_KEYBOARD_PAN_EPSILON_PX',
        'MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS',
        'MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX',
        'sbLastIOSKeyboardHeight',
        'sbComposerKeyboardPreShiftDeadline',
        'sbComposerKeyboardSettleTimer',
    ];

    const selectedDecls = declarations.filter(node => (
        (node.type === 'FunctionDeclaration' && functionNames.includes(node.id?.name))
        || (node.type === 'VariableDeclaration' && node.declarations.some(d => variableNames.includes(d.id?.name)))
    ));

    const documentElement = new FakeHTMLElement({
        id: 'html',
        rect: { top: docTop, bottom: innerHeight + docTop, left: 0, right: innerWidth },
    });
    documentElement.clientWidth = innerWidth;
    documentElement.clientHeight = innerHeight;

    const sheld = new FakeHTMLElement({
        id: 'sheld',
        rect: { top: sheldTop, bottom: innerHeight, left: 0, right: innerWidth },
    });
    const topBar = new FakeHTMLElement({
        id: 'top-bar',
        rect: { top: docTop, bottom: topBarBottom, left: 0, right: innerWidth },
    });
    const elements = new Map([
        ['sheld', sheld],
        ['top-bar', topBar],
    ]);

    const document = {
        documentElement,
        activeElement: null,
        getElementById: id => elements.get(id) ?? null,
    };

    const window = {
        innerWidth,
        innerHeight,
        visualViewport,
        getComputedStyle: () => ({
            getPropertyValue: name => (name === '--sb-topbar-layout-offset' ? topbarCssVar : ''),
        }),
    };

    const sandbox = vm.createContext({
        HTMLElement: FakeHTMLElement,
        document,
        window,
        Date,
        Math,
        Number,
        Boolean,
        sbSettingsState: { open: false },
        isMobileViewport: () => isMobile,
        isTouchOnlyDesktopViewport: () => isTouchOnlyDesktop,
        isIOSWebKitPlatform: () => isIOS,
        isLegacyIOSWebKitPlatform: () => isLegacyIOS,
    });

    const snippet = selectedDecls.map(node => source.slice(node.start, node.end)).join('\n\n');
    vm.runInContext(snippet, sandbox);

    return { sandbox, documentElement, sheld, topBar, window };
}

describe('iOS overscroll blanking and keyboard composer displacement (#438)', () => {
    test('style.css blocks document overscroll chaining on html/body and contains overscroll inside #chat', () => {
        const styleCss = readFileSync(styleCssPath, 'utf8');

        const htmlBlocks = findDeclarationBlocksForSelector(styleCss, 'html');
        const bodyBlocks = findDeclarationBlocksForSelector(styleCss, 'body');
        const chatBlocks = findDeclarationBlocksForSelector(styleCss, '#chat');

        expect(htmlBlocks.some(block => /\boverscroll-behavior\s*:\s*none\b/.test(block))).toBe(true);
        expect(bodyBlocks.some(block => /\boverscroll-behavior\s*:\s*none\b/.test(block))).toBe(true);
        expect(chatBlocks.some(block => /\boverscroll-behavior-y\s*:\s*contain\b/.test(block))).toBe(true);
    });

    test('iOS #sheld rule shifts top by --sb-shell-viewport-top without line comments swallowing it', () => {
        const mobileShellCss = readFileSync(mobileShellCssPath, 'utf8');
        const sheldBlocks = findDeclarationBlocksForSelector(mobileShellCss, 'body:not(.movingUI) #sheld');

        expect(
            sheldBlocks.some(block => (
                !/(^|[^:])\/\//.test(block)
                && /\btop\s*:\s*calc\([^;]*var\(--sb-shell-measured-top-offset[^;]*\+\s*var\(--sb-shell-viewport-top,\s*0px\)[^;]*\)\s*!important/.test(block)
            )),
        ).toBe(true);
    });

    test('getShellViewportSize and syncShellViewportBounds publish real visualViewport offsets on iOS keyboard shift', () => {
        const { sandbox, documentElement } = createTabsViewportSandbox({
            innerWidth: 390,
            innerHeight: 844,
            visualViewport: { width: 390, height: 500, offsetTop: 124.6, offsetLeft: 8.2 },
            topBarBottom: 56,
            isMobile: true,
        });

        const viewport = sandbox.getShellViewportSize();
        expect(viewport.top).toBe(125);
        expect(viewport.left).toBe(8);
        expect(viewport.height).toBe(500);

        sandbox.syncShellViewportBounds();

        expect(documentElement.style.getPropertyValue('--sb-shell-viewport-top')).toBe('125px');
        expect(documentElement.style.getPropertyValue('--sb-shell-viewport-height')).toBe('500px');
        expect(documentElement.style.getPropertyValue('--sb-shell-measured-top-offset')).toBe('56px');
        expect(documentElement.style.getPropertyValue('--sb-shell-available-height')).toBe('444px');
    });

    test('getResolvedShellTopbarOffset skips #sheld on mobile and touch-only viewports so rubber-band displacement cannot feed back', () => {
        const mobile = createTabsViewportSandbox({
            docTop: 0,
            sheldTop: 280,
            topBarBottom: 56,
            isMobile: true,
            isTouchOnlyDesktop: false,
        });
        expect(mobile.sandbox.getResolvedShellTopbarOffset()).toBe(56);

        const touchOnly = createTabsViewportSandbox({
            docTop: 0,
            sheldTop: 310,
            topBarBottom: 60,
            isMobile: false,
            isTouchOnlyDesktop: true,
        });
        expect(touchOnly.sandbox.getResolvedShellTopbarOffset()).toBe(60);
    });

    test('getResolvedShellTopbarOffset subtracts root document overscroll offset from measurements', () => {
        const shiftedMobile = createTabsViewportSandbox({
            docTop: 44,
            sheldTop: 260,
            topBarBottom: 100,
            isMobile: true,
        });
        expect(shiftedMobile.sandbox.getResolvedShellTopbarOffset()).toBe(56);

        const shiftedDesktop = createTabsViewportSandbox({
            docTop: 40,
            sheldTop: 104,
            topBarBottom: 96,
            isMobile: false,
            isTouchOnlyDesktop: false,
        });
        expect(shiftedDesktop.sandbox.getResolvedShellTopbarOffset()).toBe(64);
    });
});
