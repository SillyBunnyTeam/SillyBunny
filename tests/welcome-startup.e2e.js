import { expect, test } from '@playwright/test';
import { applyHomeTestSettings, captureAccountStorageSaves } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { IMPORT_PENDING_KEY as IMPORT_PENDING, SEEN_VERSION_KEY as SEEN_VERSION, SHOW_AT_STARTUP_KEY as SHOW_AT_STARTUP } from './helpers/welcome-dialog.js';

/*
 * When Welcome opens at startup, and what it keeps. Each test names the account it boots with. The specs that are
 * not about Welcome keep it closed with a shared helper, so none of them answers for it here.
 */

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;

const hosts = page => page.locator('dialog.sb-dialog-host:not([closing])');
const shownPage = host => host.locator('.sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)');
const titleOf = host => shownPage(host).locator('.sb-dialog__title');
const next = host => shownPage(host).getByRole('button', { name: 'Next', exact: true });

/**
 * Boots an account with the given Welcome keys in its account storage, and records what the app saves.
 * `seen: false` leaves the account that never met Welcome. Once the app has saved, a reload is served what it saved, as
 * the server would, so a test can tell what a later boot of the same account does.
 * @param {import('@playwright/test').Page} page
 * @param {{ firstRun?: boolean, showAtStartup?: 'true' | 'false' | null, seen?: boolean, importPending?: boolean, withoutQuickImageGenSettings?: boolean }} [account]
 */
async function boot(page, { firstRun = false, showAtStartup = null, seen = true, importPending = false, withoutQuickImageGenSettings = false } = {}) {
    await protectMaintainerServer(page);
    /** @type {Awaited<ReturnType<typeof captureAccountStorageSaves>>} */
    let captured;
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        if (captured.payload) {
            return route.fulfill({ json: { ...data, settings: JSON.stringify(captured.payload) } });
        }
        const settings = JSON.parse(data.settings);
        // A first run has no stored checklist, which is how Getting Started tells it from an old account.
        applyHomeTestSettings(settings, { firstRun, value: firstRun ? null : undefined, welcome: 'never-seen' });
        if (showAtStartup !== null) settings.accountStorage[SHOW_AT_STARTUP] = showAtStartup;
        if (seen) settings.accountStorage[SEEN_VERSION] = '1.0.0';
        if (withoutQuickImageGenSettings) delete settings.extension_settings['quick-image-gen'];
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    captured = await captureAccountStorageSaves(page);
    if (importPending) {
        // A reload keeps the session storage, so the marker is planted once, as the page that imported would have left it.
        await page.addInitScript((key) => {
            if (!sessionStorage.getItem('qa-marker-planted')) {
                sessionStorage.setItem('qa-marker-planted', '1');
                localStorage.setItem(key, '1');
            }
        }, IMPORT_PENDING);
    }
    await page.goto('/');
    return captured;
}

const waitForReady = page => page.waitForFunction(
    () => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'),
    null,
    { timeout: STARTUP_TIMEOUT },
);

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
}

/** The ready app has settled on Home with no dialog, which is how a boot that keeps Welcome closed looks. */
async function expectNoWelcome(page) {
    await waitForReady(page);
    await expectHome(page);
    await expect(hosts(page)).toHaveCount(0);
}

