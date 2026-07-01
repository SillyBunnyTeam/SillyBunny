import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    MOBILE_SHELL_VIEWPORT_SYNC_STEP,
    shouldBlockMobileDocumentPan,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');
const browserFixesSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'browser-fixes.js'), 'utf8');
const tabsCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileShellCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

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

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = tabsSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const paramsStart = tabsSource.indexOf('(', start);
    let parenDepth = 0;
    let paramsEnd = -1;

    for (let index = paramsStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '(') {
            parenDepth++;
        } else if (char === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                paramsEnd = index;
                break;
            }
        }
    }

    expect(paramsEnd).toBeGreaterThan(paramsStart);

    const bodyStart = tabsSource.indexOf('{', paramsEnd);
    let depth = 0;

    for (let index = bodyStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return tabsSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('mobile shell lifecycle wiring', () => {
    test('blocks mobile document panning from fixed chrome and scroll edges', () => {
        expect(browserFixesSource).toContain('blockDocumentPanFromShellGaps');
        expect(browserFixesSource).toContain('captureDocumentPanStart');
        expect(browserFixesSource).toContain('document.addEventListener(\'touchmove\', blockDocumentPanFromShellGaps, { passive: false, capture: true });');

        const chatScroller = createElementStub({
            matches: selector => selectorListIncludes(selector, '#chat'),
            scrollHeight: 1200,
            clientHeight: 600,
            scrollTop: 120,
        });
        const chatScrollerAtTop = createElementStub({
            matches: selector => selectorListIncludes(selector, '#chat'),
            scrollHeight: 1200,
            clientHeight: 600,
        });
        const wideMessageText = createElementStub({
            parentElement: chatScroller,
            matches: selector => selectorListIncludes(selector, '.mes_text'),
            scrollWidth: 900,
            clientWidth: 320,
        });
        const wideMessageTextNode = { parentNode: wideMessageText };
        const shellSurface = createElementStub({
            matches: selector => selectorListIncludes(selector, '#sheld'),
        });
        const composerChrome = createElementStub({
            matches: selector => selectorListIncludes(selector, '#nonQRFormItems'),
        });
        const sendFormChrome = createElementStub({
            matches: selector => selectorListIncludes(selector, '#send_form'),
        });
        const composerGap = createElementStub({ parentElement: composerChrome });
        const textarea = createElementStub({
            parentElement: composerChrome,
            matches: selector => selector.includes('textarea'),
        });
        const scrollableTextarea = createElementStub({
            parentElement: composerChrome,
            matches: selector => selector.includes('textarea'),
            scrollHeight: 400,
            clientHeight: 120,
            scrollTop: 100,
        });
        const textareaAtBottom = createElementStub({
            parentElement: composerChrome,
            matches: selector => selector.includes('textarea'),
            scrollHeight: 400,
            clientHeight: 120,
            scrollTop: 280,
        });
        const quickReplyRail = createElementStub({
            parentElement: composerChrome,
            matches: selector => selectorListIncludes(selector, '#leftSendForm'),
            scrollWidth: 600,
            clientWidth: 240,
            scrollLeft: 120,
        });
        const quickReplyRailAtStart = createElementStub({
            parentElement: composerChrome,
            matches: selector => selectorListIncludes(selector, '#leftSendForm'),
            scrollWidth: 600,
            clientWidth: 240,
        });
        const quickReplyButton = createElementStub({ parentElement: quickReplyRail });
        const quickReplyStartButton = createElementStub({ parentElement: quickReplyRailAtStart });
        const sendFormButton = createElementStub({ parentElement: sendFormChrome });
        const genericButton = createElementStub({
            matches: selector => selectorListIncludes(selector, 'button'),
        });
        const companionHandle = createElementStub({
            closest: selector => selectorListIncludes(selector, '#ica--tracker-panel-handle') ? companionHandle : null,
        });
        const companionPanel = createElementStub({
            matches: selector => selectorListIncludes(selector, '#ica--tracker-panel') || selectorListIncludes(selector, '.ica--tpanel'),
            scrollHeight: 1200,
            clientHeight: 600,
            scrollTop: 120,
        });
        const companionPanelAtTop = createElementStub({
            matches: selector => selectorListIncludes(selector, '#ica--tracker-panel') || selectorListIncludes(selector, '.ica--tpanel'),
            scrollHeight: 1200,
            clientHeight: 600,
        });
        const companionPanelBody = createElementStub({ parentElement: companionPanel });
        const guidedActionsContainer = createElementStub({
            parentElement: sendFormChrome,
            matches: selector => selectorListIncludes(selector, '.gg-action-buttons-container'),
        });
        const guidedActionsGap = createElementStub({ parentElement: guidedActionsContainer });
        const bottomChatBar = createElementStub({
            matches: selector => selectorListIncludes(selector, '#sb-bottom-chat-bar'),
        });
        const bottomChatButton = createElementStub({ parentElement: bottomChatBar });
        const bottomChatSelect = createElementStub({
            parentElement: bottomChatBar,
            matches: selector => selector.includes('select'),
        });
        const bottomChatLongNameSelect = createElementStub({
            parentElement: bottomChatBar,
            matches: selector => selector.includes('select'),
            scrollWidth: 900,
            clientWidth: 180,
        });
        const bottomChatSelect2Selection = createElementStub({
            matches: selector => selectorListIncludes(selector, '.select2-selection') || selectorListIncludes(selector, '[aria-labelledby="select2-sb-bottom-chat-select-container"]'),
            scrollWidth: 900,
            clientWidth: 180,
        });
        const bottomChatSecondaryRow = createElementStub({
            parentElement: bottomChatBar,
            matches: selector => selectorListIncludes(selector, '#sb-bottom-chat-secondary-row') || selectorListIncludes(selector, '.sb-bottom-chat-secondary-row'),
            scrollWidth: 700,
            clientWidth: 260,
            scrollLeft: 120,
        });
        const bottomChatSecondaryRowAtStart = createElementStub({
            parentElement: bottomChatBar,
            matches: selector => selectorListIncludes(selector, '#sb-bottom-chat-secondary-row') || selectorListIncludes(selector, '.sb-bottom-chat-secondary-row'),
            scrollWidth: 700,
            clientWidth: 260,
        });
        const bottomChatSecondaryButton = createElementStub({ parentElement: bottomChatSecondaryRow });
        const bottomChatSecondaryStartButton = createElementStub({ parentElement: bottomChatSecondaryRowAtStart });
        const presetPopupBody = createElementStub({
            matches: selector => selectorListIncludes(selector, '.popup-body'),
            scrollHeight: 1200,
            clientHeight: 600,
        });
        const presetButton = createElementStub({ parentElement: presetPopupBody });
        const legacyDialog = createElementStub({
            matches: selector => selectorListIncludes(selector, '#dialogue_popup'),
        });
        const legacyDialogText = createElementStub({
            parentElement: legacyDialog,
            matches: selector => selectorListIncludes(selector, '#dialogue_popup_text'),
            scrollHeight: 1200,
            clientHeight: 600,
        });
        const legacyDialogInput = createElementStub({
            parentElement: legacyDialog,
            matches: selector => selector.includes('textarea'),
        });
        const legacyDialogControls = createElementStub({
            parentElement: legacyDialog,
            matches: selector => selectorListIncludes(selector, '#dialogue_popup_controls'),
        });
        const legacyDialogButton = createElementStub({ parentElement: legacyDialogControls });
        const genericPopup = createElementStub({
            matches: selector => selectorListIncludes(selector, 'dialog.popup') || selectorListIncludes(selector, '.popup'),
        });
        const genericPopupBody = createElementStub({
            parentElement: genericPopup,
            matches: selector => selectorListIncludes(selector, '.popup-body'),
            scrollHeight: 1200,
            clientHeight: 600,
        });
        const genericPopupInput = createElementStub({
            parentElement: genericPopupBody,
            matches: selector => selector.includes('textarea') || selectorListIncludes(selector, '.popup-input'),
        });
        const genericPopupControls = createElementStub({
            parentElement: genericPopupBody,
            matches: selector => selectorListIncludes(selector, '.popup-controls'),
        });
        const genericPopupButton = createElementStub({ parentElement: genericPopupControls });
        const characterDrawerScroller = createElementStub({
            matches: selector => selectorListIncludes(selector, '.sb-shell-panel-scroller'),
            scrollHeight: 1600,
            clientHeight: 600,
        });
        const characterCard = createElementStub({ parentElement: characterDrawerScroller });
        const shellNavScroller = createElementStub({
            parentElement: shellSurface,
            matches: selector => selectorListIncludes(selector, '.sb-shell-nav'),
            scrollWidth: 900,
            clientWidth: 300,
            scrollLeft: 200,
        });
        const shellNavScrollerAtStart = createElementStub({
            parentElement: shellSurface,
            matches: selector => selectorListIncludes(selector, '.sb-shell-nav'),
            scrollWidth: 900,
            clientWidth: 300,
        });
        const shellNavTab = createElementStub({ parentElement: shellNavScroller });
        const shellNavStartTab = createElementStub({ parentElement: shellNavScrollerAtStart });
        const chatMove = createTouchMove(chatScroller, { y: -40 });
        const chatHorizontalMove = createTouchMove(chatScroller, { x: -70, y: 4 });
        const chatAtTopPullDownMove = createTouchMove(chatScrollerAtTop, { x: 2, y: 40 });
        const wideMessageTextMove = createTouchMove(wideMessageText, { x: -70, y: 4 });
        const wideMessageTextNodeMove = createTouchMove(wideMessageTextNode, { x: -70, y: 4 });
        const wideMessageTextVerticalMove = createTouchMove(wideMessageTextNode, { x: 2, y: -40 });
        const shellRightEdgeHorizontalMove = createTouchMove(shellSurface, { startX: 390, x: 310, y: 4 });
        const railHorizontalMove = createTouchMove(quickReplyButton, { x: 40, y: 2 });
        const railAtStartEdgeMove = createTouchMove(quickReplyStartButton, { x: 40, y: 2 });
        const railVerticalMove = createTouchMove(quickReplyButton, { x: 2, y: -40 });
        const companionHandleHorizontalMove = createTouchMove(companionHandle, { x: -40, y: 1 });
        const companionHandleVerticalMove = createTouchMove(companionHandle, { x: 1, y: 40 });
        const companionPanelVerticalMove = createTouchMove(companionPanelBody, { x: 1, y: -40 });
        const companionPanelAtTopPullDownMove = createTouchMove(companionPanelAtTop, { x: 1, y: 40 });
        const companionPanelHorizontalMove = createTouchMove(companionPanelBody, { x: -40, y: 1 });
        const gapMove = createTouchMove(composerGap, { y: -40 });
        const guidedActionsGapMove = createTouchMove(guidedActionsGap, { y: -40 });
        const textareaMove = createTouchMove(textarea, { y: -40 });
        const scrollableTextareaMove = createTouchMove(scrollableTextarea, { y: -40 });
        const textareaAtBottomMove = createTouchMove(textareaAtBottom, { y: -40 });
        const sendFormButtonMove = createTouchMove(sendFormButton, { y: -40 });
        const buttonMove = createTouchMove(genericButton, { y: -40 });
        const bottomChatButtonMove = createTouchMove(bottomChatButton, { y: -40 });
        const bottomChatSelectMove = createTouchMove(bottomChatSelect, { y: -40 });
        const bottomChatLongNameSelectMove = createTouchMove(bottomChatLongNameSelect, { x: -50, y: 1 });
        const bottomChatSelect2SelectionMove = createTouchMove(bottomChatSelect2Selection, { x: -50, y: 1 });
        const bottomChatHorizontalMove = createTouchMove(bottomChatSecondaryButton, { x: 40, y: 2 });
        const bottomChatHorizontalAtStartEdgeMove = createTouchMove(bottomChatSecondaryStartButton, { x: 40, y: 2 });
        const bottomChatVerticalMove = createTouchMove(bottomChatSecondaryButton, { x: 2, y: -40 });
        const presetMove = createTouchMove(presetButton, { y: -40 });
        const legacyDialogTextMove = createTouchMove(legacyDialogText, { y: -40 });
        const legacyDialogInputMove = createTouchMove(legacyDialogInput, { y: -40 });
        const legacyDialogButtonMove = createTouchMove(legacyDialogButton, { y: -40 });
        const genericPopupBodyMove = createTouchMove(genericPopupBody, { y: -40 });
        const genericPopupInputMove = createTouchMove(genericPopupInput, { y: -40 });
        const genericPopupButtonMove = createTouchMove(genericPopupButton, { y: -40 });
        const characterDrawerMove = createTouchMove(characterCard, { y: -40 });
        const shellNavHorizontalMove = createTouchMove(shellNavTab, { x: -50, y: 1 });
        const shellNavHorizontalAtStartEdgeMove = createTouchMove(shellNavStartTab, { x: 50, y: 1 });
        const multiTouchMove = createTouchMove(composerGap, { touches: [{}, {}] });
        const nonCancelableMove = createTouchMove(composerGap, { cancelable: false });

        expect(shouldBlockMobileDocumentPan(chatMove.event, { touchStart: chatMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(chatHorizontalMove.event, { touchStart: chatHorizontalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(chatAtTopPullDownMove.event, { touchStart: chatAtTopPullDownMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(wideMessageTextMove.event, { touchStart: wideMessageTextMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(wideMessageTextNodeMove.event, { touchStart: wideMessageTextNodeMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(wideMessageTextVerticalMove.event, { touchStart: wideMessageTextVerticalMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(shellRightEdgeHorizontalMove.event, { touchStart: shellRightEdgeHorizontalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(textareaMove.event, { touchStart: textareaMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(scrollableTextareaMove.event, { touchStart: scrollableTextareaMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(textareaAtBottomMove.event, { touchStart: textareaAtBottomMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(railHorizontalMove.event, { touchStart: railHorizontalMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(railAtStartEdgeMove.event, { touchStart: railAtStartEdgeMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(railVerticalMove.event, { touchStart: railVerticalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(companionHandleHorizontalMove.event, { touchStart: companionHandleHorizontalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(companionHandleVerticalMove.event, { touchStart: companionHandleVerticalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(companionPanelVerticalMove.event, { touchStart: companionPanelVerticalMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(companionPanelAtTopPullDownMove.event, { touchStart: companionPanelAtTopPullDownMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(companionPanelHorizontalMove.event, { touchStart: companionPanelHorizontalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(gapMove.event, { touchStart: gapMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(guidedActionsGapMove.event, { touchStart: guidedActionsGapMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(sendFormButtonMove.event, { touchStart: sendFormButtonMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(buttonMove.event, { touchStart: buttonMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(bottomChatButtonMove.event, { touchStart: bottomChatButtonMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(bottomChatSelectMove.event, { touchStart: bottomChatSelectMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(bottomChatLongNameSelectMove.event, { touchStart: bottomChatLongNameSelectMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(bottomChatSelect2SelectionMove.event, { touchStart: bottomChatSelect2SelectionMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(bottomChatHorizontalMove.event, { touchStart: bottomChatHorizontalMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(bottomChatHorizontalAtStartEdgeMove.event, { touchStart: bottomChatHorizontalAtStartEdgeMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(bottomChatVerticalMove.event, { touchStart: bottomChatVerticalMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(presetMove.event, { touchStart: presetMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(legacyDialogTextMove.event, { touchStart: legacyDialogTextMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(legacyDialogInputMove.event, { touchStart: legacyDialogInputMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(legacyDialogButtonMove.event, { touchStart: legacyDialogButtonMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(genericPopupBodyMove.event, { touchStart: genericPopupBodyMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(genericPopupInputMove.event, { touchStart: genericPopupInputMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(genericPopupButtonMove.event, { touchStart: genericPopupButtonMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(characterDrawerMove.event, { touchStart: characterDrawerMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(shellNavHorizontalMove.event, { touchStart: shellNavHorizontalMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(shellNavHorizontalAtStartEdgeMove.event, { touchStart: shellNavHorizontalAtStartEdgeMove.touchStart })).toBe(true);
        expect(shouldBlockMobileDocumentPan(multiTouchMove.event, { touchStart: multiTouchMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(nonCancelableMove.event, { touchStart: nonCancelableMove.touchStart })).toBe(false);
    });

    test('relaxes document pan guards inside open mobile shell menus', () => {
        const createMenuRoot = rootSelector => createElementStub({
            matches: selector => selectorListIncludes(selector, rootSelector) || selectorListIncludes(selector, `${rootSelector}.openDrawer`),
            scrollHeight: 1600,
            clientHeight: 600,
        });
        const workspaceRoot = createMenuRoot('#left-nav-panel');
        const customizeRoot = createMenuRoot('#user-settings-block');
        const characterRoot = createMenuRoot('#right-nav-panel');
        const closedWorkspaceRoot = createElementStub({
            matches: selector => selectorListIncludes(selector, '#left-nav-panel'),
            scrollHeight: 1600,
            clientHeight: 600,
        });
        const workspaceButton = createElementStub({ parentElement: workspaceRoot });
        const customizeSelect = createElementStub({
            parentElement: customizeRoot,
            matches: selector => selector.includes('select'),
        });
        const characterCard = createElementStub({ parentElement: characterRoot });
        const closedWorkspaceButton = createElementStub({ parentElement: closedWorkspaceRoot });

        const workspaceAtTopPullDownMove = createTouchMove(workspaceButton, { x: 1, y: 40 });
        const customizeSelectMove = createTouchMove(customizeSelect, { x: 1, y: -40 });
        const characterAtTopPullDownMove = createTouchMove(characterCard, { x: 1, y: 40 });
        const closedWorkspaceAtTopPullDownMove = createTouchMove(closedWorkspaceButton, { x: 1, y: 40 });

        expect(shouldBlockMobileDocumentPan(workspaceAtTopPullDownMove.event, { touchStart: workspaceAtTopPullDownMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(customizeSelectMove.event, { touchStart: customizeSelectMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(characterAtTopPullDownMove.event, { touchStart: characterAtTopPullDownMove.touchStart })).toBe(false);
        expect(shouldBlockMobileDocumentPan(closedWorkspaceAtTopPullDownMove.event, { touchStart: closedWorkspaceAtTopPullDownMove.touchStart })).toBe(true);
    });

    test('imports the mobile shell lifecycle seam into the shell adapter', () => {
        expect(tabsSource).toContain('createMobileShellLifecycle');
        expect(tabsSource).toContain('MOBILE_SHELL_NAV_TOGGLE_ACTION');
        expect(tabsSource).toContain('const sbMobileShellLifecycle = createMobileShellLifecycle();');
    });

    test('routes shell rail drag and scroll decisions through the lifecycle seam', () => {
        const buildShellSource = getFunctionSource('buildShell');

        expect(buildShellSource).toContain('sbMobileShellLifecycle.nav.resolvePageScroll({');
        expect(buildShellSource).toContain('nav.scrollBy(scrollRequest);');
        expect(buildShellSource).toContain('sbMobileShellLifecycle.nav.createDragState({');
        expect(buildShellSource).toContain('sbMobileShellLifecycle.nav.resolveDragMove({');
        expect(buildShellSource).toContain('sbMobileShellLifecycle.nav.resolveDragEnd({');
        expect(buildShellSource).toContain('sbMobileShellLifecycle.nav.shouldSuppressClick({');
        expect(buildShellSource).toContain('sbMobileShellLifecycle.nav.resolveScrollIndicators({');
        expect(buildShellSource).not.toContain('SB_SHELL_NAV_TOUCH_DRAG_THRESHOLD_PX');
        expect(buildShellSource).not.toContain('Date.now() + 350');
    });

    test('routes mobile modal inert decisions through the lifecycle seam', () => {
        const syncMobileModalStateSource = getFunctionSource('syncMobileModalState');

        expect(syncMobileModalStateSource).toContain('sbMobileShellLifecycle.modal.resolveA11yState({');
        expect(syncMobileModalStateSource).toContain('activeRootIds: activeRoots.map(root => root.id)');
        expect(syncMobileModalStateSource).toContain('modalState.hasActiveMobileModal');
        expect(syncMobileModalStateSource).toContain('modalState.shouldInertShell');
        expect(syncMobileModalStateSource).toContain('modalState.shouldInertTopBar');
        expect(syncMobileModalStateSource).not.toContain('activeRoots.some(root => root.id !== \'sb-mobile-nav\')');
    });

    test('routes mobile nav outside-click auto-close through the lifecycle seam', () => {
        const buildMobileNavSource = getFunctionSource('buildMobileNav');

        expect(buildMobileNavSource).toContain('sbMobileShellLifecycle.nav.shouldAutoClose({');
        expect(buildMobileNavSource).toContain('elapsedSinceOpenedMs: performance.now() - sbState.mobileNav.lastOpenedAt');
        expect(buildMobileNavSource).toContain('isHamburgerTarget: Boolean(target.closest(\'#sb-hamburger\'))');
        expect(buildMobileNavSource).toContain('isInsideNav: Boolean(target.closest(\'#sb-mobile-nav\'))');
        expect(buildMobileNavSource).not.toContain('SB_MOBILE_NAV_OPEN_GRACE_MS');
    });

    test('routes mobile nav open-state decisions through the lifecycle seam', () => {
        const setMobileNavOpenStateSource = getFunctionSource('setMobileNavOpenState');

        expect(setMobileNavOpenStateSource).toContain('sbMobileShellLifecycle.nav.resolveOpenState({');
        expect(setMobileNavOpenStateSource).toContain('navState.shouldRecordOpenedAt');
        expect(setMobileNavOpenStateSource).toContain('overlay.hidden = navState.overlayHidden;');
        expect(setMobileNavOpenStateSource).toContain('overlay.setAttribute(\'aria-hidden\', navState.overlayAriaHidden);');
        expect(setMobileNavOpenStateSource).toContain('button.setAttribute(\'aria-expanded\', navState.buttonExpanded);');
        expect(setMobileNavOpenStateSource).toContain('navState.shouldRestoreButtonFocus');
    });

    test('uses a distinct closed mobile nav icon from the Workspace proxy', () => {
        const buildTopBarSource = getFunctionSource('buildTopBar');
        const setMobileNavOpenStateSource = getFunctionSource('setMobileNavOpenState');

        expect(tabsSource).toContain('const SB_MOBILE_NAV_CLOSED_ICON = \'fa-compass\';');
        expect(buildTopBarSource).toContain('SB_MOBILE_NAV_CLOSED_ICON');
        expect(setMobileNavOpenStateSource).toContain('SB_MOBILE_NAV_CLOSED_ICON');
        expect(setMobileNavOpenStateSource).not.toContain('fa-solid fa-bars');
    });

    test('requests a mobile viewport reset when search and mobile panels close', () => {
        const searchOpenStateSource = getFunctionSource('setUniversalSearchOpenState');
        const closeShellSource = getFunctionSource('closeShell');
        const closeCharacterPanelSource = getFunctionSource('closeCharacterPanel');
        const setMobileNavOpenStateSource = getFunctionSource('setMobileNavOpenState');

        expect(tabsSource).toContain('function requestMobileViewportReset(');
        expect(tabsSource).toContain('detail: { restoreScroll: Boolean(restoreScroll) },');
        expect(tabsSource).toContain('const SB_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS = 350;');
        expect(searchOpenStateSource).toContain('requestMobileViewportReset({ restoreScroll: true });');
        expect(closeShellSource).toContain('requestMobileViewportReset();');
        expect(closeCharacterPanelSource).toContain('requestMobileViewportReset();');
        expect(setMobileNavOpenStateSource).toContain('requestMobileViewportReset();');
    });

    test('settles mobile viewport reset without reapplying the fixed-position workaround', () => {
        expect(browserFixesSource).toContain('import { isIOSWebKitPlatform } from \'./mobile-send-button.js\';');
        expect(browserFixesSource).toContain('function addDocumentViewportAnchorPatch({ suspendWhileEditing = false } = {}) {');
        expect(browserFixesSource).toContain('const shouldSuspendDocumentScrollReset = () => suspendWhileEditing && isEditableFocusTarget(document.activeElement);');
        expect(browserFixesSource).toContain('if (shouldSuspendDocumentScrollReset()) {');
        expect(browserFixesSource).toContain('if (resetScheduled || shouldSuspendDocumentScrollReset()) {');
        expect(browserFixesSource).toContain('document.addEventListener(\'focusout\', scheduleDocumentScrollReset, true);');
        expect(browserFixesSource).toContain('const isMobileViewport = isMobile();');
        expect(browserFixesSource).toContain('const isIOSWebKit = isIOSWebKitPlatform();');
        expect(browserFixesSource).toContain('addDocumentViewportAnchorPatch({ suspendWhileEditing: isMobileViewport && isIOSWebKit });');
        expect(browserFixesSource).toContain('const viewportResetSettleMs = 360;');
        expect(browserFixesSource).toContain('const resetTransientViewportPosition = ({ restoreScroll = false } = {}) => {');
        expect(browserFixesSource).toContain('const scheduleViewportReset = ({ restoreScroll = false } = {}) => {');
        expect(browserFixesSource).toContain('scheduleViewportReset({ restoreScroll: Boolean(event?.detail?.restoreScroll) });');
        expect(browserFixesSource).toContain('window.scrollTo(0, 0);');
        expect(browserFixesSource).toContain('resetTransientViewportPosition({ restoreScroll });');
        expect(browserFixesSource).toContain('if (!force && viewportResetScheduled) {');
        expect(browserFixesSource).toContain('}, viewportResetSettleMs);');
    });

    test('dedupes rail quick actions against all built-in rail actions', () => {
        const syncMobileShellRailActionsSource = getFunctionSource('syncMobileShellRailActions');

        expect(tabsSource).toContain('function getAllBuiltInRailActionKeys(');
        expect(syncMobileShellRailActionsSource).toContain('getAllBuiltInRailActionKeys()');
        expect(syncMobileShellRailActionsSource).not.toContain('builtInRailActions.map(getMobileQuickActionKey)');
    });

    test('routes mobile rail model decisions through the lifecycle seam', () => {
        const getMobileQuickActionContextSource = getFunctionSource('getMobileQuickActionContext');
        const normalizeMobileQuickActionSource = getFunctionSource('normalizeMobileQuickAction');
        const getMobileQuickActionKeySource = getFunctionSource('getMobileQuickActionKey');
        const syncMobileShellRailActionsSource = getFunctionSource('syncMobileShellRailActions');

        expect(tabsSource).toContain('const SB_MOBILE_QUICK_ACTION_LIMIT = sbMobileShellLifecycle.railModel.limits.quickActionLimit;');
        expect(tabsSource).toContain('const SB_MOBILE_QUICK_ACTION_ICON_FALLBACK = sbMobileShellLifecycle.railModel.limits.iconFallback;');
        expect(getMobileQuickActionContextSource).toContain('sbMobileShellLifecycle.railModel.resolveQuickActionRoute(value);');
        expect(normalizeMobileQuickActionSource).toContain('sbMobileShellLifecycle.railModel.normalizeQuickAction({');
        expect(normalizeMobileQuickActionSource).toContain('limits: sbMobileShellLifecycle.railModel.limits,');
        expect(getMobileQuickActionKeySource).toContain('sbMobileShellLifecycle.railModel.getQuickActionKey(normalizedAction);');
        expect(syncMobileShellRailActionsSource).toContain('sbMobileShellLifecycle.railModel.resolveActionVisibility({');
        expect(syncMobileShellRailActionsSource).toContain('builtInActionKeys: Array.from(getAllBuiltInRailActionKeys()),');
        expect(syncMobileShellRailActionsSource).toContain('shouldHideCustomizeTabs = railActionPlan.shouldHideCustomizeTabs;');
        expect(syncMobileShellRailActionsSource).toContain('for (const group of railActionPlan.beforeGroups)');
        expect(syncMobileShellRailActionsSource).toContain('if (railActionPlan.afterGroups.length > 0)');
        expect(syncMobileShellRailActionsSource).not.toContain('const shouldHideCustomizeTabs = showCustomize;');
        expect(syncMobileShellRailActionsSource).not.toContain('railQuickActionState.filter(action => !builtInRailActionKeys.has(getMobileQuickActionKey(action)))');
    });

    test('routes inline drawer decisions through the lifecycle seam', () => {
        const interceptDrawerOpenersSource = getFunctionSource('interceptDrawerOpeners');
        const getInlineDrawerStorageKeySource = getFunctionSource('getInlineDrawerStorageKey');

        expect(tabsSource).toContain('function getInlineDrawerAutoCloseId(');
        expect(interceptDrawerOpenersSource).toContain('sbMobileShellLifecycle.inlineDrawers.resolveAutoCloseSiblings({');
        expect(interceptDrawerOpenersSource).toContain('openedDrawerId,');
        expect(interceptDrawerOpenersSource).toContain('openDrawerIds,');
        expect(interceptDrawerOpenersSource).toContain('isMobileViewport: isMobileViewport(),');
        expect(interceptDrawerOpenersSource).toContain('for (const closeId of autoClosePlan.closeIds)');
        expect(interceptDrawerOpenersSource).not.toContain('parent.querySelectorAll(\':scope > .inline-drawer\').forEach');
        expect(getInlineDrawerStorageKeySource).toContain('sbMobileShellLifecycle.inlineDrawers.derivePersistenceKey({');
        expect(getInlineDrawerStorageKeySource).toContain('storagePrefix: SB_STORAGE_KEYS.settingsDrawerStatePrefix,');
        expect(getInlineDrawerStorageKeySource).toContain('contextSegments,');
        expect(getInlineDrawerStorageKeySource).not.toContain('`${SB_STORAGE_KEYS.settingsDrawerStatePrefix}:${contextSegments.join(\'/\')}:drawer-id:');
        expect(getInlineDrawerStorageKeySource).not.toContain('`${SB_STORAGE_KEYS.settingsDrawerStatePrefix}:${contextSegments.join(\'/\')}:drawer:${drawerLabel}:${drawerIndex}`');
    });

    test('clamps shell panels and iOS composer edits on stable viewport bounds', () => {
        const getResolvedShellTopbarOffsetSource = getFunctionSource('getResolvedShellTopbarOffset');
        const getDesktopShellResizeBoundsSource = getFunctionSource('getDesktopShellResizeBounds');
        const setShellSizeOverrideSource = getFunctionSource('setShellSizeOverride');
        const openShellSource = getFunctionSource('openShell');
        const closeShellSource = getFunctionSource('closeShell');
        const syncMobileViewportStateSource = getFunctionSource('syncMobileViewportState');

        expect(tabsSource).toContain('function getShellViewportSize(');
        expect(tabsSource).toContain('function getVisualViewportSize(');
        expect(tabsSource).toContain('function shouldUseStableIOSPanelViewport(');
        expect(tabsSource).toContain('import { isIOSWebKitPlatform } from \'./mobile-send-button.js\';');
        expect(tabsSource).toContain('function isChatComposerEditableElement(');
        expect(tabsSource).toContain('function hasOpenMobileShellDrawer(');
        expect(tabsSource).toContain('!isMobileViewport() || !isIOSWebKitPlatform() || !isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)');
        expect(tabsSource).toContain('return isMobileShellPanelEditableElement(activeElement) || isChatComposerEditableElement(activeElement) || hasOpenMobileShellDrawer();');
        expect(tabsSource).not.toContain('if (isChatComposerEditableElement(activeElement)) {');
        expect(tabsSource).toContain('return layoutViewport;');
        expect(tabsSource).toContain('function syncShellViewportBounds(');
        expect(tabsSource).toContain('function syncMobileShellDrawerBounds(');
        expect(tabsSource).toContain('function queueMobileShellDrawerBoundsSync(');
        expect(tabsSource).toContain('setRootViewportProperty(\'--sb-shell-available-height\'');
        expect(tabsSource).toContain('setRootViewportProperty(\'--sb-shell-viewport-top\', `${viewportSize.top}px`);');
        expect(tabsSource).toContain('function applyMobileDrawerBoundsDecision(');
        expect(tabsSource).toContain('window.visualViewport');
        expect(tabsSource).toContain('function getShellViewportTop(');
        expect(getResolvedShellTopbarOffsetSource).toContain('document.getElementById(\'sheld\')');
        expect(getResolvedShellTopbarOffsetSource).toContain('document.getElementById(\'top-bar\')');
        expect(getDesktopShellResizeBoundsSource).toContain('getShellViewportSize()');
        expect(getDesktopShellResizeBoundsSource).toContain('getShellViewportTop(root, viewportSize)');
        expect(getDesktopShellResizeBoundsSource).toContain('viewportHeight - shellTop - SB_DESKTOP_SHELL_RESIZE.bottomGap');
        expect(setShellSizeOverrideSource).toContain('clampShellSize(size, getDesktopShellResizeBounds(shellKey))');
        expect(openShellSource).toContain('syncDesktopShellSizing();');
        expect(openShellSource).toContain('syncMobileShellDrawerBounds();');
        expect(openShellSource).toContain('queueMobileShellDrawerBoundsSync();');
        expect(closeShellSource).toContain('syncMobileShellDrawerBounds();');
        expect(closeShellSource).toContain('queueMobileShellDrawerBoundsSync();');
        expect(syncMobileViewportStateSource).toContain('syncMobileShellDrawerBounds();');
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'resize\', queueMobileViewportStateSync, { passive: true });');
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'scroll\', queueMobileViewportStateSync, { passive: true });');
        expect(tabsSource).toContain('window.addEventListener(\'resize\', queueMobileViewportStateSync, { passive: true });');
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'resize\', syncDesktopShellSizing, { passive: true });');
        expect(tabsSource).toContain('window.addEventListener(\'orientationchange\', queueMobileViewportStateSync);');
        expect(mobileShellCssSource).toMatch(/#left-nav-panel\.openDrawer,[\s\S]*#right-nav-panel\.openDrawer\s*\{[\s\S]*top:\s*calc\(var\(--sb-shell-measured-top-offset,[\s\S]*bottom:\s*auto\s*!important;[\s\S]*box-sizing:\s*border-box\s*!important;[\s\S]*height:\s*calc\(var\(--sb-shell-available-height/);
        expect(mobileShellCssSource.lastIndexOf('bottom: auto !important;')).toBeGreaterThan(
            mobileShellCssSource.lastIndexOf('bottom: env(safe-area-inset-bottom, 0px) !important;'),
        );
    });

    test('routes mobile viewport sync planning through the lifecycle seam', () => {
        const syncMobileViewportStateSource = getFunctionSource('syncMobileViewportState');
        const queueMobileShellDrawerBoundsSyncSource = getFunctionSource('queueMobileShellDrawerBoundsSync');

        expect(syncMobileViewportStateSource).toContain('sbMobileShellLifecycle.viewportSync.resolveSyncPlan({');
        expect(syncMobileViewportStateSource).toContain('[viewportSyncStep.SYNC_MOBILE_SHELL_DRAWER_BOUNDS]: () => {');
        expect(syncMobileViewportStateSource).toContain('syncMobileShellDrawerBounds();');
        expect(syncMobileViewportStateSource).toContain('[viewportSyncStep.SCHEDULE_TOPBAR_CONTEXT_REFRESH]: () => scheduleTopbarContextRefresh(0),');
        expect(queueMobileShellDrawerBoundsSyncSource).toContain('sbMobileShellLifecycle.viewportSync.resolveDrawerBoundsSchedule({');
        expect(queueMobileShellDrawerBoundsSyncSource).toContain('followupDelayMs: SB_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS,');
        expect(queueMobileShellDrawerBoundsSyncSource).toContain('sbMobileShellDrawerBoundsFollowupId = window.setTimeout(() => {');
        expect(syncMobileViewportStateSource).not.toContain('if (!isMobileViewport()) {');
        expect(queueMobileShellDrawerBoundsSyncSource).not.toContain('if (!isMobileViewport()) {');
        expect(queueMobileShellDrawerBoundsSyncSource).not.toContain('if (typeof window.requestAnimationFrame === \'function\') {');
    });

    test('refreshes mobile shell layout after tab activation', () => {
        const setActiveTabSource = getFunctionSource('setActiveTab');
        const buildShellSource = getFunctionSource('buildShell');
        const activationRefreshSource = getFunctionSource('queueMobileShellActivationRefresh');

        expect(activationRefreshSource).toContain('if (!isMobileViewport()) {');
        expect(activationRefreshSource).toContain('queueMobileShellDrawerBoundsSync();');
        expect(activationRefreshSource).toContain('queueMobileViewportStateSync();');
        expect(setActiveTabSource).toMatch(/dispatchShellTabActivated\(shellKey, activeTab\);\r?\n\s+queueMobileShellActivationRefresh\(\);/);
        expect(buildShellSource).toMatch(/dispatchShellTabActivated\(shellKey, activeTab\);\r?\n\s+queueMobileShellActivationRefresh\(\);/);
    });

    test('pins every mobile viewport sync step to a dispatch handler', () => {
        const syncMobileViewportStateSource = getFunctionSource('syncMobileViewportState');

        for (const stepKey of Object.keys(MOBILE_SHELL_VIEWPORT_SYNC_STEP)) {
            expect(syncMobileViewportStateSource).toContain(`[viewportSyncStep.${stepKey}]:`);
        }
    });

    test('offers snap-to-chat-width as a persistent desktop shell sizing mode', () => {
        const getDesktopShellDimensionsSource = getFunctionSource('getDesktopShellDimensions');
        const createDesktopShellSizingSettingsGroupSource = getFunctionSource('createDesktopShellSizingSettingsGroup');
        const updateThemePickerUiSource = getFunctionSource('updateThemePickerUi');

        expect(tabsSource).toContain('desktopShellSnapToChatWidth: \'sb-desktop-shell-snap-to-chat-width\'');
        expect(tabsSource).toContain('snapToChatWidth: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopShellSnapToChatWidth), true)');
        expect(tabsSource).toContain('function setDesktopShellSnapToChatWidth(');
        expect(tabsSource).toContain('safeSetItem(SB_STORAGE_KEYS.desktopShellSnapToChatWidth, String(nextEnabled));');
        expect(getDesktopShellDimensionsSource).toContain('isShellSnapToChatWidthEnabled(shellKey)');
        expect(getDesktopShellDimensionsSource).toContain('getChatViewportWidth(viewportSize)');
        expect(createDesktopShellSizingSettingsGroupSource).toContain('Snap to chat width');
        expect(createDesktopShellSizingSettingsGroupSource).toContain('setDesktopShellSnapToChatWidth(input.checked)');
        expect(updateThemePickerUiSource).toContain('sb-desktop-shell-snap-to-chat-input');
    });

    test('opens global search as a focused readable command surface', () => {
        const setUniversalSearchOpenStateSource = getFunctionSource('setUniversalSearchOpenState');
        const buildUniversalSearchRowSource = getFunctionSource('buildUniversalSearchRow');

        expect(tabsSource).toContain('function focusUniversalSearchInput(');
        expect(tabsSource).toContain('function bindSearchShortcutPreFocus(');
        expect(tabsSource).toContain('sbSearchShortcutPreFocusAt = performance.now();');
        expect(tabsSource).toContain('bindSearchShortcutPreFocus(leftShortcut, () => getShortcutTarget(\'left\'));');
        expect(tabsSource).toContain('bindSearchShortcutPreFocus(rightShortcut, () => getShortcutTarget(\'right\'));');
        expect(setUniversalSearchOpenStateSource).toContain('focusUniversalSearchInput(input);');
        expect(buildUniversalSearchRowSource).toContain('setUniversalSearchOpenState(true, { focusInput: true });');
        expect(tabsCssSource).toMatch(/\.sb-search-results\s*\{[\s\S]*position:\s*relative;[\s\S]*isolation:\s*isolate;[\s\S]*background-color:\s*var\(--SmartThemeBlurTintColor\)/);
        expect(tabsCssSource).toMatch(/\.sb-search-result,\s*\n\.sb-search-empty\s*\{[\s\S]*position:\s*relative;[\s\S]*isolation:\s*isolate;[\s\S]*background-color:\s*var\(--SmartThemeBlurTintColor\)/);
    });

    test('routes character top-bar shortcuts through toggle-close behavior', () => {
        const buildTopBarSource = getFunctionSource('buildTopBar');
        const activateShortcutTargetSource = getFunctionSource('activateShortcutTarget');
        const toggleShellPanelSource = getFunctionSource('toggleShellPanel');
        const isCharacterPanelTabOpenSource = getFunctionSource('isCharacterPanelTabOpen');

        expect(buildTopBarSource).toContain('activateShortcutTarget(getShortcutTarget(\'left\'))');
        expect(buildTopBarSource).toContain('activateShortcutTarget(getShortcutTarget(\'right\'))');
        expect(activateShortcutTargetSource).toContain('toggleShellPanel(shell, tab);');
        expect(activateShortcutTargetSource).not.toContain('openCharacterPanelTab(tab);');
        expect(toggleShellPanelSource).toContain('isCharacterPanelTabOpen(tabId)');
        expect(toggleShellPanelSource).toContain('closeCharacterPanel();');
        expect(isCharacterPanelTabOpenSource).toContain('getActiveCharacterPanelTab() === normalizeCharacterPanelTab(tabId)');
    });

    test('routes hamburger toggle intent through the lifecycle seam', () => {
        const toggleMobileNavSource = getFunctionSource('toggleMobileNav');

        expect(toggleMobileNavSource).toContain('sbMobileShellLifecycle.nav.resolveToggleIntent({');
        expect(toggleMobileNavSource).toContain('toggleIntent.action === MOBILE_SHELL_NAV_TOGGLE_ACTION.ACTIVATE_PAGE_TARGET');
        expect(toggleMobileNavSource).toContain('toggleIntent.shouldCloseCompetingPanels');
        expect(toggleMobileNavSource).toContain('setMobileNavOpenState(toggleIntent.action === MOBILE_SHELL_NAV_TOGGLE_ACTION.OPEN_NAV);');
    });

    test('routes mobile overlay exclusivity through the lifecycle seam', () => {
        const applyExclusivitySource = getFunctionSource('applyMobileSurfaceExclusivity');
        const openMobileChatToolsSource = getFunctionSource('openMobileChatTools');
        const toggleMobileChatToolsSource = getFunctionSource('toggleMobileChatTools');
        const toggleMobileNavSource = getFunctionSource('toggleMobileNav');
        const toggleCharacterPanelSource = getFunctionSource('toggleCharacterPanel');
        const toggleShellPanelSource = getFunctionSource('toggleShellPanel');
        const openCharacterWorldInfoTabSource = getFunctionSource('openCharacterWorldInfoTab');
        const openCharacterPanelTabSource = getFunctionSource('openCharacterPanelTab');
        const openShellSource = getFunctionSource('openShell');
        const closeAllDropdownsSource = getFunctionSource('closeAllDropdowns');
        const setConnectionStripOpenStateSource = getFunctionSource('setConnectionStripOpenState');

        expect(applyExclusivitySource).toContain('[surface.NAV]: () => closeMobileNav(),');
        expect(applyExclusivitySource).toContain('[surface.LEFT_SHELL]: () => closeShell(\'left\'),');
        expect(applyExclusivitySource).toContain('[surface.RIGHT_SHELL]: () => closeShell(\'right\'),');
        expect(applyExclusivitySource).toContain('[surface.CHARACTER_PANEL]: () => closeCharacterPanel(),');
        expect(applyExclusivitySource).toContain('[surface.CHAT_TOOLS]: () => closeMobileChatTools(),');
        expect(applyExclusivitySource).toContain('[surface.CONNECTION_STRIP]: () => setConnectionStripOpenState(false),');
        expect(applyExclusivitySource).toContain('throw new Error(`Unknown mobile shell surface: ${closeSurfaceKey}`);');

        for (const source of [
            openMobileChatToolsSource,
            toggleMobileChatToolsSource,
            toggleMobileNavSource,
            toggleCharacterPanelSource,
            toggleShellPanelSource,
            openCharacterWorldInfoTabSource,
            openCharacterPanelTabSource,
            openShellSource,
            closeAllDropdownsSource,
            setConnectionStripOpenStateSource,
        ]) {
            expect(source).toContain('applyMobileSurfaceExclusivity(sbMobileShellLifecycle.overlays.resolveExclusiveOpen({');
        }

        expect(openMobileChatToolsSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.CHAT_TOOLS,');
        expect(toggleMobileChatToolsSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.CHAT_TOOLS,');
        expect(toggleMobileNavSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.NAV,');
        expect(toggleCharacterPanelSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,');
        expect(toggleShellPanelSource).toContain('surface: shellSurface,');
        expect(openCharacterWorldInfoTabSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,');
        expect(openCharacterPanelTabSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,');
        expect(openShellSource).toContain('surface: shellSurface,');
        expect(closeAllDropdownsSource).toContain('const exemptSurface = getMobileShellSurfaceForShell(except);');
        expect(closeAllDropdownsSource).toContain('surface: exemptSurface,');
        expect(closeAllDropdownsSource).toContain('closeSurfaces: sbMobileShellLifecycle.overlays.closeAllSurfaces,');
        expect(closeAllDropdownsSource).not.toContain('const surfaceByException = {');
        expect(setConnectionStripOpenStateSource).toContain('surface: sbMobileShellLifecycle.overlays.surface.CONNECTION_STRIP,');

        expect(openMobileChatToolsSource).not.toContain('closeMobileNav();\n    closeShell(\'left\');');
        expect(toggleMobileNavSource).not.toContain('closeShell(\'left\');\n        closeShell(\'right\');\n        closeCharacterPanel();\n        closeMobileChatTools();');
        expect(toggleCharacterPanelSource).not.toContain('closeShell(\'left\');\n    closeShell(\'right\');');
        expect(openCharacterWorldInfoTabSource).not.toContain('closeMobileNav();\n    closeShell(\'left\');\n    closeShell(\'right\');');
        expect(openCharacterPanelTabSource).not.toContain('closeMobileNav();\n        closeShell(\'left\');\n        closeShell(\'right\');');
        expect(openShellSource).not.toContain('closeMobileNav();\n    rememberShellFocusOrigin');
    });

    test('routes mobile drawer bound decisions through the lifecycle seam', () => {
        const applyDecisionSource = getFunctionSource('applyMobileDrawerBoundsDecision');
        const syncBoundsSource = getFunctionSource('syncMobileShellDrawerBounds');

        // The adapter is the single DOM writer for drawer bound styles.
        expect(applyDecisionSource).toContain('sbMobileShellLifecycle.drawerBounds.action.BIND');
        expect(applyDecisionSource).toContain('sbMobileShellLifecycle.drawerBounds.action.CLEAR');
        expect(applyDecisionSource).toContain('decision.styleRemovals');
        expect(applyDecisionSource).toContain('decision.styleWrites');
        expect(applyDecisionSource).toContain('drawer.style.setProperty(property, value, priority);');
        expect(applyDecisionSource).toContain('drawer.style.removeProperty(property);');

        // The call site resolves decisions through the seam and applies via the adapter.
        expect(syncBoundsSource).toContain('sbMobileShellLifecycle.drawerBounds.resolveBounds({');
        expect(syncBoundsSource).toContain('applyMobileDrawerBoundsDecision(drawer,');

        // The old inline style writes are gone from the call site.
        expect(syncBoundsSource).not.toContain('style.setProperty(\'top\'');
        expect(syncBoundsSource).not.toContain('style.setProperty(\'height\'');
        expect(syncBoundsSource).not.toContain('style.removeProperty(');
    });
});
