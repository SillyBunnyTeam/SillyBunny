import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_FORM_SELECTOR, TOAST_SELECTOR } from './helpers/toasts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/toast-forms-fixture.js', import.meta.url));

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
    await page.evaluate(() => window.toastr.clear());
    await page.addScriptTag({ content: await readFile(FIXTURE, 'utf8') });
});

const STAY = { timeOut: 0, extendedTimeOut: 0 };

/** Shows a toast that stays, and waits until it has slid in. */
async function showToast(page, kind, message, options = STAY) {
    await page.evaluate(([toastKind, text, toastOptions]) => window.toastr[toastKind](text, '', toastOptions), [kind, message, options]);
    const toast = page.locator(TOAST_FORM_SELECTOR, { hasText: message });
    await expect(toast).toBeVisible();
    await expect.poll(() => toast.evaluate(node => node.getAnimations().length)).toBe(0);
    return toast;
}

/** Waits until no message of either form is sliding, so that a box that is read is the one it rests at. */
const settled = page => expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#sb-toast-overlay > .toast, #toast-container > .toast')]
    .reduce((count, node) => count + node.getAnimations().filter(animation => animation.playState !== 'finished').length, 0))).toBe(0);

const boxOf = locator => locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
});

test.describe('the parts of a toast', () => {
    test('are a status glyph, the label, one button and the close button, in that order, and an info toast has no glyph', async ({ page }) => {
        await page.evaluate(() => window.toastr.error('<span>Could not remove it</span> <button type="button" class="menu_button" id="fx-retry">Retry</button>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false }));
        const toast = page.locator(TOAST_FORM_SELECTOR);
        await expect(toast).toBeVisible();
        await expect.poll(() => toast.evaluate(node => node.getAnimations().length)).toBe(0);

        const parts = await toast.evaluate((node) => {
            const glyph = getComputedStyle(node, '::before');
            const box = element => element.getBoundingClientRect();
            const label = node.querySelector('.toast-message');
            const action = node.querySelector('#fx-retry');
            const close = node.querySelector('.toast-close-button');
            return {
                glyphContent: glyph.content,
                glyphFont: glyph.fontFamily,
                glyphRight: node.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(node).paddingLeft) + 6 + Number.parseFloat(glyph.width),
                labelLeft: box(label).left,
                labelWeight: getComputedStyle(label).fontWeight,
                actionLeft: box(action).left,
                actionRight: box(action).right,
                closeLeft: box(close).left,
                closeRight: box(close).right,
                toastRight: node.getBoundingClientRect().right,
                lastChild: node.lastElementChild === close,
            };
        });
        expect(parts.glyphContent, 'an error has a glyph').not.toBe('none');
        expect(parts.glyphFont).toContain('Font Awesome');
        expect(parts.labelLeft, 'the label follows the glyph').toBeGreaterThanOrEqual(parts.glyphRight);
        expect(parts.actionLeft, 'the button follows the label').toBeGreaterThan(parts.labelLeft);
        expect(parts.closeLeft, 'the close button follows the button').toBeGreaterThanOrEqual(parts.actionRight);
        expect(parts.toastRight - parts.closeRight, '6px padding and 6px margin at the end').toBeCloseTo(12, 0);
        expect(Number(parts.labelWeight), 'the label is bold').toBeGreaterThanOrEqual(700);
        expect(parts.lastChild, 'the close button is last in the document too, so Tab follows what is drawn').toBe(true);

        await page.evaluate(() => window.toastr.clear());
        const info = await showToast(page, 'info', 'Nothing to report');
        expect(await info.evaluate(node => getComputedStyle(node, '::before').content), 'an info toast has no glyph').toBe('none');
        const start = await info.evaluate(node => node.querySelector('.toast-message').getBoundingClientRect().left - node.getBoundingClientRect().left);
        expect(start, '12px of padding and 6px of margin before the label').toBeCloseTo(18, 0);
    });

    test('have a close button that is round and flat, named Dismiss, with the tooltip Dismiss', async ({ page }) => {
        const toast = await showToast(page, 'success', 'Saved');
        const close = toast.getByRole('button', { name: 'Dismiss', exact: true });
        await expect(close).toHaveCount(1);
        await expect(close).toHaveAttribute('title', 'Dismiss');
        const look = await close.evaluate((node) => {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height, background: style.backgroundColor, radius: Number.parseFloat(style.borderTopLeftRadius), icon: node.querySelector('i.fa-xmark') !== null };
        });
        expect(look.width).toBeCloseTo(34, 0);
        expect(look.height).toBeCloseTo(34, 0);
        expect(look.radius, 'round').toBeGreaterThanOrEqual(17);
        expect(look.background, 'flat').toBe('rgba(0, 0, 0, 0)');
        expect(look.icon).toBe(true);
    });

    test('are one line of 46px at the pill radius, with no PNG icon, no border and the toast shadow', async ({ page }) => {
        for (const kind of ['error', 'warning', 'success', 'info']) {
            const toast = await showToast(page, kind, `A ${kind} toast`);
            const look = await toast.evaluate((node) => {
                const style = getComputedStyle(node);
                const box = node.getBoundingClientRect();
                return { height: box.height, radius: Number.parseFloat(style.borderTopLeftRadius), image: style.backgroundImage, border: style.borderTopWidth, shadow: style.boxShadow };
            });
            expect(look.height, `${kind} is one line high`).toBeCloseTo(46, 0);
            expect(look.radius, `${kind} is a pill`).toBeGreaterThanOrEqual(look.height / 2);
            expect(look.image).toBe('none');
            expect(look.border).toBe('0px');
            expect(look.shadow).not.toBe('none');
            await page.evaluate(() => window.toastr.clear());
            await expect(toast).toHaveCount(0);
        }
    });

    test('gain a 1px ring at the border strength under more contrast', async ({ page, browserName }) => {
        test.skip(browserName === 'firefox', 'Playwright cannot emulate prefers-contrast in Firefox');
        await page.emulateMedia({ contrast: 'more' });
        const toast = await showToast(page, 'info', 'A toast');
        const ring = await toast.evaluate(node => ({ width: getComputedStyle(node).outlineWidth, style: getComputedStyle(node).outlineStyle }));
        expect(ring).toEqual({ width: '1px', style: 'solid' });
    });
});

