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
        if (isMobile || selector !== '#sb-hamburger') {
            await expect(control).toBeVisible();
        }
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

    if (isMobile) {
        const hamburger = page.locator('#sb-hamburger');
        await hamburger.click();
        const mobileNav = page.locator('#sb-mobile-nav');
        await expect(mobileNav).toHaveAttribute('role', 'dialog');
        await expect(mobileNav).toHaveAttribute('aria-modal', 'true');
        await expect(mobileNav).toHaveAttribute('aria-hidden', 'false');
        await expect(mobileNav).toHaveAttribute('aria-labelledby', 'sb-mobile-nav-title');
        await expect(hamburger).toHaveAttribute('aria-expanded', 'true');
        await mobileNav.locator('.sb-mobile-panel-close').click();
        await expect(mobileNav).toBeHidden();
        await expect(hamburger).toBeFocused();
    }
});
