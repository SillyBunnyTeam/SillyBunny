import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
});

const toast = (page, title) => page.locator('#toast-container .toast', { has: page.locator('.toast-title', { hasText: title }) });

test('a second toast waits behind the first and shows when the first has gone', async ({ page }) => {
    await page.evaluate(() => {
        window.toastr.info('First message', 'First', { timeOut: 900, extendedTimeOut: 900 });
        window.toastr.info('Second message', 'Second', { timeOut: 900, extendedTimeOut: 900 });
    });
    await expect(toast(page, 'First')).toBeVisible();
    await expect(toast(page, 'Second'), 'the second toast is in the page, but hidden').toBeHidden();
    await expect(toast(page, 'Second')).toHaveCount(1);
    await expect(toast(page, 'Second'), 'it shows once the first hides').toBeVisible({ timeout: 4000 });
    await expect(toast(page, 'First')).toHaveCount(0, { timeout: 2000 });
    await expect(toast(page, 'Second'), 'it goes after its own timeout').toHaveCount(0, { timeout: 4000 });
});

test('the app listener still hears a queued toast: it is a tap target with its title when it shows', async ({ page }) => {
    await page.evaluate(() => {
        window.toastr.info('First message', 'First', { timeOut: 700, extendedTimeOut: 700 });
        window.toastr.info('Second message', 'Second', { timeOut: 5000, extendedTimeOut: 5000 });
    });
    await expect(toast(page, 'Second')).toBeVisible({ timeout: 4000 });
    await expect(toast(page, 'Second')).toHaveAttribute('title', /.+/);
    await expect(toast(page, 'Second')).toHaveClass(/interactable/);
});

test('a toast with a button shows at once and the shown toast waits at the head of the queue', async ({ page }) => {
    await page.evaluate(() => {
        window.toastr.info('First message', 'First', { timeOut: 5000, extendedTimeOut: 5000 });
        window.toastr.info('Second message', 'Second', { timeOut: 5000, extendedTimeOut: 5000 });
    });
    await expect(toast(page, 'First')).toBeVisible();
    await page.evaluate(() => {
        window.toastr.info('<button type="button" id="undo-button">Undo</button>', 'Deleted', { timeOut: 1200, extendedTimeOut: 1200, escapeHtml: false });
    });
    await expect(toast(page, 'Deleted'), 'the toast with a button shows at once').toBeVisible({ timeout: 700 });
    await expect(toast(page, 'First'), 'the first toast is pushed back and hidden').toBeHidden({ timeout: 1500 });
    await expect(toast(page, 'First')).toHaveCount(1);
    await expect(toast(page, 'Deleted')).toHaveCount(0, { timeout: 4000 });
    await expect(toast(page, 'First'), 'the pushed back toast comes back before the toast that waited').toBeVisible({ timeout: 2000 });
    await expect(toast(page, 'Second')).toBeHidden();
});

test('a toast shows over 300ms, and over 500ms when it takes the place of one that is leaving', async ({ page }) => {
    const durations = await page.evaluate(async () => {
        const durationOf = node => node.getAnimations()
            .map(animation => animation.effect.getTiming().duration)
            .filter(duration => duration === 300 || duration === 500);
        const first = window.toastr.info('First message', 'First', { timeOut: 800, extendedTimeOut: 800 });
        const second = window.toastr.info('Second message', 'Second', { timeOut: 800, extendedTimeOut: 800 });
        const firstShow = durationOf(first[0]);
        await new Promise((resolve) => {
            const watch = () => (first[0].classList.contains('sb-toast-leaving') ? resolve() : requestAnimationFrame(watch));
            watch();
        });
        const secondShow = durationOf(second[0]);
        return { firstShow, secondShow, firstLeaving: first[0].classList.contains('sb-toast-leaving') };
    });
    expect(durations.firstShow, 'a toast with nothing leaving shows over 300ms').toContain(300);
    expect(durations.firstShow).not.toContain(500);
    expect(durations.firstLeaving).toBe(true);
    expect(durations.secondShow, 'the replacement shows over 500ms').toContain(500);
});

test('a toast that waits starts its timeout when it shows, not when it is made', async ({ page }) => {
    const times = await page.evaluate(async () => {
        const started = performance.now();
        window.toastr.info('First message', 'First', { timeOut: 700, extendedTimeOut: 700 });
        const second = window.toastr.info('Second message', 'Second', { timeOut: 700, extendedTimeOut: 700 });
        let shownAt = null;
        let goneAt = null;
        await new Promise((resolve) => {
            const watch = () => {
                const now = performance.now() - started;
                if (shownAt === null && second[0].style.display !== 'none') shownAt = now;
                if (shownAt !== null && !second[0].isConnected) {
                    goneAt = now;
                    resolve();
                    return;
                }
                requestAnimationFrame(watch);
            };
            watch();
        });
        return { shownAt, goneAt };
    });
    expect(times.shownAt, 'shows when the first hides, 700ms + its hide').toBeGreaterThanOrEqual(650);
    expect(times.goneAt - times.shownAt, 'stays about its own 700ms before it hides over 300ms').toBeGreaterThanOrEqual(900);
});

test('many errors at once are all kept, ahead of the notices that were waiting', async ({ page }) => {
    const order = await page.evaluate(async () => {
        const { getToastQueue } = await import('/scripts/sillybunny-toast-motion.js');
        window.toastr.info('Now showing', 'Showing', { timeOut: 30000, extendedTimeOut: 30000 });
        for (let index = 0; index < 8; index += 1) window.toastr.info(`Notice ${index}`, `Notice ${index}`, { timeOut: 30000, extendedTimeOut: 30000 });
        for (let index = 0; index < 5; index += 1) window.toastr.error(`Error ${index}`, `Error ${index}`, { timeOut: 30000, extendedTimeOut: 30000 });
        window.toastr.error('Error 0', 'Error 0', { timeOut: 30000, extendedTimeOut: 30000 });
        return getToastQueue().waiting.map(node => node.querySelector('.toast-title')?.textContent);
    });
    const waitingErrors = order.filter(title => title.startsWith('Error'));
    expect(waitingErrors, 'five different errors, the repeat of the first is not queued twice').toHaveLength(5);
    expect(order.slice(0, 5), 'the errors are the first to show after the current toast').toEqual(waitingErrors);
    expect(order.filter(title => title.startsWith('Notice')).length, 'the oldest notices were dropped').toBeLessThanOrEqual(6);
});
