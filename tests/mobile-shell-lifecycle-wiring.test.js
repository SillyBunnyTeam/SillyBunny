import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MOBILE_SHELL_VIEWPORT_SYNC_STEP } from '../public/scripts/mobile-shell-lifecycle/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');
const browserFixesSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'browser-fixes.js'), 'utf8');
const tabsCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8');
const mobileShellCssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8');

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

    test('clamps resizable shell panels against the visual viewport and panel top', () => {
        const getResolvedShellTopbarOffsetSource = getFunctionSource('getResolvedShellTopbarOffset');
        const getDesktopShellResizeBoundsSource = getFunctionSource('getDesktopShellResizeBounds');
        const setShellSizeOverrideSource = getFunctionSource('setShellSizeOverride');
        const openShellSource = getFunctionSource('openShell');
        const closeShellSource = getFunctionSource('closeShell');
        const syncMobileViewportStateSource = getFunctionSource('syncMobileViewportState');

        expect(tabsSource).toContain('function getShellViewportSize(');
        expect(tabsSource).toContain('function syncShellViewportBounds(');
        expect(tabsSource).toContain('function syncMobileShellDrawerBounds(');
        expect(tabsSource).toContain('function queueMobileShellDrawerBoundsSync(');
        expect(tabsSource).toContain('root.style.setProperty(\'--sb-shell-available-height\'');
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
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'resize\', syncMobileViewportState, { passive: true });');
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'scroll\', syncMobileViewportState, { passive: true });');
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'resize\', syncDesktopShellSizing, { passive: true });');
        expect(tabsSource).toContain('window.visualViewport?.addEventListener(\'scroll\', syncDesktopShellSizing, { passive: true });');
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
        expect(queueMobileShellDrawerBoundsSyncSource).toContain('window.setTimeout(sync, schedule.followupDelayMs);');
        expect(syncMobileViewportStateSource).not.toContain('if (!isMobileViewport()) {');
        expect(queueMobileShellDrawerBoundsSyncSource).not.toContain('if (!isMobileViewport()) {');
        expect(queueMobileShellDrawerBoundsSyncSource).not.toContain('if (typeof window.requestAnimationFrame === \'function\') {');
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
        expect(tabsSource).toContain('snapToChatWidth: normalizeStoredBoolean(safeGetItem(SB_STORAGE_KEYS.desktopShellSnapToChatWidth), false)');
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
