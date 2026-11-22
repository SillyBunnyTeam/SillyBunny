import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_FORM_SELECTOR } from './helpers/toasts.js';

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
});

// The queue of the toast form: a plain message with no title. A message with a title is an in-app notification, which has a queue of its own.
const toast = (page, text) => page.locator(TOAST_FORM_SELECTOR, { has: page.locator('.toast-message', { hasText: text }) });

test('a second toast waits behind the first and shows when the first has gone', async ({ page }) => {
    await page.evaluate(() => {
        window.toastr.info('First message', '', { timeOut: 900, extendedTimeOut: 900 });
        window.toastr.info('Second message', '', { timeOut: 900, extendedTimeOut: 900 });
    });
    await expect(toast(page, 'First')).toBeVisible();
    await expect(toast(page, 'Second'), 'the second toast is in the page, but hidden').toBeHidden();
    await expect(toast(page, 'Second')).toHaveCount(1);
    await expect(toast(page, 'Second'), 'it shows once the first hides').toBeVisible({ timeout: 4000 });
    await expect(toast(page, 'First')).toHaveCount(0, { timeout: 2000 });
    await expect(toast(page, 'Second'), 'it goes after its own timeout').toHaveCount(0, { timeout: 4000 });
});

test('the app listener still hears a queued toast: it is a tap target when it shows', async ({ page }) => {
    await page.evaluate(() => {
        window.toastr.info('First message', '', { timeOut: 700, extendedTimeOut: 700 });
        window.toastr.info('Second message', '', { timeOut: 5000, extendedTimeOut: 5000 });
    });
    await expect(toast(page, 'Second')).toBeVisible({ timeout: 4000 });
    await expect(toast(page, 'Second')).toHaveAttribute('title', /.+/);
    await expect(toast(page, 'Second')).toHaveClass(/interactable/);
});

test('a toast with a button shows at once and the shown toast waits at the head of the queue', async ({ page }) => {
    await page.evaluate(() => {
        window.toastr.info('First message', '', { timeOut: 5000, extendedTimeOut: 5000 });
        window.toastr.info('Second message', '', { timeOut: 5000, extendedTimeOut: 5000 });
    });
    await expect(toast(page, 'First')).toBeVisible();
    await page.evaluate(() => {
        window.toastr.info('<button type="button" id="undo-button">Undo</button>', '', { timeOut: 1200, extendedTimeOut: 1200, escapeHtml: false });
    });
    const undo = page.locator(TOAST_FORM_SELECTOR, { has: page.locator('#undo-button') });
    await expect(undo, 'the toast with a button shows at once').toBeVisible({ timeout: 700 });
    await expect(toast(page, 'First'), 'the first toast is pushed back and hidden').toBeHidden({ timeout: 1500 });
    await expect(toast(page, 'First')).toHaveCount(1);
    await expect(undo).toHaveCount(0, { timeout: 4000 });
    await expect(toast(page, 'First'), 'the pushed back toast comes back before the toast that waited').toBeVisible({ timeout: 2000 });
    await expect(toast(page, 'Second')).toBeHidden();
});

test('a toast shows over 300ms, and over 500ms when it takes the place of one that is leaving', async ({ page }) => {
    const durations = await page.evaluate(async () => {
        const durationOf = node => node.getAnimations()
            .map(animation => animation.effect.getTiming().duration)
            .filter(duration => duration === 300 || duration === 500);
        const first = window.toastr.info('First message', '', { timeOut: 800, extendedTimeOut: 800 });
        const second = window.toastr.info('Second message', '', { timeOut: 800, extendedTimeOut: 800 });
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
        window.toastr.info('First message', '', { timeOut: 700, extendedTimeOut: 700 });
        const second = window.toastr.info('Second message', '', { timeOut: 700, extendedTimeOut: 700 });
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
        window.toastr.info('Now showing', '', { timeOut: 30000, extendedTimeOut: 30000 });
        for (let index = 0; index < 8; index += 1) window.toastr.info(`Notice ${index}`, '', { timeOut: 30000, extendedTimeOut: 30000 });
        for (let index = 0; index < 5; index += 1) window.toastr.error(`Error ${index}`, '', { timeOut: 30000, extendedTimeOut: 30000 });
        window.toastr.error('Error 0', '', { timeOut: 30000, extendedTimeOut: 30000 });
        return getToastQueue().waiting.map(node => node.querySelector('.toast-message')?.textContent);
    });
    const waitingErrors = order.filter(title => title.startsWith('Error'));
    expect(waitingErrors, 'five different errors, the repeat of the first is not queued twice').toHaveLength(5);
    expect(order.slice(0, 5), 'the errors are the first to show after the current toast').toEqual(waitingErrors);
    expect(order.filter(title => title.startsWith('Notice')).length, 'the oldest notices were dropped').toBeLessThanOrEqual(6);
});