test.describe('a first run', () => {
    test('shows Welcome in place of the onboarding popup, and it is the only dialog', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false, withoutQuickImageGenSettings: true });

        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(titleOf(host)).toHaveText('Welcome');
        await expect(page.locator('dialog[open]')).toHaveCount(1);
        await expect(page.locator('#qig-setup-wizard')).toHaveCount(0);
    });

    test('cannot be closed before the persona has a name: no Close, and Escape and the backdrop do nothing', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });

        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeHidden();
        await page.keyboard.press('Escape');
        await page.mouse.click(5, 5);

        await expect(host).toBeVisible();
        await expect(titleOf(host)).toHaveText('Welcome');
    });

    test('asks for a name on the persona page: Next waits for a name, and a name is written as the onboarding popup wrote it', async ({ page }) => {
        const captured = await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await next(host).click();
        await expect(titleOf(host)).toHaveText('Your Persona');
        const name = shownPage(host).getByRole('textbox', { name: 'Your Name' });
        await expect(name).toHaveValue('');
        await expect(next(host)).toBeDisabled();

        await name.fill('   ');
        await expect(next(host)).toBeDisabled();
        await name.fill('Ada Lovelace');
        await expect(next(host)).toBeEnabled();
        await next(host).click();

        await expect(titleOf(host)).toHaveText('What’s Next');
        const written = await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const { user_avatar } = await import('/scripts/personas.js');
            const { name1 } = await import('/script.js');
            return { name1, persona: power_user.personas[user_avatar], description: power_user.persona_descriptions[user_avatar] };
        });
        expect(written).toEqual({ name1: 'Ada Lovelace', persona: 'Ada Lovelace', description: { description: '', position: 0 } });
        await expect(shownPage(host).getByRole('switch', { name: 'Show at Startup' })).toBeChecked();
        await shownPage(host).getByRole('button', { name: 'Start', exact: true }).click();
        await expect(hosts(page)).toHaveCount(0);
        await waitForReady(page);
        await expectHome(page);
        await expect.poll(() => captured.accountStorage[SHOW_AT_STARTUP], { timeout: 15_000 }).toBe('true');
        expect(captured.accountStorage[SEEN_VERSION]).toBeTruthy();
        // Getting Started read firstRun before the dialog ended, so the new account starts with its checklist shown.
        await expect(page.locator('#chat > .welcomePanel .sbHomeTile[data-sb-home-key="getting-started"]')).toBeVisible();
    });

    test('does not open a second Welcome when the app is ready', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await next(host).click();
        await shownPage(host).getByRole('textbox', { name: 'Your Name' }).fill('Ada');
        await next(host).click();
        await shownPage(host).getByRole('button', { name: 'Start', exact: true }).click();

        await waitForReady(page);
        await expectHome(page);

        await expect(hosts(page)).toHaveCount(0);
    });
});

/** Walks a first run to What's Next, naming the persona on the way. */
async function nameThePersona(host, name = 'Ada Lovelace') {
    await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
    await next(host).click();
    await shownPage(host).getByRole('textbox', { name: 'Your Name' }).fill(name);
    await next(host).click();
    await expect(titleOf(host)).toHaveText('What’s Next');
}

test.describe('a first run, once the persona has a name', () => {
    test('lets startup go on while Welcome stays open on What’s Next, and the settings it saves carry the persona', async ({ page }) => {
        const captured = await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);

        await nameThePersona(host);

        await waitForReady(page);
        await expect(titleOf(host)).toHaveText('What’s Next');
        await expect.poll(() => captured.payload?.username, { timeout: 15_000 }).toBe('Ada Lovelace');
        const saved = captured.payload;
        expect(saved.firstRun).toBe(false);
        expect(Object.values(saved.power_user.personas)).toContain('Ada Lovelace');
        expect(Object.values(saved.power_user.persona_descriptions)).toContainEqual(expect.objectContaining({ description: '', position: 0 }));
        expect(saved.accountStorage[SHOW_AT_STARTUP]).toBe('true');
        expect(saved.accountStorage[SEEN_VERSION]).toBeTruthy();
    });

    test('is not asked for the name again by a reload on What’s Next, which opens Welcome as a reopen', async ({ page }) => {
        const captured = await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await nameThePersona(host);
        await expect.poll(() => captured.payload?.username, { timeout: 15_000 }).toBe('Ada Lovelace');

        await page.reload();

        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeVisible();
        await next(host).click();
        await expect(shownPage(host).getByRole('textbox', { name: 'Your Name' })).toHaveCount(0);
        await expect(shownPage(host).getByText('Ada Lovelace', { exact: true })).toBeVisible();
    });

    test('is asked for the name again by a reload on the persona page, before the name is written', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await next(host).click();
        await shownPage(host).getByRole('textbox', { name: 'Your Name' }).fill('Ada');

        await page.reload();

        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeHidden();
        await next(host).click();
        await expect(shownPage(host).getByRole('textbox', { name: 'Your Name' })).toHaveValue('');
    });
});

