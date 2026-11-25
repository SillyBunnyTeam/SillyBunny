import { expect, test } from '@playwright/test';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_FORM_SELECTOR, TOAST_SELECTOR } from './helpers/toasts.js';

/*
 * While a modal dialog is open, a toast shows at its place in the window, above the dialog and its dimming, whatever kind of
 * dialog it is. The dimming covers the composer, so a bottom toast sits 24px from the window edge. A dialog that is a bottom
 * sheet is a bar for the toasts: 24px above its top edge, or, when it leaves no room above, 24px above its bottom action row
 * or its bottom edge. In-app notifications are unchanged.
 */

const STAY = { timeOut: 0, extendedTimeOut: 0 };
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

/** Each opens one kind of dialog in the page and leaves nothing but the dialog behind. Escape closes every one of them. */
const OPENERS = {
    popup: async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.__popup = new Popup('<h3>A Popup</h3><p>Some text in a Popup.</p>', POPUP_TYPE.TEXT, '');
        void window.__popup.show();
    },
    alert: async () => {
        const { openAlert } = await import('/scripts/sillybunny-editor/dialog.js');
        void openAlert({ heading: 'An alert', body: 'A body that has some words in it.', responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK' }] });
    },
    frame: async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const content = document.createElement('div');
        content.textContent = 'The content of a Dialog.';
        void openDialog({ tier: 'dialog', title: 'A Dialog', content, responses: { cancel: {}, affirmative: { id: 'ok', label: 'Save' } } });
    },
    window: async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const content = document.createElement('div');
        content.textContent = 'The content of a Window.';
        void openDialog({ tier: 'window', title: 'A Window', content, responses: { cancel: {} } });
    },
    raw: async () => {
        // What an extension does: a plain dialog that it opens itself, with no frame of ours.
        const dialog = document.createElement('dialog');
        dialog.id = 'qa-raw-dialog';
        dialog.style.cssText = 'padding: 20px; border-radius: 12px;';
        dialog.innerHTML = '<p>An extension dialog</p><button type="button">Close</button>';
        dialog.querySelector('button').addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove());
        document.body.append(dialog);
        dialog.showModal();
    },
    alertTall: async () => {
        const { openAlert } = await import('/scripts/sillybunny-editor/dialog.js');
        const body = document.createElement('div');
        for (let line = 0; line < 40; line += 1) {
            const paragraph = document.createElement('p');
            paragraph.textContent = `Line ${line} of a body that is tall.`;
            body.append(paragraph);
        }
        void openAlert({ heading: 'A tall alert', bodyNode: body, responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK' }] });
    },
    frameTall: async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const content = document.createElement('div');
        for (let line = 0; line < 40; line += 1) {
            const paragraph = document.createElement('p');
            paragraph.textContent = `Line ${line} of a Dialog that is tall.`;
            content.append(paragraph);
        }
        void openDialog({ tier: 'dialog', title: 'A tall Dialog', content, responses: { cancel: {}, affirmative: { id: 'ok', label: 'Save' } } });
    },
};

/** A chat, so that the composer is there, with the toasts and the notifications at the positions of the test. */
async function openChat(page, viewport, { toast = 'toast-bottom-center', notification = 'toast-bottom-center' } = {}) {
    await page.setViewportSize(viewport);
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
    await selectSampleCharacter(page);
    await page.evaluate(async ([toastPosition, notificationPosition]) => {
        const motion = await import('/scripts/sillybunny-toast-motion.js');
        motion.setToastPosition(toastPosition);
        motion.setNotificationPosition(notificationPosition);
        window.toastr.clear(undefined, { force: true });
    }, [toast, notification]);
    await expect(page.locator('#form_sheld')).toBeVisible();
    await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0);
}

/** Waits until a dialog is open and has stopped opening: no `opening` attribute, no animation that runs on it. */
const dialogSettled = page => expect.poll(() => page.evaluate(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (!dialog || dialog.hasAttribute('opening') || dialog.hasAttribute('closing')) {
        return false;
    }
    return dialog.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getComputedTiming().endTime)).length === 0;
})).toBe(true);

const openDialog = async (page, kind) => {
    await page.evaluate(OPENERS[kind]);
    await dialogSettled(page);
};

const closeDialog = async (page) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
};

/** Waits until no message is sliding in or out, so that a box that is read is the one it rests at. */
const settled = page => expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#toast-container > .toast, #sb-toast-overlay > .toast')]
    .reduce((count, node) => count + node.getAnimations().filter(animation => animation.playState !== 'finished').length, 0))).toBe(0);

async function showToast(page, text = 'A toast') {
    await page.evaluate(([message, options]) => window.toastr.success(message, '', options), [text, STAY]);
    await settled(page);
}

