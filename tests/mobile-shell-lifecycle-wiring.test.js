/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { parse } from '@adobe/css-tools';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    shouldBlockMobileDocumentPan,
} from '../public/scripts/mobile-shell-lifecycle/index.js';
import { importTabsModule, DEFAULT_TABS_DOM } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileShellCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

let loaded = null;
const activeCleanups = [];

afterEach(() => {
    jest.useRealTimers();
    while (activeCleanups.length) {
        activeCleanups.pop()();
    }
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

function createElementStub({
    parentElement = null,
    matches = () => false,
    closest = () => null,
    scrollWidth = 0,
    clientWidth = 0,
    scrollHeight = 0,
    clientHeight = 0,
    scrollLeft = 0,
    scrollTop = 0,
} = {}) {
    return {
        parentElement,
        matches,
        closest,
        scrollWidth,
        clientWidth,
        scrollHeight,
        clientHeight,
        scrollLeft,
        scrollTop,
    };
}

function selectorListIncludes(selector, token) {
    return String(selector ?? '')
        .split(',')
        .map(part => part.trim())
        .includes(token);
}

function createTouchMove(target, { startX = 0, startY = 0, x = 0, y = 0, cancelable = true, touches = null } = {}) {
    const touchStart = { identifier: 1, clientX: startX, clientY: startY };

    return {
        event: {
            target,
            cancelable,
            touches: touches ?? [{ identifier: 1, clientX: x, clientY: y }],
        },
        touchStart,
    };
}

async function mountBrowserFixes({ mobile = true, isIOS = false, isLegacyIOS = false } = {}) {
    jest.resetModules();

    const listeners = [];
    const origDocAdd = document.addEventListener.bind(document);
    const origWinAdd = window.addEventListener.bind(window);
    document.addEventListener = (type, fn, opts) => { listeners.push([document, type, fn, opts]); return origDocAdd(type, fn, opts); };
    window.addEventListener = (type, fn, opts) => { listeners.push([window, type, fn, opts]); return origWinAdd(type, fn, opts); };

    const vvListeners = new Map();
    const visualViewport = {
        width: 390,
        height: 844,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        addEventListener(type, fn) { if (!vvListeners.has(type)) vvListeners.set(type, new Set()); vvListeners.get(type).add(fn); },
        removeEventListener(type, fn) { vvListeners.get(type)?.delete(fn); },
        dispatchEvent(evt) { for (const fn of [...(vvListeners.get(evt.type) ?? [])]) fn(evt); },
    };
    const origVVDesc = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: visualViewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });

    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = cb => { cb(0); return 0; };

    const scrollTo = jest.fn();
    window.scrollTo = scrollTo;

    const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));
    await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({
        getParsedUA: () => ({ os: { name: 'iOS' }, browser: { name: 'Safari' }, platform: { type: 'mobile' } }),
        isMobile: () => mobile,
    }));
    await jest.unstable_mockModule(pub('scripts/mobile-send-button.js'), () => ({
        isIOSWebKitPlatform: () => isIOS,
        isLegacyIOSWebKitPlatform: () => isLegacyIOS,
    }));

    const { applyBrowserFixes } = await import('../public/scripts/browser-fixes.js');
    applyBrowserFixes();

    activeCleanups.push(() => {
        for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
        vvListeners.clear();
        document.addEventListener = origDocAdd;
        window.addEventListener = origWinAdd;
        window.requestAnimationFrame = origRaf;
        if (origVVDesc) Object.defineProperty(window, 'visualViewport', origVVDesc);
        else delete window.visualViewport;
        document.documentElement.className = '';
        document.documentElement.removeAttribute('style');
        document.body.className = '';
        document.body.removeAttribute('style');
        document.body.innerHTML = '';
    });

    return { visualViewport, scrollTo };
}

