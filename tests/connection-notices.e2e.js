import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

async function bootRoleplayChat(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), WelcomePage_LastMode: 'roleplay' };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/chats/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    const card = page.locator('#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"]');
    await expect(card.locator('.sbHomeCardOpen')).toBeEnabled({ timeout: 30000 });
    await card.locator('.sbHomeFootButton').first().click();
    await expect(page.locator('#chat .mes[mesid="0"]')).toBeVisible({ timeout: 30000 });
    await showToasts(page);
}

async function goOffline(page) {
    await page.evaluate(async () => (await import('/script.js')).setOnlineStatus('no_connection'));
    await expect(page.locator('#send_form')).toHaveClass(/\bno-connection\b/);
    await expect(page.locator('#chat .mes[mesid="0"]')).toBeVisible();
    return page.locator('#chat .mes').count();
}
const notice = page => page.locator('.toast', { hasText: 'Not connected to API!' });

/** Opens Connections on the OpenAI source with no key saved, and returns the key field. */
async function openEmptyKeyField(page) {
    await bootRoleplayChat(page);
    await goOffline(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
    await page.evaluate(() => {
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('openai').trigger('change');
    });
    const key = page.locator('#api_key_openai');
    await expect(key).toBeVisible();
    await expect(key).toHaveValue('');
    return key;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${viewport.width}px`, () => {
        test.use({ viewport, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

        // Enter starts a new line on a phone, so the Send button test covers it there.
        if (viewport.width >= 620) {
            test('Enter with no API connection keeps the draft and the chat, and the notice opens Connections', async ({ page }) => {
                await bootRoleplayChat(page);

                const messages = await goOffline(page);

                await page.locator('#send_textarea').fill('Is anyone there?');
                await page.locator('#send_textarea').press('Enter');

                await expect(notice(page)).toHaveCount(1);
                await expect(notice(page).locator('[data-sb-connection-notice="not-connected"]')).toHaveText('Your message wasn\'t sent. Connect a model first, then send it again.');
                await expect(page.locator('#send_textarea')).toHaveValue('Is anyone there?');
                await expect(page.locator('#chat .mes')).toHaveCount(messages);

                await notice(page).getByRole('button', { name: 'Show Me', exact: true }).click();

                await expect(notice(page)).toHaveCount(0);
                await expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible();
            });
        }

        test('pressing the dimmed Send button says why nothing was sent', async ({ page }) => {
            await bootRoleplayChat(page);
            await goOffline(page);

            await page.locator('#send_textarea').fill('Press the button');
            const box = await page.locator('#send_but').boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

            await expect(notice(page)).toHaveCount(1);
            await expect(page.locator('#send_textarea')).toHaveValue('Press the button');
        });

        test('a slash command still runs with no API connection', async ({ page }) => {
            await bootRoleplayChat(page);
            await goOffline(page);

            await page.locator('#send_textarea').fill('/sys Offline note');
            await page.locator('#send_textarea').press('Enter');

            await expect(page.locator('#chat .mes', { hasText: 'Offline note' })).toHaveCount(1);
            await expect(notice(page)).toHaveCount(0);
        });

        test('Connect with an empty key marks the key field, moves focus to it and says what is missing', async ({ page }) => {
            const key = await openEmptyKeyField(page);

            await page.evaluate(() => $('#api_button_openai').trigger('click'));
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
            await expect(key).not.toHaveAttribute('aria-invalid');
            await expect(page.locator('.toast', { hasText: 'Missing key' })).toHaveCount(0);

            await page.locator('#api_button_openai').click();

            await expect(key).toHaveAttribute('aria-invalid', 'true');
            await expect(key).toBeFocused();
            const dangerBorder = await page.evaluate(() => {
                const probe = document.createElement('div');
                probe.style.border = '1px solid var(--sb-color-danger)';
                document.body.append(probe);
                const color = getComputedStyle(probe).borderTopColor;
                probe.remove();
                return color;
            });
            await expect(key).toHaveCSS('border-top-color', dangerBorder);
            const toast = page.locator('.toast', { hasText: 'Missing key' });
            await expect(toast).toHaveCount(1);
            await expect(toast.locator('[data-sb-connection-notice="missing-key"]')).toHaveText('Enter your API key, then press Connect.');

            await key.pressSequentially('sk');
            await expect(key).not.toHaveAttribute('aria-invalid');
        });

        // The keyboard shortcuts of the app press buttons with element.click(), which is not a trusted event.
        for (const [how, press] of [
            ['Enter on the focused Connect button', page => page.locator('#api_button_openai').focus().then(() => page.keyboard.press('Enter'))],
            ['a click that a script made with element.click()', page => page.evaluate(() => document.querySelector('#api_button_openai').click())],
        ]) {
            test(`Connect with an empty key answers ${how}`, async ({ page }) => {
                const key = await openEmptyKeyField(page);

                await press(page);

                await expect(key).toHaveAttribute('aria-invalid', 'true');
                await expect(page.locator('.toast', { hasText: 'Missing key' })).toHaveCount(1);
            });
        }
    });
}