async function showNotification(page) {
    await page.evaluate(options => window.toastr.warning('The body of a notification.', 'A notification', options), STAY);
    await settled(page);
}

async function clearMessages(page) {
    await page.evaluate(() => window.toastr.clear(undefined, { force: true }));
    await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0);
}

/**
 * Where the toast, the notification, the strip of the toasts, the composer and the open dialog are, in px from the bottom
 * edge of the window, and the middle of the toast.
 */
const measure = page => page.evaluate(({ toast, note }) => {
    const vh = document.documentElement.clientHeight;
    const box = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect && rect.height > 0 ? rect : null;
    };
    const toastBox = box(toast);
    const noteBox = box(note);
    const overlay = box('#sb-toast-overlay');
    const composer = box('#form_sheld');
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    const surface = dialog?.classList.contains('sb-dialog-host') ? dialog.querySelector(':scope > .sb-dialog') : dialog;
    const surfaceBox = surface?.getBoundingClientRect();
    const rows = surface ? [...surface.querySelectorAll('.sb-dialog__responses, .sb-dialog__bottom-bar, .popup-controls')]
        .filter(row => row.getClientRects().length > 0)
        .map(row => row.getBoundingClientRect())
        .filter(rowBox => rowBox.height > 0 && rowBox.top + rowBox.height / 2 > surfaceBox.top + surfaceBox.height / 2) : [];
    const topBar = document.getElementById('top-bar')?.getBoundingClientRect();
    return {
        vh,
        toast: toastBox && Math.round(vh - toastBox.bottom),
        toastTop: toastBox && Math.round(toastBox.top),
        toastCentre: toastBox && Math.round((toastBox.left + toastBox.right) / 2),
        note: noteBox && Math.round(vh - noteBox.bottom),
        noteTop: noteBox && Math.round(noteBox.top),
        overlay: overlay && Math.round(vh - overlay.bottom),
        composer: composer && Math.round(vh - composer.top),
        between: toastBox && noteBox ? Math.round(toastBox.top - noteBox.bottom) : null,
        sheet: surfaceBox ? Math.round(vh - surfaceBox.top) : null,
        sheetTop: surfaceBox ? Math.round(surfaceBox.top) : null,
        sheetBottom: surfaceBox ? Math.round(surfaceBox.bottom) : null,
        row: rows.length > 0 ? Math.round(vh - Math.min(...rows.map(row => row.top))) : null,
        topBar: topBar ? Math.round(topBar.bottom) : 0,
        windowCentre: Math.round(document.documentElement.clientWidth / 2),
    };
}, { toast: TOAST_FORM_SELECTOR, note: NOTIFICATION_FORM_SELECTOR });

/** Whether the toast is the element that a pointer reaches at its middle, and so is drawn above the dialog and not inert. */
const reachable = page => page.evaluate((selector) => {
    const toast = document.querySelector(selector);
    const rect = toast.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { reachable: hit !== null && toast.contains(hit), inert: toast.closest('[inert]') !== null, inDialog: toast.closest('dialog') !== null };
}, TOAST_FORM_SELECTOR);

/**
 * Samples the strip of the toasts and the first toast on every frame, from now until `stopWatching`. A strip that is not
 * drawn, as while a Popup opens, is marked hidden: it has no place that a user can see.
 */
