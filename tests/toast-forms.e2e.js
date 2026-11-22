import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_CONTAINERS, TOAST_FORM_SELECTOR, TOAST_SELECTOR } from './helpers/toasts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/toast-forms-fixture.js', import.meta.url));

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
    await page.addScriptTag({ content: await readFile(FIXTURE, 'utf8') });
});

/** Runs one fixture function in the page. */
const fire = (page, name, ...args) => page.evaluate(([fixtureName, fixtureArgs]) => window.__toastForms[fixtureName](...fixtureArgs), [name, args]);
const calls = page => page.evaluate(() => [...window.__toastFormsCalls]);

test.describe('which form a message takes, and where it shows', () => {
    test('a plain message is a toast in #sb-toast-overlay at the bottom, and a titled one a notification in #toast-container at the top, at once', async ({ page }) => {
        const toast = await fire(page, 'plain', 'success', 'Saved', '', { timeOut: 0, extendedTimeOut: 0 });
        const notification = await fire(page, 'plain', 'success', 'Saved the chat', 'Chat', { timeOut: 0, extendedTimeOut: 0 });

        expect(toast).toMatchObject({ form: 'toast', containerId: 'sb-toast-overlay' });
        expect(toast.containerClass).toContain('toast-bottom-center');
        expect(notification).toMatchObject({ form: 'notification', containerId: 'toast-container', title: 'Chat' });

        const shownToast = page.locator(TOAST_FORM_SELECTOR);
        const shownNotification = page.locator(NOTIFICATION_FORM_SELECTOR);
        await expect(shownToast).toBeVisible();
        await expect(shownNotification).toBeVisible();
        const viewport = page.viewportSize();
        const toastBox = await shownToast.boundingBox();
        const notificationBox = await shownNotification.boundingBox();
        expect(toastBox.y + toastBox.height, 'the toast sits at the bottom, 24px above the edge').toBeGreaterThan(viewport.height - 80);
        expect(notificationBox.y + notificationBox.height, 'the notification sits at the top').toBeLessThan(viewport.height / 2);
        await expect(shownToast.locator('.toast-message')).toHaveText('Saved');
    });

    test('a toast and a notification are both announced as status messages', async ({ page }) => {
        await fire(page, 'plain', 'info', 'A toast', '', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'plain', 'info', 'A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        await expect(page.locator(TOAST_FORM_SELECTOR)).toHaveAttribute('role', 'status');
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR)).toHaveAttribute('role', 'status');
    });

    test('a click action, several buttons and several blocks make a notification, and one button keeps a toast', async ({ page }) => {
        expect(await fire(page, 'onclick')).toMatchObject({ form: 'notification' });
        expect(await fire(page, 'severalButtons')).toMatchObject({ form: 'notification' });
        expect(await fire(page, 'linkLine')).toMatchObject({ form: 'notification', title: 'STMemoryBooks' });
        expect(await fire(page, 'oneButton')).toMatchObject({ form: 'toast' });
    });

    test('the 34em limit is measured, and the same message takes the same form in a wide and in a narrow window', async ({ page }) => {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            const under = await fire(page, 'messageNearLimit', -8);
            const over = await fire(page, 'messageNearLimit', 8);
            const forms = await page.evaluate(([underText, overText]) => ({
                under: window.toastr.info(underText, '', { timeOut: 0, extendedTimeOut: 0 })[0].className.match(/sb-form-\w+/)?.[0],
                over: window.toastr.info(overText, '', { timeOut: 0, extendedTimeOut: 0 })[0].className.match(/sb-form-\w+/)?.[0],
            }), [under.text, over.text]);
            expect(forms, `at ${viewport.width}px, ${under.width}px and ${over.width}px of text against 34em = ${34 * under.fontSize}px with ${under.padding}px of padding`).toEqual({ under: 'sb-form-toast', over: 'sb-form-notification' });
            await fire(page, 'clearAll');
            await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0, { timeout: 3000 });
        }
    });
});

