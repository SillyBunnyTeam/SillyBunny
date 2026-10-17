import { expect, test } from '@playwright/test';

const layerTwoControls = [
    '#sb-left-shell-toggle',
    '#sb-right-shell-toggle',
    '#sb-home-toggle',
    '#sb-character-toggle',
];

const expectedShellTabs = {
    left: ['connections', 'sampling', 'prompting', 'editor', 'context', 'agents'],
    right: ['appearance', 'extensions', 'interface', 'messages', 'data-security', 'logs'],
};

test.beforeEach(async ({ page, baseURL }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === baseURL ? route.continue() : route.abort();
    });
});

test('preserves Layer 2 controls, labels, settings tabs, and settings focus', async ({ page, isMobile }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));

    const controls = page.locator(layerTwoControls.join(', '));
    await expect(controls).toHaveCount(layerTwoControls.length);
    for (const selector of layerTwoControls) {
        const control = page.locator(selector);
        await expect(control).toHaveAttribute('type', 'button');
        await expect(control).toHaveAttribute('aria-label', /.+/);
        await expect(control).toBeAttached();
        await expect(control).toBeVisible();
        if (isMobile) {
            const bounds = await control.boundingBox();
            expect(bounds?.width).toBeGreaterThanOrEqual(44);
            expect(bounds?.height).toBeGreaterThanOrEqual(44);
        }
    }

    const primaryOrder = await page.locator('#sb-topbar-primary button').evaluateAll(buttons => buttons
        .map(button => button.id)
        .filter(id => ['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-home-toggle', 'sb-character-toggle'].includes(id)));
    expect(primaryOrder.indexOf('sb-left-shell-toggle')).toBeLessThan(primaryOrder.indexOf('sb-right-shell-toggle'));
    expect(primaryOrder.indexOf('sb-right-shell-toggle')).toBeLessThan(primaryOrder.indexOf('sb-home-toggle'));
    expect(primaryOrder.indexOf('sb-home-toggle')).toBeLessThan(primaryOrder.indexOf('sb-character-toggle'));

    const settingsPage = page.locator('#sb-settings-page');
    const settingsTabList = page.locator('#sb-settings-tab-list');
    const settingsClose = page.locator('#sb-settings-close');

    for (const [shellKey, toggleId] of [['left', 'sb-left-shell-toggle'], ['right', 'sb-right-shell-toggle']]) {
        const toggle = page.locator(`#${toggleId}`);
        await toggle.click();
        const shell = page.locator(`#${shellKey === 'left' ? 'left-nav-panel' : 'user-settings-block'}`);
        await expect(settingsPage).toBeVisible();
        await expect(settingsPage).not.toHaveAttribute('hidden');
        await expect(shell).toHaveClass(/sb-settings-active-root/);
        await expect(shell).toHaveAttribute('data-sb-shell-ready', 'true');
        await expect(shell).toHaveAttribute('data-sb-shell-key', shellKey);
        await expect(shell).toHaveAttribute('aria-hidden', 'false');
        await expect(settingsTabList).toHaveAttribute('role', 'tablist');
        await expect(settingsTabList).toHaveAttribute('aria-orientation', 'vertical');
        await expect(settingsClose).toHaveAttribute('aria-label', /Close/);
        await expect(settingsClose).toBeVisible();

        const tabs = settingsTabList.locator('.sb-settings-tab');
        await expect(tabs).toHaveCount(expectedShellTabs[shellKey].length);
        expect(await tabs.evaluateAll(buttons => buttons.map(button => button.dataset.sbSettingsTab))).toEqual(expectedShellTabs[shellKey]);
        await expect(settingsTabList.locator('.sb-settings-tab[aria-selected="true"]')).toHaveCount(1);

        if (isMobile) {
            await expect(settingsTabList.locator('.sb-settings-tab[aria-selected="true"]')).toBeFocused();
        } else {
            await expect(settingsClose).toBeFocused();
        }

        await settingsClose.click();
        await expect(settingsPage).toHaveAttribute('hidden', '');
        await expect(shell).not.toHaveClass(/sb-settings-active-root/);
        await expect(shell).toHaveAttribute('aria-hidden', 'true');
        await expect(toggle).not.toHaveClass(/sb-settings-active/);
    }

    await expect(page.locator('#sb-mobile-nav')).toBeHidden();
});

