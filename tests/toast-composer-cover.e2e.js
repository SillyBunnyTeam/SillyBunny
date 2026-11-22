import { expect, test } from '@playwright/test';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_FORM_SELECTOR, TOAST_SELECTOR } from './helpers/toasts.js';

const STAY = { timeOut: 0, extendedTimeOut: 0 };
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const PANELS = [['Backend', '#sb-left-shell-toggle'], ['Customize', '#sb-right-shell-toggle']];

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

/** Removes every message, including one that the app showed on its own. */
async function clearMessages(page) {
    await page.evaluate(() => window.toastr.clear(undefined, { force: true }));
    await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0);
}

/** A chat, with the toasts and the notifications at the bottom centre, where the composer is the bar that they sit above. */
async function openChat(page, viewport) {
    await page.setViewportSize(viewport);
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
    await selectSampleCharacter(page);
    await page.evaluate(async () => {
        const motion = await import('/scripts/sillybunny-toast-motion.js');
        motion.setToastPosition('toast-bottom-center');
        motion.setNotificationPosition('toast-bottom-center');
    });
    await expect(page.locator('#form_sheld')).toBeVisible();
    await clearMessages(page);
}

/**
 * Distances from the bottom edge of the window, in px, of the toast, the notification, the strip of the toasts and the
 * top of the composer, and the space between a toast and a notification that sit at the same position.
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
    return {
        toast: toastBox && Math.round(vh - toastBox.bottom),
        note: noteBox && Math.round(vh - noteBox.bottom),
        overlay: overlay && Math.round(vh - overlay.bottom),
        composer: composer && Math.round(vh - composer.top),
        between: toastBox && noteBox ? Math.round(toastBox.top - noteBox.bottom) : null,
    };
}, { toast: TOAST_FORM_SELECTOR, note: NOTIFICATION_FORM_SELECTOR });

/** Waits until no message is sliding in or out, so that a box that is read is the one it rests at. */
const settled = page => expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#toast-container > .toast, #sb-toast-overlay > .toast')]
    .reduce((count, node) => count + node.getAnimations().filter(animation => animation.playState !== 'finished').length, 0))).toBe(0);

async function showToast(page) {
    await page.evaluate(options => window.toastr.success('Probe toast', '', options), STAY);
    await settled(page);
}

async function showNotification(page) {
    await page.evaluate(options => window.toastr.warning('Probe body text', 'Probe notification', options), STAY);
    await settled(page);
}

/** Whether the topmost element at the composer's top edge is outside it: a panel is over it. */
const composerIsCovered = page => page.evaluate(() => {
    const composer = document.getElementById('form_sheld');
    const box = composer.getBoundingClientRect();
    const hit = document.elementsFromPoint(box.left + box.width / 2, box.top + 3).find(element => !element.closest('#toast-container, #sb-toast-overlay'));
    return !composer.contains(hit);
});

async function togglePanel(page, toggle, open) {
    await page.locator(toggle).click();
    if (open) {
        await expect(page.locator(toggle)).toHaveClass(/\bsb-settings-active\b/);
        await expect.poll(() => composerIsCovered(page)).toBe(true);
    } else {
        await expect(page.locator(toggle)).not.toHaveClass(/\bsb-settings-active\b/);
        await expect.poll(() => composerIsCovered(page)).toBe(false);
    }
}

/** Reads the distance of the toast from the window edge on every frame, from now until `stopWatching`. */
const watchToast = page => page.evaluate(() => {
    const vh = document.documentElement.clientHeight;
    window.qaToastGaps = [];
    const tick = () => {
        const rect = document.querySelector('#sb-toast-overlay > .sb-form-toast:not(.sb-toast-measure)')?.getBoundingClientRect();
        if (rect) {
            window.qaToastGaps.push(Math.round(vh - rect.bottom));
        }
        window.qaToastFrame = requestAnimationFrame(tick);
    };
    tick();
});

