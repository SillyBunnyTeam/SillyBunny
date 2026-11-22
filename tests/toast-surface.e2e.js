import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { TOAST_SELECTOR } from './helpers/toasts.js';

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
});

// A toast is a pill with the status colour on its icon and its title; an in-app notification is a card whose icon takes the
// status colour and whose title takes the ink. A short message with no title is a toast, and a message with a title is a notification.
const FORMS = [
    { form: 'toast', title: '', message: 'A short message.' },
    { form: 'notification', title: 'Title', message: 'A message that is long enough to wrap onto a second line in a narrow toast.' },
];

for (const { form, title, message } of FORMS) {
    test(`a ${form} ${form === 'toast' ? 'is a pill' : 'is a card'}, and only an error, warning or success one has a status glyph, drawn in the status colour`, async ({ page }) => {
        const measured = await page.evaluate(({ titleText, messageText }) => {
            const read = (kind) => {
                const toast = window.toastr[kind](messageText, titleText, { timeOut: 0, extendedTimeOut: 0 });
                const node = toast[0];
                const style = getComputedStyle(node);
                const titleNode = node.querySelector('.toast-title');
                const icon = getComputedStyle(node, '::before');
                const box = node.getBoundingClientRect();
                return {
                    radius: Number.parseFloat(style.borderTopLeftRadius),
                    height: box.height,
                    titleColour: titleNode ? getComputedStyle(titleNode).color : null,
                    form: node.classList.contains('sb-form-toast') ? 'toast' : 'notification',
                    ink: style.color,
                    iconContent: icon.content,
                    iconColour: icon.color,
                    background: style.backgroundImage,
                };
            };
            const result = Object.fromEntries(['error', 'warning', 'success', 'info'].map(kind => [kind, read(kind)]));
            window.toastr.remove();
            return result;
        }, { titleText: title, messageText: message });

        for (const [kind, toast] of Object.entries(measured)) {
            expect(toast.form, `${kind} is a ${form}`).toBe(form);
            if (form === 'toast') {
                expect(toast.radius, `${kind} toast radius`).toBeGreaterThanOrEqual(toast.height / 2);
            } else {
                expect(toast.radius, `${kind} notification radius is the Overlay radius`).toBe(15);
            }
        }
        for (const kind of ['error', 'warning', 'success']) {
            expect(measured[kind].iconColour, `${kind} icon colour is not the ink`).not.toBe(measured[kind].ink);
            expect(measured[kind].iconContent, `${kind} icon glyph`).not.toBe('none');
            expect(measured[kind].background, `${kind} ${form} draws no PNG icon`).toBe('none');
            if (form === 'toast') {
                expect(measured[kind].titleColour).toBeNull();
            } else {
                expect(measured[kind].titleColour, `${kind} notification title is the ink`).toBe(measured[kind].ink);
            }
        }
        expect(measured.info.iconContent, 'info has no glyph').toBe('none');
        expect(measured.info.background, 'info draws no PNG icon').toBe('none');
    });
}

test('a toast stays for 5 seconds and shows and hides over 300ms', async ({ page }) => {
    const options = await page.evaluate(() => ({ ...window.toastr.options }));
    expect(options.timeOut).toBe(5000);
    expect(options.extendedTimeOut).toBe(5000);
    expect(options.showDuration).toBe(300);
    expect(options.hideDuration).toBe(300);
});

test('a toast is kept while it is hovered or has keyboard focus inside it, and goes after it is released', async ({ page }) => {
    // A short timeout keeps the test fast; the hold logic does not depend on its length.
    await page.evaluate(() => {
        window.toastr.info('<a href="#" id="toast-link">Details</a>', 'Held', { timeOut: 600, extendedTimeOut: 600, escapeHtml: false });
    });
    const toast = page.locator(TOAST_SELECTOR, { hasText: 'Held' });
    await expect(toast).toBeVisible();
    await page.locator('#toast-link').focus();
    await page.waitForTimeout(1800);
    await expect(toast, 'focus inside holds the toast past its timeout').toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());
    await expect(toast, 'the toast goes once focus leaves').toHaveCount(0, { timeout: 5000 });

    await page.evaluate(() => {
        window.toastr.info('Hover me', 'Hovered', { timeOut: 600, extendedTimeOut: 600 });
    });
    const hovered = page.locator(TOAST_SELECTOR, { hasText: 'Hovered' });
    await expect(hovered).toBeVisible();
    await hovered.hover();
    await page.waitForTimeout(1800);
    await expect(hovered, 'the pointer over the toast holds it').toBeVisible();
    await page.mouse.move(2, 2);
    await expect(hovered, 'the toast goes once the pointer leaves').toHaveCount(0, { timeout: 5000 });
});