test.describe('with a finger', () => {
    test.use({ hasTouch: true });

    test('a toast with a button stays while the finger is on it, and goes after the finger lifts', async ({ page }) => {
        await page.evaluate(() => {
            const body = document.createElement('div');
            body.textContent = 'Removed';
            const action = document.createElement('button');
            action.className = 'menu_button';
            action.textContent = 'Undo';
            body.append(action);
            window.toastr.info(body, '', { timeOut: 700, extendedTimeOut: 700, escapeHtml: false });
        });
        const held = page.locator(TOAST_FORM_SELECTOR, { hasText: 'Removed' });
        await expect(held).toBeVisible();
        const box = await held.locator('button').boundingBox();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await page.waitForTimeout(2000);
        await expect(held, 'the press holds the toast past its timeout').toBeVisible();
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(held, 'it goes once the press ends').toHaveCount(0, { timeout: 4000 });
    });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`a toast's button sits at the end of the title line at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.evaluate(() => {
            window.toastr.info('<div>Removed Main Prompt <button type="button" class="menu_button" id="toast-action">Undo</button></div>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false });
            window.toastr.info('A plain toast', '', { timeOut: 0, extendedTimeOut: 0 });
        });
        const action = page.locator('#toast-action');
        const withButton = page.locator(TOAST_FORM_SELECTOR, { has: action });
        await expect(action).toBeVisible();
        const layout = await page.evaluate(() => {
            const button = document.getElementById('toast-action').getBoundingClientRect();
            const body = document.getElementById('toast-action').parentElement;
            const range = document.createRange();
            range.selectNodeContents(body.firstChild);
            const text = range.getBoundingClientRect();
            const toastBox = document.getElementById('toast-action').closest('.toast').getBoundingClientRect();
            return { buttonTop: button.top, buttonBottom: button.bottom, buttonLeft: button.left, buttonRight: button.right, textTop: text.top, textBottom: text.bottom, textRight: text.right, toastRight: toastBox.right, toastBottom: toastBox.bottom, toastTop: toastBox.top };
        });
        expect(layout.buttonTop, 'the button is not below the text').toBeLessThan(layout.textBottom);
        expect(layout.buttonLeft, 'the button is after the text').toBeGreaterThanOrEqual(layout.textRight - 1);
        expect(Math.abs((layout.buttonTop + layout.buttonBottom) / 2 - (layout.textTop + layout.textBottom) / 2), 'the button and the text share a centre line').toBeLessThan(4);
        expect(layout.buttonRight).toBeLessThanOrEqual(layout.toastRight);
        expect(layout.toastBottom - layout.toastTop, 'the toast is one line high plus its padding').toBeLessThan(layout.buttonBottom - layout.buttonTop + 24);
        await expect(withButton).toBeVisible();
    });
}

test('a toast without a button keeps its block layout', async ({ page }) => {
    await page.evaluate(() => window.toastr.info('A plain toast', '', { timeOut: 0, extendedTimeOut: 0 }));
    await expect(toast(page, 'A plain toast')).toBeVisible();
    expect(await toast(page, 'A plain toast').evaluate(node => getComputedStyle(node).display)).toBe('block');
});

test('a message with two buttons is an in-app notification, and keeps its block layout so the buttons do not share a cell', async ({ page }) => {
    await page.evaluate(() => window.toastr.info('<div>Unsaved changes</div><div><button type="button" id="first-action">Restore</button><button type="button" id="second-action">Discard</button></div>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false }));
    await expect(page.locator('#first-action')).toBeVisible();
    expect(await page.locator(NOTIFICATION_FORM_SELECTOR).first().evaluate(node => getComputedStyle(node).display)).toBe('block');
    await page.locator('#second-action').click({ trial: true });
    await page.locator('#first-action').click({ trial: true });
});
