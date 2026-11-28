import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp } from '../helpers/surfaces/boot.js';
import { surfaceById } from '../helpers/surfaces/index.js';
import { labelPage } from '../helpers/surfaces/steps.js';

// F-304: the open step of a settings page returns once the page is built. The modules that build Appearance, Formatting,
// Presets, Sampling, Data & Security and Logs load on demand, and a loaded machine makes the import slow, so these tests
// make it slow on purpose: each module answers after MODULE_DELAY_MS, and the step is read the moment it returns, with no
// wait of the test's own. Before the step waited, the page was still the raw upstream rows or a loading status.

const MODULE_DELAY_MS = 6000;
const SLOW_MODULES = /\/scripts\/(?:sillybunny-appearance|sillybunny-backend-pages|sillybunny-sampling|sillybunny-data-security|sillybunny-server-tools)\.js/;
const APPEARANCE_PENDING = '[data-sb-panel="appearance"] .sb-shell-panel-scroller > [aria-busy="true"]';
/**
 * `built` is something that only the module's own work leaves on the page. Interface and Messages are completed by the Appearance
 * module, so `pending` is what must be gone: the raw rows that Appearance holds back until it has regrouped them.
 */
const PAGES = [
    { id: 'settings.customize.appearance', tab: 'appearance', pending: APPEARANCE_PENDING },
    { id: 'settings.customize.interface', tab: 'interface', pending: APPEARANCE_PENDING },
    { id: 'settings.customize.messages', tab: 'messages', pending: APPEARANCE_PENDING },
    { id: 'settings.backend.formatting', tab: 'context', built: '#AdvancedFormatting[data-sb-formatting-presented="true"]' },
    { id: 'settings.backend.presets', tab: 'prompting', built: '#ai_response_configuration [data-sb-presented="true"]' },
    { id: 'settings.backend.sampling', tab: 'sampling', built: '[data-sb-panel="sampling"] .sb-sampling-mode-pill' },
    { id: 'settings.customize.data-security', tab: 'data-security', built: '[data-sb-panel="data-security"] button:has-text("Usage Stats")' },
    { id: 'settings.customize.logs', tab: 'logs', built: '[data-sb-panel="logs"] .sb-console-log-note' },
];

test.use(variantContextOptions({ viewport: '1440x900' }));

for (const entry of PAGES) {
    const { id, tab, built = `[data-sb-panel="${tab}"]`, pending = `[data-sb-panel="${tab}"][aria-busy="true"]` } = entry;
    test(`${id} is built when its open step returns, while its modules load slowly`, async ({ page, baseURL }) => {
        test.setTimeout(120_000);
        // Before the boot, so that a module the app starts loading by itself while it boots is late as well.
        await page.route(SLOW_MODULES, async (route) => {
            await new Promise(resolve => setTimeout(resolve, MODULE_DELAY_MS));
            await route.fallback();
        });
        await bootSurfaceApp(page, baseURL, { needs: surfaceById(id).needs });
        labelPage(page, id);
        await surfaceById(id).open(page, {});
        // Plain reads, not retrying assertions: the step has to have waited already.
        const count = selector => page.locator(selector).count();
        const panel = `[data-sb-panel="${tab}"]`;
        expect(await count(`${panel} [data-state="loading"]`), 'the loading status of the page').toBe(0);
        expect(await count(`${panel} .sb-shell-panel-scroller > [aria-busy="true"]`), 'a container that the page holds back').toBe(0);
        expect(await count(pending), `${pending} is gone`).toBe(0);
        expect(await count(built), `the module's own work (${built}) is on the page`).toBeGreaterThan(0);
    });
}

