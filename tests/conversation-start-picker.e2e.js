import { expect, test } from '@playwright/test';
import { resetConversations, uniquePersona } from './helpers/conversation-seed.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

const NEW_MENU = '[data-sb-conversation-action="open-new-menu"]';
const COMPOSER = '#sb_conversation_input';
const PICKER = '.sb-picker';

async function boot(page, baseURL, { stylesheetDelay = 0 } = {}) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let settingsVersion = Date.now();
    const persona = uniquePersona();
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);

    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            return route.abort();
        }
        if (url.pathname === '/api/extensions/discover') {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            // This page sees only its own conversations, because the server's user is shared with the specs that run beside this one.
            settings.user_avatar = persona;
            settings.power_user.auto_connect = false;
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (url.pathname.endsWith('/sillybunny-conversation.css') && stylesheetDelay) {
            await new Promise(resolve => setTimeout(resolve, stylesheetDelay));
            return route.continue();
        }
        // The conversations are on the server of the test, which each test empties after the page has loaded.
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/') || url.pathname.startsWith('/api/sillybunny-conversation/')) {
            return route.continue();
        }
        if (url.pathname.startsWith('/api/backends/')) {
            return route.fulfill({ json: { data: [] } });
        }
        if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method())) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
    await resetConversations(page);
}

/** Opens the workspace on no thread, so that the rail's New button is the way in. */
async function openEmptyWorkspace(page) {
    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        openConversationWorkspaceForAvatar(null, { showToast: false });
        stopConversationAutoWorker();
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(NEW_MENU)).toBeVisible();
}

async function chooseNewMenuItem(page, name) {
    await page.locator(NEW_MENU).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    await expect(page.locator(PICKER)).toBeVisible();
}

test('New DM picks a character from the shared picker and focuses the composer', async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await boot(page, baseURL);
    await openEmptyWorkspace(page);
    await chooseNewMenuItem(page, 'New DM');

    await expect(page.locator(`${PICKER} .sb-picker__option img.sb-conversation-picker-avatar`).first()).toBeVisible();
    await page.locator(`${PICKER} .sb-picker__search`).fill('zzzz-no-such-character');
    await expect(page.locator(`${PICKER} .sb-picker__empty .sb-status-page__title`)).toHaveText('No matching characters found.');
    await page.locator(`${PICKER} .sb-picker__search`).fill('Seraphina');
    await page.locator(`${PICKER} .sb-picker__option`).filter({ hasText: 'Seraphina' }).click();

    await expect(page.locator(PICKER)).toHaveCount(0);
    await expect(page.locator(COMPOSER)).toBeEnabled();
    await expect(page.locator(COMPOSER)).toBeFocused();
});

test('New group keeps Create Group off until two members are chosen, then opens the group', async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await boot(page, baseURL);
    await openEmptyWorkspace(page);
    await chooseNewMenuItem(page, 'New Group');

    const create = page.getByRole('button', { name: 'Create Group', exact: true });
    const options = page.locator(`${PICKER} .sb-picker__option`);
    await expect(create).toBeDisabled();
    await options.nth(0).click();
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(create).toBeDisabled();
    await options.nth(1).click();
    await expect(create).toBeEnabled();
    await options.nth(1).click();
    await expect(create).toBeDisabled();
    await options.nth(1).click();
    await create.click();

    await expect(page.locator(PICKER)).toHaveCount(0);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(COMPOSER)).toBeFocused();
});

test('opening the first DM focuses the composer after a slow stylesheet load, not after a fixed delay', async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await boot(page, baseURL, { stylesheetDelay: 1500 });
    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const character = window.SillyTavern.getContext().characters.find(entry => /Seraphina/.test(entry?.name ?? ''));
        openConversationWorkspaceForAvatar(character.avatar, { showToast: false });
        stopConversationAutoWorker();
    });
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(COMPOSER)).toBeFocused();
});
