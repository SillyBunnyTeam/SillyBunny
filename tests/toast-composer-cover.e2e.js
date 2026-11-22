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
    const centre = rect => rect && Math.round((rect.left + rect.right) / 2);
    return {
        toast: toastBox && Math.round(vh - toastBox.bottom),
        note: noteBox && Math.round(vh - noteBox.bottom),
        overlay: overlay && Math.round(vh - overlay.bottom),
        composer: composer && Math.round(vh - composer.top),
        between: toastBox && noteBox ? Math.round(toastBox.top - noteBox.bottom) : null,
        toastCentre: centre(toastBox),
        noteCentre: centre(noteBox),
        composerCentre: centre(composer),
        windowCentre: Math.round(document.documentElement.clientWidth / 2),
        toastLeft: toastBox && Math.round(toastBox.left),
        toastRight: toastBox && Math.round(document.documentElement.clientWidth - toastBox.right),
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

/**
 * Records the transitions that start, as `id:property`, from now on. A transition that has run its course before the next
 * frame leaves no frame between its ends in an engine that stalls while a panel opens, and still fires its event.
 */
const recordTransitions = page => page.evaluate(() => {
    document.removeEventListener('transitionrun', window.qaRunListener, true);
    window.qaRuns = [];
    window.qaRunListener = event => window.qaRuns.push(`${event.target.id}:${event.propertyName}`);
    document.addEventListener('transitionrun', window.qaRunListener, true);
});

const transitionsRun = page => page.evaluate(() => window.qaRuns);

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

            await recordTransitions(page);
            await watchToast(page);
            await togglePanel(page, toggle, true);
            await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
            const opening = await stopWatching(page);
            expect(opening.at(0)).toBe(composer + 24);
            expect(opening.at(-1)).toBe(24);
            expect(await transitionsRun(page), 'it glides, and does not jump').toContain('sb-toast-overlay:bottom');
            expect(opening, 'and only one way').toEqual([...opening].sort((first, second) => second - first));

            await recordTransitions(page);
            await watchToast(page);
            await togglePanel(page, toggle, false);
            await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
            const closing = await stopWatching(page);
            expect(closing.at(-1)).toBe(composer + 24);
            expect(await transitionsRun(page), 'it glides, and does not jump').toContain('sb-toast-overlay:bottom');
            expect(closing, 'and only one way').toEqual([...closing].sort((first, second) => first - second));
        });

        test('a notification that is on screen eases the same way, alone and beyond a toast', async ({ page }) => {
            await openChat(page, viewport);
            await showNotification(page);
            await expect.poll(() => measure(page)).toMatchObject({ note: expect.any(Number) });
            const { composer } = await measure(page);
            const [, toggle] = PANELS[0];

            await recordTransitions(page);
            await watchStrips(page);
            await togglePanel(page, toggle, true);
            await expect.poll(() => measure(page)).toMatchObject({ note: 4 });
            const alone = await stopWatchingStrips(page);
            expect(alone.notifications.at(0)).toBe(composer);
            expect(alone.notifications.at(-1)).toBe(0);
            expect(await transitionsRun(page), 'it glides, and does not jump').toContain('toast-container:bottom');

            await showToast(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
            const stacked = await measure(page);
            await recordTransitions(page);
            await watchStrips(page);
            await togglePanel(page, toggle, false);
            await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
            const closing = await stopWatchingStrips(page);
            const settledStack = await measure(page);
            expect(settledStack.between, 'the notification keeps its distance beyond the toast').toBe(stacked.between);
            expect(await transitionsRun(page), 'the toasts and the notifications glide together').toEqual(expect.arrayContaining(['sb-toast-overlay:bottom', 'toast-container:margin-bottom']));
            expect(closing.notifications, 'and only one way').toEqual([...closing.notifications].sort((first, second) => first - second));
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

    test('moves a toast that is on screen to the edge when it covers the window under the top bar, and back when it goes', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const { composer } = await measure(page);
        const topBar = await page.evaluate(() => Math.round(document.getElementById('top-bar').getBoundingClientRect().bottom));

        await addSurface(page, `left: 0; right: 0; bottom: 0; top: ${topBar}px;`);
        await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
        await removeSurface(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
    });

    test('lifts a toast above it when it is docked at the bottom edge and wide, whichever element it is', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const { composer } = await measure(page);

        await addSurface(page, 'left: 0; right: 0; bottom: 0; height: 320px;');
        await expect.poll(() => measure(page)).toMatchObject({ toast: 320 + 24, overlay: 320 });
        await removeSurface(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
    });

    test('does not lift a toast above a narrow panel that is docked at one side, which is no bar', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const before = await measure(page);

        await addSurface(page, 'left: 0; width: 320px; bottom: 0; height: 320px;');
        await afterFrames(page);
        expect(await measure(page)).toMatchObject({ toast: before.toast });
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

/** How far the top of an element is from the bottom edge of the window. */
const heightOf = (page, selector) => page.evaluate(sel => Math.round(document.documentElement.clientHeight - document.querySelector(sel).getBoundingClientRect().top), selector);

/** Waits until the element has stopped moving, which a sheet that springs in has not when it appears. */
const stillAt = (page, selector) => expect.poll(() => page.evaluate(sel => new Promise((resolve) => {
    const read = () => Math.round(document.documentElement.clientHeight - document.querySelector(sel).getBoundingClientRect().top);
    const first = read();
    let frames = 0;
    const tick = () => {
        frames += 1;
        if (frames >= 15) {
            resolve(read() === first);
        } else {
            requestAnimationFrame(tick);
        }
    };
    requestAnimationFrame(tick);
}), selector)).toBe(true);

const openActionSheet = page => page.evaluate(async () => {
    const trigger = document.getElementById('sb-bottom-chat-bar') ?? document.getElementById('send_but');
    const { openActionMenu } = await import('/scripts/sillybunny-action-menu.js');
    openActionMenu({ trigger, title: 'Probe menu', sections: [{ items: Array.from({ length: 6 }, (_, index) => ({ label: `Item ${index}`, onSelect: () => {} })) }] });
});

/** A side panel through the engine, with the shell narrowed as the engine's own spec does, so that the composer has room to move. */
const openSidePanel = page => page.evaluate(async () => {
    document.documentElement.style.setProperty('--sheldWidth', '55vw');
    const wrapper = document.createElement('div');
    wrapper.id = 'visual-novel-wrapper';
    document.body.append(wrapper);
    const holdVisible = document.createElement('style');
    holdVisible.textContent = '#visual-novel-wrapper { display: flex !important; }';
    document.head.append(holdVisible);
    const power = await import('/scripts/power-user.js');
    power.power_user.movingUIState = {};
    const source = document.createElement('section');
    source.id = 'qa-side-panel';
    const control = document.createElement('button');
    control.textContent = 'Panel control';
    source.append(control);
    document.getElementById('movingDivs').append(source);
    const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
    window.qaSidePanel = sidePanels.registerSidePanel({ id: 'qa-side-panel', element: source, title: 'Test Panel', defaultSide: 'left', onClose: () => {} });
    await window.qaSidePanel.open({});
});

const closeSidePanel = page => page.evaluate(() => window.qaSidePanel.close());
const SIDE_PANEL = '.sb-side-panel[data-sb-side-panel-id="qa-side-panel"]';

test.describe('a sheet at the bottom of a phone is a bottom bar', () => {
    const PHONE = VIEWPORTS[1];

    test('the action menu over the composer: a toast sits 24px and a notification 4px above its top, and they come back down when it closes', async ({ page }) => {
        await openChat(page, PHONE);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const { composer } = await measure(page);

        await openActionSheet(page);
        await expect(page.locator('.sb-action-sheet')).toBeVisible();
        await stillAt(page, '.sb-action-sheet');
        const sheet = await heightOf(page, '.sb-action-sheet');
        expect(sheet, 'the sheet reaches higher than the composer').toBeGreaterThan(composer);
        await expect.poll(() => measure(page)).toMatchObject({ toast: sheet + 24, overlay: sheet });
        await clearMessages(page);
        await showNotification(page);
        await expect.poll(() => measure(page)).toMatchObject({ note: sheet + 4 });
        await clearMessages(page);
        await showToast(page);
        await showNotification(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: sheet + 24 });

        await page.keyboard.press('Escape');
        await expect(page.locator('.sb-action-sheet')).toBeHidden();
        await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
    });

    test('the sheet of a side panel on top of the composer: a toast sits 24px and a notification 4px above its top', async ({ page }) => {
        await openChat(page, PHONE);
        await showToast(page);
        await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
        const { composer } = await measure(page);

        await openSidePanel(page);
        await expect(page.locator(`${SIDE_PANEL}.sb-side-panel--sheet`)).toBeVisible();
        await stillAt(page, `${SIDE_PANEL}.sb-side-panel--sheet`);
        const sheet = await heightOf(page, `${SIDE_PANEL}.sb-side-panel--sheet`);
        expect(sheet, 'the sheet is on top of the composer').toBeGreaterThan(composer);
        await expect.poll(() => measure(page)).toMatchObject({ toast: sheet + 24, overlay: sheet });
        await clearMessages(page);
        await showNotification(page);
        await expect.poll(() => measure(page)).toMatchObject({ note: sheet + 4 });

        await clearMessages(page);
        await showToast(page);
        await closeSidePanel(page);
        await expect(page.locator(`${SIDE_PANEL}.sb-side-panel--sheet`)).toBeHidden();
        await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
    });
});

test.describe('a message is centred on the bar that it sits above', () => {
    const DESKTOP = { width: 1024, height: 768 };

    test('on the composer that a docked side panel pushes aside, and on the window at the window edge', async ({ page }) => {
        await openChat(page, DESKTOP);
        await openSidePanel(page);
        await expect(page.locator(SIDE_PANEL)).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.getElementById('form_sheld').getBoundingClientRect().left)).toBeGreaterThan(200);

        await showToast(page);
        const docked = await measure(page);
        expect(Math.abs(docked.composerCentre - docked.windowCentre), 'the composer is off to the side').toBeGreaterThan(40);
        await expect.poll(async () => Math.abs((await measure(page)).toastCentre - docked.composerCentre)).toBeLessThanOrEqual(1);
        await clearMessages(page);
        await showNotification(page);
        await expect.poll(async () => Math.abs((await measure(page)).noteCentre - docked.composerCentre)).toBeLessThanOrEqual(1);
        await clearMessages(page);

        // Backend covers the composer, so the message sits at the window edge, and the window is what it centres on.
        await showToast(page);
        await closeSidePanel(page);
        await expect(page.locator(SIDE_PANEL)).toBeHidden();
        await togglePanel(page, PANELS[0][1], true);
        await expect.poll(async () => Math.abs((await measure(page)).toastCentre - docked.windowCentre)).toBeLessThanOrEqual(1);
        await expect.poll(() => measure(page)).toMatchObject({ toast: 24 });
    });

    test('and goes along when the panel opens and closes while the toast is on screen', async ({ page }) => {
        await openChat(page, DESKTOP);
        await showToast(page);
        const before = await measure(page);
        expect(Math.abs(before.toastCentre - before.windowCentre)).toBeLessThanOrEqual(1);
        await openSidePanel(page);
        await expect.poll(async () => {
            const now = await measure(page);
            return Math.abs(now.toastCentre - now.composerCentre);
        }).toBeLessThanOrEqual(1);
        expect((await measure(page)).composerCentre).not.toBe(before.windowCentre);
        await closeSidePanel(page);
        await expect.poll(async () => Math.abs((await measure(page)).toastCentre - before.windowCentre)).toBeLessThanOrEqual(1);
    });

    test('and stays 12px inside the window, however far the composer would take it', async ({ page }) => {
        await openChat(page, DESKTOP);
        await showToast(page);
        const shiftTo = value => page.evaluate(shift => document.getElementById('sb-toast-overlay').style.setProperty('--sb-toast-bar-shift', shift), value);
        // A shift that no composer has, to reach the clamp.
        await shiftTo('900px');
        await expect.poll(async () => (await measure(page)).toastRight).toBe(12);
        await shiftTo('-900px');
        await expect.poll(async () => (await measure(page)).toastLeft).toBe(12);
        await shiftTo('20px');
        await expect.poll(async () => (await measure(page)).toastCentre).toBe((await measure(page)).windowCentre + 20);
    });
});

test.describe('under a modal dialog', () => {
    const openPopup = page => page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        window.qaPopup = new Popup('<h3>A Popup</h3><p>Text</p>', POPUP_TYPE.TEXT, '');
        void window.qaPopup.show();
    });

    for (const viewport of VIEWPORTS) {
        test(`a bottom notification sits 4px from the window edge, because the dimming covers the composer, at ${viewport.width}px`, async ({ page }) => {
            await openChat(page, viewport);
            await showNotification(page);
            await expect.poll(() => measure(page)).toMatchObject({ note: expect.any(Number) });
            const { composer } = await measure(page);

            await openPopup(page);
            await expect(page.locator('dialog.popup[open]')).toBeVisible();
            await expect.poll(() => measure(page)).toMatchObject({ note: 4 });

            await page.evaluate(() => window.qaPopup.completeCancelled());
            await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
            await expect.poll(() => measure(page)).toMatchObject({ note: composer + 4 });
        });
    }

    test('a toast in the dialog stays in it, as before', async ({ page }) => {
        await openChat(page, VIEWPORTS[0]);
        await openPopup(page);
        await expect(page.locator('dialog.popup[open]')).toBeVisible();
        await showToast(page);
        const inside = await page.evaluate(() => {
            const overlay = document.getElementById('sb-toast-overlay');
            const dialog = overlay.closest('dialog');
            const toast = overlay.querySelector('.sb-form-toast').getBoundingClientRect();
            const box = dialog.getBoundingClientRect();
            return { inDialog: overlay.hasAttribute('data-sb-toast-in-dialog'), within: toast.bottom <= box.bottom && toast.top >= box.top };
        });
        expect(inside).toEqual({ inDialog: true, within: true });
    });
});

