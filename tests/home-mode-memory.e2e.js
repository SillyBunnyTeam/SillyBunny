import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { installFixtureChats, pickFixtureCharacters, registerFixtureChat } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { DESKTOP, matrixViewports } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 60_000 });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const STARTUP_TIMEOUT = 20_000;
const STORAGE_KEY = 'WelcomePage_LastMode';

const modeLabel = mode => (mode === 'conversation' ? 'Conversation' : 'Roleplay');
const modeTitle = mode => `Chat mode: ${modeLabel(mode)} (Ctrl+M)`;

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
}

async function expectChat(page) {
    await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#form_sheld')).toBeVisible();
}

async function expectConversation(page) {
    await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

async function openModeMenu(page) {
    await page.locator('#sb-mode-toggle').click();
    await expect(page.locator('#sb-mode-menu')).toBeVisible();
}

async function chooseModeFromMenu(page, mode) {
    await openModeMenu(page);
    await page.getByRole('menuitemradio', { name: new RegExp(modeLabel(mode)) }).click();
}

async function goHome(page) {
    await page.locator('#sb-home-toggle').click();
    await expectHome(page);
}

async function readOpenChat(page) {
    return page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        return { chatId: context.getCurrentChatId(), avatar: context.characters[context.characterId]?.avatar ?? null };
    });
}

async function stubRecentChats(page, items) {
    await page.route('**/api/chats/recent', route => route.fulfill({ json: items }));
}

async function countModeChanges(page) {
    await page.evaluate(() => {
        window.qaModeChanges = 0;
        document.addEventListener('sb:chat-mode-changed', () => { window.qaModeChanges++; });
    });
}

const readModeChanges = page => page.evaluate(() => window.qaModeChanges);

/** The chat that is open now becomes a fixture, so a later request to resume it finds the file. */
async function adoptOpenChat(page) {
    const openChat = await readOpenChat(page);
    const name = await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        return context.characters[context.characterId].name;
    });
    registerFixtureChat(page, { avatar: openChat.avatar, name, chat: openChat.chatId });
    return openChat;
}

async function trackSettingsSaves(page) {
    const saved = { accountStorage: {}, version: 1000 };
    await page.route('**/api/settings/save', route => {
        const payload = JSON.parse(route.request().postData() ?? '{}');
        Object.assign(saved.accountStorage, payload.accountStorage);
        return route.fulfill({ json: { result: 'ok', version: ++saved.version } });
    });
    return saved;
}