test.describe('taps and buttons', () => {
    test('a tap on a toast does nothing, and the close button, the button and nothing else dismiss it', async ({ page }) => {
        const toast = await showToast(page, 'info', 'Tap me');
        await toast.locator('.toast-message').click();
        await toast.click({ position: { x: 20, y: 23 } });
        // Nothing is expected to happen, so there is no event to wait for: the toast has to survive a moment.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(700);
        await expect(toast, 'a tap leaves the toast').toBeVisible();
        expect(await toast.evaluate(node => ({ title: node.getAttribute('title'), interactable: node.classList.contains('interactable'), cursor: getComputedStyle(node).cursor })), 'no tap hint')
            .toEqual({ title: null, interactable: false, cursor: 'default' });

        await toast.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(toast).toHaveCount(0, { timeout: 3000 });
    });

    test('a toast with a button runs the action once, and the toast goes', async ({ page }) => {
        await page.evaluate(() => {
            window.__undone = 0;
            window.toastr.info('<span>Removed the prompt</span> <button type="button" class="menu_button" id="fx-undo">Undo</button>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false });
            document.getElementById('fx-undo').addEventListener('click', () => { window.__undone += 1; });
        });
        const toast = page.locator(TOAST_FORM_SELECTOR);
        await expect(toast).toBeVisible();
        await toast.locator('#fx-undo').click();
        await expect(toast).toHaveCount(0, { timeout: 3000 });
        expect(await page.evaluate(() => window.__undone)).toBe(1);
    });

    test('a click on an in-app notification still dismisses it, and its close button works', async ({ page }) => {
        await page.evaluate(() => {
            window.toastr.info('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 });
            window.toastr.warning('Another', 'Title', { timeOut: 0, extendedTimeOut: 0 });
        });
        const notifications = page.locator(NOTIFICATION_FORM_SELECTOR);
        await expect(notifications).toHaveCount(2);
        await notifications.first().getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(notifications).toHaveCount(1, { timeout: 3000 });
        await notifications.first().click({ position: { x: 60, y: 8 } });
        await expect(notifications).toHaveCount(0, { timeout: 3000 });
    });
});

test.describe('keyboard focus', () => {
    /** Moves focus the way a keyboard does, so that the browser treats it as keyboard focus. */
    async function focusByKeyboard(page, locator) {
        await page.keyboard.press('Tab');
        await locator.focus();
        expect(await locator.evaluate(node => node.matches(':focus-visible')), 'the focus is keyboard focus').toBe(true);
    }

    const ringOf = locator => locator.evaluate((node) => {
        const style = getComputedStyle(node);
        return { shadow: style.boxShadow, outline: style.outlineStyle };
    });

    test('the button of a toast and Dismiss show the focus ring of the app, in a visible colour', async ({ page }) => {
        await page.evaluate(() => window.toastr.info('<span>Removed the prompt</span> <button type="button" class="menu_button" id="fx-undo">Undo</button>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false }));
        const toast = page.locator(TOAST_FORM_SELECTOR);
        await expect(toast).toBeVisible();
        await settled(page);
        for (const control of [toast.locator('#fx-undo'), toast.getByRole('button', { name: 'Dismiss', exact: true })]) {
            await focusByKeyboard(page, control);
            // The ring fades in with the control's transition, so it is read once it has its full width.
            await expect.poll(async () => (await ringOf(control)).shadow, { message: 'a ring of two pixels, drawn inside the control as the ring of the app is' }).toMatch(/0px 0px 0px 2px inset$/);
            await page.locator('body').click({ position: { x: 1, y: 1 } });
        }
    });

    test('Dismiss of an in-app notification shows it too', async ({ page }) => {
        await page.evaluate(() => window.toastr.info('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 }));
        const dismiss = page.locator(NOTIFICATION_FORM_SELECTOR).getByRole('button', { name: 'Dismiss', exact: true });
        await expect(dismiss).toBeVisible();
        await settled(page);
        await focusByKeyboard(page, dismiss);
        await expect.poll(async () => (await ringOf(dismiss)).shadow).toMatch(/0px 0px 0px 2px inset$/);
    });

    test('the ring is not the colour of the toast layer, so that it can be seen on it', async ({ page }) => {
        const toast = await showToast(page, 'info', 'A toast');
        const dismiss = toast.getByRole('button', { name: 'Dismiss', exact: true });
        await focusByKeyboard(page, dismiss);
        await expect.poll(async () => (await ringOf(dismiss)).shadow).toMatch(/0px 0px 0px 2px inset$/);
        const colours = await dismiss.evaluate((node) => {
            const toastStyle = getComputedStyle(node.parentElement);
            return { shadow: getComputedStyle(node).boxShadow, layer: toastStyle.backgroundColor };
        });
        expect(colours.shadow, 'a ring').not.toBe('none');
        expect(colours.shadow.split(' inset')[0], 'the ring colour differs from the layer it is drawn on').not.toBe(colours.layer);
    });
});

test.describe('the width of a toast', () => {
    test('is as wide as its text, and a toast with a button is at least 450px and never wider than the window minus 24px', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const short = await showToast(page, 'info', 'Short');
        const shortWidth = (await boxOf(short)).width;
        expect(shortWidth, 'narrower than 450px').toBeLessThan(250);
        await page.evaluate(() => window.toastr.clear());
        await expect(short).toHaveCount(0, { timeout: 3000 });

        await page.evaluate(() => window.toastr.info('<span>Done</span> <button type="button" class="menu_button">Undo</button>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false }));
        const withButton = page.locator(TOAST_FORM_SELECTOR);
        await expect(withButton).toBeVisible();
        expect((await boxOf(withButton)).width, 'a button makes it at least 450px').toBeCloseTo(450, 0);
        await page.evaluate(() => window.toastr.clear());
        await expect(withButton).toHaveCount(0, { timeout: 3000 });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.toastr.info('<span>Done</span> <button type="button" class="menu_button">Undo</button>', '', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false }));
        await expect(page.locator(TOAST_FORM_SELECTOR)).toBeVisible();
        expect((await boxOf(page.locator(TOAST_FORM_SELECTOR))).width, 'at 390px it is the window minus 24px').toBeCloseTo(366, 0);
    });

    test('is at most 34em: a text that cannot fit is an in-app notification, and one that fits stays under the limit', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const near = await page.evaluate(() => window.__toastForms.messageNearLimit(-8));
        const toast = await showToast(page, 'info', near.text);
        const { width, fontSize } = await toast.evaluate(node => ({ width: node.getBoundingClientRect().width, fontSize: Number.parseFloat(getComputedStyle(node).fontSize) }));
        expect(width).toBeLessThanOrEqual(34 * fontSize + 0.5);
        expect(width, 'it fills most of the limit').toBeGreaterThan(34 * fontSize - 40);
        await page.evaluate(() => window.toastr.clear());
        await expect(toast).toHaveCount(0, { timeout: 3000 });

        await page.evaluate(() => window.toastr.info('A message that is far too long for a toast to hold on a single line, so it is an in-app notification that wraps, and that keeps all of its text.', '', { timeOut: 0, extendedTimeOut: 0 }));
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR)).toBeVisible();
        await expect(page.locator(TOAST_FORM_SELECTOR)).toHaveCount(0);
    });

    test('wraps in a window narrower than its text, at half the height of a one-line toast, and shows all of the text', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 700 });
        // The limit is measured for an info toast, which has no glyph, so the toast is one too.
        const message = (await page.evaluate(() => window.__toastForms.messageNearLimit(-8))).text;
        const toast = await showToast(page, 'info', message);
        const look = await toast.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const label = node.querySelector('.toast-message');
            return {
                width: box.width,
                height: box.height,
                radius: Number.parseFloat(getComputedStyle(node).borderTopLeftRadius),
                clipped: label.scrollWidth > label.clientWidth + 1,
                lines: Math.round(label.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(label).lineHeight)),
                windowWidth: document.documentElement.clientWidth,
            };
        });
        expect(look.width, 'the window minus 24px').toBeLessThanOrEqual(look.windowWidth - 24 + 0.5);
        expect(look.lines, 'the label wraps onto several lines').toBeGreaterThan(2);
        expect(look.height, 'and the toast grows').toBeGreaterThan(46);
        expect(look.radius, 'half the height of a one-line toast, from the metrics: 6px + 34px + 6px, halved').toBe(23);
        expect(look.clipped, 'no text is cut').toBe(false);
        await expect(toast).toHaveClass(/sb-form-toast/);
    });
});