const watch = page => page.evaluate(() => {
    const vh = document.documentElement.clientHeight;
    window.qaSamples = [];
    const tick = (now) => {
        const overlay = document.getElementById('sb-toast-overlay');
        const toast = overlay?.querySelector(':scope > .sb-form-toast:not(.sb-toast-measure)');
        if (overlay && toast) {
            const strip = overlay.getBoundingClientRect();
            const rect = toast.getBoundingClientRect();
            window.qaSamples.push({
                at: now,
                gap: Math.round((vh - strip.bottom) * 10) / 10,
                top: Math.round(strip.top * 10) / 10,
                left: Math.round(rect.left * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
                hidden: getComputedStyle(overlay).visibility === 'hidden',
                host: overlay.parentElement.tagName.toLowerCase(),
            });
        }
        window.qaFrame = requestAnimationFrame(tick);
    };
    window.qaFrame = requestAnimationFrame(tick);
});

const stopWatching = page => page.evaluate(() => {
    cancelAnimationFrame(window.qaFrame);
    return window.qaSamples;
});

/** The fastest that the strip moved between two frames, in px per ms. A glide of the toasts stays under 2.5, and a jump is far beyond it. */
const fastest = samples => samples.slice(1).reduce((most, sample, index) => {
    const before = samples[index];
    return Math.max(most, Math.abs(sample.gap - before.gap) / Math.max(sample.at - before.at, 1));
}, 0);

const drawn = samples => samples.filter(sample => !sample.hidden);

test.describe('a toast above a dialog at 1440px', () => {
    for (const kind of ['popup', 'alert', 'frame', 'window', 'raw']) {
        test(`${kind}: sits at its place in the window, 24px from its edge, above the dimming, and its Dismiss and its button work`, async ({ page }) => {
            await openChat(page, DESKTOP);
            await openDialog(page, kind);
            await page.evaluate((options) => {
                window.__undone = 0;
                window.toastr.info('<div>Removed <button type="button" id="qa-undo">Undo</button></div>', '', { escapeHtml: false, ...options });
                document.addEventListener('click', (event) => {
                    if (event.target.id === 'qa-undo') window.__undone += 1;
                }, true);
            }, STAY);
            await settled(page);

            await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
            const where = await measure(page);
            expect(Math.abs(where.toastCentre - where.windowCentre), 'centred on the window').toBeLessThanOrEqual(1);
            expect(await reachable(page)).toEqual({ reachable: true, inert: false, inDialog: true });

            // A toast whose button has run goes, as it does without a dialog, and the dialog stays.
            await page.locator('#qa-undo').click();
            expect(await page.evaluate(() => window.__undone), 'the toast\'s button runs above the dialog').toBe(1);
            await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0);
            await expect(page.locator('dialog[open]')).toHaveCount(1);

            await showToast(page, 'Dismissed above the dialog');
            await page.locator(`${TOAST_FORM_SELECTOR} .toast-close-button`).click();
            await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0);
            await expect(page.locator('dialog[open]')).toHaveCount(1);
            await closeDialog(page);
        });
    }

    test('a toast at a top position is where it is without a dialog', async ({ page }) => {
        await openChat(page, DESKTOP, { toast: 'toast-top-center', notification: 'toast-top-center' });
        await showToast(page);
        const without = await measure(page);
        await openDialog(page, 'popup');
        await expect.poll(async () => (await measure(page)).toastTop).toBe(without.toastTop);
        expect((await measure(page)).toastCentre).toBe(without.toastCentre);
        expect(await reachable(page)).toEqual({ reachable: true, inert: false, inDialog: true });
        await closeDialog(page);
    });

    test('a toast and an in-app notification at one position share a stack, and a notification alone is where it was', async ({ page }) => {
        await openChat(page, DESKTOP);
        await showToast(page);
        await showNotification(page);
        const without = await measure(page);
        await openDialog(page, 'frame');
        await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
        expect((await measure(page)).between, 'the notification is as far beyond the toast as without a dialog').toBe(without.between);
        expect((await measure(page)).noteTop).toBeLessThan((await measure(page)).toastTop);

        await clearMessages(page);
        await showNotification(page);
        await expect.poll(() => measure(page)).toMatchObject({ note: 4 });
        await closeDialog(page);
    });
});

test.describe('a toast above a dialog at 390px', () => {
    for (const kind of ['popup', 'alert', 'frame']) {
        test(`${kind}: as a sheet with room above it, sits 24px above its top edge, and the clip edge is that edge`, async ({ page }) => {
            await openChat(page, PHONE);
            await openDialog(page, kind);
            const sheet = await measure(page);
            expect(sheet.sheetBottom, 'the dialog is a sheet at the foot of the window').toBeGreaterThanOrEqual(PHONE.height - 1);
            expect(sheet.sheetTop - sheet.topBar, 'with room above it for a toast and its margins').toBeGreaterThan(100);
            await showToast(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: sheet.sheet + 24, overlay: sheet.sheet });
            expect(await reachable(page)).toEqual({ reachable: true, inert: false, inDialog: true });

            await clearMessages(page);
            await showNotification(page);
            await expect.poll(() => measure(page), 'a notification alone keeps its window place').toMatchObject({ note: 4 });
            await closeDialog(page);
        });
    }

    test('raw: a dialog that is not a sheet leaves the toast at the window edge', async ({ page }) => {
        await openChat(page, PHONE);
        await openDialog(page, 'raw');
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
        await closeDialog(page);
    });

    test('a tall sheet with an action row, which leaves no room above it, sits 24px above its bottom action row, and comes out of that edge', async ({ page }) => {
        await openChat(page, PHONE);
        await openDialog(page, 'alertTall');
        const sheet = await measure(page);
        expect(sheet.sheetTop - sheet.topBar, 'no room above the sheet for a toast and its margins').toBeLessThan(82);
        expect(sheet.row, 'the sheet has an action row at its foot').not.toBeNull();
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: sheet.row + 24, overlay: sheet.row });
        // A toast is clipped by the edge of its strip, so it comes out of the action row and not out of the window.
        const clip = await page.evaluate(() => getComputedStyle(document.getElementById('sb-toast-overlay')).clipPath);
        expect(clip).toMatch(/inset\(.* 0px\)/);
        await closeDialog(page);
    });

    test('a tall sheet with no action row sits 24px above its bottom edge', async ({ page }) => {
        await openChat(page, PHONE);
        await openDialog(page, 'frameTall');
        const sheet = await measure(page);
        expect(sheet.sheetTop - sheet.topBar).toBeLessThan(82);
        expect(sheet.row, 'the sheet has no action row at its foot').toBeNull();
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
        await closeDialog(page);
    });

    test('a toast at a top position is where it is without a dialog, with a sheet open', async ({ page }) => {
        await openChat(page, PHONE, { toast: 'toast-top-center', notification: 'toast-top-center' });
        await showToast(page);
        const without = await measure(page);
        await openDialog(page, 'alertTall');
        await expect.poll(async () => (await measure(page)).toastTop).toBe(without.toastTop);
        await closeDialog(page);
    });

    test('a toast and an in-app notification share a stack above the sheet', async ({ page }) => {
        await openChat(page, PHONE);
        await showToast(page);
        await showNotification(page);
        const without = await measure(page);
        await openDialog(page, 'alert');
        const sheet = await measure(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: sheet.sheet + 24 });
        expect((await measure(page)).between).toBe(without.between);
        await closeDialog(page);
    });
});