const stopWatching = page => page.evaluate(() => {
    cancelAnimationFrame(window.qaToastFrame);
    return window.qaToastGaps;
});

/**
 * Reads the bottom edge of the toast strip and of the notification strip on every frame, from now until `stopWatchingStrips`.
 * A strip counts while it holds a card that is shown: a toast that is only being measured sits in one of them for a moment.
 */
const watchStrips = page => page.evaluate(() => {
    const vh = document.documentElement.clientHeight;
    window.qaStripGaps = { overlay: [], notifications: [] };
    const strips = [
        ['overlay', '#sb-toast-overlay', '#sb-toast-overlay > .sb-form-toast:not(.sb-toast-measure)'],
        ['notifications', '#toast-container', '#toast-container > .sb-form-notification'],
    ];
    const tick = () => {
        for (const [key, strip, card] of strips) {
            const rect = document.querySelector(strip)?.getBoundingClientRect();
            if (rect && rect.height > 0 && document.querySelector(card)) {
                window.qaStripGaps[key].push(Math.round(vh - rect.bottom));
            }
        }
        window.qaStripFrame = requestAnimationFrame(tick);
    };
    tick();
});

const stopWatchingStrips = page => page.evaluate(() => {
    cancelAnimationFrame(window.qaStripFrame);
    return window.qaStripGaps;
});

