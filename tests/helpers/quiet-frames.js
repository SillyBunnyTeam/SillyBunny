/**
 * Waits until the page paints steadily, so a test that counts or times the frames of a motion measures the motion
 * and not the work still running after the app is ready.
 *
 * WebKit keeps the main thread busy for several seconds after `APP_READY`, so its first frames come seconds apart
 * and a motion started then is measured as a stall. Chromium is quiet at once, so the wait costs it `frames` frames.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ frames?: number, maxGap?: number, timeout?: number }} [options]
 *   `frames`: how many frame gaps in a row must stay under `maxGap` (ms). `timeout` (ms) is how long to wait.
 * @returns {Promise<number>} How long the wait took, in ms.
 */
export async function waitForQuietFrames(page, { frames = 10, maxGap = 50, timeout = 20_000 } = {}) {
    const result = await page.evaluate(({ needed, limit, budget }) => new Promise((resolve) => {
        const startedAt = performance.now();
        const recentGaps = [];
        let quiet = 0;
        let previous = startedAt;
        let giveUp = null;
        const finish = (quietEnough) => {
            clearTimeout(giveUp);
            resolve({ quietEnough, waited: performance.now() - startedAt, recentGaps });
        };
        const tick = (now) => {
            const gap = now - previous;
            previous = now;
            recentGaps.push(Math.round(gap));
            if (recentGaps.length > needed) recentGaps.shift();
            quiet = gap < limit ? quiet + 1 : 0;
            if (quiet >= needed) return finish(true);
            if (now - startedAt > budget) return finish(false);
            requestAnimationFrame(tick);
        };
        // A page that paints no frame at all never reaches the check inside `tick`.
        giveUp = setTimeout(() => finish(false), budget + 1000);
        requestAnimationFrame(tick);
    }), { needed: frames, limit: maxGap, budget: timeout });

    if (!result.quietEnough) {
        throw new Error(`The page did not paint ${frames} frames in a row under ${maxGap} ms within ${timeout} ms. Latest frame gaps (ms): ${result.recentGaps.join(', ') || 'none'}`);
    }
    return result.waited;
}
