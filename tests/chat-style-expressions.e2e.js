import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { assertIsolatedServer, protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

/**
 * Character expressions in the picture slot of the Echo, Whisper and Ripple chat styles. The sprites are the packs of
 * the bundled assistants, read through the real server, so it needs a data root that was seeded from the bundled content.
 */
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
// Screenshots of each style are written only when a directory is named, for a review of the look.
const SHOT_DIRECTORY = process.env.SILLYBUNNY_TEST_SHOT_DIRECTORY;
const FOLDER = 'Assistant Reisen';
const MODULE_PATH = '/scripts/extensions/expressions/chat-style-sprites.js';

const STYLES = [
    { name: 'echo', value: 3, slot: { selector: '#chat .mes[mesid="0"]', pseudo: '::before', target: '.mes_text' }, userSlot: { selector: '#chat .mes[is_user="true"]', pseudo: '::before', target: '.mes_text' } },
    { name: 'whisper', value: 4, slot: { selector: '#chat .mes[mesid="0"]', pseudo: '::before', target: '' }, userSlot: { selector: '#chat .mes[is_user="true"]', pseudo: '::before', target: '' } },
    { name: 'ripple', value: 6, slot: { selector: '#chat .mes[mesid="0"] .mesAvatarWrapper .avatar', pseudo: null, target: '' }, userSlot: { selector: '#chat .mes[is_user="true"] .mesAvatarWrapper .avatar', pseudo: null, target: '' } },
];

const VIEWPORTS = [
    { name: '1440', title: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: '390', title: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

test.beforeEach(({ baseURL }) => {
    assertIsolatedServer(baseURL, 'Chat style expressions');
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ chatDisplay: number, withoutSprites?: boolean, hiddenLabels?: string[] }} options
 */
async function openChat(page, { chatDisplay, withoutSprites = false, hiddenLabels = [] }) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.power_user.chat_display = chatDisplay;
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), WelcomePage_LastMode: 'roleplay' };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    if (withoutSprites || hiddenLabels.length) {
        await page.route('**/api/sprites/get*', async (route) => {
            if (withoutSprites) return route.fulfill({ json: [] });
            const response = await route.fetch();
            const sprites = await response.json();
            return route.fulfill({ response, json: sprites.filter(sprite => !hiddenLabels.includes(sprite.label)) });
        });
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    const card = page.locator('#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"]');
    await expect(card.locator('.sbHomeCardOpen')).toBeEnabled({ timeout: STARTUP_TIMEOUT });
    await card.locator('.sbHomeFootButton').first().click();
    await expect(page.locator('#chat .mes[mesid="0"]')).toBeVisible({ timeout: STARTUP_TIMEOUT });
}

/** Adds one user message and one more message of the character, so there are two of each kind to compare. */
async function addMessages(page) {
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        await context.executeSlashCommandsWithOptions('/send Hello there.');
        await context.executeSlashCommandsWithOptions(`/sendas name="${context.name2}" A second reply.`);
    });
    await expect(page.locator('#chat .mes[is_user="true"]')).toHaveCount(1, { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#chat .mes[is_user="false"]:not(.smallSysMes)')).toHaveCount(2, { timeout: STARTUP_TIMEOUT });
}

const setExpression = (page, label) => page.evaluate(async (expression) => {
    const context = window.SillyTavern.getContext();
    context.extensionSettings.expressions.api = 'none';
    await context.executeSlashCommandsWithOptions(`/sprite ${expression}`);
}, label);

const readSlot = (page, { selector, pseudo, target }, scope = selector) => page.evaluate(({ scopeSelector, pseudoElement, targetSelector }) => {
    const root = document.querySelector(scopeSelector);
    const element = targetSelector ? root.querySelector(targetSelector) : root;
    return decodeURIComponent(getComputedStyle(element, pseudoElement).backgroundImage);
}, { scopeSelector: scope, pseudoElement: pseudo, targetSelector: target });

const characterMarks = page => page.locator('#chat .mes[is_user="false"]:not(.smallSysMes)').evaluateAll(
    elements => elements.map(element => element.getAttribute('data-sb-expression')));

async function scrollToSlot(page, style) {
    await page.locator('#chat .mes[mesid="0"]').evaluate((message, name) => {
        (name === 'echo' ? message.querySelector('.mes_text') : message).scrollIntoView({ block: 'start' });
    }, style.name);
}

async function shot(page, name) {
    if (!SHOT_DIRECTORY) return;
    mkdirSync(SHOT_DIRECTORY, { recursive: true });
    await page.screenshot({ path: `${SHOT_DIRECTORY}/${name}.png` });
}

for (const viewport of VIEWPORTS) {
    test.describe(`the sprite slot at ${viewport.title}`, () => {
        test.use(viewport.options);

        for (const style of STYLES) {
            test(`${style.name}: a character with sprites shows one, a user message keeps its avatar`, async ({ page }) => {
                await openChat(page, { chatDisplay: style.value });
                await addMessages(page);

                const first = page.locator('#chat .mes[mesid="0"]');
                await expect(first).toHaveAttribute('data-sb-expression', /.+/, { timeout: STARTUP_TIMEOUT });
                expect(await readSlot(page, style.slot)).toContain(`/characters/${FOLDER}/`);
                expect(await readSlot(page, style.slot)).not.toContain('type=avatar');

                const user = page.locator('#chat .mes[is_user="true"]');
                await expect(user).not.toHaveAttribute('data-sb-expression', /.*/);
                expect(await readSlot(page, style.userSlot)).not.toContain('/characters/Assistant');
                await expect(user.locator('.mesAvatarWrapper .avatar img')).toHaveAttribute('src', /.+/);

                // The small round avatar in the name row and the avatar image keep the profile picture.
                const avatarSrc = await first.locator('.mesAvatarWrapper .avatar img').getAttribute('src');
                expect(avatarSrc).not.toContain('/sprites');
                expect(avatarSrc).not.toMatch(/\/characters\/Assistant Reisen\/\w+\.webp/);

                await scrollToSlot(page, style);
                await shot(page, `${style.name}-${viewport.name}`);
            });

            test(`${style.name}: a character without sprites keeps the avatar`, async ({ page }) => {
                await openChat(page, { chatDisplay: style.value, withoutSprites: true });
                await addMessages(page);
                await expect.poll(() => characterMarks(page)).toEqual([null, null]);
                expect(await readSlot(page, style.slot)).not.toContain('/characters/Assistant Reisen/');
                await scrollToSlot(page, style);
                await shot(page, `${style.name}-${viewport.name}-nosprites`);
            });
        }
    });
}

test.describe('a changed expression', () => {
    test.use(VIEWPORTS[0].options);

    test('changes the slot of every message of the character and falls back in order', async ({ page }) => {
        await openChat(page, { chatDisplay: STYLES[0].value, hiddenLabels: ['anger'] });
        await addMessages(page);
        await expect.poll(() => characterMarks(page), { timeout: STARTUP_TIMEOUT }).not.toContain(null);

        await setExpression(page, 'joy');
        await expect.poll(() => characterMarks(page)).toEqual(['joy', 'joy']);
        for (const mesid of [0, 2]) {
            const slot = { ...STYLES[0].slot, selector: `#chat .mes[mesid="${mesid}"]` };
            expect(await readSlot(page, slot)).toContain(`/characters/${FOLDER}/joy.webp`);
        }

        // A label with no sprite gives the fallback expression, and without a fallback it gives neutral.
        await page.evaluate(() => { window.SillyTavern.getContext().extensionSettings.expressions.fallback_expression = 'surprise'; });
        await setExpression(page, 'anger');
        await expect.poll(() => characterMarks(page)).toEqual(['surprise', 'surprise']);

        await page.evaluate(() => { window.SillyTavern.getContext().extensionSettings.expressions.fallback_expression = null; });
        await setExpression(page, 'anger');
        await expect.poll(() => characterMarks(page)).toEqual(['neutral', 'neutral']);
    });
});

test.describe('a message that enters the chat without a render event', () => {
    test.use(VIEWPORTS[0].options);

    test('gets the sprite, as a reply does while it streams', async ({ page }) => {
        await openChat(page, { chatDisplay: STYLES[1].value });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveAttribute('data-sb-expression', /.+/, { timeout: STARTUP_TIMEOUT });

        // A streamed reply is added like this at its first token; its render event is sent when the stream ends.
        // The extension's poll would mark the message two seconds later through its own event, so that event is
        // stopped before it reaches the document, and only the watch on the chat is left to find the message.
        await page.evaluate(() => {
            for (const type of ['sb:expression-changed', 'sb:expression-sprites-changed']) {
                window.addEventListener(type, event => event.stopImmediatePropagation(), true);
            }
            const context = window.SillyTavern.getContext();
            const message = { name: context.name2, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'A streamed reply.', extra: {} };
            context.chat.push(message);
            context.addOneMessage(message);
        });

        await expect(page.locator('#chat .mes[mesid="1"]')).toHaveAttribute('data-sb-expression', /.+/);
    });
});

test.describe('the module of the sprite slot', () => {
    test.use(VIEWPORTS[0].options);

    test('is not requested under the default chat style and is requested once after a switch to Echo', async ({ page }) => {
        const requests = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname === MODULE_PATH) requests.push(request.url());
        });

        await openChat(page, { chatDisplay: 0 });
        await expect.poll(() => page.evaluate(() => document.body.className)).not.toMatch(/echostyle|whisperstyle|ripplestyle/);
        // init() of the extension has run its first check once its wrapper exists.
        await expect(page.locator('#expression-wrapper')).toBeAttached();
        expect(requests).toHaveLength(0);

        await page.evaluate(() => {
            const select = document.getElementById('chat_display');
            select.value = '3';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveAttribute('data-sb-expression', /.+/, { timeout: STARTUP_TIMEOUT });
        expect(requests).toHaveLength(1);

        await page.evaluate(() => {
            const select = document.getElementById('chat_display');
            select.value = '4';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('body')).toHaveClass(/whisperstyle/);
        expect(requests).toHaveLength(1);
    });
});