test.describe('the content and the callbacks of the message', () => {
    test('a toast with one button keeps its markup, and the button works', async ({ page }) => {
        const toast = await fire(page, 'oneButton');
        expect(toast.html).toBe('<span>Removed Main Prompt</span> <button type="button" class="menu_button" id="fx-undo">Undo</button>');
        await page.locator(`${TOAST_FORM_SELECTOR} #fx-undo`).click();
        expect(await calls(page)).toEqual(['undo']);
    });

    test('a notification with several buttons keeps its markup, and each button works', async ({ page }) => {
        const toast = await fire(page, 'severalButtons');
        expect(toast.html).toBe('<div>Unsaved changes</div><div><button type="button" id="fx-restore">Restore</button><button type="button" id="fx-discard">Discard</button></div>');
        await page.locator(`${NOTIFICATION_FORM_SELECTOR} #fx-restore`).click();
        await page.locator(`${NOTIFICATION_FORM_SELECTOR} #fx-discard`).click();
        expect(await calls(page)).toEqual(['restore', 'discard']);
    });

    test('a link in a message with tapToDismiss off runs its handler and leaves the notification on screen', async ({ page }) => {
        await fire(page, 'linkLine');
        const notification = page.locator(NOTIFICATION_FORM_SELECTOR);
        await expect(notification).toHaveClass(/toast-non-interactable/);
        await notification.locator('.fx-raw-link').click();
        expect(await calls(page)).toEqual(['link']);
        await expect(notification).toBeVisible();
    });

    test('onclick runs once when the notification is clicked, and the notification goes', async ({ page }) => {
        await fire(page, 'onclick');
        const notification = page.locator(NOTIFICATION_FORM_SELECTOR);
        await notification.click();
        await expect(notification).toHaveCount(0, { timeout: 3000 });
        expect(await calls(page)).toEqual(['onclick']);
    });

    test('tapToDismiss false keeps both forms on screen when they are clicked', async ({ page }) => {
        const toast = await fire(page, 'tapToDismissOff', '');
        const notification = await fire(page, 'tapToDismissOff', 'Title');
        expect(toast.form).toBe('toast');
        expect(notification.form).toBe('notification');
        for (const selector of [TOAST_FORM_SELECTOR, NOTIFICATION_FORM_SELECTOR]) {
            const element = page.locator(selector);
            await expect(element).toHaveClass(/toast-non-interactable/);
            await element.click();
            await page.waitForTimeout(800);
            await expect(element).toBeVisible();
        }
    });

    test('preventDuplicates returns nothing for the repeat, and one toast is on screen', async ({ page }) => {
        const result = await fire(page, 'preventDuplicates');
        expect(result.secondIsUndefined).toBe(true);
        expect(result.first.form).toBe('toast');
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(1);
    });

    test('a reader of .toast-message straight after the call sees the content, and a clone of the element stays a toast', async ({ page }) => {
        const toast = await fire(page, 'readerRightAfterTheCall', '<b>Bold</b> text', '');
        expect(toast).toEqual({ read: '<b>Bold</b> text', cloneIsToast: true, form: 'toast' });
        const titled = await fire(page, 'readerRightAfterTheCall', 'Details', 'Title');
        expect(titled).toEqual({ read: 'Details', cloneIsToast: true, form: 'notification' });
    });

    test('a class that /echo adds stays on the element in its container', async ({ page }) => {
        const echoed = await fire(page, 'echoWithClass');
        expect(echoed.classes).toContain('fx-echo-class');
        await expect(page.locator(`${TOAST_FORM_SELECTOR}.fx-echo-class`)).toBeVisible();
    });
});

test.describe('progress toasts that change after they show', () => {
    test('a titled progress toast, hidden, shown and edited in place, stays a notification with the new text', async ({ page }) => {
        const progress = await fire(page, 'progressTitled');
        expect(progress).toMatchObject({ form: 'notification', containerId: 'toast-container' });
        const notification = page.locator(NOTIFICATION_FORM_SELECTOR);
        await expect(notification.locator('.toast-message')).toHaveText('Loading 40%');
        await expect(notification).toBeVisible();
        await fire(page, 'hideProgress');
        await expect(notification).toBeHidden();
        await fire(page, 'showProgress');
        await expect(notification).toBeVisible();
    });

    test('a toast whose text grows far past one line keeps its form and wraps', async ({ page }) => {
        const before = await fire(page, 'progressUntitled');
        expect(before.form).toBe('toast');
        const toast = page.locator(TOAST_FORM_SELECTOR);
        const oneLine = (await toast.boundingBox()).height;
        const after = await fire(page, 'growProgress', 'A message that grows while it shows. '.repeat(30));
        expect(after).toMatchObject({ form: 'toast', containerId: 'sb-toast-overlay' });
        await expect(toast).toBeVisible();
        expect((await toast.boundingBox()).height, 'the toast wraps').toBeGreaterThan(oneLine * 1.5);
    });
});

