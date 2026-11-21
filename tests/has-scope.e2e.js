import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

async function bootHome(page) {
    await protectMaintainerServer(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    await expect(page.locator('#chat > .welcomePanel')).toBeVisible({ timeout: 30000 });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${viewport.width}px`, () => {
        test.use({ viewport, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
        // A phone centres the avatar, a desktop keeps it beside the split view.
        const expectedAvatarLeft = viewport.width < 620 ? `${viewport.width / 2}px` : '12px';

        // The narrowed :has() rules name these places by direct relation, so each must stay a direct child.
        test('the places the narrowed :has() rules rely on stay where the rules look for them', async ({ page }) => {
            await bootHome(page);

            const placement = await page.evaluate(() => ({
                settingsPage: document.getElementById('sb-settings-page')?.parentElement === document.body,
                sheld: document.getElementById('sheld')?.parentElement === document.body,
            }));
            expect(placement).toEqual({ settingsPage: true, sheld: true });
        });

        test('the companion handle hides behind an open dialog, whether the dialog was added before or after it', async ({ page }) => {
            await bootHome(page);
            const handle = page.locator('#ica--tracker-panel-handle');
            await expect(handle).toHaveCount(1);
            await handle.evaluate(element => { element.style.display = 'flex'; });
            await expect(handle).toHaveCSS('visibility', 'visible');

            await page.evaluate(() => {
                const dialog = document.createElement('dialog');
                dialog.id = 'qaDialogAfter';
                document.body.append(dialog);
                dialog.showModal();
            });
            await expect(handle).toHaveCSS('visibility', 'hidden');
            await page.evaluate(() => document.getElementById('qaDialogAfter').remove());
            await expect(handle).toHaveCSS('visibility', 'visible');

            await page.evaluate(() => {
                const dialog = document.createElement('dialog');
                dialog.id = 'qaDialogBefore';
                document.body.insertBefore(dialog, document.getElementById('ica--tracker-panel-handle'));
                dialog.showModal();
            });
            await expect(handle).toHaveCSS('visibility', 'hidden');
            await page.evaluate(() => document.getElementById('qaDialogBefore').close());
            await expect(handle).toHaveCSS('visibility', 'visible');
        });

        test('the legacy prompt popup stays hidden once the prompt editor owns the column', async ({ page }) => {
            await bootHome(page);
            await page.evaluate(() => $('#main_api').val('openai').trigger('change'));
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
            await expect(page.locator('.sb-editor-panel.sb-prompt-owned')).toHaveCount(1, { timeout: 30000 });
            await expect(page.locator('#completion_prompt_manager_popup')).toHaveAttribute('data-sb-prompt-owned', '');
            await expect(page.locator('#completion_prompt_manager_popup')).toHaveCSS('display', 'none');
        });

        test('Conversation zoomed avatars sit where the Conversation rule puts them', async ({ page }) => {
            await bootHome(page);
            await page.evaluate(() => window.SillyBunnyAssets.loadStylesheetAsync('css/sillybunny-conversation.css', { id: 'qa-conversation-css' }));
            await page.evaluate(() => {
                const avatar = document.createElement('div');
                avatar.className = 'zoomed_avatar sb-conversation-zoomed-avatar';
                avatar.id = 'qaZoomed';
                avatar.style.position = 'fixed';
                avatar.style.display = 'flex';
                document.body.append(avatar);
            });
            const avatar = page.locator('#qaZoomed');
            const before = await avatar.evaluate(element => getComputedStyle(element).top);

            await page.evaluate(() => document.getElementById('sheld').setAttribute('data-sb-conversation-mode', 'on'));

            await expect.poll(() => avatar.evaluate(element => getComputedStyle(element).top)).not.toBe(before);
            await expect(avatar).toHaveCSS('left', expectedAvatarLeft);

            await page.evaluate(() => document.getElementById('sheld').removeAttribute('data-sb-conversation-mode'));
            await expect.poll(() => avatar.evaluate(element => getComputedStyle(element).top)).toBe(before);
        });

        test('floating portraits hide while the settings page is open and come back when it closes', async ({ page }) => {
            await bootHome(page);
            await page.evaluate(() => {
                const portrait = document.createElement('div');
                portrait.className = 'zoomed_avatar';
                portrait.setAttribute('forchar', 'qa.png');
                portrait.id = 'qaPortrait';
                portrait.style.cssText = 'position: fixed; top: 100px; left: 100px; width: 40px; height: 40px;';
                document.body.append(portrait);
            });
            const portrait = page.locator('#qaPortrait');
            await expect(portrait).toHaveCSS('visibility', 'visible');

            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await expect(portrait).toHaveCSS('visibility', 'hidden');

            await page.keyboard.press('Escape');
            await expect(page.locator('#sb-settings-page')).toBeHidden();
            await expect(portrait).toHaveCSS('visibility', 'visible');
        });
    });
}
