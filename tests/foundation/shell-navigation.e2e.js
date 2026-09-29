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