test.describe('taps on a message', () => {
    test('a tap on a toast or on a notification does not close an open drawer that is not pinned, and a tap on the page does', async ({ page }) => {
        await page.evaluate(() => {
            const drawer = document.createElement('div');
            drawer.id = 'fx-drawer';
            drawer.className = 'openDrawer';
            document.body.append(drawer);
        });
        await fire(page, 'tapToDismissOff', '');
        await fire(page, 'tapToDismissOff', 'Title');
        const drawer = page.locator('#fx-drawer');

        await page.locator(TOAST_FORM_SELECTOR).click();
        await expect(drawer, 'a tap on a toast leaves the drawer').toHaveClass(/openDrawer/);
        await page.locator(NOTIFICATION_FORM_SELECTOR).click();
        await expect(drawer, 'a tap on a notification leaves the drawer').toHaveClass(/openDrawer/);

        await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
        await expect(drawer, 'a tap on the page closes it').toHaveClass(/closedDrawer/);
    });
});

test.describe('progress bars', () => {
    for (const [form, title] of [['toast', ''], ['notification', 'Title']]) {
        test(`the progress bar of a ${form} runs down while it shows`, async ({ page }) => {
            await page.evaluate(([titleText]) => window.toastr.info('Saved', titleText, { progressBar: true, timeOut: 6000, extendedTimeOut: 6000 }), [title]);
            const bar = page.locator(`${form === 'toast' ? TOAST_FORM_SELECTOR : NOTIFICATION_FORM_SELECTOR} .toast-progress`);
            const width = () => bar.evaluate(node => node.getBoundingClientRect().width);
            await expect(bar).toHaveCount(1);
            const start = await width();
            expect(start, 'it starts across the toast').toBeGreaterThan(20);
            await expect.poll(width, { timeout: 4000 }).toBeLessThan(start * 0.75);
        });
    }
});

