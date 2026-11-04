/**
 * Records what each popup looks like in every animation frame, from the frame in which it is first open.
 * The sampler runs in `requestAnimationFrame`, which the browser calls just before it paints, so a frame
 * holds the DOM that the user sees. Only a popup that appears after `startPaintProbe` is recorded.
 */
export async function startPaintProbe(page) {
    await page.evaluate(() => {
        const preexisting = new Set([...document.querySelectorAll('dialog.popup')].map(dialog => dialog.dataset.id));
        const popups = new Map();
        const probe = { popups, stopped: false };
        window.__paintProbe = probe;

        const isShown = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const outline = element => `${element.tagName.toLowerCase()}.${[...element.classList].sort().join('.')}`;

        function describe(dialog) {
            const content = dialog.querySelector('.popup-content');
            const header = dialog.querySelector('.sb-dialog__header');
            const shown = [...dialog.querySelectorAll('*')].filter(isShown);
            return {
                opening: dialog.hasAttribute('opening'),
                opacity: Number(getComputedStyle(dialog).opacity),
                presentation: dialog.dataset.presentation ?? null,
                classes: [...dialog.classList].filter(name => name.startsWith('sb-')).sort(),
                looseLabels: shown.filter(element => element.matches('label.text_label')).length,
                looseFields: shown.filter(element => element.matches('input, textarea, select') && !element.closest('.ds-row')).length,
                rowTitles: shown.filter(element => element.matches('.ds-row-label')).map(element => element.textContent.trim()),
                rowSubtitles: shown.filter(element => element.matches('.ds-row-subtitle')).map(element => element.textContent.trim()),
                contentHeadings: content ? shown.filter(element => content.contains(element) && element.matches('h1, h2, h3, h4')).map(element => element.textContent.trim()) : [],
                outline: shown.filter(element => content?.contains(element)).map(outline),
                rowHeights: shown.filter(element => element.matches('.ds-row')).map(element => element.offsetHeight),
                headerOutline: shown.filter(element => header?.contains(element)).map(outline),
                okClasses: [...(dialog.querySelector('.popup-button-ok')?.classList ?? [])].sort(),
            };
        }

        function sample() {
            for (const dialog of document.querySelectorAll('dialog.popup[open]')) {
                const id = dialog.dataset.id;
                if (preexisting.has(id)) continue;
                if (!popups.has(id)) popups.set(id, []);
                popups.get(id).push(describe(dialog));
            }
            if (!probe.stopped) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
    });
}

/**
 * Stops the probe once the newest popup has finished opening and returns its frames.
 * @param {import('@playwright/test').Page} page
 * @param {number} [expectedPopups] How many popups open after the probe starts (a dialog opened from another one counts both).
 * @returns {Promise<Array<object>>} One entry per animation frame, in order.
 */
export async function stopPaintProbe(page, expectedPopups = 1) {
    await page.waitForFunction(expected => {
        const ids = [...window.__paintProbe.popups.keys()];
        if (ids.length < expected) return false;
        const dialog = document.querySelector(`dialog.popup[data-id="${ids.at(-1)}"]`);
        return Boolean(dialog?.hasAttribute('open')) && !dialog.hasAttribute('opening');
    }, expectedPopups, { timeout: 15000 });
    // Two more frames, so a change that lands after the opening animation is recorded as well.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    return page.evaluate(() => {
        const probe = window.__paintProbe;
        probe.stopped = true;
        const ids = [...probe.popups.keys()];
        return probe.popups.get(ids.at(-1));
    });
}

/**
 * The first Popup of a page can open without its animation in WebKit, and then the probe has nothing to prove.
 * One popup opened and closed first makes the next one animate.
 */
export async function warmUpPopups(page) {
    const id = await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const popup = new Popup('warm up', POPUP_TYPE.TEXT);
        const done = popup.show();
        popup.okButton.click();
        await done;
        return popup.id;
    });
    await page.waitForFunction(popupId => !document.querySelector(`dialog.popup[data-id="${popupId}"]`), id);
}

/** A page booted with reduced motion, as most dialog helpers do, gets motion back. */
export async function motionOn(page) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => {
        (await import('/scripts/power-user.js')).power_user.reduced_motion = false;
        document.body.classList.remove('reduced-motion');
    });
}