for (const { name, options } of matrixViewports(VIEWPORTS, [DESKTOP])) {
    test.describe(`Home mode memory at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await installFixtureChats(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);
        });

        test('Home shows Conversation after a Conversation visit', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));

            await goHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
        });

        test('Home shows Roleplay after a Roleplay chat', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await goHome(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));

            await selectSampleCharacter(page);
            await expectChat(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('roleplay'));
            await goHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('roleplay'));
        });

        test('the remembered mode survives a reload', async ({ page }) => {
            const saved = await trackSettingsSaves(page);
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await goHome(page);

            await expect.poll(() => saved.accountStorage[STORAGE_KEY], { timeout: STARTUP_TIMEOUT }).toBe('conversation');

            await page.route('**/api/settings/get', async route => {
                const data = await fetchJsonOrSkip(route);
                if (!data) return;
                const settings = JSON.parse(data.settings);
                settings.accountStorage = { ...settings.accountStorage, ...saved.accountStorage };
                applyHomeTestSettings(settings);
                return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction('document.getElementById("preloader") === null', undefined, { timeout: STARTUP_TIMEOUT });
            await testSetup.waitForAppReady({ page });

            await expectHome(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
        });

        test('the menu on Home checks the remembered mode', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await goHome(page);

            await openModeMenu(page);

            await expect(page.getByRole('menuitemradio', { name: /Conversation/ })).toHaveAttribute('aria-checked', 'true');
            await expect(page.getByRole('menuitemradio', { name: /Roleplay/ })).toHaveAttribute('aria-checked', 'false');
        });

        test('Escape closes the menu on Home and returns focus to the button', async ({ page }) => {
            await openModeMenu(page);
            await expect(page.getByRole('menuitemradio', { name: /Roleplay/ })).toBeFocused();

            await page.keyboard.press('Escape');

            await expect(page.locator('#sb-mode-menu')).toHaveCount(0);
            await expect(page.locator('#sb-mode-toggle')).toBeFocused();
        });

        test('choosing Roleplay on Home resumes the latest Roleplay chat', async ({ page }) => {
            await selectSampleCharacter(page);
            await expectChat(page);
            const openChat = await adoptOpenChat(page);
            await goHome(page);
            await stubRecentChats(page, [
                { file_name: `${openChat.chatId}.jsonl`, avatar: openChat.avatar, group: undefined, last_mes: Date.now() },
            ]);

            await chooseModeFromMenu(page, 'roleplay');

            await expectChat(page);
            expect(await readOpenChat(page)).toEqual(openChat);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('roleplay'));
        });

        test('choosing Roleplay on Home with no Roleplay chats opens the Characters menu', async ({ page }) => {
            await stubRecentChats(page, []);

            await chooseModeFromMenu(page, 'roleplay');

            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
        });

        test('choosing Conversation on Home opens Conversation', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');

            await expectConversation(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
        });

        test('a temporary chat started from Home records Roleplay', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await goHome(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));

            await page.evaluate(async () => {
                const { newAssistantChat } = await import('/script.js');
                await newAssistantChat({ temporary: true });
            });
            await expectChat(page);
            await goHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('roleplay'));
        });

        test('the title click keeps the remembered mode when Conversation is open over Home', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);

            await page.locator('#sb-topbar-title').click();
            await expectHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
        });

        test('the title click records Roleplay when Conversation is open over a Roleplay chat', async ({ page }) => {
            await selectSampleCharacter(page);
            await expectChat(page);
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);

            await page.locator('#sb-topbar-title').click();
            await expectChat(page);
            await goHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('roleplay'));
        });

        test('returning Home from Conversation announces no mode change', async ({ page }) => {
            await countModeChanges(page);

            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            expect(await readModeChanges(page)).toBe(1);
            await goHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
            expect(await readModeChanges(page)).toBe(1);
        });

        test('re-rendering Home keeps the remembered mode', async ({ page }) => {
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await goHome(page);
            await countModeChanges(page);

            await page.evaluate(async () => {
                const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
                await openWelcomeScreen({ force: true });
            });
            await expectHome(page);

            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
            expect(await readModeChanges(page)).toBe(0);
        });

        test('choosing Roleplay on Home opens the Characters menu when the recent chats request fails', async ({ page }) => {
            await page.route('**/api/chats/recent', route => route.fulfill({ status: 500, json: {} }));

            await chooseModeFromMenu(page, 'roleplay');

            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
        });

        test('choosing Roleplay on Home opens the chat with the newest last message and ignores pins', async ({ page }) => {
            const [pinned, newest, oldest] = await pickFixtureCharacters(page, 3);
            expect(newest).toBeDefined();
            const requests = [];
            await page.route('**/api/chats/recent', route => {
                requests.push(JSON.parse(route.request().postData() ?? '{}'));
                return route.fulfill({
                    json: [
                        { file_name: `${pinned.chat}.jsonl`, avatar: pinned.avatar, last_mes: 'June 3, 2025 4:12pm' },
                        { file_name: `${oldest.chat}.jsonl`, avatar: oldest.avatar, last_mes: '2024-01-02T03:04:05.000Z' },
                        { file_name: `${newest.chat}.jsonl`, avatar: newest.avatar, last_mes: 'July 4, 2026 9:45am' },
                    ],
                });
            });

            await chooseModeFromMenu(page, 'roleplay');

            await expectChat(page);
            await expect.poll(() => readOpenChat(page), { timeout: STARTUP_TIMEOUT }).toEqual({ chatId: newest.chat, avatar: newest.avatar });
            expect(requests).toHaveLength(1);
            expect(requests[0].pinned).toEqual([]);
        });

        test('a Roleplay choice does not open a chat once the user has picked Conversation', async ({ page }) => {
            const [character] = await pickFixtureCharacters(page, 1);
            let releaseRecentChats;
            const recentChatsHeld = new Promise(resolve => { releaseRecentChats = resolve; });
            await page.route('**/api/chats/recent', async route => {
                await recentChatsHeld;
                await route.fulfill({ json: [{ file_name: `${character.chat}.jsonl`, avatar: character.avatar, last_mes: Date.now() }] });
            });

            await chooseModeFromMenu(page, 'roleplay');
            await page.keyboard.press('Control+m');
            await expectConversation(page);
            const before = await readOpenChat(page);
            const answered = page.waitForResponse('**/api/chats/recent');
            releaseRecentChats();
            await answered;
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

            expect(await readOpenChat(page)).toEqual(before);
            await expect(page.locator('#sb-settings-page')).toBeHidden();
        });

        test('Ctrl+M on Home with Roleplay shown opens Conversation', async ({ page }) => {
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('roleplay'));

            await page.keyboard.press('Control+m');

            await expectConversation(page);
        });

        test('Ctrl+M on Home with Conversation shown resumes Roleplay', async ({ page }) => {
            await selectSampleCharacter(page);
            await expectChat(page);
            const openChat = await adoptOpenChat(page);
            await goHome(page);
            await chooseModeFromMenu(page, 'conversation');
            await expectConversation(page);
            await goHome(page);
            await expect(page.locator('#sb-mode-toggle')).toHaveAttribute('aria-label', modeTitle('conversation'));
            await stubRecentChats(page, [
                { file_name: `${openChat.chatId}.jsonl`, avatar: openChat.avatar, group: undefined, last_mes: Date.now() },
            ]);

            await page.keyboard.press('Control+m');

            await expectChat(page);
            expect(await readOpenChat(page)).toEqual(openChat);
        });
    });
}
