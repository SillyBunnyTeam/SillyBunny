import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp, openSurface } from '../helpers/surfaces/boot.js';
import { surfaceById } from '../helpers/surfaces/index.js';

// F-302: a run shares its server between surfaces, so a boot that writes to the server hands its state to every later
// boot on that server. The Chats Archive writes the view it last showed (`_sbca_organization.json`) half a second after a
// search, and the next boot opened the archive filtered to that search. The first test searches and waits for that write;
// the second boots again on the same server, as a surface that runs after it does, and reads the archive unfiltered.

test.describe.configure({ mode: 'serial' });
test.use(variantContextOptions({ viewport: '1440x900' }));

const NEEDS = ['character', 'characters-many', 'archived-chats'];
const SAVE_DELAY_AND_MARGIN_MS = 2500;

test('a search in the Chats Archive is not written to the server', async ({ page, baseURL }) => {
    await bootSurfaceApp(page, baseURL, { needs: NEEDS });
    await openSurface(page, surfaceById('list.archive'), { stateId: 'search-results', viewport: '1440x900' });
    await expect(page.locator('.sbca-status')).toContainText('matching chats');
    // The debounce of the save is 500 ms; a test that stops sooner would not see a write that is still to come.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(SAVE_DELAY_AND_MARGIN_MS);
});

test('the next boot on the same server opens the Chats Archive unfiltered', async ({ page, baseURL }) => {
    await bootSurfaceApp(page, baseURL, { needs: NEEDS });
    await openSurface(page, surfaceById('list.archive'), { viewport: '1440x900' });
    await expect(page.locator('.sbca-status')).toHaveText(/^\d+ indexed chat files$/);
    // The five chats of `archived-chats` are all listed; the search of the first test matched one of them.
    await expect.poll(() => page.locator('.sbca-row').count()).toBeGreaterThanOrEqual(5);
});
