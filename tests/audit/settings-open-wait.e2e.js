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
