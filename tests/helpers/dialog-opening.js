import { expect } from '@playwright/test';

export const MOTION = { reducedMotion: 'no-preference' };

/**
 * Records every open Popup on each animation frame. The first frame after the opening task shows what the
 * first paint shows. `offsetWidth` and `offsetHeight` read the layout size, so the opening scale does not change them.
 */
export async function installOpeningSampler(page) {
    expect(await page.evaluate(() => document.body.classList.contains('reduced-motion')), 'these checks need motion on').toBe(false);
    await page.evaluate(() => {
        window.__openingFrames = [];
        const tick = () => {
            for (const dlg of document.querySelectorAll('dialog.popup[open]:not([closing])')) {
                window.__openingFrames.push({
                    id: dlg.dataset.id,
                    width: dlg.offsetWidth,
                    height: dlg.offsetHeight,
                    response: dlg.querySelector('.popup-controls > .menu_button')?.offsetWidth ?? 0,
                });
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}

export async function closePopups(page) {
    await page.evaluate(async () => {
        const { Popup } = await import('/scripts/popup.js');
        for (const popup of [...Popup.util.popups].reverse()) await popup.completeCancelled();
    });
}

/** `open` starts the Popup. It may wait for the end of the opening animation; the sampler keeps the earlier frames. */
export async function expectOpensAtFinalSize(page, name, open, { keepOpen = false } = {}) {
    await page.evaluate(() => { window.__openingFrames.length = 0; });
    await open();
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    // `onOpen` runs right after the animation, so read the settled size later.
    await page.waitForTimeout(200);
    const frames = await page.evaluate(() => {
        const id = [...document.querySelectorAll('dialog.popup[open]:not([closing])')].at(-1)?.dataset.id;
        return window.__openingFrames.filter(frame => frame.id === id);
    });
    const [first, last] = [frames[0], frames.at(-1)];
    expect(first, `${name}: the sampler saw the dialog`).toBeTruthy();
    for (const [label, key] of [['width', 'width'], ['height', 'height'], ['first response width', 'response']]) {
        expect.soft(Math.abs(first[key] - last[key]), `${name}: ${label} goes ${first[key]} -> ${last[key]}`).toBeLessThanOrEqual(1);
    }
    if (!keepOpen) await closePopups(page);
}
