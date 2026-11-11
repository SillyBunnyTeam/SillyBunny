/**
 * Open and wait steps that family files share. Each is copied from the spec that already does it (named on the
 * function), so a selector here is one that a passing spec uses. This module imports nothing from Playwright, so the
 * registry loads in Jest.
 */

import { BACKENDS, DEFAULT_BACKEND } from './schema.js';
import { fixture as LOGIT_BIAS } from './needs/logit-bias.js';

const surfaceLabels = new WeakMap();

/**
 * Names the surface that a page is showing, so that a wait that times out in a step says which surface it was waiting for.
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 */
export function labelPage(page, label) {
    surfaceLabels.set(page, label);
}

/**
 * Waits for the fonts and two frames, then until no animation or transition that has an end is running inside `root`
 * (an animation that repeats forever, such as a spinner, is ignored), so that a measured box is the settled one.
 * The wait is bounded: after `timeout` ms it fails with the animations that are still running and the surface's label.
 * @param {import('@playwright/test').Page} page
 * @param {{ root?: string, timeout?: number }} [options] `root` is a selector; the whole body when omitted.
 */
export async function settle(page, { root = 'body', timeout = 5000 } = {}) {
    await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    // A registry root may use selector syntax that only Playwright knows (`:visible`, `:has-text()`), which the page cannot
    // query. Such a root is resolved here once; a CSS root is queried in the page on every frame, so that it follows an
    // element that the app builds again while it settles.
    const isCss = await page.evaluate((selector) => {
        try {
            document.querySelector(selector);
            return true;
        } catch {
            return false;
        }
    }, root);
    const resolved = isCss ? [] : await page.locator(root).elementHandles();
    const running = await page.evaluate(({ root, timeout, isCss, resolved }) => new Promise(resolve => {
        const scopes = () => {
            const found = isCss ? [...document.querySelectorAll(root)] : resolved.filter(node => node.isConnected);
            return found.length ? found : [document.body];
        };
        const pending = () => document.getAnimations().filter(animation => {
            const target = animation.effect?.target;
            const timing = animation.effect?.getComputedTiming?.();
            return target && timing && Number.isFinite(timing.endTime)
                && (animation.playState === 'running' || animation.playState === 'pending')
                && scopes().some(scope => scope.contains(target));
        });
        const describe = animation => {
            const target = animation.effect.target;
            const name = animation.animationName ?? animation.transitionProperty ?? 'animation';
            return `${target.localName}${target.id ? `#${target.id}` : ''} ${name}`;
        };
        const started = performance.now();
        const check = () => {
            const list = pending();
            if (list.length === 0 || performance.now() - started > timeout) {
                resolve(list.map(describe));
                return;
            }
            requestAnimationFrame(check);
        };
        check();
    }), { root, timeout, isCss, resolved });
    if (running.length) {
        throw new Error(`${surfaceLabels.get(page) ?? 'The page'}: ${running.length} animation(s) still running in ${root} after ${timeout} ms: ${running.slice(0, 5).join(', ')}.`);
    }
}

/**
 * Opens a settings page of the shell and waits until its panel is shown.
 * From `sillybunny-settings-consistency.e2e.js` (`openSettingsTab`).
 * @param {import('@playwright/test').Page} page
 * @param {{ shell: 'left' | 'right', tab: string }} target `left` is Backend, `right` is Customize.
 */
export async function openSettingsTab(page, { shell, tab }) {
    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
    await page.locator(`button[data-sb-settings-tab="${tab}"]`).evaluate(button => button.click());
    await page.waitForFunction(id => document.querySelector(`[data-sb-panel="${id}"]`)?.getAttribute('aria-hidden') === 'false', tab);
    await page.locator(`[data-sb-panel="${tab}"] .sb-shell-panel-scroller`).evaluate(scroller => { scroller.scrollTop = 0; });
    await settle(page, { root: `[data-sb-panel="${tab}"]` });
}

/**
 * Opens a tab of the Characters shell (`list`, `world-info`, `persona`, and the rest) and returns once the shell has
 * handled the request. From `world-info-editor.e2e.js` and `persona-editor.e2e.js`.
 * @param {import('@playwright/test').Page} page
 * @param {string} tab
 */
export async function openCharactersTab(page, tab) {
    await page.evaluate(tab => window.SillyBunnyShell.openTab('characters', tab), tab);
}

/**
 * Picks the backend that Connections, Sampling and Presets differ by. From `sillybunny-backend-settings.e2e.js`
 * (`selectBackend`).
 * @param {import('@playwright/test').Page} page
 * @param {string} [backendId] A key of `BACKENDS`.
 */
export async function selectBackend(page, backendId = DEFAULT_BACKEND) {
    const backend = BACKENDS[backendId];
    if (!backend) {
        throw new Error(`Unknown backend "${backendId}". Known: ${Object.keys(BACKENDS).join(', ')}.`);
    }
    await page.evaluate(({ api, source }) => {
        window.$('#main_api').val(api).trigger('change');
        if (source) {
            window.$(api === 'openai' ? '#chat_completion_source' : '#textgen_type').val(source).trigger('change');
        }
    }, backend);
    // The app has shown the backend once its connection block is shown, which is later than the select taking the value.
    try {
        await page.waitForFunction(({ api, connector }) => document.querySelector('#main_api')?.value === api
            && document.querySelector(connector) !== null
            && getComputedStyle(document.querySelector(connector)).display !== 'none', backend, { timeout: 10_000 });
    } catch {
        throw new Error(`${surfaceLabels.get(page) ?? 'The page'}: the app did not show ${backend.connector} for the ${backendId} backend.`);
    }
}

