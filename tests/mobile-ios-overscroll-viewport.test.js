/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTabsModule } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const styleCssPath = path.join(repoRoot, 'public', 'style.css');
const mobileShellCssPath = path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css');

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

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) {
        activeCleanups.pop()();
    }
    jest.restoreAllMocks();
});

async function mountTabsViewport({
    innerWidth = 390,
    innerHeight = 844,
    vvWidth = innerWidth,
    vvHeight = innerHeight,
    vvTop = 0,
    vvLeft = 0,
    docTop = 0,
    sheldTop = 56,
    topBarBottom = 56,
    isMobile = true,
    isTouchOnlyDesktop = false,
    isIOS = true,
    isLegacyIOS = false,
} = {}) {
    const origMaxTouchPointsDesc = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    const origPlatformDesc = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        value: isTouchOnlyDesktop ? 5 : 0,
    });
    Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: isTouchOnlyDesktop ? 'MacIntel' : 'Win32',
    });

    const loaded = await importTabsModule({
        mobile: isMobile,
        width: isMobile ? Math.min(innerWidth, 767) : Math.max(innerWidth, 1024),
        height: innerHeight,
        mocks: {
            'scripts/mobile-send-button.js': {
                bindIOSFastTapSendButton: jest.fn(),
                isIOSWebKitPlatform: () => isIOS,
                isLegacyIOSWebKitPlatform: () => isLegacyIOS,
            },
        },
    });

    const docEl = document.documentElement;
    const sheld = document.getElementById('sheld');
    const topBar = document.getElementById('top-bar');

    docEl.getClientRects = () => /** @type {any} */ ([{ top: docTop, bottom: innerHeight + docTop, left: 0, right: innerWidth }]);
    docEl.getBoundingClientRect = () => /** @type {any} */ ({ top: docTop, bottom: innerHeight + docTop, left: 0, right: innerWidth, width: innerWidth, height: innerHeight });
    sheld.getClientRects = () => /** @type {any} */ ([{ top: sheldTop, bottom: innerHeight, left: 0, right: innerWidth }]);
    sheld.getBoundingClientRect = () => /** @type {any} */ ({ top: sheldTop, bottom: innerHeight, left: 0, right: innerWidth, width: innerWidth, height: innerHeight - sheldTop });
    topBar.getClientRects = () => /** @type {any} */ ([{ top: docTop, bottom: topBarBottom, left: 0, right: innerWidth }]);
    topBar.getBoundingClientRect = () => /** @type {any} */ ({ top: docTop, bottom: topBarBottom, left: 0, right: innerWidth, width: innerWidth, height: topBarBottom - docTop });

    loaded.setViewport({
        width: isMobile ? Math.min(innerWidth, 767) : Math.max(innerWidth, 1024),
        height: innerHeight,
        vvWidth,
        vvHeight,
        vvTop,
        vvLeft,
    });
    loaded.visualViewport.dispatchEvent(new Event('resize'));

    activeCleanups.push(() => {
        loaded.cleanup();
        if (origMaxTouchPointsDesc) Object.defineProperty(navigator, 'maxTouchPoints', origMaxTouchPointsDesc);
        else delete navigator.maxTouchPoints;
        if (origPlatformDesc) Object.defineProperty(navigator, 'platform', origPlatformDesc);
        else delete navigator.platform;
    });

    return { loaded, docEl };
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

    test('syncShellViewportBounds publishes real visualViewport offsets on iOS keyboard shift', async () => {
        const { docEl } = await mountTabsViewport({
            innerWidth: 390,
            innerHeight: 844,
            vvWidth: 390,
            vvHeight: 500,
            vvTop: 124.6,
            vvLeft: 8.2,
            topBarBottom: 56,
            isMobile: true,
        });

        expect(docEl.style.getPropertyValue('--sb-shell-viewport-top')).toBe('125px');
        expect(docEl.style.getPropertyValue('--sb-shell-viewport-height')).toBe('500px');
        expect(docEl.style.getPropertyValue('--sb-shell-measured-top-offset')).toBe('56px');
        expect(docEl.style.getPropertyValue('--sb-shell-available-height')).toBe('444px');
    });

    test('topbar offset skips #sheld on mobile and touch-only viewports so rubber-band displacement cannot feed back', async () => {
        const mobile = await mountTabsViewport({
            docTop: 0,
            sheldTop: 280,
            topBarBottom: 56,
            isMobile: true,
            isTouchOnlyDesktop: false,
        });
        expect(mobile.docEl.style.getPropertyValue('--sb-shell-measured-top-offset')).toBe('56px');

        const touchOnly = await mountTabsViewport({
            innerWidth: 1024,
            innerHeight: 768,
            docTop: 0,
            sheldTop: 310,
            topBarBottom: 60,
            isMobile: false,
            isTouchOnlyDesktop: true,
        });
        expect(touchOnly.docEl.style.getPropertyValue('--sb-shell-measured-top-offset')).toBe('60px');
    });

    test('topbar offset subtracts root document overscroll offset from measurements', async () => {
        const shiftedMobile = await mountTabsViewport({
            docTop: 44,
            sheldTop: 260,
            topBarBottom: 100,
            isMobile: true,
        });
        expect(shiftedMobile.docEl.style.getPropertyValue('--sb-shell-measured-top-offset')).toBe('56px');

        const shiftedDesktop = await mountTabsViewport({
            innerWidth: 1280,
            innerHeight: 844,
            docTop: 40,
            sheldTop: 104,
            topBarBottom: 96,
            isMobile: false,
            isTouchOnlyDesktop: false,
        });
        expect(shiftedDesktop.docEl.style.getPropertyValue('--sb-shell-measured-top-offset')).toBe('64px');
    });
});
