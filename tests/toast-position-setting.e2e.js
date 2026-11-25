import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { keepSavesInPage } from './helpers/saves-in-page.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_FORM_SELECTOR } from './helpers/toasts.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

// Customize > Appearance: Notifications places in-app notifications (#toastr_position, upstream's setting) and Toasts places
// toasts (#toast_position). Each choice is saved, and moves the next message of its own form and no other.

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });
// A fade replaces the slide, so a box that the test measures is not moving.
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

// Where a notification at Bottom Left can be seen to sit. On a phone it may be as wide as the window and then has no side,
// and the test holds whatever width the notification has.
const VIEWPORTS = [
    { width: 1440, height: 900, sidesOfBottomLeftNotification: ['left'] },
    { width: 390, height: 844, sidesOfBottomLeftNotification: ['left', null] },
];

const STAYS = { timeOut: 0, extendedTimeOut: 0 };

async function boot(page) {
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });
    await showToasts(page);
}

/** Starts the page with these `power_user` values, as if the user had saved them before. */
async function startWith(page, powerUser) {
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyWelcomeSettings(settings);
        Object.assign(settings.power_user, powerUser);
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function openAppearance(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await page.locator('button[data-sb-settings-tab="appearance"]').evaluate(element => element.click());
    const panel = page.locator('[data-sb-panel="appearance"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

const rowOf = (page, selectId) => page.locator('.ds-select-row', { has: page.locator(`#${selectId}`) });

async function choose(page, selectId, label) {
    const row = rowOf(page, selectId);
    await row.scrollIntoViewIfNeeded();
    await row.locator('.ds-select-row__trigger').click();
    await page.locator('.sb-picker:visible .sb-picker__option, .sb-picker-sheet:visible .sb-picker__option')
        .filter({ has: page.locator('.sb-picker__label', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) })
        .click();
    await expect(row.locator('.ds-select-row__value')).toHaveText(label);
}

const showToast = page => page.evaluate(text => window.toastr.success(text, '', { timeOut: 0, extendedTimeOut: 0 })[0].className, 'Saved');
const showNotification = page => page.evaluate(text => window.toastr.success(text, 'Chat', { timeOut: 0, extendedTimeOut: 0 })[0].className, 'Saved the chat');
const clearMessages = page => page.evaluate(() => window.toastr.clear());

/** Which side of the window a message is on: its centre against the thirds of the width and the middle of the height. */
async function placeOf(page, locator) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    const { width, height } = page.viewportSize();
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;
    return {
        vertical: centreY < height / 2 ? 'top' : 'bottom',
        // A message as wide as the window has no left or right.
        horizontal: box.width > width / 2 ? null : centreX < width / 3 ? 'left' : centreX > (2 * width) / 3 ? 'right' : 'center',
    };
}

for (const viewport of VIEWPORTS) {
    test.describe(`at ${viewport.width}x${viewport.height}`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height } });

        test('Toasts starts at the bottom centre and Notifications at the top centre, each in a row of its own', async ({ page }) => {
            await boot(page);
            const panel = await openAppearance(page);

            await expect(page.locator('#toast_position')).toHaveValue('toast-bottom-center');
            await expect(page.locator('#toastr_position')).toHaveValue('toast-top-center');
            await expect(rowOf(page, 'toastr_position').locator('.ds-row-label')).toHaveText('Notifications');
            await expect(rowOf(page, 'toastr_position').locator('.ds-row-subtitle').first()).toHaveText('Choose where application pop-up notifications appear on the screen');
            await expect(rowOf(page, 'toast_position').locator('.ds-row-label')).toHaveText('Toasts');
            await expect(rowOf(page, 'toast_position').locator('.ds-row-subtitle').first()).toHaveText('Choose where application toast confirmations appear on the screen');
            await expect(panel.locator('.ds-select-row:has(#toastr_position) + .ds-select-row:has(#toast_position)')).toHaveCount(1);

            await showToast(page);
            await showNotification(page);
            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-bottom-center/);
            await expect(page.locator('#toast-container')).toHaveClass(/toast-top-center/);
            expect(await placeOf(page, page.locator(TOAST_FORM_SELECTOR))).toMatchObject({ vertical: 'bottom', horizontal: 'center' });
            expect((await placeOf(page, page.locator(NOTIFICATION_FORM_SELECTOR))).vertical).toBe('top');
        });

        test('a choice in Toasts moves the next toast and is saved, and a choice in Notifications moves the next notification and is saved', async ({ page }) => {
            const kept = await keepSavesInPage(page);
            await boot(page);
            await openAppearance(page);

            await choose(page, 'toast_position', 'Top Right');
            await expect.poll(() => kept.settings?.power_user?.toast_position).toBe('toast-top-right');
            expect(kept.settings.power_user.toastr_position, 'the other setting is left alone').toBe('toast-top-center');

            await showToast(page);
            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-top-right/);
            await expect(page.locator('#sb-toast-overlay')).not.toHaveClass(/toast-bottom-center/);
            const toast = await placeOf(page, page.locator(TOAST_FORM_SELECTOR));
            expect(toast).toMatchObject({ vertical: 'top', horizontal: 'right' });

            await showNotification(page);
            await expect(page.locator('#toast-container')).toHaveClass(/toast-top-center/);

            await clearMessages(page);
            await choose(page, 'toastr_position', 'Bottom Left');
            await expect.poll(() => kept.settings?.power_user?.toastr_position).toBe('toast-bottom-left');
            expect(kept.settings.power_user.toast_position, 'the other setting is left alone').toBe('toast-top-right');

            await showNotification(page);
            await showToast(page);
            await expect(page.locator('#toast-container')).toHaveClass(/toast-bottom-left/);
            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-top-right/);
            const notification = await placeOf(page, page.locator(NOTIFICATION_FORM_SELECTOR));
            expect(notification.vertical).toBe('bottom');
            expect(viewport.sidesOfBottomLeftNotification).toContain(notification.horizontal);
            expect((await placeOf(page, page.locator(TOAST_FORM_SELECTOR))).vertical).toBe('top');
        });

        test('a saved choice is applied when the page loads again, in the select and for the next toast', async ({ page }) => {
            const kept = await keepSavesInPage(page);
            await boot(page);
            await openAppearance(page);
            await choose(page, 'toast_position', 'Bottom Left');
            await expect.poll(() => kept.settings?.power_user?.toast_position).toBe('toast-bottom-left');

            await page.reload();
            await waitForAppReady(page, { timeout: 60000 });
            await showToasts(page);
            await openAppearance(page);

            await expect(page.locator('#toast_position')).toHaveValue('toast-bottom-left');
            await expect(rowOf(page, 'toast_position').locator('.ds-select-row__value')).toHaveText('Bottom Left');
            await showToast(page);
            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-bottom-left/);
            expect(await placeOf(page, page.locator(TOAST_FORM_SELECTOR))).toMatchObject({ vertical: 'bottom', horizontal: 'left' });
        });

        test('a saved toast position that is not one of the six becomes Bottom Center and breaks nothing', async ({ page }) => {
            const errors = [];
            // WebKit reports a ResizeObserver notification that came after the frame as an error event. It is not a failure of the page.
            page.on('pageerror', error => !/ResizeObserver loop/.test(error.message) && errors.push(error.message));
            await startWith(page, { toast_position: 'toast-middle-nowhere', toastr_position: 'toast-top-right' });
            await boot(page);
            await openAppearance(page);

            await expect(page.locator('#toast_position')).toHaveValue('toast-bottom-center');
            await expect(rowOf(page, 'toast_position').locator('.ds-select-row__value')).toHaveText('Bottom Center');
            await showToast(page);
            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-bottom-center/);
            // The notification setting still has its own value.
            await showNotification(page);
            await expect(page.locator('#toast-container')).toHaveClass(/toast-top-right/);
            expect(errors).toEqual([]);
        });

        test('a toast that is already on screen follows a new choice at once', async ({ page }) => {
            await boot(page);
            await openAppearance(page);
            await page.evaluate(options => window.toastr.info('Still here', '', options), STAYS);
            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-bottom-center/);

            await choose(page, 'toast_position', 'Top Left');

            await expect(page.locator('#sb-toast-overlay')).toHaveClass(/toast-top-left/);
            expect(await placeOf(page, page.locator(TOAST_FORM_SELECTOR))).toMatchObject({ vertical: 'top', horizontal: 'left' });
        });
    });
}