for (const viewport of VIEWPORTS) {
    test.describe(`at ${viewport.width}px`, () => {
        for (const [name, toggle] of PANELS) {
            test(`a toast sits 24px and a notification 4px from the window edge while ${name} covers the composer`, async ({ page }) => {
                await openChat(page, viewport);

                // With nothing over the composer, the composer is the docked bar that they sit above.
                await showToast(page);
                await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
                const docked = await measure(page);
                expect(docked.toast, 'a toast keeps 24px from the composer').toBe(docked.composer + 24);
                await clearMessages(page);
                await showNotification(page);
                await expect.poll(() => measure(page)).toMatchObject({ note: docked.composer + 4 });
                await clearMessages(page);
                await showToast(page);
                await showNotification(page);
                await expect.poll(() => measure(page)).toMatchObject({ toast: docked.composer + 24 });
                const dockedStack = await measure(page);
                await clearMessages(page);

                await togglePanel(page, toggle, true);

                await showToast(page);
                // The strip's own edge is what clips the toast while it slides in, so it moves with the toast.
                await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
                await clearMessages(page);

                await showNotification(page);
                await expect.poll(() => measure(page)).toMatchObject({ note: 4 });
                await clearMessages(page);

                await showToast(page);
                await showNotification(page);
                await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
                const stack = await measure(page);
                expect(stack.between, 'the notification is as far beyond the toast as it is above the composer').toBe(dockedStack.between);
                await clearMessages(page);

                // The composer is the docked bar again once the panel is gone.
                await togglePanel(page, toggle, false);
                await showToast(page);
                await expect.poll(() => measure(page)).toMatchObject({ toast: docked.composer + 24 });
            });
        }

        test('a toast that is on screen eases to the edge when a panel opens over the composer, and back when it closes', async ({ page }) => {
            await openChat(page, viewport);
            await showToast(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
            const { composer } = await measure(page);
            const [, toggle] = PANELS[0];

            await watchToast(page);
            await togglePanel(page, toggle, true);
            await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
            const opening = await stopWatching(page);
            expect(opening.at(0)).toBe(composer + 24);
            expect(opening.at(-1)).toBe(24);
            expect(opening.filter(gap => gap > 24 && gap < composer + 24).length, 'it glides, and does not jump').toBeGreaterThan(2);
            expect(opening, 'and only one way').toEqual([...opening].sort((first, second) => second - first));

            await watchToast(page);
            await togglePanel(page, toggle, false);
            await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
            const closing = await stopWatching(page);
            expect(closing.at(-1)).toBe(composer + 24);
            expect(closing.filter(gap => gap > 24 && gap < composer + 24).length, 'it glides, and does not jump').toBeGreaterThan(2);
            expect(closing, 'and only one way').toEqual([...closing].sort((first, second) => first - second));
        });

        test('a notification that is on screen eases the same way, alone and beyond a toast', async ({ page }) => {
            await openChat(page, viewport);
            await showNotification(page);
            await expect.poll(() => measure(page)).toMatchObject({ note: expect.any(Number) });
            const { composer } = await measure(page);
            const [, toggle] = PANELS[0];

            await watchStrips(page);
            await togglePanel(page, toggle, true);
            await expect.poll(() => measure(page)).toMatchObject({ note: 4 });
            const alone = await stopWatchingStrips(page);
            expect(alone.notifications.at(0)).toBe(composer);
            expect(alone.notifications.at(-1)).toBe(0);
            expect(alone.notifications.filter(gap => gap > 0 && gap < composer).length, 'it glides, and does not jump').toBeGreaterThan(2);

            await showToast(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
            const stacked = await measure(page);
            await watchStrips(page);
            await togglePanel(page, toggle, false);
            await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
            const closing = await stopWatchingStrips(page);
            const settledStack = await measure(page);
            expect(settledStack.between, 'the notification keeps its distance beyond the toast').toBe(stacked.between);
            expect(closing.overlay.filter(gap => gap > 0 && gap < composer).length, 'the toasts glide').toBeGreaterThan(2);
            expect(closing.notifications.filter(gap => gap > 0 && gap < closing.notifications.at(-1)).length, 'the notifications glide with them').toBeGreaterThan(2);
        });

        test('a message that is shown while a panel is open appears at the edge, and never above the composer first', async ({ page }) => {
            await openChat(page, viewport);
            await togglePanel(page, PANELS[0][1], true);

            await watchStrips(page);
            await showToast(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
            await clearMessages(page);
            await showNotification(page);
            await expect.poll(() => measure(page)).toMatchObject({ note: 4 });
            const gaps = await stopWatchingStrips(page);
            expect(gaps.overlay.length).toBeGreaterThan(0);
            expect(gaps.notifications.length).toBeGreaterThan(0);
            expect(new Set(gaps.overlay), 'the toast strip is at the window edge from its first frame').toEqual(new Set([0]));
            expect(new Set(gaps.notifications), 'the notification strip is at the window edge from its first frame').toEqual(new Set([0]));
        });
    });
}

test.describe('whichever surface covers the composer', () => {
    /** A fixed element at the bottom of the window, over the composer, that no list of panels knows. */
    const addSurface = (page, style) => page.evaluate((css) => {
        const surface = document.createElement('div');
        surface.id = 'qa-surface';
        surface.style.cssText = `position: fixed; z-index: 500; background: rgb(40, 40, 60); ${css}`;
        document.body.append(surface);
    }, style);
    const removeSurface = page => page.evaluate(() => document.getElementById('qa-surface')?.remove());
    /** Two frames after a change, which is when the page has looked at it. */
    const afterFrames = page => page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 400)));
    }));

    test('moves a toast that is on screen to the edge, and back when it goes', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const { composer } = await measure(page);

        await addSurface(page, 'left: 0; right: 0; bottom: 0; height: 320px;');
        await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
        await removeSurface(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
    });

    test('does not count a menu over a small part of its top edge', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const before = await measure(page);
        const left = await page.evaluate(() => document.getElementById('form_sheld').getBoundingClientRect().left);

        await addSurface(page, `left: ${left}px; width: 120px; bottom: ${before.composer - 60}px; height: 120px;`);
        await afterFrames(page);
        expect(await measure(page)).toMatchObject({ toast: before.toast });
    });

    test('does not count an element that takes no pointer events, which is not in the way of the composer', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const before = await measure(page);

        await addSurface(page, 'left: 0; right: 0; bottom: 0; height: 320px; pointer-events: none;');
        await afterFrames(page);
        expect(await measure(page)).toMatchObject({ toast: before.toast });
    });
});