test.describe('where a toast sits', () => {
    test('on Home, a bottom toast is 24px above the window edge and centred', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const toast = await showToast(page, 'info', 'On Home');
        const box = await boxOf(toast);
        await expect(page.locator('#form_sheld'), 'Home has no composer').toBeHidden();
        expect(900 - box.bottom).toBeCloseTo(24, 0);
        expect((box.left + box.right) / 2).toBeCloseTo(720, 0);
    });

    test('in a chat, a bottom toast is 24px above the composer, and follows the page back to Home', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await selectSampleCharacter(page);
        await expect(page.locator('#form_sheld')).toBeVisible();
        const toast = await showToast(page, 'info', 'In a chat');
        const composer = await boxOf(page.locator('#form_sheld'));
        await expect.poll(async () => composer.top - (await boxOf(toast)).bottom).toBeCloseTo(24, 0);

        await page.locator('#sb-home-toggle').click();
        await expect(page.locator('#form_sheld')).toBeHidden();
        await expect.poll(async () => 900 - (await boxOf(toast)).bottom).toBeCloseTo(24, 0);
    });

    test('in a chat, a composer that grows lifts the toast', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await selectSampleCharacter(page);
        const toast = await showToast(page, 'info', 'Lifted');
        const before = (await boxOf(toast)).bottom;
        await page.evaluate(() => {
            const form = document.getElementById('form_sheld');
            const spacer = document.createElement('div');
            spacer.id = 'fx-composer-spacer';
            spacer.style.height = '80px';
            form.prepend(spacer);
        });
        await expect.poll(async () => before - (await boxOf(toast)).bottom).toBeCloseTo(80, 0);
        const composer = await boxOf(page.locator('#form_sheld'));
        expect(composer.top - (await boxOf(toast)).bottom).toBeCloseTo(24, 0);
    });

    test('a top toast is 24px under the edge it sits at, as today\'s top toasts sit', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(async () => (await import('/scripts/sillybunny-toast-motion.js')).setToastPosition('toast-top-right'));
        const toast = await showToast(page, 'info', 'At the top right');
        const box = await boxOf(toast);
        const barBottom = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.getElementById('sb-toast-overlay')).marginTop));
        expect(box.top - barBottom).toBeCloseTo(24, 0);
        expect(1440 - box.right, '12px of margin at the side').toBeCloseTo(12, 0);
        await page.evaluate(async () => (await import('/scripts/sillybunny-toast-motion.js')).setToastPosition('toast-bottom-center'));
    });

    for (const position of ['bottom', 'top']) {
        test(`at the same ${position} position as the notifications, the toast keeps the edge and the notification sits beyond it, and they move as the toast goes`, async ({ page }) => {
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.evaluate(async (edge) => {
                const motion = await import('/scripts/sillybunny-toast-motion.js');
                motion.setToastPosition(`toast-${edge}-center`);
                motion.setNotificationPosition(`toast-${edge}-center`);
            }, position);
            const notification = page.locator(NOTIFICATION_FORM_SELECTOR);
            await page.evaluate(() => window.toastr.warning('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 }));
            await expect(notification).toBeVisible();
            await settled(page);
            const alone = await boxOf(notification);

            const toast = await showToast(page, 'success', 'A toast');
            const toastBox = await boxOf(toast);
            await expect.poll(async () => {
                const box = await boxOf(notification);
                return position === 'bottom' ? toastBox.top - box.bottom : box.top - toastBox.bottom;
            }, { message: 'the notification does not overlap the toast, and is not far from it' }).toBeGreaterThanOrEqual(0);
            const stacked = await boxOf(notification);
            expect(position === 'bottom' ? stacked.bottom <= toastBox.top : stacked.top >= toastBox.bottom).toBe(true);
            expect(position === 'bottom' ? toastBox.top - stacked.bottom : stacked.top - toastBox.bottom, 'about one margin apart').toBeLessThan(40);
            expect(position === 'bottom' ? 900 - toastBox.bottom : toastBox.top, 'the toast keeps the edge').toBeLessThan(position === 'bottom' ? 260 : 120);

            await page.evaluate(() => window.toastr.clear(window.jQuery('#sb-toast-overlay > .toast')));
            await expect(toast).toHaveCount(0, { timeout: 3000 });
            await expect.poll(async () => Math.abs((await boxOf(notification)).top - alone.top), { message: 'the notification goes back to its own place' }).toBeLessThan(1);
            await page.evaluate(async () => {
                const motion = await import('/scripts/sillybunny-toast-motion.js');
                motion.setToastPosition('toast-bottom-center');
                motion.setNotificationPosition('toast-top-center');
            });
        });
    }

    test('at different positions the two forms do not share a stack', async ({ page }) => {
        await page.evaluate(() => window.toastr.warning('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 }));
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR)).toBeVisible();
        await settled(page);
        const before = await boxOf(page.locator(NOTIFICATION_FORM_SELECTOR));
        await showToast(page, 'success', 'A toast');
        const after = await boxOf(page.locator(NOTIFICATION_FORM_SELECTOR));
        expect(after.top).toBeCloseTo(before.top, 0);
    });
});