describe('mobile shell lifecycle wiring', () => {
    test('keeps the trailing mobile chat hardening and search popover CSS parseable', () => {
        expect(() => parse(mobileShellCssSource, { source: 'sillybunny-mobile-shell.css' })).not.toThrow();
        expect(mobileShellCssSource).toMatch(/#sb-bottom-chat-bar\s*\{[^}]*touch-action:\s*pan-x;/);
        expect(mobileShellCssSource).toMatch(/#sb-bottom-chat-secondary-row\s*\{[^}]*touch-action:\s*pan-x;/);
        expect(tabsCssSource).toMatch(/\.sb-search-results\s*\{[\s\S]*position:\s*relative;[\s\S]*isolation:\s*isolate;[\s\S]*background:\s*var\(--sb-layer-popover\)/);
        expect(tabsCssSource).toMatch(/\.sb-search-result,\s*\n\.sb-search-empty\s*\{[\s\S]*position:\s*relative;[\s\S]*border:\s*0;\s*background:\s*transparent;/);
    });

    test('blocks mobile document panning from fixed chrome and scroll edges', () => {
        const chatScroller = createElementStub({ matches: s => selectorListIncludes(s, '#chat'), scrollHeight: 1200, clientHeight: 600, scrollTop: 120 });
        const chatScrollerAtTop = createElementStub({ matches: s => selectorListIncludes(s, '#chat'), scrollHeight: 1200, clientHeight: 600 });
        const wideMessageText = createElementStub({ parentElement: chatScroller, matches: s => selectorListIncludes(s, '.mes_text'), scrollWidth: 900, clientWidth: 320 });
        const wideMessageTextNode = { parentNode: wideMessageText };
        const shellSurface = createElementStub({ matches: s => selectorListIncludes(s, '#sheld') });
        const composerChrome = createElementStub({ matches: s => selectorListIncludes(s, '#nonQRFormItems') });
        const sendFormChrome = createElementStub({ matches: s => selectorListIncludes(s, '#send_form') });
        const composerGap = createElementStub({ parentElement: composerChrome });
        const textarea = createElementStub({ parentElement: composerChrome, matches: s => s.includes('textarea') });
        const scrollableTextarea = createElementStub({ parentElement: composerChrome, matches: s => s.includes('textarea'), scrollHeight: 400, clientHeight: 120, scrollTop: 100 });
        const textareaAtBottom = createElementStub({ parentElement: composerChrome, matches: s => s.includes('textarea'), scrollHeight: 400, clientHeight: 120, scrollTop: 280 });
        const quickReplyRail = createElementStub({ parentElement: composerChrome, matches: s => selectorListIncludes(s, '#leftSendForm'), scrollWidth: 600, clientWidth: 240, scrollLeft: 120 });
        const quickReplyRailAtStart = createElementStub({ parentElement: composerChrome, matches: s => selectorListIncludes(s, '#leftSendForm'), scrollWidth: 600, clientWidth: 240 });
        const quickReplyButton = createElementStub({ parentElement: quickReplyRail });
        const quickReplyStartButton = createElementStub({ parentElement: quickReplyRailAtStart });
        const quickReplyControl = createElementStub({ parentElement: quickReplyRail, matches: s => selectorListIncludes(s, '.interactable') });
        const incidentalComposerRail = createElementStub({ parentElement: composerChrome, matches: s => selectorListIncludes(s, '#leftSendForm'), scrollWidth: 57, clientWidth: 55 });
        const incidentalComposerGap = createElementStub({ parentElement: incidentalComposerRail });
        const incidentalComposerControl = createElementStub({ parentElement: incidentalComposerRail, matches: s => selectorListIncludes(s, '.interactable') });
        const sendFormButton = createElementStub({ parentElement: sendFormChrome });
        const genericButton = createElementStub({ matches: s => selectorListIncludes(s, 'button') });
        const companionHandle = createElementStub({ closest: s => selectorListIncludes(s, '#ica--tracker-panel-handle') ? companionHandle : null });
        const companionPanel = createElementStub({ matches: s => selectorListIncludes(s, '#ica--tracker-panel') || selectorListIncludes(s, '.ica--tpanel'), scrollHeight: 1200, clientHeight: 600, scrollTop: 120 });
        const companionPanelAtTop = createElementStub({ matches: s => selectorListIncludes(s, '#ica--tracker-panel') || selectorListIncludes(s, '.ica--tpanel'), scrollHeight: 1200, clientHeight: 600 });
        const companionPanelBody = createElementStub({ parentElement: companionPanel });
        const guidedActionsContainer = createElementStub({ parentElement: sendFormChrome, matches: s => selectorListIncludes(s, '.gg-action-buttons-container') });
        const guidedActionsGap = createElementStub({ parentElement: guidedActionsContainer });
        const bottomChatBar = createElementStub({ matches: s => selectorListIncludes(s, '#sb-bottom-chat-bar') });
        const bottomChatButton = createElementStub({ parentElement: bottomChatBar });
        const bottomChatSelect = createElementStub({ parentElement: bottomChatBar, matches: s => s.includes('select') });
        const bottomChatLongNameSelect = createElementStub({ parentElement: bottomChatBar, matches: s => s.includes('select'), scrollWidth: 900, clientWidth: 180 });
        const bottomChatSelect2Selection = createElementStub({ matches: s => selectorListIncludes(s, '.select2-selection') || selectorListIncludes(s, '[aria-labelledby="select2-sb-bottom-chat-select-container"]'), scrollWidth: 900, clientWidth: 180 });
        const bottomChatSecondaryRow = createElementStub({ parentElement: bottomChatBar, matches: s => selectorListIncludes(s, '#sb-bottom-chat-secondary-row') || selectorListIncludes(s, '.sb-bottom-chat-secondary-row'), scrollWidth: 700, clientWidth: 260, scrollLeft: 120 });
        const bottomChatSecondaryRowAtStart = createElementStub({ parentElement: bottomChatBar, matches: s => selectorListIncludes(s, '#sb-bottom-chat-secondary-row') || selectorListIncludes(s, '.sb-bottom-chat-secondary-row'), scrollWidth: 700, clientWidth: 260 });
        const bottomChatSecondaryButton = createElementStub({ parentElement: bottomChatSecondaryRow });
        const bottomChatSecondaryStartButton = createElementStub({ parentElement: bottomChatSecondaryRowAtStart });
        const presetPopupBody = createElementStub({ matches: s => selectorListIncludes(s, '.popup-body'), scrollHeight: 1200, clientHeight: 600 });
        const presetButton = createElementStub({ parentElement: presetPopupBody });
        const legacyDialog = createElementStub({ matches: s => selectorListIncludes(s, '#dialogue_popup') });
        const legacyDialogText = createElementStub({ parentElement: legacyDialog, matches: s => selectorListIncludes(s, '#dialogue_popup_text'), scrollHeight: 1200, clientHeight: 600 });
        const legacyDialogInput = createElementStub({ parentElement: legacyDialog, matches: s => s.includes('textarea') });
        const legacyDialogControls = createElementStub({ parentElement: legacyDialog, matches: s => selectorListIncludes(s, '#dialogue_popup_controls') });
        const legacyDialogButton = createElementStub({ parentElement: legacyDialogControls });
        const genericPopup = createElementStub({ matches: s => selectorListIncludes(s, 'dialog.popup') || selectorListIncludes(s, '.popup') });
        const genericPopupBody = createElementStub({ parentElement: genericPopup, matches: s => selectorListIncludes(s, '.popup-body'), scrollHeight: 1200, clientHeight: 600 });
        const genericPopupInput = createElementStub({ parentElement: genericPopupBody, matches: s => s.includes('textarea') || selectorListIncludes(s, '.popup-input') });
        const genericPopupControls = createElementStub({ parentElement: genericPopupBody, matches: s => selectorListIncludes(s, '.popup-controls') });
        const genericPopupButton = createElementStub({ parentElement: genericPopupControls });
        const characterDrawerScroller = createElementStub({ matches: s => selectorListIncludes(s, '.sb-shell-panel-scroller'), scrollHeight: 1600, clientHeight: 600 });
        const characterCard = createElementStub({ parentElement: characterDrawerScroller });
        const shellNavScroller = createElementStub({ parentElement: shellSurface, matches: s => selectorListIncludes(s, '.sb-shell-nav'), scrollWidth: 900, clientWidth: 300, scrollLeft: 200 });
        const shellNavScrollerAtStart = createElementStub({ parentElement: shellSurface, matches: s => selectorListIncludes(s, '.sb-shell-nav'), scrollWidth: 900, clientWidth: 300 });
        const shellNavTab = createElementStub({ parentElement: shellNavScroller });
        const shellNavStartTab = createElementStub({ parentElement: shellNavScrollerAtStart });

        for (const [move, expected] of [
            [createTouchMove(chatScroller, { y: -40 }), false],
            [createTouchMove(chatScroller, { x: -70, y: 4 }), true],
            [createTouchMove(chatScrollerAtTop, { x: 2, y: 40 }), true],
            [createTouchMove(wideMessageText, { x: -70, y: 4 }), true],
            [createTouchMove(wideMessageTextNode, { x: -70, y: 4 }), true],
            [createTouchMove(wideMessageTextNode, { x: 2, y: -40 }), false],
            [createTouchMove(shellSurface, { startX: 390, x: 310, y: 4 }), true],
            [createTouchMove(textarea, { y: -40 }), true],
            [createTouchMove(scrollableTextarea, { y: -40 }), false],
            [createTouchMove(textareaAtBottom, { y: -40 }), true],
            [createTouchMove(quickReplyButton, { x: 40, y: 2 }), false],
            [createTouchMove(quickReplyStartButton, { x: 40, y: 2 }), true],
            [createTouchMove(quickReplyButton, { x: 2, y: -40 }), true],
            [createTouchMove(quickReplyControl, { x: -40, y: 2 }), false],
            [createTouchMove(incidentalComposerGap, { x: -40, y: 2 }), true],
            [createTouchMove(incidentalComposerControl, { x: -40, y: 2 }), true],
            [createTouchMove(companionHandle, { x: -40, y: 1 }), true],
            [createTouchMove(companionHandle, { x: 1, y: 40 }), true],
            [createTouchMove(companionPanelBody, { x: 1, y: -40 }), false],
            [createTouchMove(companionPanelAtTop, { x: 1, y: 40 }), true],
            [createTouchMove(companionPanelBody, { x: -40, y: 1 }), true],
            [createTouchMove(composerGap, { y: -40 }), true],
            [createTouchMove(guidedActionsGap, { y: -40 }), true],
            [createTouchMove(sendFormButton, { y: -40 }), true],
            [createTouchMove(genericButton, { y: -40 }), false],
            [createTouchMove(bottomChatButton, { y: -40 }), true],
            [createTouchMove(bottomChatSelect, { y: -40 }), true],
            [createTouchMove(bottomChatLongNameSelect, { x: -50, y: 1 }), true],
            [createTouchMove(bottomChatSelect2Selection, { x: -50, y: 1 }), true],
            [createTouchMove(bottomChatSecondaryButton, { x: 40, y: 2 }), false],
            [createTouchMove(bottomChatSecondaryStartButton, { x: 40, y: 2 }), true],
            [createTouchMove(bottomChatSecondaryButton, { x: 2, y: -40 }), true],
            [createTouchMove(presetButton, { y: -40 }), false],
            [createTouchMove(legacyDialogText, { y: -40 }), false],
            [createTouchMove(legacyDialogInput, { y: -40 }), true],
            [createTouchMove(legacyDialogButton, { y: -40 }), true],
            [createTouchMove(genericPopupBody, { y: -40 }), false],
            [createTouchMove(genericPopupInput, { y: -40 }), false],
            [createTouchMove(genericPopupButton, { y: -40 }), false],
            [createTouchMove(characterCard, { y: -40 }), false],
            [createTouchMove(shellNavTab, { x: -50, y: 1 }), false],
            [createTouchMove(shellNavStartTab, { x: 50, y: 1 }), true],
            [createTouchMove(composerGap, { touches: [{}, {}] }), false],
            [createTouchMove(composerGap, { cancelable: false }), false],
        ]) {
            expect(shouldBlockMobileDocumentPan(move.event, { touchStart: move.touchStart })).toBe(expected);
        }
    });

    test('allows horizontal scrolling within designated mobile rails', () => {
        for (const [rootSelector, railSelector] of [
            ['#sheld', '.group_speaker_list'],
            ['#user-settings-block', '.sb-settings-tabs-nav'],
            ['#top-bar', '.sb-topbar-group-left'],
            ['#right-nav-panel', '.sb-character-create-bar'],
            ['#right-nav-panel', '#HotSwapWrapper .hotswap'],
            ['#right-nav-panel', '#right-nav-panel .rm_tag_controls'],
            ['#left-nav-panel', '#completion_prompt_manager .completion_prompt_manager_prompt > span:nth-child(3)'],
            ['.popup', '.popup.horizontal_scrolling_dialogue_popup .popup-content'],
            ['#chat', '.mes_text pre code'],
            ['#chat', '.mes_reasoning pre code'],
            ['.popup', '.img_enlarged_holder'],
            ['.popup', '.img_enlarged_container pre code'],
        ]) {
            const root = createElementStub({ matches: s => selectorListIncludes(s, rootSelector) });
            const rail = createElementStub({ parentElement: root, matches: s => selectorListIncludes(s, railSelector), scrollWidth: 600, clientWidth: 240, scrollLeft: 120 });
            const railAtStart = createElementStub({ parentElement: root, matches: s => selectorListIncludes(s, railSelector), scrollWidth: 600, clientWidth: 240 });
            const control = createElementStub({ parentElement: rail, matches: s => selectorListIncludes(s, 'button') });
            const controlAtStart = createElementStub({ parentElement: railAtStart, matches: s => selectorListIncludes(s, 'button') });

            expect(shouldBlockMobileDocumentPan(createTouchMove(control, { x: -40, y: 2 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(false);
            expect(shouldBlockMobileDocumentPan(createTouchMove(rail, { x: -40, y: 2 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(false);
            expect(shouldBlockMobileDocumentPan(createTouchMove(controlAtStart, { x: 40, y: 2 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
            expect(shouldBlockMobileDocumentPan(createTouchMove(control, { x: 2, y: -40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
        }
    });

    test('allows owned scrolling from controls while blocking edge overscroll and outside-guard leakage', () => {
        const createMenuRoot = rootSelector => createElementStub({
            matches: s => selectorListIncludes(s, rootSelector) || selectorListIncludes(s, `${rootSelector}.openDrawer`),
            scrollHeight: 1600,
            clientHeight: 600,
        });
        const workspaceRoot = createMenuRoot('#left-nav-panel');
        const customizeRoot = createMenuRoot('#user-settings-block');
        const characterRoot = createMenuRoot('#right-nav-panel');
        const closedWorkspaceRoot = createElementStub({ matches: s => selectorListIncludes(s, '#left-nav-panel'), scrollHeight: 1600, clientHeight: 600 });
        const workspaceButton = createElementStub({ parentElement: workspaceRoot, matches: s => selectorListIncludes(s, 'button') });
        const connectionProfileAction = createElementStub({ parentElement: workspaceRoot });
        const customizeSelect = createElementStub({ parentElement: customizeRoot, matches: s => s.includes('select') });
        const characterCard = createElementStub({ parentElement: characterRoot });
        const closedWorkspaceButton = createElementStub({ parentElement: closedWorkspaceRoot });
        const documentScroller = createElementStub({ scrollHeight: 2000, clientHeight: 800, scrollTop: 200 });
        const guardedSurface = createElementStub({ parentElement: documentScroller, matches: s => selectorListIncludes(s, '#send_form') });
        const guardedButton = createElementStub({ parentElement: guardedSurface, matches: s => selectorListIncludes(s, 'button') });

        expect(shouldBlockMobileDocumentPan(createTouchMove(workspaceButton, { x: 1, y: -40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(false);
        expect(shouldBlockMobileDocumentPan(createTouchMove(workspaceButton, { x: 1, y: 40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
        expect(shouldBlockMobileDocumentPan(createTouchMove(connectionProfileAction, { x: 40, y: 1 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
        expect(shouldBlockMobileDocumentPan(createTouchMove(customizeSelect, { x: 1, y: -40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(false);
        expect(shouldBlockMobileDocumentPan(createTouchMove(characterCard, { x: 1, y: 40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
        expect(shouldBlockMobileDocumentPan(createTouchMove(closedWorkspaceButton, { x: 1, y: 40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
        expect(shouldBlockMobileDocumentPan(createTouchMove(guardedButton, { y: -40 }).event, { touchStart: { identifier: 1, clientX: 0, clientY: 0 } })).toBe(true);
    });

    test('browser-fixes.js blocks touchmove on guarded chrome, suspends document scroll reset only when hiding focused editable, and settles viewport reset', async () => {
        jest.useFakeTimers();
        document.body.innerHTML = '<form id="send_form"><input id="field" type="text"></form>';
        const { visualViewport, scrollTo } = await mountBrowserFixes({ mobile: true, isIOS: true, isLegacyIOS: false });

        // Guarded chrome touchmove calls preventDefault.
        const form = document.getElementById('send_form');
        const touchStartEvt = new Event('touchstart', { bubbles: true, cancelable: true });
        Object.defineProperty(touchStartEvt, 'touches', { value: [{ identifier: 1, clientX: 10, clientY: 10 }] });
        form.dispatchEvent(touchStartEvt);

        const touchMoveEvt = new Event('touchmove', { bubbles: true, cancelable: true });
        Object.defineProperty(touchMoveEvt, 'touches', { value: [{ identifier: 1, clientX: 10, clientY: -40 }] });
        form.dispatchEvent(touchMoveEvt);
        expect(touchMoveEvt.defaultPrevented).toBe(true);

        // Document scroll reset suspends when resetting would push a focused input below visualViewport.height - 8.
        const field = document.getElementById('field');
        field.getBoundingClientRect = () => ({ top: 440, bottom: 480, left: 0, right: 200, width: 200, height: 40 });
        field.focus();
        visualViewport.height = 460;
        Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 40 });
        window.dispatchEvent(new Event('scroll'));
        expect(scrollTo).not.toHaveBeenCalled();

        // Once focus leaves, focusout triggers the deferred scroll reset to (0, 0).
        field.blur();
        field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        expect(scrollTo).toHaveBeenCalledWith(0, 0);
        // Let focusout's own viewport reset settle window finish before testing an explicit reset event.
        jest.advanceTimersByTime(400);

        // Mobile viewport reset event clears transient position styles and settles after 360ms.
        scrollTo.mockClear();
        document.documentElement.style.position = 'fixed';
        document.body.style.transform = 'translateY(10px)';
        Object.defineProperty(document, 'scrollingElement', { configurable: true, value: { scrollTop: 30, scrollLeft: 0 } });
        window.dispatchEvent(new CustomEvent('sb-mobile-viewport-reset', { detail: { restoreScroll: true } }));
        jest.advanceTimersByTime(16);
        expect(document.documentElement.style.position).toBe('');
        expect(document.body.style.transform).toBe('');
        expect(scrollTo).toHaveBeenCalledWith(0, 0);

        // While settling, another non-forced resize does not reapply position: fixed.
        visualViewport.height = 700;
        visualViewport.dispatchEvent(new Event('resize'));
        expect(document.documentElement.style.position).toBe('');
        jest.advanceTimersByTime(360);
    });

    test('shell modal inerting never inerts #top-bar and closing panels/search dispatches mobile viewport reset', async () => {
        let fakeNow = 1000;
        jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);

        loaded = await importTabsModule({ mobile: true, width: 390, height: 844 });
        const resetEvents = [];
        window.addEventListener('sb-mobile-viewport-reset', evt => resetEvents.push(evt.detail));

        // Open global search, verify focus, and close it -> dispatches reset with restoreScroll: true.
        loaded.shell.openGlobalSearch({ focusInput: true });
        expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(resetEvents.some(d => d?.restoreScroll === true)).toBe(true);

        // Opening settings page on mobile never marks #top-bar inert, and closing dispatches reset.
        resetEvents.length = 0;
        loaded.shell.openTab('left', 'connections');
        expect(document.getElementById('top-bar').hasAttribute('inert')).toBe(false);
        document.getElementById('sb-settings-close').click();
        expect(resetEvents.length).toBeGreaterThan(0);

        // Character top-bar shortcut toggles close on second click (past mobile tap debounce).
        const charBtn = document.getElementById('sb-character-toggle');
        fakeNow += 500;
        charBtn.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBe('true');
        fakeNow += 500;
        charBtn.click();
        expect(document.documentElement.dataset.sbSettingsOpen).toBeUndefined();

        // Retired desktop snap API remains a safe no-op.
        expect(() => loaded.shell.setDesktopShellSnapToChatWidth(true)).not.toThrow();
    });

    test('character drawer Escape closes locally while deferring nested editors, stop buttons, and open dialogs', async () => {
        loaded = await importTabsModule({ mobile: false });
        const panel = document.getElementById('right-nav-panel');
        // Remove role="dialog" from the enclosing settings shell so #right-nav-panel's own Escape handler runs directly
        // instead of deferring to an ancestor dialog role, and intercept bubbling Escape right outside panel.
        document.getElementById('sb-settings-page').removeAttribute('role');
        const bubbledEscapes = [];
        panel.parentElement.addEventListener('keydown', evt => {
            if (evt.key === 'Escape') {
                bubbledEscapes.push({ defaultPrevented: evt.defaultPrevented, target: evt.target });
                evt.stopPropagation();
            }
        });

        // Open a nested dialog inside panel -> Escape inside dialog defers closing the character panel.
        loaded.shell.openTab('characters', 'characters');
        expect(panel.classList.contains('openDrawer')).toBe(true);

        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        panel.append(dialog);
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(panel.classList.contains('openDrawer')).toBe(true);
        expect(bubbledEscapes).toHaveLength(1);
        expect(bubbledEscapes[0].defaultPrevented).toBe(false);
        dialog.remove();

        // Active #curEditTextarea -> Escape defers.
        const editArea = document.createElement('textarea');
        editArea.id = 'curEditTextarea';
        panel.append(editArea);
        editArea.focus();
        editArea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(panel.classList.contains('openDrawer')).toBe(true);
        expect(bubbledEscapes).toHaveLength(2);
        expect(bubbledEscapes[1].defaultPrevented).toBe(false);
        editArea.remove();

        // Visible #dialogue_popup overlay outside inert #sheld -> Escape on panel defers.
        const legacyPopup = document.createElement('div');
        legacyPopup.id = 'dialogue_popup';
        legacyPopup.getClientRects = () => /** @type {any} */ ([{}]);
        document.body.append(legacyPopup);
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(panel.classList.contains('openDrawer')).toBe(true);
        expect(bubbledEscapes).toHaveLength(3);
        expect(bubbledEscapes[2].defaultPrevented).toBe(false);
        legacyPopup.remove();

        // Clean state -> Escape on panel closes the character panel locally and stops propagation.
        const closeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        panel.dispatchEvent(closeEvent);
        expect(panel.classList.contains('openDrawer')).toBe(false);
        expect(closeEvent.defaultPrevented).toBe(true);
        expect(bubbledEscapes).toHaveLength(3);
    });

    test('clamps shell viewport bounds, keeps iOS panels stable, lets iOS composer follow viewport, and applies legacy iOS inset only for legacy iOS', async () => {
        // Modern iOS WebKit: composer follows visualViewport, open settings page keeps layout height.
        loaded = await importTabsModule({
            mobile: true,
            width: 390,
            height: 844,
            mocks: {
                'scripts/mobile-send-button.js': {
                    isIOSWebKitPlatform: () => true,
                    isLegacyIOSWebKitPlatform: () => false,
                },
            },
        });

        const composer = document.getElementById('send_textarea');
        composer.focus();
        loaded.setViewport({ width: 390, height: 844, vvHeight: 500, vvTop: 12 });
        loaded.visualViewport.dispatchEvent(new Event('resize'));
        expect(document.documentElement.style.getPropertyValue('--sb-shell-viewport-height')).toBe('500px');
        expect(document.documentElement.style.getPropertyValue('--sb-shell-viewport-top')).toBe('12px');
        expect(document.documentElement.classList.contains('sb-ios-composer-keyboard-inset-active')).toBe(false);

        // Legacy iOS WebKit: composer edit enables sb-ios-composer-keyboard-inset-active and shrinks viewport height by keyboard height.
        loaded.cleanup();
        loaded = await importTabsModule({
            mobile: true,
            width: 390,
            height: 844,
            mocks: {
                'scripts/mobile-send-button.js': {
                    isIOSWebKitPlatform: () => true,
                    isLegacyIOSWebKitPlatform: () => true,
                },
            },
        });
        const legacyComposer = document.getElementById('send_textarea');
        legacyComposer.focus();
        loaded.setViewport({ width: 390, height: 844, vvHeight: 500, vvTop: 0 });
        loaded.visualViewport.dispatchEvent(new Event('resize'));
        expect(document.documentElement.classList.contains('sb-ios-composer-keyboard-inset-active')).toBe(true);
        expect(document.documentElement.style.getPropertyValue('--sb-shell-viewport-height')).toBe('500px');
    });

    test('auto-closes sibling inline drawers on mobile when opening a closed sibling', async () => {
        const domWithDrawers = DEFAULT_TABS_DOM.replace(
            '<div id="respective-presets-block"></div>',
            `<div id="respective-presets-block">
                <div id="drawer-a" class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header"><b>Drawer A</b><div class="inline-drawer-icon fa-circle-chevron-up up"></div></div>
                    <div class="inline-drawer-content" style="display: block">A</div>
                </div>
                <div id="drawer-b" class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header"><b>Drawer B</b><div class="inline-drawer-icon fa-circle-chevron-down down"></div></div>
                    <div class="inline-drawer-content" style="display: none">B</div>
                </div>
            </div>`,
        );
        loaded = await importTabsModule({
            dom: domWithDrawers,
            mobile: true,
            width: 390,
            height: 844,
            storage: { 'sb-settings-drawer-auto-close': 'true' },
        });

        // Clicking closed Drawer B's toggle collapses open sibling Drawer A.
        document.querySelector('#drawer-b .inline-drawer-toggle').click();
        await loaded.flush();

        const drawerAIcon = document.querySelector('#drawer-a .inline-drawer-icon');
        const drawerAContent = /** @type {HTMLElement} */ (document.querySelector('#drawer-a .inline-drawer-content'));
        expect(drawerAIcon.classList.contains('fa-circle-chevron-down')).toBe(true);
        expect(drawerAContent.style.display).toBe('none');
    });
});