test.describe('extensions that write the options of toastr', () => {
    test('a position class, container id or target in the global options moves and merges nothing', async ({ page }) => {
        const result = await page.evaluate(() => window.__toastForms.withGlobalWrites({ positionClass: 'toast-top-left', containerId: 'ext-container', target: '#nowhere' }, { toast: 'A toast', notification: 'A notification' }));
        expect(result.toast).toMatchObject({ form: 'toast', containerId: 'sb-toast-overlay' });
        expect(result.toast.containerClass).toBe('toast-bottom-center');
        expect(result.notification).toMatchObject({ form: 'notification', containerId: 'toast-container' });
        expect(result.notification.containerClass).not.toContain('toast-top-left');
        await expect(page.locator('#ext-container')).toHaveCount(0);
        await expect(page.locator('#sb-toast-overlay')).toHaveCount(1);
        await expect(page.locator('#toast-container')).toHaveCount(1);
    });

    test('a position class, container id or target in a call moves and merges nothing', async ({ page }) => {
        const result = await fire(page, 'withCallOptions', { positionClass: 'toast-top-left', containerId: 'ext-container', target: '#nowhere' });
        expect(result.toast).toMatchObject({ form: 'toast', containerId: 'sb-toast-overlay' });
        expect(result.toast.containerClass).toBe('toast-bottom-center');
        expect(result.notification).toMatchObject({ form: 'notification', containerId: 'toast-container' });
        await expect(page.locator('#ext-container')).toHaveCount(0);
    });

    test('a toastClass that hides every toast keeps working: the toast stays hidden, shows on its own timer and holds nothing back', async ({ page }) => {
        await fire(page, 'hideByClass', true);
        await page.evaluate(() => window.toastr.info('Moving entries', '', { timeOut: 1500, extendedTimeOut: 1500 }));
        const hidden = page.locator(`${TOAST_CONTAINERS} > .displayNone`);
        await expect(hidden).toHaveCount(1);
        expect(await hidden.evaluate(node => getComputedStyle(node).display)).toBe('none');
        expect(await page.evaluate(async () => (await import('/scripts/sillybunny-toast-motion.js')).getToastQueue().current)).toBeNull();

        // The extension's own toasts name `toast` as their class, and show at once.
        await page.evaluate(() => window.toastr.info('Done moving', '', { toastClass: 'toast', timeOut: 0, extendedTimeOut: 0 }));
        await expect(page.locator(TOAST_FORM_SELECTOR, { hasText: 'Done moving' })).toBeVisible();
        await expect(hidden, 'the hidden toast goes after its own timeout').toHaveCount(0, { timeout: 5000 });
        await fire(page, 'hideByClass', false);
    });

    test('a wrapper installed afterwards that returns null breaks no toast', async ({ page }) => {
        await fire(page, 'installNullWrapper');
        expect(await page.evaluate(() => window.toastr.info('A toast', '', { timeOut: 0, extendedTimeOut: 0 }))).toBeNull();
        expect(await page.evaluate(() => window.toastr.info('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 }))).toBeNull();
        await fire(page, 'removeNullWrapper');
        await expect(page.locator(TOAST_FORM_SELECTOR, { hasText: 'A toast' })).toBeVisible();
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR, { hasText: 'A notification' })).toBeVisible();
    });
});

test.describe('dialogs that are not Popups', () => {
    /** Both messages are in the dialog, above it, and they are still on screen in the page after it closes. */
    async function expectMessagesFollowTheDialog(page, { open, close }) {
        await fire(page, 'plain', 'info', 'A toast over the dialog', '', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'plain', 'info', 'A notification over the dialog', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        await open();
        await expect(page.locator('dialog[open] > #sb-toast-overlay')).toHaveCount(1);
        await expect(page.locator('dialog[open] > #toast-container')).toHaveCount(1);
        // A trial click needs the message to be the element at its point, so a message under the modal fails here.
        await page.locator(TOAST_FORM_SELECTOR).click({ trial: true });
        await page.locator(NOTIFICATION_FORM_SELECTOR).click({ trial: true });

        await close();
        await expect(page.locator('body > #sb-toast-overlay')).toHaveCount(1);
        await expect(page.locator('body > #toast-container')).toHaveCount(1);
        await expect(page.locator(TOAST_FORM_SELECTOR)).toBeVisible();
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR)).toBeVisible();
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(2);
    }

    test('a dialog host of openDialog keeps the messages above it, and gives them back when it closes', async ({ page }) => {
        await expectMessagesFollowTheDialog(page, {
            open: () => fire(page, 'openFrame'),
            close: () => fire(page, 'closeFrame'),
        });
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });

    test('an alert keeps the messages above it, and gives them back when its response closes it', async ({ page }) => {
        await expectMessagesFollowTheDialog(page, {
            open: () => fire(page, 'openAlertFrame'),
            // The toast sits at the bottom of the alert, over its responses, so the alert is closed with the keyboard.
            close: () => page.keyboard.press('Escape'),
        });
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });

    test('a modal dialog of an extension that closes and removes itself in one task loses no message', async ({ page }) => {
        await expectMessagesFollowTheDialog(page, {
            open: () => fire(page, 'openRawModal'),
            close: () => fire(page, 'closeRawModal'),
        });
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });

    test('messages raised while such a dialog is open are above it too, and survive it', async ({ page }) => {
        await fire(page, 'openRawModal');
        await fire(page, 'plain', 'info', 'A toast in the dialog', '', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'plain', 'info', 'A notification in the dialog', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        await expect(page.locator('dialog[open] > #sb-toast-overlay')).toHaveCount(1);
        await expect(page.locator('dialog[open] > #toast-container')).toHaveCount(1);
        await page.locator(TOAST_FORM_SELECTOR).click({ trial: true });
        await page.locator(NOTIFICATION_FORM_SELECTOR).click({ trial: true });

        await fire(page, 'closeRawModal');
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(2);
        await expect(page.locator(TOAST_FORM_SELECTOR)).toBeVisible();
        await fire(page, 'plain', 'info', 'A toast after the dialog', '', { timeOut: 0, extendedTimeOut: 0 });
        await expect(page.locator('body > #sb-toast-overlay > .toast')).toHaveCount(2);
    });
});

test.describe('clear, remove and dialogs', () => {
    test('toastr.clear() clears both containers, and toastr.remove() does too, and the empty containers go', async ({ page }) => {
        await fire(page, 'plain', 'info', 'A toast', '', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'plain', 'info', 'A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(2);
        await fire(page, 'clearAll');
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0, { timeout: 3000 });
        await expect(page.locator('#sb-toast-overlay')).toHaveCount(0);
        await expect(page.locator('#toast-container')).toHaveCount(0);

        await fire(page, 'plain', 'info', 'A toast', '', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'plain', 'info', 'A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'removeAll');
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0);
        await expect(page.locator('#sb-toast-overlay')).toHaveCount(0);
    });

    test('a toast shows inside the open dialog, and the overlay returns to the page when the dialog closes', async ({ page }) => {
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.__popup = new Popup('<p>A dialog</p>', POPUP_TYPE.TEXT, '');
            void window.__popup.show();
        });
        await expect(page.locator('dialog[open]')).toHaveCount(1);
        await fire(page, 'plain', 'info', 'A toast over the dialog', '', { timeOut: 0, extendedTimeOut: 0 });
        await fire(page, 'plain', 'info', 'A notification over the dialog', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        await expect(page.locator('dialog[open] > #sb-toast-overlay')).toHaveCount(1);
        await expect(page.locator('dialog[open] > #toast-container')).toHaveCount(1);
        await expect(page.locator(TOAST_FORM_SELECTOR)).toBeVisible();
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR)).toBeVisible();

        await page.evaluate(() => window.__popup.completeCancelled());
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await expect(page.locator('body > #sb-toast-overlay')).toHaveCount(1);
        await expect(page.locator('body > #toast-container')).toHaveCount(1);
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(2);
    });
});
