/**
 * The pause before a bubble of a reply, which makes a reply read as typed. A page that is not visible has nobody to
 * watch the typing, and a tab that is about to close fires `visibilitychange` first, so the pause ends when the page
 * becomes hidden: the rest of the reply is written and saved at once, before the tab is gone. This file imports
 * nothing, so that a test can drive it with a fake document.
 */

/**
 * @param {number} delayMs
 * @param {object} [options]
 * @param {Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>|undefined} [options.doc]
 * @returns {Promise<void>} Resolves when the delay is over or the page is hidden, at once for a page that is hidden already.
 */
export function waitForDelay(delayMs, { doc = globalThis.document } = {}) {
    if (doc?.visibilityState === 'hidden') {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let timer = null;
        const finish = () => {
            clearTimeout(timer);
            doc?.removeEventListener('visibilitychange', onVisibilityChange);
            resolve();
        };
        const onVisibilityChange = () => {
            if (doc.visibilityState === 'hidden') {
                finish();
            }
        };
        doc?.addEventListener('visibilitychange', onVisibilityChange);
        timer = setTimeout(finish, delayMs);
    });
}
