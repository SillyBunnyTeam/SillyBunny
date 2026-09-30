import { expect, test } from '@playwright/test';

const layerTwoControls = [
    '#sb-hamburger',
    '#sb-left-shell-toggle',
    '#sb-right-shell-toggle',
    '#sb-home-toggle',
    '#sb-character-toggle',
];

const expectedShellTabs = {
    left: ['presets', 'api', 'sampling', 'advanced-formatting', 'agents'],
    right: ['settings', 'extensions', 'background', 'server', 'console-logs'],
};

test.beforeEach(async ({ page, baseURL }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === baseURL ? route.continue() : route.abort();
    });
});

test('preserves Layer 2 controls, labels, shell tabs, and focus restoration', async ({ page, isMobile }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));

    const controls = page.locator(layerTwoControls.join(', '));
    await expect(controls).toHaveCount(layerTwoControls.length);
    for (const selector of layerTwoControls) {
        const control = page.locator(selector);
        await expect(control).toHaveAttribute('type', 'button');
        await expect(control).toHaveAttribute('aria-label', /.+/);
        await expect(control).toBeAttached();
        if (selector === '#sb-hamburger') {
            // Mobile section navigation replaces the hamburger overlay; desktop never showed it.
            await expect(control).toBeHidden();
            continue;
        }
        await expect(control).toBeVisible();
        if (isMobile) {
            const bounds = await control.boundingBox();
            expect(bounds?.width).toBeGreaterThanOrEqual(44);
            expect(bounds?.height).toBeGreaterThanOrEqual(44);
        }
    }

    const primaryOrder = await page.locator('#sb-topbar-primary button').evaluateAll(buttons => buttons
        .map(button => button.id)
        .filter(id => ['sb-hamburger', 'sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-home-toggle', 'sb-character-toggle'].includes(id)));
    expect(primaryOrder.indexOf('sb-hamburger')).toBeLessThan(primaryOrder.indexOf('sb-left-shell-toggle'));
    expect(primaryOrder.indexOf('sb-left-shell-toggle')).toBeLessThan(primaryOrder.indexOf('sb-right-shell-toggle'));
    expect(primaryOrder.indexOf('sb-right-shell-toggle')).toBeLessThan(primaryOrder.indexOf('sb-home-toggle'));
    expect(primaryOrder.indexOf('sb-home-toggle')).toBeLessThan(primaryOrder.indexOf('sb-character-toggle'));

    for (const [shellKey, toggleId] of [['left', 'sb-left-shell-toggle'], ['right', 'sb-right-shell-toggle']]) {
        const toggle = page.locator(`#${toggleId}`);
        await toggle.click();
        const shell = page.locator(`#${shellKey === 'left' ? 'left-nav-panel' : 'user-settings-block'}`);
        await expect(shell).toHaveClass(/openDrawer/);
        await expect(shell).toHaveAttribute('data-sb-shell-ready', 'true');
        await expect(shell).toHaveAttribute('data-sb-shell-key', shellKey);
        await expect(shell.locator('nav.sb-shell-nav[role="tablist"]')).toHaveAttribute('aria-label', /sections/);
        await expect(shell.locator('.sb-shell-close')).toHaveAttribute('aria-label', /Close/);

        const tabs = shell.locator('[role="tab"][data-sb-tab]');
        await expect(tabs).toHaveCount(expectedShellTabs[shellKey].length);
        expect(await tabs.evaluateAll(buttons => buttons.map(button => button.dataset.sbTab))).toEqual(expectedShellTabs[shellKey]);
        await expect(shell.locator('[role="tab"][data-sb-tab][aria-selected="true"]')).toHaveCount(1);

        await shell.locator('.sb-shell-close').click();
        await expect(shell).not.toHaveClass(/openDrawer/);
        await expect(toggle).toBeFocused();
    }

    await expect(page.locator('#sb-mobile-nav')).toBeHidden();
});