test.describe('a toast in a dialog', () => {
    /** The box of the surface of the open dialog: the Popup itself, or the frame inside a shared dialog host. */
    const surfaceBox = page => page.evaluate(() => {
        const host = document.querySelector('dialog[open]');
        const surface = host.classList.contains('sb-dialog-host') ? host.querySelector(':scope > .sb-dialog') : host;
        const box = surface.getBoundingClientRect();
        // A Popup holds the overlay inside its border, and a frame of the shared dialog is measured at its outer edge.
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, border: surface === host ? Number.parseFloat(getComputedStyle(surface).borderBottomWidth) : 0 };
    });

    async function expectAtTheBottomOfTheDialog(page, toast) {
        const surface = await surfaceBox(page);
        await expect.poll(async () => surface.bottom - surface.border - (await boxOf(toast)).bottom).toBeCloseTo(24, 0);
        const box = await boxOf(toast);
        expect((box.left + box.right) / 2, 'centred in the dialog').toBeCloseTo((surface.left + surface.right) / 2, 0);
        expect(box.left, 'inside the dialog').toBeGreaterThanOrEqual(surface.left);
        expect(box.right).toBeLessThanOrEqual(surface.right);
    }

    test('in a Popup is at the bottom centre of the Popup, whatever the position setting says', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(async () => (await import('/scripts/sillybunny-toast-motion.js')).setToastPosition('toast-top-left'));
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.__popup = new Popup('<h3>A Popup</h3><p>Some text in a Popup.</p>', POPUP_TYPE.TEXT, '');
            void window.__popup.show();
        });
        await expect(page.locator('dialog[open]:not([opening])')).toHaveCount(1);
        const toast = await showToast(page, 'success', 'In a Popup');
        await expect(page.locator('dialog[open] > #sb-toast-overlay')).toHaveCount(1);
        await expectAtTheBottomOfTheDialog(page, toast);
        await page.evaluate(async () => {
            window.__popup.completeCancelled();
            (await import('/scripts/sillybunny-toast-motion.js')).setToastPosition('toast-bottom-center');
        });
    });

    test('in a shared dialog host whose content scrolls is at the bottom centre of its frame, and stays there while the content scrolls', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            const body = document.createElement('div');
            for (let line = 0; line < 80; line += 1) {
                const paragraph = document.createElement('p');
                paragraph.textContent = `Line ${line} of a body that scrolls inside the frame.`;
                body.append(paragraph);
            }
            window.__frame = openDialog({ tier: 'dialog', title: 'Fixture', content: body, responses: { cancel: {}, affirmative: { id: 'ok', label: 'Save' } } });
        });
        await expect(page.locator('dialog[open].sb-dialog-host')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => document.querySelector('dialog[open].sb-dialog-host .sb-dialog').getAnimations().length)).toBe(0);
        const toast = await showToast(page, 'success', 'In a frame');
        await expectAtTheBottomOfTheDialog(page, toast);

        await page.evaluate(() => { document.querySelector('.sb-dialog__body').scrollTop = 600; });
        await expectAtTheBottomOfTheDialog(page, toast);
        await page.evaluate(async () => {
            await window.__frame.close('cancel');
            await window.__frame.closed;
        });
    });

    test('in a bottom sheet on a phone is at the bottom of the sheet', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(async () => {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.__frame = openDialog({ tier: 'dialog', title: 'Fixture', content: document.createElement('div'), responses: { cancel: {}, affirmative: { id: 'ok', label: 'Save' } } });
        });
        await expect(page.locator('dialog[open].sb-dialog-host[data-presentation="sheet"]')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => document.querySelector('dialog[open].sb-dialog-host .sb-dialog').getAnimations().length)).toBe(0);
        const toast = await showToast(page, 'success', 'In a sheet');
        await expectAtTheBottomOfTheDialog(page, toast);
        const sheet = await surfaceBox(page);
        expect(sheet.bottom, 'the sheet is on the window edge').toBeCloseTo(844, 0);
        await page.evaluate(async () => {
            await window.__frame.close('cancel');
            await window.__frame.closed;
        });
    });

    test('keeps in-app notifications at their window position', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(async () => {
            const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
            window.__popup = new Popup('<h3>A Popup</h3><p>Some text in a Popup.</p>', POPUP_TYPE.TEXT, '');
            void window.__popup.show();
        });
        await expect(page.locator('dialog[open]:not([opening])')).toHaveCount(1);
        await page.evaluate(() => window.toastr.warning('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 }));
        const notification = page.locator(NOTIFICATION_FORM_SELECTOR);
        await expect(notification).toBeVisible();
        expect((await boxOf(notification)).top, 'at the top of the window, as its setting says').toBeLessThan(150);
        await page.evaluate(() => window.__popup.completeCancelled());
    });
});

