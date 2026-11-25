/**
 * Resolves when a rule of a stylesheet that has just loaded applies. WebKit applies a sheet that `loadStylesheetAsync()`
 * resolved a frame or two after its load event, and the popover measures its content once, when it opens: opened too early,
 * the chooser is 49px high, sits low, and grows down out of the window when the sheet arrives.
 */

/** About a fifth of a second. A sheet that has not applied by then (it failed, or the browser is stalled) does not keep the chooser shut. */
export const STYLE_WAIT_FRAMES = 12;

/**
 * @param {string} className A class whose rule sets the property.
 * @param {string} property The CSS property that the rule sets, in the form `getComputedStyle()` reads it.
 * @param {string} value What the rule sets it to.
 * @returns {Promise<boolean>} Whether the rule applied; false when the wait ran out.
 */
export function whenStyled(className, property, value) {
    const probe = document.createElement('div');
    probe.className = className;
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position: fixed; visibility: hidden; pointer-events: none;';
    document.body.append(probe);
    return new Promise((resolve) => {
        let frames = 0;
        const check = () => {
            const applied = getComputedStyle(probe).getPropertyValue(property) === value;
            if (applied || frames++ >= STYLE_WAIT_FRAMES) {
                probe.remove();
                resolve(applied);
                return;
            }
            requestAnimationFrame(check);
        };
        check();
    });
}