test('desktop Characters settings page opens from its top-bar trigger', async ({ page, isMobile }) => {
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

    await page.locator('#sb-character-toggle').click();
    const settingsPage = page.locator('#sb-settings-page');
    const characterPanel = page.locator('#right-nav-panel');
    await expect(settingsPage).toBeVisible();
    await expect(characterPanel).toHaveClass(/sb-settings-active-root/);
    await expect(characterPanel).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#sb-settings-tab-list .sb-settings-tab')).toHaveCount(6);
    await expect(page.locator('#sb-settings-content-title')).toContainText('Characters');

    await page.locator('#sb-settings-close').click();
    await expect(settingsPage).toHaveAttribute('hidden', '');
    await expect(characterPanel).not.toHaveClass(/sb-settings-active-root/);
});

test('mobile Characters pager stays below the toolbar after Home navigation', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The mobile character toolbar layout is mobile-only.');
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));

    await page.locator('#sb-home-toggle').click();
    await expect(page.locator('.welcomePanel')).toBeVisible();
    await page.locator('#sb-character-toggle').click();
    await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
    await page.locator('#rm_print_characters_pagination').evaluate((element) => {
        element.style.setProperty('display', 'flex', 'important');
    });

    const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.sb-character-create-bar');
        const pager = document.getElementById('rm_print_characters_pagination');
        const toolbarRect = toolbar.getBoundingClientRect();
        const pagerRect = pager.getBoundingClientRect();
        const overlapsToolbar = pagerRect.width > 0 && pagerRect.height > 0 && Array.from(toolbar.children).some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0
                && Math.min(rect.right, pagerRect.right) - Math.max(rect.left, pagerRect.left) > 1
                && Math.min(rect.bottom, pagerRect.bottom) - Math.max(rect.top, pagerRect.top) > 1;
        });

        return {
            pagerParent: pager.parentElement?.id,
            toolbarBottom: toolbarRect.bottom,
            pagerTop: pagerRect.top,
            overlapsToolbar,
        };
    });

    expect(layout.pagerParent).toBe('rm_characters_block');
    expect(layout.pagerTop).toBeGreaterThanOrEqual(layout.toolbarBottom);
    expect(layout.overlapsToolbar).toBe(false);
});

test('mobile top-bar shell triggers open the settings page with motion', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile shell motion is mobile-only.');
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.body.classList.remove('reduced-motion'));

    await page.evaluate(() => {
        window.__sbMobileShellAnimations = [];
        const originalAnimate = HTMLElement.prototype.animate;
        HTMLElement.prototype.animate = function (keyframes, options) {
            if (this.id === 'sb-settings-page') {
                window.__sbMobileShellAnimations.push({
                    duration: options.duration,
                    keyframes: keyframes.map(({ opacity, transform }) => ({ opacity, transform })),
                });
            }
            return originalAnimate.call(this, keyframes, options);
        };
    });

    for (const toggleId of ['sb-left-shell-toggle', 'sb-right-shell-toggle', 'sb-character-toggle']) {
        await page.locator(`#${toggleId}`).click();
        await expect.poll(() => page.evaluate(() => window.__sbMobileShellAnimations.at(-1))).toBeTruthy();
        const details = await page.evaluate(() => window.__sbMobileShellAnimations.at(-1));
        expect(details.duration).toBe(250);
        expect(details.keyframes).toEqual([
            { opacity: 0, transform: 'scale(0.96)' },
            { opacity: 1, transform: 'scale(1)' },
        ]);
        const renderedSamples = await page.evaluate(() => new Promise(resolve => {
            const panel = document.getElementById('sb-settings-page');
            const samples = [];
            const startedAt = performance.now();
            const sample = () => {
                const style = getComputedStyle(panel);
                samples.push({ opacity: style.opacity, scale: style.scale });
                if (performance.now() - startedAt >= 80) {
                    resolve(samples);
                    return;
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        }));
        expect(renderedSamples.some(sample => sample.opacity !== '1' || sample.scale !== '1')).toBe(true);

        const settingsPage = page.locator('#sb-settings-page');
        await page.locator('#sb-settings-close').click();
        await expect(settingsPage).toHaveAttribute('hidden', '');
    }
});