test.describe('the motion of a toast', () => {
    test('slides in from beyond the edge it sits at, clipped there, with no fade, over 300ms', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const result = await page.evaluate(async () => {
            const toast = window.toastr.info('Sliding in', '', { timeOut: 0, extendedTimeOut: 0 })[0];
            const animation = toast.getAnimations().find(candidate => candidate.effect.getKeyframes().some(frame => frame.transform));
            const keyframes = animation.effect.getKeyframes();
            const timing = animation.effect.getTiming();
            animation.pause();
            animation.currentTime = 0;
            const start = toast.getBoundingClientRect();
            const overlay = document.getElementById('sb-toast-overlay').getBoundingClientRect();
            const clip = getComputedStyle(document.getElementById('sb-toast-overlay')).clipPath;
            animation.currentTime = timing.duration;
            const end = toast.getBoundingClientRect();
            animation.cancel();
            return {
                properties: [...new Set(keyframes.flatMap(frame => Object.keys(frame)))].filter(name => !['offset', 'computedOffset', 'easing', 'composite'].includes(name)),
                duration: timing.duration,
                easing: timing.easing,
                startTop: start.top,
                overlayBottom: overlay.bottom,
                endBottom: end.bottom,
                clip,
            };
        });
        expect(result.properties, 'a transform and nothing else: no fade').toEqual(['transform']);
        expect(result.duration).toBe(300);
        // WebKit reports this curve by its keyword, which is the same curve.
        expect(['cubic-bezier(0.25, 0.1, 0.25, 1)', 'ease']).toContain(result.easing);
        expect(result.startTop, 'it starts fully beyond the bottom edge, which clips it').toBeGreaterThanOrEqual(result.overlayBottom);
        expect(result.endBottom, 'and ends 24px above it').toBeCloseTo(result.overlayBottom - 24, 0);
        expect(result.clip, 'the overlay clips on the bottom edge only').toMatch(/inset\(/);
    });

    test('at a top position slides down from above the edge', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(async () => (await import('/scripts/sillybunny-toast-motion.js')).setToastPosition('toast-top-center'));
        const result = await page.evaluate(() => {
            const toast = window.toastr.info('Sliding down', '', { timeOut: 0, extendedTimeOut: 0 })[0];
            const animation = toast.getAnimations().find(candidate => candidate.effect.getKeyframes().some(frame => frame.transform));
            animation.pause();
            animation.currentTime = 0;
            const start = toast.getBoundingClientRect();
            const overlay = document.getElementById('sb-toast-overlay').getBoundingClientRect();
            animation.cancel();
            return { startBottom: start.bottom, overlayTop: overlay.top };
        });
        expect(result.startBottom, 'fully above the top edge').toBeLessThanOrEqual(result.overlayTop);
        await page.evaluate(async () => (await import('/scripts/sillybunny-toast-motion.js')).setToastPosition('toast-bottom-center'));
    });

    test('leaves with a fade and a scale to 0.95 from its centre over 300ms', async ({ page }) => {
        const toast = await showToast(page, 'info', 'Leaving');
        const result = await page.evaluate(() => {
            const element = document.querySelector('#sb-toast-overlay > .sb-form-toast');
            window.toastr.clear(window.jQuery(element));
            const animation = element.getAnimations().find(candidate => candidate.effect.getKeyframes().some(frame => frame.opacity === '0'));
            const keyframes = animation.effect.getKeyframes();
            const timing = animation.effect.getTiming();
            return { keyframes: keyframes.map(({ opacity, transform }) => ({ opacity, transform })), duration: timing.duration, easing: timing.easing, origin: getComputedStyle(element).transformOrigin, width: element.offsetWidth, height: element.offsetHeight };
        });
        expect(result.keyframes).toEqual([{ opacity: '1', transform: 'none' }, { opacity: '0', transform: 'scale(0.95)' }]);
        expect(result.duration).toBe(300);
        expect(result.easing).toBe('cubic-bezier(0.33, 1, 0.68, 1)');
        const [x, y] = result.origin.split(' ').map(Number.parseFloat);
        expect(x, 'from the centre').toBeCloseTo(result.width / 2, 0);
        expect(y).toBeCloseTo(result.height / 2, 0);
        await expect(toast).toHaveCount(0, { timeout: 3000 });
    });

    test('shows over 500ms when a toast is still leaving', async ({ page }) => {
        const durations = await page.evaluate(async () => {
            window.toastr.info('First', '', { timeOut: 600, extendedTimeOut: 600 });
            const second = window.toastr.info('Second', '', { timeOut: 5000, extendedTimeOut: 5000 })[0];
            const durationOf = element => element.getAnimations().map(animation => animation.effect.getTiming().duration);
            await new Promise((resolve) => {
                const watch = () => (document.querySelector('.sb-toast-leaving') ? resolve() : requestAnimationFrame(watch));
                watch();
            });
            return durationOf(second);
        });
        expect(durations).toContain(500);
    });

    test('is a fade of at most 200ms under reduced motion, in and out', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const result = await page.evaluate(() => {
            const element = window.toastr.info('Fading', '', { timeOut: 0, extendedTimeOut: 0 })[0];
            const enter = element.getAnimations()[0];
            const entering = { keyframes: enter.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })), duration: enter.effect.getTiming().duration };
            return { entering };
        });
        expect(result.entering.keyframes.every(frame => frame.transform === undefined), 'no movement').toBe(true);
        expect(result.entering.keyframes.map(frame => frame.opacity)).toEqual(['0', '1']);
        expect(result.entering.duration).toBeLessThanOrEqual(200);

        const leaving = await page.evaluate(() => {
            const element = document.querySelector('#sb-toast-overlay > .sb-form-toast');
            window.toastr.clear(window.jQuery(element));
            const animation = element.getAnimations().find(candidate => candidate.effect.getKeyframes().some(frame => frame.opacity === '0'));
            return { keyframes: animation.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })), duration: animation.effect.getTiming().duration };
        });
        expect(leaving.keyframes.every(frame => frame.transform === undefined), 'no scale').toBe(true);
        expect(leaving.duration).toBeLessThanOrEqual(200);
        await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0, { timeout: 3000 });
    });

    test('keeps the notification\'s fade and slide, and its shorter reduced-motion path unchanged', async ({ page }) => {
        const keyframes = await page.evaluate(() => {
            const element = window.toastr.info('A notification', 'Title', { timeOut: 0, extendedTimeOut: 0 })[0];
            const animation = element.getAnimations().find(candidate => candidate.effect.getKeyframes().some(frame => frame.opacity === '0'));
            return animation.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform }));
        });
        expect(keyframes.map(frame => frame.opacity)).toEqual(['0', '1']);
        expect(keyframes[0].transform).toMatch(/translateY/);
    });
});