test.describe('a first run, paging with Escape and through Import', () => {
    test('Escape on the first page does nothing, and on every later page it goes back one page', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });

        await page.keyboard.press('Escape');
        await expect(titleOf(host)).toHaveText('Welcome');
        await next(host).click();
        await expect(titleOf(host)).toHaveText('Your Persona');
        await page.keyboard.press('Escape');
        await expect(titleOf(host)).toHaveText('Welcome');
        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeHidden();

        await next(host).click();
        await shownPage(host).getByRole('textbox', { name: 'Your Name' }).fill('Ada');
        await next(host).click();
        await expect(titleOf(host)).toHaveText('What’s Next');
        await page.keyboard.press('Escape');
        await expect(titleOf(host)).toHaveText('Your Persona');
        await expect(hosts(page)).toHaveCount(1);
    });

    test('goes through the Import page and back to the first page, which still has no Close', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });

        await shownPage(host).getByRole('button', { name: 'Import From SillyTavern' }).click();
        await expect(titleOf(host)).toHaveText('Import From SillyTavern');
        await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();

        await expect(titleOf(host)).toHaveText('Welcome');
        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeHidden();
        await shownPage(host).getByRole('button', { name: 'Import From SillyTavern' }).click();
        await page.keyboard.press('Escape');
        await expect(titleOf(host)).toHaveText('Welcome');
        await next(host).click();
        await expect(shownPage(host).getByRole('textbox', { name: 'Your Name' })).toHaveValue('');
    });
});

test.describe('a first run when the Welcome dialog cannot load', () => {
    test('shows the onboarding popup of upstream alone, and no Welcome follows once the app is ready', async ({ page }) => {
        await page.route('**/scripts/sillybunny-welcome.js*', route => route.abort());
        const captured = await boot(page, { firstRun: true, seen: false });
        const popup = page.locator('dialog.popup[open]');
        await expect(popup).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(page.locator('dialog[open]')).toHaveCount(1);

        await popup.locator('.popup-input').fill('Ada');
        await popup.locator('.popup-button-ok').click();
        await waitForReady(page);
        await expectHome(page);

        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await expect(page.locator('.toast-message', { hasText: 'TODO(copy)' })).toHaveCount(0);
        await expect.poll(() => captured.saves, { timeout: 15_000 }).toBeGreaterThan(0);
        expect(captured.accountStorage[SEEN_VERSION]).toBeUndefined();
    });
});

test.describe('a first run on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('opens as a sheet with no Close, and a named persona leads to Home', async ({ page }) => {
        await boot(page, { firstRun: true, seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(host).toHaveAttribute('data-presentation', 'sheet');
        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeHidden();

        await next(host).click();
        await shownPage(host).getByRole('textbox', { name: 'Your Name' }).fill('Ada');
        await next(host).click();
        await shownPage(host).getByRole('button', { name: 'Start', exact: true }).click();

        await expect(hosts(page)).toHaveCount(0);
        await waitForReady(page);
        await expectHome(page);
    });
});