test.describe('a composer that MovingUI has moved', () => {
    const moveComposer = page => page.evaluate(() => {
        document.body.classList.add('movingUI');
        const shell = document.getElementById('sheld');
        for (const [property, value] of [['top', '60px'], ['height', '600px'], ['left', '80px'], ['width', '700px'], ['bottom', 'auto'], ['margin', 'unset']]) {
            shell.style.setProperty(property, value, 'important');
        }
    });
    const moveBack = page => page.evaluate(() => {
        const shell = document.getElementById('sheld');
        for (const property of ['top', 'height', 'left', 'width', 'bottom', 'margin']) {
            shell.style.removeProperty(property);
        }
        document.body.classList.remove('movingUI');
    });

    for (const viewport of VIEWPORTS) {
        test(`is not a bottom bar: a toast sits 24px and a notification 4px from the window edge, at ${viewport.width}px`, async ({ page }) => {
            await openChat(page, viewport);
            await showToast(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: expect.any(Number) });
            const { composer } = await measure(page);

            await moveComposer(page);
            await expect.poll(async () => (await measure(page)).composer, 'the composer floats above the window edge').toBeGreaterThan(composer + 100);
            await expect.poll(() => measure(page)).toMatchObject({ toast: 24, overlay: 0 });
            await clearMessages(page);
            await showNotification(page);
            await expect.poll(() => measure(page)).toMatchObject({ note: 4 });

            await clearMessages(page);
            await showToast(page);
            await moveBack(page);
            await expect.poll(() => measure(page)).toMatchObject({ toast: composer + 24 });
        });
    }
});
