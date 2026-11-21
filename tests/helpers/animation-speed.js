/**
 * Slows every Web Animation the page plays from now on, so a test can read a half-finished slide.
 * It works in every browser, unlike the Chromium-only `Animation.setPlaybackRate` DevTools call.
 * The motion helper plays through `Element.animate`, so patching it reaches each sheet and panel.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} rate Playback rate, for example 0.05 for twenty times slower.
 */
export async function slowAnimations(page, rate) {
    await page.evaluate(playbackRate => {
        // The patched method reads the rate from here, so a second call with another rate takes effect.
        window.qaAnimationRate = playbackRate;
        if (!window.qaOriginalAnimate) {
            const original = Element.prototype.animate;
            window.qaOriginalAnimate = original;
            Element.prototype.animate = function slowedAnimate(...args) {
                const animation = original.apply(this, args);
                animation.playbackRate = window.qaAnimationRate;
                return animation;
            };
        }
        for (const animation of document.getAnimations()) animation.playbackRate = playbackRate;
    }, rate);
}

/** Puts the animation speed back to normal, including the animations that are still running. */
export async function restoreAnimationSpeed(page) {
    await page.evaluate(() => {
        if (window.qaOriginalAnimate) {
            Element.prototype.animate = window.qaOriginalAnimate;
            delete window.qaOriginalAnimate;
        }
        delete window.qaAnimationRate;
        for (const animation of document.getAnimations()) animation.playbackRate = 1;
    });
}