test.describe('a toast while a dialog opens and closes', () => {
    for (const viewport of [DESKTOP, PHONE]) {
        for (const kind of ['frame', 'raw']) {
            test(`${kind} at ${viewport.width}px: raised before the dialog opens, it moves once, without a jump, and at its place across the width`, async ({ page }) => {
                await openChat(page, viewport);
                await showToast(page);
                const before = await measure(page);
                await watch(page);
                await openDialog(page, kind);
                await expect.poll(async () => (await measure(page)).toast).not.toBe(before.toast);
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
                const samples = drawn(await stopWatching(page));
                expect(samples.length).toBeGreaterThan(5);
                expect(new Set(samples.map(sample => sample.left)).size, 'the toast does not move sideways').toBe(1);
                expect(new Set(samples.map(sample => sample.width)).size).toBe(1);
                expect(fastest(samples), 'it glides to its new place and does not jump').toBeLessThan(2.5);
                expect(samples.at(-1).host, 'in the dialog').toBe('dialog');
            });

            test(`${kind} at ${viewport.width}px: raised while the dialog opens, it is at its place from its first frame`, async ({ page }) => {
                await openChat(page, viewport);
                await watch(page);
                await page.evaluate(OPENERS[kind]);
                await page.evaluate(() => window.toastr.success('Raised while the dialog opens', '', { timeOut: 0, extendedTimeOut: 0 }));
                await dialogSettled(page);
                await settled(page);
                const settledAt = await measure(page);
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
                const samples = drawn(await stopWatching(page));
                expect(samples.length).toBeGreaterThan(5);
                expect(new Set(samples.map(sample => sample.left)).size).toBe(1);
                expect(new Set(samples.map(sample => sample.gap)).size, 'the strip is at one place from its first frame').toBe(1);
                expect(samples[0].gap).toBe(settledAt.overlay);
            });

            test(`${kind} at ${viewport.width}px: closing while the toast shows, it stays at its place in the window, and is above the composer again`, async ({ page }) => {
                await openChat(page, viewport);
                await openDialog(page, kind);
                await showToast(page);
                const above = await measure(page);
                await expect.poll(async () => (await measure(page)).toast).toBe(above.toast);
                await watch(page);
                await closeDialog(page);
                await expect.poll(async () => (await measure(page)).toast).toBe(above.composer + 24);
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
                const samples = drawn(await stopWatching(page));
                expect(new Set(samples.map(sample => sample.left)).size, 'the toast does not move sideways').toBe(1);
                expect(fastest(samples), 'it eases up to the composer and does not jump').toBeLessThan(2.5);
                expect(samples.at(-1).host).toBe('body');
            });
        }

        test(`popup at ${viewport.width}px: a toast is never drawn at a wrong place while the Popup opens and closes`, async ({ page }) => {
            await openChat(page, viewport, { toast: 'toast-top-center', notification: 'toast-top-center' });
            await showToast(page);
            const without = await measure(page);
            await watch(page);
            await openDialog(page, 'popup');
            await expect.poll(async () => (await measure(page)).toastTop).toBe(without.toastTop);
            await closeDialog(page);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
            const samples = await stopWatching(page);
            // A Popup scales as it opens, which makes it the place that a fixed strip is measured from, so the strip is not drawn then.
            for (const sample of drawn(samples)) {
                expect(sample.top).toBe(drawn(samples)[0].top);
                expect(sample.left).toBe(drawn(samples)[0].left);
            }
            expect(drawn(samples).length).toBeGreaterThan(5);
        });
    }
});