test('desktop Characters drawer opens from its top-bar trigger', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The trigger-origin animation is desktop-only.');
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));

    const setupWizard = page.locator('#qig-setup-wizard');
    if (await setupWizard.isVisible().catch(() => false)) {
        await setupWizard.locator('.qig-close-btn').click({ force: true });
        await expect(setupWizard).toBeHidden({ timeout: 5000 });
    }
    await page.evaluate(() => document.body.classList.remove('reduced-motion'));

    await page.evaluate(() => {
        const originalAnimate = HTMLElement.prototype.animate;
        window.__sbShellOriginAnimation = null;
        HTMLElement.prototype.animate = function (keyframes, options) {
            if (this.id === 'right-nav-panel') {
                const trigger = document.getElementById('sb-character-toggle').getBoundingClientRect();
                const panel = this.getBoundingClientRect();
                window.__sbShellOriginAnimation = {
                    duration: options.duration,
                    origin: this.style.transformOrigin,
                    expectedOrigin: `${Math.round(trigger.left + trigger.width / 2 - panel.left)}px ${Math.round(trigger.top + trigger.height / 2 - panel.top)}px`,
                    keyframes: keyframes.map(({ opacity, transform }) => ({ opacity, transform })),
                };
            }
            return originalAnimate.call(this, keyframes, options);
        };
    });

    await page.locator('#sb-character-toggle').click();
    const drawer = page.locator('#right-nav-panel');
    await expect(drawer).toHaveClass(/openDrawer/);
    await expect.poll(() => page.evaluate(() => window.__sbShellOriginAnimation)).not.toBeNull();
    const animation = await page.evaluate(() => window.__sbShellOriginAnimation);
    expect(animation.duration).toBe(240);
    expect(animation.origin).toBe(animation.expectedOrigin);
    expect(animation.keyframes).toEqual([
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 1, transform: 'scale(1)' },
    ]);

    await drawer.locator('.sb-shell-close').click();
    await expect(drawer).not.toHaveClass(/openDrawer/);
});

test('mobile section navigation opens on the hub once, then uses the section menu', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Section navigation is mobile-only.');
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await expect(page.locator('html')).toHaveAttribute('data-sb-mobile-ui-mode', 'mobile');
    await page.evaluate(() => sessionStorage.removeItem('sb-section-nav-seen:workspace'));

    const shell = page.locator('#left-nav-panel');
    const toggle = page.locator('#sb-left-shell-toggle');
    const hub = shell.locator('.sb-section-nav-hub');
    const trigger = shell.locator('.sb-section-nav-menu-trigger');
    const backButton = shell.locator('.sb-section-nav-back');
    const menu = shell.locator('.sb-section-nav-menu');

    await toggle.click();
    await expect(shell).toHaveAttribute('data-sb-section-view', 'hub');
    await expect(hub).toBeVisible();
    await expect(shell.locator('.sb-shell-nav-wrapper')).toBeHidden();
    const hubItems = hub.locator('.sb-section-nav-hub-item');
    await expect(hubItems).toHaveCount(expectedShellTabs.left.length);
    expect(await hubItems.evaluateAll(items => items.map(item => item.dataset.sbSectionTab))).toEqual(expectedShellTabs.left);

    await hub.locator('.sb-section-nav-hub-item[data-sb-section-tab="api"]').click();
    await expect(shell).toHaveAttribute('data-sb-section-view', 'section');
    await expect(hub).toBeHidden();
    await expect(shell.locator('[role="tab"][data-sb-tab="api"]')).toHaveAttribute('aria-selected', 'true');
    await expect(backButton).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveAttribute('data-sb-section-tab', 'api');
    await menu.locator('[role="menuitemradio"][data-sb-section-tab="sampling"]').click();
    await expect(menu).toBeHidden();
    await expect(shell.locator('[role="tab"][data-sb-tab="sampling"]')).toHaveAttribute('aria-selected', 'true');

    await trigger.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await backButton.click();
    await expect(shell).toHaveAttribute('data-sb-section-view', 'hub');
    await expect(hub).toBeVisible();

    await shell.locator('.sb-shell-close').click();
    await expect(shell).not.toHaveClass(/openDrawer/);
    await toggle.click();
    await expect(shell).toHaveClass(/openDrawer/);
    await expect(shell).toHaveAttribute('data-sb-section-view', 'section');
    await expect(hub).toBeHidden();
});

test('mobile section menu and chat tools use state motion with reduced-motion fallback', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile motion is mobile-only.');
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.body.classList.remove('reduced-motion'));

    const shell = page.locator('#left-nav-panel');
    await page.evaluate(() => sessionStorage.setItem('sb-section-nav-seen:workspace', '1'));
    await page.locator('#sb-left-shell-toggle').click();
    const trigger = shell.locator('.sb-section-nav-menu-trigger');
    await trigger.click();
    await expect(shell.locator('.sb-section-nav-menu')).toBeVisible();
    await expect.poll(() => shell.locator('.sb-section-nav-menu').evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
    await trigger.click();
    await expect(shell.locator('.sb-section-nav-menu')).toBeHidden();
    await shell.locator('.sb-shell-close').click();
    await expect(shell).not.toHaveClass(/openDrawer/);

    await page.locator('.sb-bottom-chat-chip').click();
    await expect(page.locator('#sb-bottom-chat-sheet')).toBeVisible();
    await expect.poll(() => page.locator('#sb-bottom-chat-sheet').evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#sb-bottom-chat-sheet .sb-bottom-chat-sheet-close').click();
    await expect(page.locator('#sb-bottom-chat-sheet')).toBeHidden();
    expect(await page.locator('#sb-bottom-chat-sheet').evaluate(element => element.getAnimations().length)).toBe(0);
});
