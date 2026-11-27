/**
 * Loads a panel once on demand. Indexing can prepare it without activating polling
 * or requests, and closing it while loading prevents a late activation.
 * @param {() => Promise<{onActivate?: Function, onDeactivate?: Function}>} load
 * @returns {{ensureReady: Function, activate: Function, deactivate: Function}}
 */
export function createDeferredPanel(load) {
    let pending;
    let panel;
    let active = false;
    let activated = false;

    const ensureReady = () => {
        if (panel) return Promise.resolve(panel);
        pending ??= Promise.resolve().then(load).then(result => {
            panel = result;
            return result;
        }).catch(error => {
            pending = undefined;
            throw error;
        });
        return pending;
    };

    return {
        ensureReady,
        async activate() {
            active = true;
            const result = await ensureReady();
            if (active && !activated) {
                activated = true;
                try {
                    result.onActivate?.();
                } catch (error) {
                    activated = false;
                    throw error;
                }
            }
        },
        deactivate() {
            active = false;
            if (activated) panel.onDeactivate?.();
            activated = false;
        },
    };
}

const SCROLLER = ':scope > .sb-shell-panel-scroller';
const holds = new WeakMap();

/**
 * Holds a settings page that a deferred module still has to build, so that its raw upstream rows never show. It is marked
 * busy for assistive technology, and so is each direct child of its scroller, which the stylesheet hides while it is
 * `aria-busy` (`.sb-shell-panel-scroller > [aria-busy='true']` in sillybunny-tabs.css). Call it when the page is
 * registered, before it can be shown. Calling it again marks a page that was released or that failed busy again.
 * @param {HTMLElement} panel The `section` that holds the scroller.
 */
export function holdPanel(panel) {
    let hold = holds.get(panel);
    if (!hold) {
        const scroller = panel.querySelector(SCROLLER);
        hold = { targets: scroller ? [...scroller.children] : [], page: null };
        holds.set(panel, hold);
    }
    panel.setAttribute('aria-busy', 'true');
    for (const target of hold.targets) target.setAttribute('aria-busy', 'true');
}

/** @param {HTMLElement} panel */
export const isPanelHeld = panel => holds.has(panel);

/**
 * Removes the status page of a held page. Returns whether the keyboard focus was inside it, so that the caller can put the
 * focus somewhere that stays.
 * @param {HTMLElement} panel
 * @returns {boolean}
 */
export function clearPanelPage(panel) {
    const hold = holds.get(panel);
    const page = hold?.page;
    if (!page) return false;
    hold.page = null;
    const focused = page.element.contains(document.activeElement);
    page.release?.();
    page.element.remove();
    return focused;
}

/**
 * Shows a status page first in a held page, in place of the one that was there. The held rows stay hidden.
 * @param {HTMLElement} panel
 * @param {{ element: HTMLElement, release?: () => void }} page
 * @returns {boolean} Whether the keyboard focus was inside the page that this one replaces.
 */
export function showPanelPage(panel, page) {
    if (!holds.has(panel)) holdPanel(panel);
    const focused = clearPanelPage(panel);
    holds.get(panel).page = page;
    panel.querySelector(SCROLLER)?.prepend(page.element);
    return focused;
}

/**
 * Shows a held page: the status page goes and every busy mark with it.
 * @param {HTMLElement} panel
 * @returns {boolean} Whether the keyboard focus was inside the status page.
 */
export function releasePanel(panel) {
    const hold = holds.get(panel);
    if (!hold) return false;
    const focused = clearPanelPage(panel);
    holds.delete(panel);
    panel.removeAttribute('aria-busy');
    for (const target of hold.targets) target.removeAttribute('aria-busy');
    return focused;
}