/**
 * Clicks a trigger that opens an action menu or sheet, then the item of that name.
 * From `world-info-editor.e2e.js` (`selectSettings`).
 * @param {import('@playwright/test').Page} page
 * @param {string} trigger A selector.
 * @param {string} item The item's name, as the menu shows it.
 */
export async function chooseMenuItem(page, trigger, item) {
    await page.locator(trigger).first().click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: item, exact: true }).click();
}

/**
 * Opens every expander of a page: closed `details`, collapsed inline drawers, and `aria-expanded` buttons whose target
 * is hidden (a tab also carries `aria-expanded`, but it is not an expander and is left alone). It repeats until none is left, because opening one can reveal the next, then fails if one remains.
 * @param {import('@playwright/test').Page} page
 * @param {string} scroller A selector for the element that holds the expanders.
 */
export async function expandAll(page, scroller) {
    for (let pass = 0; pass < 4; pass++) {
        const opened = await page.evaluate(selector => {
            const root = document.querySelector(selector);
            let clicks = 0;
            for (const details of root.querySelectorAll('details:not([open])')) {
                details.open = true;
                clicks++;
            }
            for (const drawer of root.querySelectorAll('.inline-drawer')) {
                const content = drawer.querySelector(':scope > .inline-drawer-content');
                if (content && getComputedStyle(content).display === 'none' && drawer.getClientRects().length) {
                    drawer.querySelector(':scope > .inline-drawer-toggle')?.click();
                    clicks++;
                }
            }
            for (const button of root.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"]')) {
                const target = button.getAttribute('aria-controls') && document.getElementById(button.getAttribute('aria-controls'));
                const hidden = target && (target.hidden || getComputedStyle(target).display === 'none');
                if (!button.hasAttribute('aria-haspopup') && hidden) {
                    button.click();
                    clicks++;
                }
            }
            return clicks;
        }, scroller);
        await waitForStableExpanders(page, scroller);
        if (opened === 0) {
            break;
        }
    }
    const remaining = await page.evaluate(selector => {
        const root = document.querySelector(selector);
        const describe = element => `${element.localName}${element.id ? `#${element.id}` : ''}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).join('.')}` : ''}`;
        const left = [];
        for (const details of root.querySelectorAll('details:not([open])')) {
            if (details.getClientRects().length) {
                left.push(`${describe(details)} is closed`);
            }
        }
        for (const drawer of root.querySelectorAll('.inline-drawer')) {
            const content = drawer.querySelector(':scope > .inline-drawer-content');
            if (content && getComputedStyle(content).display === 'none' && drawer.getClientRects().length) {
                left.push(`${describe(drawer)} has hidden content`);
            }
        }
        for (const button of root.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"]')) {
            const target = button.getAttribute('aria-controls') && document.getElementById(button.getAttribute('aria-controls'));
            if (!button.hasAttribute('aria-haspopup') && target && (target.hidden || getComputedStyle(target).display === 'none') && button.getClientRects().length) {
                left.push(`${describe(button)} has a hidden target`);
            }
        }
        return left;
    }, scroller);
    if (remaining.length) {
        throw new Error(`${surfaceLabels.get(page) ?? 'The page'}: ${remaining.length} expander(s) are still closed in ${scroller}: ${remaining.slice(0, 5).join('; ')}.`);
    }
    await settle(page, { root: scroller });
}

/** Waits until the number of expanders under `scroller` is the same on two animation frames in a row, so that what an open revealed has been built. */
async function waitForStableExpanders(page, scroller) {
    await page.evaluate(selector => new Promise((resolve, reject) => {
        const count = () => document.querySelector(selector).querySelectorAll('details, .inline-drawer, [aria-expanded]').length;
        const started = performance.now();
        let last = count();
        let unchanged = 0;
        const frame = () => {
            const now = count();
            unchanged = now === last ? unchanged + 1 : 0;
            last = now;
            if (unchanged >= 2) {
                resolve();
            } else if (performance.now() - started > 5000) {
                reject(new Error(`The expanders of ${selector} kept changing for 5 seconds.`));
            } else {
                requestAnimationFrame(frame);
            }
        };
        requestAnimationFrame(frame);
    }), scroller);
}

/**
 * Shows the preset of the `logit-bias` need in the Chat Completions logit bias list and waits for its rows.
 * The app fills the preset select after the page is shown, and applying the active Chat Completion preset sets the bias selection
 * again, to the one that the preset holds. Whichever happens last wins, so the selection is made here, checked again once the page
 * has settled, and made again when a late preset application has undone it (three times at most).
 * @param {import('@playwright/test').Page} page
 */
export async function selectLogitBiasPreset(page) {
    const { preset, entries } = LOGIT_BIAS;
    const rows = '[data-sb-panel="sampling"] .openai_logit_bias_list > *';
    const shown = () => page.evaluate(({ rows, preset }) => ({
        selected: document.getElementById('openai_logit_bias_preset')?.value === preset,
        count: document.querySelectorAll(rows).length,
    }), { rows, preset });
    await page.waitForFunction(name => [...document.getElementById('openai_logit_bias_preset')?.options ?? []].some(option => option.value === name), preset, { timeout: 15_000 })
        .catch(() => { throw new Error(`The logit bias preset "${preset}" is not among the options of #openai_logit_bias_preset after 15 s.`); });
    let state = await shown();
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate((name) => {
            const select = document.getElementById('openai_logit_bias_preset');
            if (select.value !== name) {
                select.value = name;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, preset);
        await page.waitForFunction(({ rows, count }) => document.querySelectorAll(rows).length === count, { rows, count: entries }, { timeout: 10_000 }).catch(() => {});
        await settle(page);
        state = await shown();
        if (state.selected && state.count === entries) {
            return;
        }
    }
    throw new Error(`The logit bias list does not show the ${entries} rows of the preset "${preset}" (selected: ${state.selected}, rows: ${state.count}).`);
}