test.describe('an existing account', () => {
    test('with Show at Startup on opens Welcome once the app is ready, with the persona in its reopen form', async ({ page }) => {
        await boot(page, { showAtStartup: 'true' });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await waitForReady(page);

        await expect(shownPage(host).getByRole('button', { name: 'Close', exact: true })).toBeVisible();
        await next(host).click();
        await expect(titleOf(host)).toHaveText('Your Persona');
        await expect(shownPage(host).getByRole('textbox', { name: 'Your Name' })).toHaveCount(0);
        await expect(shownPage(host).getByRole('button', { name: 'Manage Personas' })).toBeVisible();
        await next(host).click();
        await expect(shownPage(host).getByRole('switch', { name: 'Show at Startup' })).toBeChecked();
    });

    test('with Show at Startup off and a seen version opens nothing', async ({ page }) => {
        await boot(page, { showAtStartup: 'false', seen: true });

        await expectNoWelcome(page);

        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });

    test('that never met Welcome gets it once, with Show at Startup off, and records that it saw it', async ({ page }) => {
        const captured = await boot(page, { seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });

        await next(host).click();
        await next(host).click();
        await expect(shownPage(host).getByRole('switch', { name: 'Show at Startup' })).not.toBeChecked();
        await expect.poll(() => captured.accountStorage[SEEN_VERSION], { timeout: 15_000 }).toBeTruthy();
        expect(captured.accountStorage[SHOW_AT_STARTUP]).toBe('false');
    });

    test('Show at Startup is saved when the switch is flipped', async ({ page }) => {
        const captured = await boot(page, { seen: false });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await next(host).click();
        await next(host).click();

        await shownPage(host).getByRole('switch', { name: 'Show at Startup' }).check();
        await expect.poll(() => captured.accountStorage[SHOW_AT_STARTUP], { timeout: 15_000 }).toBe('true');
        await shownPage(host).getByRole('switch', { name: 'Show at Startup' }).uncheck();
        await expect.poll(() => captured.accountStorage[SHOW_AT_STARTUP], { timeout: 15_000 }).toBe('false');
    });

    test('Manage Personas closes Welcome and opens Characters, Personas', async ({ page }) => {
        await boot(page, { showAtStartup: 'true' });
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await next(host).click();

        await shownPage(host).getByRole('button', { name: 'Manage Personas' }).click();

        await expect(hosts(page)).toHaveCount(0);
        await expect(page.locator('#PersonaManagement')).toBeVisible({ timeout: STARTUP_TIMEOUT });
    });
});

