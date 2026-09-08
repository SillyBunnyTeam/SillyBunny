/* global document, window, navigator, getComputedStyle */
import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const publicRoot = new URL('../public/', import.meta.url);
const safariUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const controlsClass = /\bsb-ios-composer-keyboard-controls-active\b/;

// Known top-level functions end at a column-zero brace; no application bootstrap is loaded.
function extractFunction(source, name) {
    const match = source.match(new RegExp(`^(?:export )?(function ${name}\\([\\s\\S]*?^}$)`, 'm'));
    if (!match) throw new Error(`Missing production function: ${name}`);
    return match[1];
}

function extractDeclaration(source, name) {
    const match = source.match(new RegExp(`^(?:export )?((?:const|let) ${name} = [\\s\\S]*?;)`, 'm'));
    if (!match) throw new Error(`Missing production declaration: ${name}`);
    return match[1];
}

test.use({ viewport: { width: 390, height: 844 }, userAgent: safariUA, reducedMotion: 'reduce' });

async function mountFixture(page, { platform = 'iPhone', userAgent = safariUA } = {}) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
        <div id="sheld"><div id="chat"></div><div id="form_sheld"><form id="send_form">
            <div id="nonQRFormItems"><div id="leftSendForm"></div><textarea id="send_textarea"></textarea><div id="rightSendForm"></div></div>
        </form></div></div>
        <div id="user-settings-block" class="drawer-content sb-shell-root">
            <div class="sb-shell-frame"><div class="sb-shell-main"><div class="sb-shell-body">
                <div class="sb-shell-panel sb-shell-panel-active"><div class="sb-shell-panel-scroller">
                    <input id="first-setting" aria-label="First setting">
                    ${Array.from({ length: 30 }, (_, index) => `<p>Setting row ${index}</p>`).join('')}
                    <textarea id="last-setting" aria-label="Last setting"></textarea>
                </div></div>
            </div></div></div>
        </div>
    </body></html>`);
    for (const [file, media] of [
        ['style.css', 'all'],
        ['css/mobile-styles.css', '(max-width: 768px)'],
        ['css/sillybunny-theme.css', 'all'],
        ['css/sillybunny-paper-theme.css', '(max-width: 768px)'],
        ['css/sillybunny-tabs.css', 'all'],
        ['css/sillybunny-mobile-shell.css', '(max-width: 768px)'],
    ]) {
        const style = await page.addStyleTag({ content: await fs.readFile(new URL(file, publicRoot), 'utf8') });
        await style.evaluate((element, media) => { element.media = media; }, media);
    }
    await page.evaluate(({ platform, userAgent }) => {
        Object.defineProperties(navigator, {
            platform: { configurable: true, value: platform },
            userAgent: { configurable: true, value: userAgent },
            maxTouchPoints: { configurable: true, value: 5 },
        });
        const viewport = new window.EventTarget();
        Object.assign(viewport, { width: window.innerWidth, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    }, { platform, userAgent });

    const [tabs, lifecycle, sendButton] = await Promise.all([
        'scripts/sillybunny-tabs.js', 'scripts/mobile-shell-lifecycle/index.js', 'scripts/mobile-send-button.js',
    ].map(file => fs.readFile(new URL(file, publicRoot), 'utf8')));
    const bindings = tabs.match(/ {4}window\.addEventListener\('resize', queueMobileViewportStateSync,[\s\S]*?(?= {4}\/\/ SillyBunny: re-sync shell width)/)?.[0];
    if (!bindings) throw new Error('Missing production viewport/focus bindings');
    await page.addScriptTag({ content: [
        ...['IOS_STABLE_COMPOSER_VIEWPORT_MAJOR'].map(name => extractDeclaration(sendButton, name)),
        ...['isIOSWebKitPlatform', 'isLegacyIOSWebKitPlatform'].map(name => extractFunction(sendButton, name)),
        ...['MOBILE_SHELL_DRAWER_BOUND_ACTION', 'MOBILE_SHELL_DRAWER_BOUND_STYLE_PROPERTIES', 'MOBILE_SHELL_VIEWPORT_SYNC_STEP'].map(name => extractDeclaration(lifecycle, name)),
        ...['normalizeNumber', 'clampBoundNumber', 'resolveMobileDrawerBounds', 'resolveMobileViewportSyncPlan'].map(name => extractFunction(lifecycle, name)),
        ...['SB_MOBILE_MEDIA_QUERY', 'MOBILE_COMPOSER_KEYBOARD_PAN_EPSILON_PX', 'MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS',
            'MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX', 'sbLastIOSKeyboardHeight', 'sbComposerKeyboardPreShiftDeadline',
            'sbComposerKeyboardSettleTimer', 'sbMobileViewportStateFrameId', 'sbIsSyncingRailActions', 'sbMobileFocusedInputScrollTimer',
        ].map(name => extractDeclaration(tabs, name)),
        ...['isMobileViewport', 'isTouchOnlyDesktopViewport', 'readFiniteViewportNumber', 'getLayoutViewportSize', 'getVisualViewportSize',
            'isEditableElement', 'isMobileShellPanelEditableElement', 'isChatComposerEditableElement', 'hasOpenMobileShellDrawer',
            'shouldUseStableIOSPanelViewport', 'isVisualViewportKeyboardOpen', 'getComposerKeyboardInset',
            'handleComposerKeyboardFocusIn', 'handleMobileKeyboardFocusOut', 'syncIOSKeyboardBottomInset',
            'getShellViewportSize', 'syncShellViewportBounds', 'getResolvedShellTopbarOffset', 'getMobileShellBoundDrawers',
            'applyMobileDrawerBoundsDecision', 'syncMobileShellDrawerBounds', 'syncMobileViewportState', 'queueMobileViewportStateSync',
            'getMobileFocusedInputScroller', 'syncMobileFocusedInputScroll', 'scheduleMobileFocusedInputScroll',
        ].map(name => extractFunction(tabs, name)),
        // Only unrelated navigation, branding, popup and app construction work is stubbed.
        ...['closeMobileNav', 'closeMobileChatTools', 'syncMobileShellRailActions', 'syncDesktopShellSizing', 'applyTopbarOffset',
            'syncChatbarVisibilityState', 'updateTopBarBrand', 'scheduleTopbarContextRefresh', 'syncMobileModalState', 'scheduleMobilePopupKeyboardSync',
        ].map(name => `function ${name}() {}`),
        `const sbMobileShellLifecycle = {
            drawerBounds: { action: MOBILE_SHELL_DRAWER_BOUND_ACTION, resolveBounds: resolveMobileDrawerBounds },
            viewportSync: { step: MOBILE_SHELL_VIEWPORT_SYNC_STEP, resolveSyncPlan: resolveMobileViewportSyncPlan },
        };`,
        bindings,
        'syncMobileViewportState();',
    ].join('\n') });
    if (errors.length) throw new Error(errors.join('\n'));
    return errors;
}

async function setVisualViewport(page, height, offsetTop = 0, event = 'resize') {
    await page.evaluate(({ height, offsetTop, event }) => {
        Object.assign(window.visualViewport, { height, offsetTop });
        window.visualViewport.dispatchEvent(new window.Event(event));
    }, { height, offsetTop, event });
}

async function drawerGeometry(page) {
    return page.locator('#user-settings-block').evaluate(drawer => {
        const rect = drawer.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
    });
}

test('modern iOS keeps the composer flush with the keyboard while focused', async ({ page }) => {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 0, right: 0, bottom: 34, left: 0 },
    });
    const errors = await mountFixture(page);
    const root = page.locator('html');
    const composer = page.locator('#form_sheld');
    const composerForm = page.locator('#send_form');
    await page.locator('#send_textarea').focus();
    await expect(composer).toHaveCSS('padding-bottom', '34px');
    await expect(root).not.toHaveClass(controlsClass);

    // Chromium does not implement the iOS-only CSS supports block; composer geometry uses offset zero.
    await setVisualViewport(page, 500);
    await expect(root).toHaveClass(controlsClass);
    await expect(composer).toHaveCSS('padding-bottom', '0px');
    const bounds = await composer.boundingBox();
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(498);
    const formBounds = await composerForm.boundingBox();
    expect(formBounds.y + formBounds.height).toBeLessThanOrEqual(500);
    expect(formBounds.y + formBounds.height).toBeGreaterThanOrEqual(498);

    // No resize or direct sync: both focusout and focusin must use the production queue.
    await page.locator('#send_textarea').evaluate(textarea => textarea.blur());
    await expect(root).not.toHaveClass(controlsClass);
    await expect(composer).toHaveCSS('padding-bottom', '34px');
    await page.locator('#send_textarea').focus();
    await expect(composer).toHaveCSS('padding-bottom', '0px');
    await page.locator('#user-settings-block').evaluate(drawer => drawer.classList.add('openDrawer'));
    await page.locator('#first-setting').focus();
    await expect(composer).toHaveCSS('padding-bottom', '34px');
    await expect(root).not.toHaveClass(controlsClass);
    await expect(page.locator('.sb-shell-panel-scroller')).toHaveCSS('padding-bottom', '34px');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--sb-ios-keyboard-bottom-inset'))).toBe('0px');
    expect(await page.evaluate(() => [window.innerWidth, window.innerHeight, window.visualViewport.height])).toEqual([390, 844, 500]);

    await page.locator('#user-settings-block').evaluate(drawer => drawer.classList.remove('openDrawer'));
    await page.locator('#send_textarea').focus();
    await expect(composer).toHaveCSS('padding-bottom', '0px');
    await setVisualViewport(page, 844);
    await expect(root).not.toHaveClass(controlsClass);
    await expect(composer).toHaveCSS('padding-bottom', '34px');
    expect(errors).toEqual([]);
});

test('settings follow the visual bottom and keep the final field reachable after viewport panning', async ({ page }) => {
    const errors = await mountFixture(page);
    await page.locator('#user-settings-block').evaluate(drawer => drawer.classList.add('openDrawer'));
    await page.locator('#first-setting').focus();
    await setVisualViewport(page, 500);
    await expect.poll(async () => (await drawerGeometry(page)).bottom).toBeCloseTo(500, 0);
    const initial = await drawerGeometry(page);
    expect(initial.height).toBeGreaterThan(300);
    await setVisualViewport(page, 500, 40, 'scroll');
    await expect.poll(async () => (await drawerGeometry(page)).bottom).toBeCloseTo(540, 0);
    const shifted = await drawerGeometry(page);
    expect(shifted.top - initial.top).toBeCloseTo(40, 0);
    expect(shifted.height).toBeCloseTo(initial.height, 0);
    await expect(page.locator('.sb-shell-panel-scroller')).toHaveCSS('padding-bottom', '34px');

    // Remove inline bounds to exercise the final real CSS fallback independently of the JS writes.
    await page.locator('#user-settings-block').evaluate(drawer => drawer.removeAttribute('style'));
    const cssOnly = await drawerGeometry(page);
    expect(cssOnly.bottom).toBeCloseTo(540, 0);
    expect(cssOnly.top).toBeCloseTo(shifted.top, 0);
    expect(cssOnly.height).toBeCloseTo(shifted.height, 0);

    await page.locator('#last-setting').focus();
    await expect.poll(() => page.locator('#last-setting').evaluate(field => {
        const rect = field.getBoundingClientRect();
        const scroller = field.closest('.sb-shell-panel-scroller');
        const visible = scroller.getBoundingClientRect();
        return scroller.scrollTop > 0 && rect.top >= visible.top && rect.bottom <= Math.min(visible.bottom, 540);
    })).toBe(true);
    await expect(page.locator('#last-setting')).toBeFocused();
    await page.locator('#last-setting').fill('Still reachable');
    await expect(page.locator('#last-setting')).toHaveValue('Still reachable');
    expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([390, 844]);

    await setVisualViewport(page, 844);
    await expect.poll(async () => (await drawerGeometry(page)).bottom).toBeCloseTo(844, 0);
    await expect(page.locator('#form_sheld')).toHaveCSS('padding-bottom', '0px');
    expect(errors).toEqual([]);
});

for (const scenario of [
    { name: 'legacy iOS phone', width: 390, platform: 'iPhone', userAgent: safariUA.replace('Version/26.1', 'Version/18.7'), inset: '304px' },
    { name: 'wide modern iPad', width: 900, platform: 'MacIntel', userAgent: safariUA.replace('iPhone; CPU iPhone OS 18_7 like Mac OS X', 'Macintosh; Intel Mac OS X 10_15_7'), inset: '304px' },
    { name: 'non-iOS phone', width: 390, platform: 'Linux armv8l', userAgent: 'Chrome/140.0', inset: '0px' },
]) {
    test(`${scenario.name} retains its keyboard inset policy without composer controls padding`, async ({ page }) => {
        await page.setViewportSize({ width: scenario.width, height: 844 });
        const errors = await mountFixture(page, scenario);
        await page.locator('#user-settings-block').evaluate(drawer => drawer.classList.add('openDrawer'));
        await page.locator('#first-setting').focus();
        await setVisualViewport(page, 500, 40);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--sb-ios-keyboard-bottom-inset'))).toBe(scenario.inset);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--sb-shell-viewport-height'))).toBe(scenario.inset === '0px' ? '500px' : '844px');
        await expect(page.locator('html')).not.toHaveClass(controlsClass);
        await page.locator('#send_textarea').focus();
        await expect(page.locator('html')).not.toHaveClass(controlsClass);
        expect(await page.locator('#form_sheld').evaluate(form => getComputedStyle(form).paddingBottom)).not.toBe('48px');
        await setVisualViewport(page, 844);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--sb-ios-keyboard-bottom-inset'))).toBe('0px');
        await expect(page.locator('html')).not.toHaveClass(/\bsb-ios-keyboard-inset-active\b/);
        expect(errors).toEqual([]);
    });
}