// The pages that a lazy module builds must not show their raw upstream rows while it loads: they are held from the moment
// they are registered, show the loading status page after its short delay, and show the error page with Retry when the
// module cannot load. `backend-panels.js` is one of the five tab modules, and the Presets, Editor, Formatting and the three
// Customize pages wait for it.
const HELD_MODULES = /\/scripts\/(?:sillybunny-tabs\/backend-panels|sillybunny-backend-pages)\.js/;
const HELD_PAGES = [
    { id: 'settings.backend.presets', shell: 'left', tab: 'prompting' },
    { id: 'settings.backend.formatting', shell: 'left', tab: 'context' },
    { id: 'settings.backend.editor', shell: 'left', tab: 'editor' },
    { id: 'settings.customize.appearance', shell: 'right', tab: 'appearance' },
    { id: 'settings.customize.interface', shell: 'right', tab: 'interface' },
    { id: 'settings.customize.messages', shell: 'right', tab: 'messages' },
];

for (const { id, shell, tab } of HELD_PAGES) {
    const panel = `[data-sb-panel="${tab}"]`;
    const scroller = `${panel} .sb-shell-panel-scroller`;
    /** The rows of the page that are painted: a direct child of the scroller that is not hidden and is not the status page. */
    const paintedRows = page => page.evaluate(selector => [...document.querySelector(selector)?.children ?? []]
        .filter(child => !child.classList.contains('sb-status-page') && getComputedStyle(child).visibility !== 'hidden' && child.getBoundingClientRect().height > 0)
        .length, scroller);

    test(`${id} shows the loading status, not its raw rows, while its module loads slowly`, async ({ page, baseURL }) => {
        test.setTimeout(120_000);
        await page.route(HELD_MODULES, async (route) => {
            await new Promise(resolve => setTimeout(resolve, MODULE_DELAY_MS));
            await route.fallback();
        });
        await bootSurfaceApp(page, baseURL, { needs: surfaceById(id).needs });
        // The first act after the boot: no step waits for the page.
        await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
        await expect(page.locator(panel)).toHaveAttribute('aria-hidden', 'false');

        expect(await paintedRows(page), 'raw rows that are painted before the module has built the page').toBe(0);
        await expect(page.locator(`${scroller} > .sb-status-page[data-state="loading"]`)).toBeVisible();
        expect(await paintedRows(page), 'raw rows that are painted while the loading status shows').toBe(0);
        await expect(page.locator(panel)).toHaveAttribute('aria-busy', 'true');

        await expect(page.locator(panel)).not.toHaveAttribute('aria-busy', 'true', { timeout: MODULE_DELAY_MS * 3 });
        await expect(page.locator(`${scroller} > .sb-status-page`)).toHaveCount(0);
        expect(await paintedRows(page), 'the built page is painted').toBeGreaterThan(0);
    });
}

test('a page whose module cannot load shows the error page and no toast, keeps its raw rows hidden, and Retry builds it', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    let failing = true;
    await page.route(HELD_MODULES, route => (failing ? route.abort('connectionreset') : route.fallback()));
    await bootSurfaceApp(page, baseURL, { needs: surfaceById('settings.backend.presets').needs });
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));

    const panel = '[data-sb-panel="prompting"]';
    const status = page.locator(`${panel} .sb-shell-panel-scroller > .sb-status-page`);
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(status).toContainText('Settings Not Loaded');
    await expect(page.locator(panel)).not.toHaveAttribute('aria-busy', 'true');
    expect(await page.locator(`${panel} .sb-shell-panel-scroller > :not(.sb-status-page)`).evaluateAll(rows => rows.filter(row => getComputedStyle(row).visibility !== 'hidden').length), 'raw rows that are painted next to the error page').toBe(0);

    // One failure is one report: the error page, with no toast, as the Sampling and Data & Security pages do.
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);

    // A Retry that fails again shows the error page again, still with no toast.
    await status.getByRole('button', { name: 'Retry' }).click();
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);

    failing = false;
    await status.getByRole('button', { name: 'Retry' }).click();
    await expect(status).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(panel)).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#ai_response_configuration [data-sb-presented="true"]').first()).toBeAttached();
    // The button that was pressed has left the page, so the focus is on a control that stays, not on the body.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});
