/**
 * The test for "this open surface shows something", as a function that runs in the page (`locator.evaluate(visibleContent)`),
 * so it takes everything from its argument and imports nothing. No Playwright import.
 */

/**
 * What a root shows, or `null` when it shows nothing. A root counts when it is itself a visible control (a container that
 * is only focusable by script, `tabindex="-1"`, is not one), holds a visible control,
 * holds a visible image, video or canvas that has a size of its own (a picture that has not loaded has none), or has text.
 * @param {Element} root
 * @returns {'control' | 'media' | 'text' | null}
 */
export function visibleContent(root) {
    const controls = 'button, input, select, textarea, a[href], [role="button"], [role="switch"], [tabindex]:not([tabindex="-1"])';
    const shown = element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const sized = element => {
        if (element instanceof HTMLImageElement) {
            return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
        }
        if (element instanceof HTMLVideoElement) {
            return element.videoWidth > 0 && element.videoHeight > 0;
        }
        return element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0;
    };
    if ([root, ...root.querySelectorAll(controls)].some(element => element.matches(controls) && shown(element))) {
        return 'control';
    }
    if ([root, ...root.querySelectorAll('img, video, canvas')].some(element => sized(element) && shown(element))) {
        return 'media';
    }
    return root.innerText.trim().length > 0 ? 'text' : null;
}
