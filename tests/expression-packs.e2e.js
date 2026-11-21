import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { assertIsolatedServer, protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

/**
 * The expression packs of Reisen and Tewi, read through the real server and the real Expressions extension. Like the
 * card spec, it needs a data root that was seeded from the bundled content, which a fresh one is.
 */
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;

// The extension asks for these labels, so a pack that lacks one falls back to another sprite or to none.
const LABELS = [...readFileSync(new URL('../public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8')
    .match(/const DEFAULT_EXPRESSIONS = \[([^\]]+)\]/)[1].matchAll(/'([a-z]+)'/g)].map(([, label]) => label).sort();

// The folder of a pack is the name of its card, because the extension looks sprites up by the name of the character.
const PACKS = [
    { key: 'reisen', folder: 'Assistant Reisen' },
    { key: 'tewi', folder: 'Assistant Tewi' },
];

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

test.beforeEach(({ baseURL }) => {
    assertIsolatedServer(baseURL, 'Expression packs');
});

test.describe('the expression packs that the server seeded', () => {
    test('are the 28 labels of the extension', () => {
        expect(LABELS).toHaveLength(28);
    });

    for (const { folder } of PACKS) {
        test(`${folder} lists every label, and each file is served as WebP`, async ({ request }) => {
            const response = await request.get(`/api/sprites/get?name=${encodeURIComponent(folder)}`);
            expect(response.ok()).toBe(true);
            const sprites = await response.json();

            expect(sprites.map(sprite => sprite.label).sort()).toEqual(LABELS);
            for (const sprite of sprites) {
                expect(sprite.path).toMatch(new RegExp(`^/characters/${folder}/${sprite.label}\\.webp(\\?t=\\d+)?$`));
            }

            const files = await Promise.all(sprites.map(sprite => request.get(encodeURI(sprite.path))));
            expect(files.map(file => file.status())).toEqual(sprites.map(() => 200));
            expect([...new Set(files.map(file => file.headers()['content-type']))]).toEqual(['image/webp']);
        });
    }
});

/**
 * Starts the app on Home with the cards that the server seeded and opens a chat with one of them.
 * @param {import('@playwright/test').Page} page
 * @param {string} key The Home key of the assistant.
 */
async function openChatWith(page, key) {
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
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    const card = page.locator(`#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-${key}"]`);
    await expect(card.locator('.sbHomeCardOpen')).toBeEnabled({ timeout: STARTUP_TIMEOUT });
    await card.locator('.sbHomeFootButton').first().click();
    await expect(page.locator('#chat .mes[mesid="0"]')).toBeVisible({ timeout: STARTUP_TIMEOUT });
}

const setExpression = (page, label) => page.evaluate(async (expression) => {
    const context = window.SillyTavern.getContext();
    context.extensionSettings.expressions.api = 'none';
    await context.executeSlashCommandsWithOptions(`/sprite ${expression}`);
}, label);

const setVisualNovel = (page, on) => page.evaluate((enabled) => {
    const toggle = document.getElementById('waifuMode');
    toggle.checked = enabled;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
}, on);

for (const { name, options } of VIEWPORTS) {
    test.describe(`the sprite of a chat with Reisen or Tewi, at ${name}`, () => {
        test.use(options);

        for (const { key, folder } of PACKS) {
            // The back-view pose is the one that every pack has and a fallback would not guess.
            test(`${folder} shows its annoyance sprite in the chat and in Visual Novel mode`, async ({ page }) => {
                await openChatWith(page, key);
                const sprite = page.locator('#expression-image');
                const file = `${folder}/annoyance.webp`;

                // The extension sets up its own state when a chat opens, and a command that comes before that is dropped.
                await expect.poll(async () => {
                    await setExpression(page, 'annoyance');
                    return sprite.evaluate(image => decodeURIComponent(new URL(image.src).pathname));
                }, { timeout: STARTUP_TIMEOUT }).toBe(`/characters/${file}`);
                await expect.poll(() => sprite.evaluate(image => image.naturalWidth), { timeout: STARTUP_TIMEOUT }).toBeGreaterThan(0);

                await setVisualNovel(page, true);
                await expect(page.locator('body')).toHaveClass(/waifuMode/);
                await expect(sprite).toBeVisible();
                const frame = await page.evaluate(() => {
                    const image = document.getElementById('expression-image').getBoundingClientRect();
                    return { top: image.top, left: image.left, right: image.right, bottom: image.bottom, topBar: document.getElementById('top-bar').getBoundingClientRect().bottom, width: innerWidth, height: innerHeight };
                });
                // The head must not go under the top bar, and the box must not spill past the sides or the bottom.
                expect(frame.top).toBeGreaterThanOrEqual(frame.topBar);
                expect(frame.left).toBeGreaterThanOrEqual(0);
                expect(frame.right).toBeLessThanOrEqual(frame.width);
                expect(frame.bottom).toBeLessThanOrEqual(frame.height + 1);
            });
        }
    });
}