test.describe('after an import', () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/api/users/import-sillytavern/**', route => route.fulfill({ status: 400, json: { error: 'The import route was not meant to be reached.' } }));
    });

    test('Welcome stays closed on a first run, and the account is marked as having seen it', async ({ page }) => {
        const captured = await boot(page, { firstRun: true, seen: false, importPending: true });

        await expectNoWelcome(page);

        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await expect.poll(() => captured.accountStorage[SEEN_VERSION], { timeout: 15_000 }).toBeTruthy();
        expect(captured.accountStorage[SHOW_AT_STARTUP]).toBe('false');
        expect(await page.evaluate(key => localStorage.getItem(key), IMPORT_PENDING)).toBeNull();
    });

    test('Welcome stays closed although the imported settings say Show at Startup, which the import turns off', async ({ page }) => {
        const captured = await boot(page, { showAtStartup: 'true', seen: false, importPending: true });

        await expectNoWelcome(page);

        await expect.poll(() => captured.accountStorage[SHOW_AT_STARTUP], { timeout: 15_000 }).toBe('false');
    });

    test('Show Welcome still opens it on that boot', async ({ page }) => {
        await boot(page, { seen: false, importPending: true });
        await expectNoWelcome(page);

        await page.locator('#chat > .welcomePanel .sbHomeMenuButton').click();
        await page.getByRole('menuitem', { name: 'Show Welcome', exact: true }).click();

        await expect(titleOf(hosts(page))).toHaveText('Welcome');
    });
});

test.describe('the Import From SillyTavern page', () => {
    // A request that no test answered must not reach the server, where it would replace the data of the account.
    test.beforeEach(async ({ page }) => {
        await page.route('**/api/users/import-sillytavern/**', route => route.fulfill({ status: 400, json: { error: 'The import route was not meant to be reached.' } }));
    });

    async function openImportPage(page) {
        const host = hosts(page);
        await expect(host).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await shownPage(host).getByRole('button', { name: 'Import From SillyTavern' }).click();
        await expect(titleOf(host)).toHaveText('Import From SillyTavern');
        return host;
    }

    const confirmImport = async (page) => {
        const alert = page.locator('dialog[role="alertdialog"]');
        await expect(alert).toBeVisible();
        await expect(alert.locator('[data-sb-copy-slot="WD-IMPORT-CONFIRM"]')).toHaveText('TODO(copy)');
        await alert.getByRole('button', { name: 'Import', exact: true }).click();
    };

    test('has real buttons, and an empty folder path sends nothing', async ({ page }) => {
        let requests = 0;
        await page.route('**/api/users/import-sillytavern/**', (route) => { requests += 1; return route.abort(); });
        await boot(page, { seen: false });
        const host = await openImportPage(page);
        const current = shownPage(host);
        await expect(current.getByRole('button', { name: 'Import Folder', exact: true })).not.toHaveAttribute('data-sb-stub', /.*/);

        await current.getByRole('button', { name: 'Import Folder', exact: true }).click();

        await expect(current.getByRole('textbox', { name: 'Folder Path' })).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('dialog[role="alertdialog"]')).toHaveCount(0);
        expect(requests).toBe(0);
    });

    test('a declined confirmation sends nothing and plants no marker', async ({ page }) => {
        let requests = 0;
        await page.route('**/api/users/import-sillytavern/**', (route) => { requests += 1; return route.abort(); });
        await boot(page, { seen: false });
        const host = await openImportPage(page);
        await shownPage(host).getByRole('textbox', { name: 'Folder Path' }).fill('/home/me/SillyTavern');

        await shownPage(host).getByRole('button', { name: 'Import Folder', exact: true }).click();
        const alert = page.locator('dialog[role="alertdialog"]');
        await expect(alert).toBeVisible();
        await alert.getByRole('button', { name: 'Cancel', exact: true }).click();

        await expect(alert).toHaveCount(0);
        expect(requests).toBe(0);
        expect(await page.evaluate(key => localStorage.getItem(key), IMPORT_PENDING)).toBeNull();
    });

    test('a folder import sends the path with the marker already set, reloads, and Welcome stays closed after the reload', async ({ page }) => {
        const seen = [];
        await page.route('**/api/users/import-sillytavern/folder', async (route) => {
            seen.push({ body: route.request().postDataJSON(), marker: await page.evaluate(key => localStorage.getItem(key), IMPORT_PENDING) });
            return route.fulfill({ json: { message: 'Imported 3 data sections.' } });
        });
        const captured = await boot(page, { seen: false });
        const host = await openImportPage(page);
        await shownPage(host).getByRole('textbox', { name: 'Folder Path' }).fill('/home/me/SillyTavern');

        await shownPage(host).getByRole('button', { name: 'Import Folder', exact: true }).click();
        await confirmImport(page);
        await page.waitForEvent('load');

        expect(seen).toEqual([{ body: { sourcePath: '/home/me/SillyTavern' }, marker: '1' }]);
        await expectNoWelcome(page);
        await expect.poll(() => captured.accountStorage[SHOW_AT_STARTUP], { timeout: 15_000 }).toBe('false');
        expect(await page.evaluate(key => localStorage.getItem(key), IMPORT_PENDING)).toBeNull();
    });

    test('a backup ZIP is uploaded as a form file, and a failed import shows the message of the server, clears the marker and stays', async ({ page }) => {
        const uploads = [];
        await page.route('**/api/users/import-sillytavern/zip', (route) => {
            uploads.push({ type: route.request().headers()['content-type'], size: route.request().postDataBuffer()?.length ?? 0 });
            return route.fulfill({ status: 400, json: { error: 'A SillyTavern backup ZIP is required.' } });
        });
        await boot(page, { seen: false });
        const host = await openImportPage(page);

        await shownPage(host).locator('input[type="file"]').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('PK-not-a-real-zip') });
        await confirmImport(page);

        await expect(shownPage(host).getByRole('status')).toHaveText('A SillyTavern backup ZIP is required.');
        expect(uploads).toHaveLength(1);
        expect(uploads[0].type).toMatch(/^multipart\/form-data/);
        expect(await page.evaluate(key => localStorage.getItem(key), IMPORT_PENDING)).toBeNull();
        await expect(shownPage(host).getByRole('button', { name: 'Import Folder', exact: true })).toBeEnabled();
        await expect(titleOf(host)).toHaveText('Import From SillyTavern');
    });
});
