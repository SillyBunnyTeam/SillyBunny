import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { decodeClip, GLYPH_CONTRAST, contrastOf } from './helpers/page-contrast.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

async function bootRoleplayChat(page, { theme = null } = {}) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), WelcomePage_LastMode: 'roleplay' };
        if (theme) {
            const { name, ...palette } = data.themes.find(entry => entry.name === theme);
            settings.power_user = { ...settings.power_user, ...palette, theme: name };
        }
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

/** Opens Connections on the OpenAI source with no key saved, and returns the key field. `options` go to `bootRoleplayChat`. */
async function openEmptyKeyField(page, options) {
    await bootRoleplayChat(page, options);
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

        test('in Libadwaita Light the invalid key field has a danger edge that stands out at 3:1', async ({ page }) => {
            const key = await openEmptyKeyField(page, { theme: 'Libadwaita Light' });
            expect(await page.evaluate(() => window.SillyTavern.getContext().powerUserSettings.theme)).toBe('Libadwaita Light');
            await page.locator('#api_button_openai').click();
            await expect(key).toHaveAttribute('aria-invalid', 'true');
            // The toast and the focus ring settle first, so that the edge is read at rest.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

            const box = await key.evaluate((node) => {
                node.scrollIntoView({ block: 'center' });
                const { left, top, width } = node.getBoundingClientRect();
                return { left, top, width };
            });
            const y = Math.round(box.top);
            const pixel = await decodeClip(page, { x: Math.floor(box.left), y: y - 6, width: Math.ceil(box.width), height: 12 });
            const x = Math.round(box.left + box.width / 2);

            expect(contrastOf(pixel(x, y), pixel(x, y - 3)), 'the top edge of the field against the page above it').toBeGreaterThanOrEqual(GLYPH_CONTRAST);
        });

        test.describe('in forced colours', () => {
            test.use({ forcedColors: 'active' });

            test('the invalid key field differs from a valid one by an outline or a border, because the palette drops its colour and shadow', async ({ page }) => {
                const key = await openEmptyKeyField(page);
                const edgeOf = () => key.evaluate((node) => {
                    const style = getComputedStyle(node);
                    return {
                        borderStyle: style.borderTopStyle,
                        borderWidth: style.borderTopWidth,
                        outlineStyle: style.outlineStyle,
                        outlineWidth: style.outlineWidth,
                    };
                });
                await key.evaluate(node => node.blur());
                const valid = await edgeOf();

                await page.locator('#api_button_openai').click();
                await expect(key).toHaveAttribute('aria-invalid', 'true');
                await key.evaluate(node => node.blur());

                expect(await edgeOf(), 'the edge of the field once it is invalid').not.toEqual(valid);
            });
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
