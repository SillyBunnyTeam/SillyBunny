import { test, expect } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

// The cases need a server with accounts off and one with accounts on, so each case is skipped without its settings:
// SILLYBUNNY_TEST_BASE_URL for the server with accounts off, and SILLYBUNNY_TEST_ACCOUNTS_URL for the server with accounts on,
// with SILLYBUNNY_TEST_ADMIN_HANDLE and SILLYBUNNY_TEST_MEMBER_HANDLE, plus their _PASSWORD variables for accounts with a password.
const accountsUrl = process.env.SILLYBUNNY_TEST_ACCOUNTS_URL;
const admin = { handle: process.env.SILLYBUNNY_TEST_ADMIN_HANDLE, password: process.env.SILLYBUNNY_TEST_ADMIN_PASSWORD };
const member = { handle: process.env.SILLYBUNNY_TEST_MEMBER_HANDLE, password: process.env.SILLYBUNNY_TEST_MEMBER_PASSWORD };

/**
 * Logs the browser context in through the API, so that the test does not depend on the login page.
 * @param {import('@playwright/test').Page} page Page
 * @param {{handle: string, password?: string}} account Account
 */
async function logIn(page, account) {
    const { token } = await (await page.request.get('/csrf-token')).json();
    const response = await page.request.post('/api/users/login', { data: account, headers: { 'X-CSRF-Token': token } });
    expect(response.status()).toBe(200);
}

/**
 * Opens the import card: Customize, then the System & Device settings, then the Import & Restore drawer.
 * @param {import('@playwright/test').Page} page Page
 */
async function openImportCard(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
    await page.locator('.sb-settings-tab-btn[data-tab="system-device"]').click();
    // The drawer remembers its open state per account.
    if (!(await page.locator('#SillyTavernImportSection > .inline-drawer-content').isVisible())) {
        await page.locator('#SillyTavernImportSection .inline-drawer-toggle').click();
    }
    await expect(page.locator('#sb-import-card')).toBeVisible();
}

function folderPane(page) {
    return page.locator('#sb-import-card .sb-import-pane', { hasText: 'Import From Folder Path' });
}

function zipPane(page) {
    return page.locator('#sb-import-card .sb-import-pane', { hasText: 'Import From Backup ZIP' });
}

async function startApp(page) {
    await page.goto('/');
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 0 });
    await testSetup.waitForAppReady({ page });
}

test.describe('folder import pane, accounts off', () => {
    test('shows the folder import to the single user', async ({ page }) => {
        await startApp(page);
        const accountsEnabled = await page.evaluate(async () => (await import('/scripts/user.js')).accountsEnabled);
        // eslint-disable-next-line playwright/no-skipped-test -- The one server of a run can have accounts on, and this case needs accounts off.
        test.skip(accountsEnabled, 'the server at SILLYBUNNY_TEST_BASE_URL has accounts on');

        await openImportCard(page);

        await expect(folderPane(page)).toBeVisible();
        await expect(zipPane(page)).toBeVisible();
    });
});

test.describe('folder import pane, accounts on', () => {
    test.use({ baseURL: accountsUrl });

    test('shows the folder import to an admin', async ({ page }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- A default run has one server, and this case needs a second one with accounts on.
        test.skip(!accountsUrl || !admin.handle, 'needs SILLYBUNNY_TEST_ACCOUNTS_URL and SILLYBUNNY_TEST_ADMIN_HANDLE');
        await logIn(page, admin);
        await startApp(page);

        await openImportCard(page);

        await expect(folderPane(page)).toBeVisible();
        await expect(zipPane(page)).toBeVisible();
    });

    test('hides the folder import from a member and keeps the backup ZIP import', async ({ page }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- A default run has one server, and this case needs a second one with accounts on.
        test.skip(!accountsUrl || !member.handle, 'needs SILLYBUNNY_TEST_ACCOUNTS_URL and SILLYBUNNY_TEST_MEMBER_HANDLE');
        await logIn(page, member);
        await startApp(page);

        await openImportCard(page);

        await expect(folderPane(page)).toBeHidden();
        await expect(zipPane(page)).toBeVisible();
    });

    test('shows the folder import to an admin whose user data arrives after the card is built', async ({ page }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- A default run has one server, and this case needs a second one with accounts on.
        test.skip(!accountsUrl || !admin.handle, 'needs SILLYBUNNY_TEST_ACCOUNTS_URL and SILLYBUNNY_TEST_ADMIN_HANDLE');
        await logIn(page, admin);
        let releaseUserData;
        const userDataReleased = new Promise(resolve => {
            releaseUserData = resolve;
        });
        await page.route('**/api/users/me', async route => {
            await userDataReleased;
            await route.continue();
        });
        // The client asks for /api/users/me after it turns the account controls on, so isAdmin() is false from then until the answer.
        const userDataRequested = page.waitForRequest('**/api/users/me');
        await page.goto('/', { waitUntil: 'commit' });
        await userDataRequested;
        await page.waitForFunction(() => window.SillyBunnyShell?.openTab);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
        await expect(page.locator('#sb-import-card')).toBeAttached();
        expect(await page.evaluate(async () => (await import('/scripts/user.js')).isAdmin())).toBe(false);
        await expect(folderPane(page)).toHaveCSS('display', 'none');

        releaseUserData();
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 0 });
        await testSetup.waitForAppReady({ page });

        await expect(folderPane(page)).not.toHaveCSS('display', 'none');
    });

    test('hides the folder import from a member whose user data arrives after the card is built', async ({ page }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- A default run has one server, and this case needs a second one with accounts on.
        test.skip(!accountsUrl || !member.handle, 'needs SILLYBUNNY_TEST_ACCOUNTS_URL and SILLYBUNNY_TEST_MEMBER_HANDLE');
        await logIn(page, member);
        let releaseSettings;
        const settingsReleased = new Promise(resolve => {
            releaseSettings = resolve;
        });
        await page.route('**/api/settings/get', async route => {
            await settingsReleased;
            await route.continue();
        });
        // Until the settings answer, the client does not know that accounts are on, so isAdmin() is true.
        const settingsRequested = page.waitForRequest('**/api/settings/get');
        await page.goto('/', { waitUntil: 'commit' });
        await settingsRequested;
        await page.waitForFunction(() => window.SillyBunnyShell?.openTab);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
        await expect(page.locator('#sb-import-card')).toBeAttached();
        expect(await page.evaluate(async () => (await import('/scripts/user.js')).isAdmin())).toBe(true);
        await expect(folderPane(page)).not.toHaveCSS('display', 'none');

        releaseSettings();
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 0 });
        await testSetup.waitForAppReady({ page });

        await expect(folderPane(page)).toHaveCSS('display', 'none');
    });
});