test('settings page opens with sidebar tabs and switches content', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile settings navigation is mobile-only.');
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await expect(page.locator('html')).toHaveAttribute('data-sb-mobile-ui-mode', 'mobile');

    const settingsPage = page.locator('#sb-settings-page');
    const sidebar = page.locator('#sb-settings-sidebar');

    // An explicit tab route opens the mobile sidebar; the top-bar toggle intentionally restores
    // the last selected tab directly in content view.
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
    await expect(settingsPage).not.toHaveAttribute('hidden');
    await expect(sidebar).toBeVisible();

    // Mobile starts in sidebar view
    await expect(settingsPage).not.toHaveClass(/sb-settings-page--content/);

    const tabButtons = sidebar.locator('.sb-settings-tab');
    await expect(tabButtons).toHaveCount(expectedShellTabs.left.length);
    expect(await tabButtons.evaluateAll(buttons => buttons.map(button => button.dataset.sbSettingsTab))).toEqual(expectedShellTabs.left);

    // Click a tab to switch to content view
    await sidebar.locator('.sb-settings-tab[data-sb-settings-tab="connections"]').click();
    await expect(settingsPage).toHaveClass(/sb-settings-page--content/);
    await expect(sidebar.locator('.sb-settings-tab[data-sb-settings-tab="connections"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#sb-settings-content-title')).toContainText('Connections');

    // Return to navigation before selecting another tab; content view slides the sidebar off-canvas.
    await page.locator('#sb-settings-back').click();
    await expect(settingsPage).not.toHaveClass(/sb-settings-page--content/);
    await expect(sidebar).toBeVisible();

    await sidebar.locator('.sb-settings-tab[data-sb-settings-tab="sampling"]').click();
    await expect(sidebar.locator('.sb-settings-tab[data-sb-settings-tab="sampling"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#sb-settings-content-title')).toContainText('Sampling');

    // Back button returns to sidebar
    await page.locator('#sb-settings-back').click();
    await expect(settingsPage).not.toHaveClass(/sb-settings-page--content/);
    await expect(sidebar).toBeVisible();

    // Close and reopen
    await page.locator('#sb-settings-close').click();
    await expect(settingsPage).toHaveAttribute('hidden');
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
    await expect(settingsPage).not.toHaveAttribute('hidden');

    // Should be back in sidebar view after reopen
    await expect(settingsPage).not.toHaveClass(/sb-settings-page--content/);

    await page.reload();
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
});

test('mobile settings page and chat tools use WAAPI motion with reduced-motion fallback', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile motion is mobile-only.');
    await page.goto('/');
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function' && !document.querySelector('#preloader'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.body.classList.remove('reduced-motion'));

    await page.locator('#sb-left-shell-toggle').click();
    const settingsPage = page.locator('#sb-settings-page');
    await expect(settingsPage).not.toHaveAttribute('hidden');

    // Settings page open should have animations
    await expect.poll(() => settingsPage.evaluate(element => element.getAnimations().length)).toBeGreaterThanOrEqual(0);

    await page.locator('#sb-settings-close').click();
    await expect(settingsPage).toHaveAttribute('hidden');

    await page.locator('.sb-bottom-chat-chip').click();
    await expect.poll(() => page.locator('#sb-bottom-chat-sheet').evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
    await expect(page.locator('#sb-bottom-chat-sheet')).toBeVisible();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#sb-bottom-chat-sheet .sb-bottom-chat-sheet-close').click();
    await expect(page.locator('#sb-bottom-chat-sheet')).toBeHidden();
    expect(await page.locator('#sb-bottom-chat-sheet').evaluate(element => element.getAnimations().length)).toBe(0);
});
