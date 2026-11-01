import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { makeCharacterCard, withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats, registerFixtureChat } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const COPY_PLACEHOLDER = 'TODO(copy)';
const THUMBNAIL = readFileSync(new URL('../public/img/ai4.png', import.meta.url));

const VIEWPORTS = [
    { name: 'desktop 1440x900', portrait: 128, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', portrait: 64, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const NAHIDA = 'default_AssistantNahida.png';
const NAMES = { [REISEN]: 'Assistant Reisen', [TEWI]: 'Assistant Tewi', [NAHIDA]: 'Assistant Nahida', 'Alice.png': 'Alice' };
const MODE_KEY = 'WelcomePage_LastMode';
// An account that was migrated keeps the pointer it has; the startup would otherwise move it to Reisen.
const MIGRATED = { WelcomePage_AssistantPointerMigrated: 'true' };

const HOME = '#chat > .welcomePanel';
const cardOf = (page, key) => page.locator(`${HOME} .sbHomeCard[data-sb-home-key="${key}"]`);
const overlayOf = card => card.locator('.sbHomeCardOpen');
const startOf = card => card.locator('.sbHomeFootButton').nth(0);
const temporaryOf = card => card.locator('.sbHomeFootButton').nth(1);
const menuOf = card => card.locator('.sbHomeRowMenu');
const hosts = page => page.locator('dialog.sb-dialog-host:not([closing])');

const card = avatar => makeCharacterCard(avatar, NAMES[avatar] ?? avatar);

/**
 * Starts the app on Home with a library that the test names, in memory, and an account storage that it seeds. The
 * cards of the library are made up, and every write the app makes is recorded and answered without reaching the server.
 * @param {import('@playwright/test').Page} page
 * @param {{ library: string[], accountStorage?: Record<string, string>, lastMode?: 'roleplay' | 'conversation' }} options
 */
async function boot(page, { library, accountStorage = {}, lastMode = 'roleplay' }) {
    const world = { library: new Set(library), imports: [], chatSaves: [], lastChats: [] };
    const bundled = [REISEN, TEWI, NAHIDA];

    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() !== 'POST') return;
        if (pathname === '/api/characters/import') world.imports.push(request.url());
        if (pathname === '/api/chats/save') world.chatSaves.push(request.url());
        if (pathname === '/api/characters/last-chat') world.lastChats.push(request.postDataJSON());
    });

    await protectMaintainerServer(page);
    await installFixtureChats(page);
    // Every character already has a chat, so a new chat is told from the one that opens with the character.
    for (const avatar of library) {
        registerFixtureChat(page, { avatar, name: NAMES[avatar] ?? avatar, chat: `qa-${avatar}` });
    }
    await page.route('**/thumbnail?*', route => route.fulfill({ contentType: 'image/png', body: THUMBNAIL }));
    await page.route('**/api/characters/all', async (route) => {
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        return route.fulfill({ json: [...real.filter(entry => !bundled.includes(entry.avatar)), ...[...world.library].map(card)] });
    });
    await page.route('**/api/characters/import', (route) => {
        world.library.add(NAHIDA);
        return route.fulfill({ json: { file_name: NAHIDA.replace(/\.png$/, '') } });
    });
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), [MODE_KEY]: lastMode, ...MIGRATED, ...accountStorage };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });

    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator(HOME)).toBeAttached({ timeout: STARTUP_TIMEOUT });
    return world;
}

const currentChat = page => page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
const currentAvatar = page => page.evaluate(async () => {
    const script = await import('/script.js');
    return script.characters[script.this_chid]?.avatar ?? null;
});
const reloadCharacters = page => page.evaluate(async () => (await import('/script.js')).getCharacters());

/** Makes the thread of a character, which holds its first branch, so a test can count the branches that a click adds. */
const startThread = (page, avatar) => page.evaluate(async (target) => {
    const { getConversationThreadStore } = await import('/scripts/sillybunny-conversation/context.js');
    getConversationThreadStore(target, { create: true });
}, avatar);

const conversationOf = (page, avatar) => page.evaluate(async (target) => {
    const { conversationState } = await import('/scripts/sillybunny-conversation/state.js');
    const { getConversationBranches, getConversationThreadStore } = await import('/scripts/sillybunny-conversation/context.js');
    const { getSettings } = await import('/scripts/sillybunny-conversation/settings-store.js');
    return {
        open: Boolean(conversationState.conversationWorkspaceOpen),
        selected: conversationState.conversationSelectedAvatar,
        branches: getConversationBranches(target).length,
        active: getConversationThreadStore(target, { create: false })?.activeBranchId ?? null,
        enabled: Boolean(getSettings(target).enabled),
    };
}, avatar);

const isTemporary = page => page.evaluate(async () => (await import('/scripts/sillybunny-temporary-chat-state.js')).isTemporaryChat());
const stored = (page, key) => page.evaluate(async storageKey => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem(storageKey), key);

const BOTH = [REISEN, TEWI];

for (const { name, portrait, options } of VIEWPORTS) {
    test.describe(`Home assistant cards at ${name}`, () => {
        test.use(options);

        test.describe('the cards', () => {
            test('are the character of the pointer, then Reisen, Tewi and an installed Nahida, each with its subtitle slot', async ({ page }) => {
                await boot(page, { library: [...BOTH, NAHIDA, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });

                const keys = await page.locator(`${HOME} .sbHomeCards > .sbHomeCard`).evaluateAll(nodes => nodes.map(node => node.dataset.sbHomeKey));
                expect(keys).toEqual(['assistant-pointer', 'assistant-reisen', 'assistant-tewi', 'assistant-nahida', 'assistants-more']);
                await expect(page.locator(`${HOME} .sbHomeCardName`)).toHaveText(['Alice', 'Reisen', 'Tewi', 'Nahida', 'More Assistants']);
                for (const [key, slot] of [['assistant-pointer', 'AS-POINTER-SUB'], ['assistant-reisen', 'AS-REISEN-SUB'], ['assistant-tewi', 'AS-TEWI-SUB'], ['assistant-nahida', 'AS-NAHIDA-SUB']]) {
                    const subtitle = cardOf(page, key).locator('.sbHomeCardSub');
                    await expect(subtitle, key).toHaveAttribute('data-sb-copy-slot', slot);
                    await expect(subtitle, key).toHaveAttribute('data-sb-copy-placeholder', 'true');
                    await expect(subtitle, key).toHaveText(COPY_PLACEHOLDER);
                }
            });

            test('show the thumbnail of the card for the pointer character and for Nahida, and a placeholder box for Reisen and Tewi', async ({ page }) => {
                await boot(page, { library: [...BOTH, NAHIDA, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });

                await expect(cardOf(page, 'assistant-nahida').locator('.sbHomeArt[data-sb-art-placeholder="row-nahida"] img')).toHaveAttribute('src', /file=default_AssistantNahida\.png/);
                await expect(cardOf(page, 'assistant-pointer').locator('.sbHomeArt[data-sb-art-placeholder="row-pointer"] img')).toHaveAttribute('src', /file=Alice\.png/);
                for (const key of ['assistant-nahida', 'assistant-pointer']) {
                    await expect.poll(() => cardOf(page, key).locator('.sbHomeArt img').evaluate(image => image.complete && image.naturalWidth), key).toBeGreaterThan(0);
                }
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeArt[data-sb-art-placeholder="row-reisen"]')).toBeVisible();
                await expect(cardOf(page, 'assistant-reisen').locator('img')).toHaveCount(0);

                // Every portrait has the box of the placeholder of Reisen: the one pixel scale of the screen, the same corners, and a thumbnail that covers it.
                const boxes = await page.locator(`${HOME} .sbHomeCard:not(.sbHomeCard--more) .sbHomeArt`).evaluateAll(nodes => nodes.map((node) => {
                    const box = node.getBoundingClientRect();
                    const image = node.querySelector('img');
                    const imageBox = image?.getBoundingClientRect();
                    return {
                        art: node.dataset.sbArtPlaceholder,
                        size: [Math.round(box.width), Math.round(box.height)],
                        radius: getComputedStyle(node).borderTopLeftRadius,
                        image: imageBox ? { size: [Math.round(imageBox.width), Math.round(imageBox.height)], fit: getComputedStyle(image).objectFit } : null,
                    };
                }));
                const reisen = boxes.find(box => box.art === 'row-reisen');
                expect(reisen.size).toEqual([portrait, portrait]);
                for (const box of boxes) {
                    expect(box.size, `${box.art} box`).toEqual(reisen.size);
                    expect(box.radius, `${box.art} corners`).toBe(reisen.radius);
                }
                const pictures = boxes.filter(box => box.image);
                expect(pictures.map(box => box.art)).toEqual(['row-pointer', 'row-nahida']);
                expect(pictures.map(box => box.image)).toEqual(Array(2).fill({ size: reisen.size, fit: 'cover' }));
            });

            test('keep the box of their art once a window has opened, because the art rules of a window stay inside the window', async ({ page }) => {
                await boot(page, { library: [...BOTH, NAHIDA, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });
                const boxes = () => page.locator(`${HOME} .sbHomeCard:not(.sbHomeCard--more) .sbHomeArt`).evaluateAll(nodes => nodes.map((node) => {
                    const box = node.getBoundingClientRect();
                    return { art: node.dataset.sbArtPlaceholder, size: [Math.round(box.width), Math.round(box.height)] };
                }));
                const before = await boxes();
                expect(before.map(box => box.size)).toEqual(Array(4).fill([portrait, portrait]));

                await page.locator(`${HOME} .sbHomeTile[data-sb-home-key="extras"]`).click();
                await expect(hosts(page)).toBeVisible();
                await expect(page.locator('#deferred-windows-css')).toBeAttached();
                await page.keyboard.press('Escape');
                await expect(hosts(page)).toHaveCount(0);

                expect(await boxes()).toEqual(before);
            });

            test('list Reisen and Tewi alone, with no card for Nahida, while the pointer names one of them or nothing', async ({ page }) => {
                await boot(page, { library: BOTH, accountStorage: { assistant: REISEN } });

                await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`)).toHaveCount(3);
                await expect(cardOf(page, 'assistant-pointer')).toHaveCount(0);
                await expect(cardOf(page, 'assistant-nahida')).toHaveCount(0);
            });

            test('are sensitive when the library has the card: the card button, both footer buttons and the menu button are enabled', async ({ page }) => {
                await boot(page, { library: BOTH });

                for (const key of ['assistant-reisen', 'assistant-tewi']) {
                    await expect(cardOf(page, key).locator('button')).toHaveCount(4);
                    for (const control of await cardOf(page, key).locator('button').all()) {
                        await expect(control, key).toBeEnabled();
                    }
                    await expect(cardOf(page, key).locator('[data-sb-stub]')).toHaveCount(0);
                }
            });
        });

        test.describe('a card with no file', () => {
            test('is insensitive when the library never had the card: its buttons are disabled and it has no menu', async ({ page }) => {
                await boot(page, { library: [REISEN] });
                const tewi = cardOf(page, 'assistant-tewi');

                await expect(overlayOf(tewi)).toBeDisabled();
                await expect(startOf(tewi)).toBeDisabled();
                await expect(temporaryOf(tewi)).toBeDisabled();
                await expect(menuOf(tewi)).toHaveCount(0);
                await expect(tewi.locator('.sbHomeCardFooter > *')).toHaveCount(2);
                await expect(overlayOf(cardOf(page, 'assistant-reisen'))).toBeEnabled();
            });

            test('is insensitive in the same way when the account recorded that the card was deleted', async ({ page }) => {
                await boot(page, { library: [TEWI], accountStorage: { bundledAssistantReisenDeleted: 'true' } });
                const reisen = cardOf(page, 'assistant-reisen');

                await expect(overlayOf(reisen)).toBeDisabled();
                await expect(startOf(reisen)).toBeDisabled();
                await expect(temporaryOf(reisen)).toBeDisabled();
                await expect(menuOf(reisen)).toHaveCount(0);
            });

            test('keeps its name, its placeholder subtitle and its footer labels, and adds no text', async ({ page }) => {
                await boot(page, { library: [] });
                const reisen = cardOf(page, 'assistant-reisen');

                await expect(reisen.locator('.sbHomeCardName')).toHaveText('Reisen');
                await expect(reisen.locator('.sbHomeCardSub')).toHaveText(COPY_PLACEHOLDER);
                await expect(reisen.locator('.sbHomeFootLabel')).toHaveText(['Start New Chat', 'Temporary Chat']);
                await expect(reisen.locator('[data-sb-copy-placeholder="true"]')).toHaveCount(1);
            });

            test('opens nothing when it is pressed', async ({ page }) => {
                const world = await boot(page, { library: [REISEN] });
                const tewi = cardOf(page, 'assistant-tewi');

                await overlayOf(tewi).dispatchEvent('click');
                await startOf(tewi).dispatchEvent('click');
                await temporaryOf(tewi).dispatchEvent('click');

                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
                expect(await currentAvatar(page)).toBeNull();
                expect(world.chatSaves).toEqual([]);
            });

            test('becomes sensitive on the next render of Home once its card is in the library', async ({ page }) => {
                const world = await boot(page, { library: [REISEN] });
                await expect(overlayOf(cardOf(page, 'assistant-tewi'))).toBeDisabled();

                world.library.add(TEWI);
                await reloadCharacters(page);
                await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));

                await expect(overlayOf(cardOf(page, 'assistant-tewi'))).toBeEnabled();
                await expect(menuOf(cardOf(page, 'assistant-tewi'))).toHaveCount(1);
            });
        });

        test.describe('New Chat in Roleplay', () => {
            test('Start New Chat selects the character and opens a new chat of hers', async ({ page }) => {
                const world = await boot(page, { library: BOTH });

                await startOf(cardOf(page, 'assistant-reisen')).click();

                await expect.poll(() => currentAvatar(page)).toBe(REISEN);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Reisen - /);
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', 'on');
                // The chat is recorded as the last one of the character after the new chat has opened.
                await expect.poll(() => world.lastChats.at(-1)).toMatchObject({ avatar: REISEN, chat: expect.stringMatching(/^Assistant Reisen - /) });
                expect(await isTemporary(page)).toBe(false);
            });

            test('the card button does the same for Tewi', async ({ page }) => {
                await boot(page, { library: BOTH });

                await overlayOf(cardOf(page, 'assistant-tewi')).click();

                await expect.poll(() => currentAvatar(page)).toBe(TEWI);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Tewi - /);
            });

            test('opens a chat with Nahida from her card', async ({ page }) => {
                await boot(page, { library: [...BOTH, NAHIDA, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });

                await startOf(cardOf(page, 'assistant-nahida')).click();

                await expect.poll(() => currentAvatar(page)).toBe(NAHIDA);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Nahida - /);
            });

            test('opens one chat when the button is pressed twice in a row', async ({ page }) => {
                const world = await boot(page, { library: BOTH });
                const button = startOf(cardOf(page, 'assistant-reisen'));

                await button.evaluate((node) => {
                    node.click();
                    node.click();
                });

                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Reisen - /);
                // That a second press opens nothing is the unit test of the actions; here the first one must reach the app once.
                await expect.poll(() => world.lastChats.filter(entry => entry.avatar === REISEN).length).toBe(1);
            });
        });

        test.describe('New Chat in Conversation', () => {
            test('makes a new branch of the thread, turns Conversation on for the character and opens it', async ({ page }) => {
                const world = await boot(page, { library: BOTH, lastMode: 'conversation' });
                await startThread(page, REISEN);
                const before = await conversationOf(page, REISEN);

                await startOf(cardOf(page, 'assistant-reisen')).click();

                await expect.poll(() => conversationOf(page, REISEN)).toMatchObject({ open: true, selected: REISEN, enabled: true, branches: before.branches + 1 });
                const after = await conversationOf(page, REISEN);
                expect(after.active).not.toBe(before.active);
                expect(await currentChat(page)).toBeUndefined();
                expect(world.chatSaves).toEqual([]);
            });

            test('a second New Chat is a second fresh branch, not the one before', async ({ page }) => {
                await boot(page, { library: BOTH, lastMode: 'conversation' });
                await startThread(page, TEWI);
                await overlayOf(cardOf(page, 'assistant-tewi')).click();
                await expect.poll(() => conversationOf(page, TEWI)).toMatchObject({ open: true });
                const first = await conversationOf(page, TEWI);

                await page.evaluate(async () => {
                    window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
                    await (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true });
                });
                await expect.poll(async () => (await conversationOf(page, TEWI)).open).toBe(false);
                await overlayOf(cardOf(page, 'assistant-tewi')).click();

                await expect.poll(async () => (await conversationOf(page, TEWI)).branches).toBe(first.branches + 1);
                expect((await conversationOf(page, TEWI)).active).not.toBe(first.active);
            });
        });

        test.describe('Temporary Chat', () => {
            test('opens a temporary chat with the character: the banner shows and nothing is saved', async ({ page }) => {
                const world = await boot(page, { library: BOTH });

                await temporaryOf(cardOf(page, 'assistant-reisen')).click();

                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                expect(await currentAvatar(page)).toBe(REISEN);
                expect(await isTemporary(page)).toBe(true);
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', 'on');
                expect(world.chatSaves).toEqual([]);
                expect(world.lastChats).toEqual([]);
            });

            test('a new chat asks before it leaves a temporary chat that was written in, and Cancel keeps the chat unsaved', async ({ page }) => {
                const world = await boot(page, { library: BOTH });
                await temporaryOf(cardOf(page, 'assistant-reisen')).click();
                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                await page.evaluate(async () => {
                    const script = await import('/script.js');
                    script.chat.push({ name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'Hello there', extra: {} });
                    window.qaNewChat = script.doNewChat({ deleteCurrentChat: false });
                });

                const alert = page.locator('[role="alertdialog"]');
                await expect(alert.locator('.sb-dialog__heading')).toHaveAttribute('data-sb-copy-slot', 'TC-LEAVE-HEAD');
                await alert.getByRole('button', { name: 'Cancel' }).click();
                await page.evaluate(() => window.qaNewChat);

                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                expect(await isTemporary(page)).toBe(true);
                expect(world.chatSaves).toEqual([]);
                expect(world.lastChats).toEqual([]);
            });

            test('opens in Roleplay even when Conversation was the last mode', async ({ page }) => {
                const world = await boot(page, { library: BOTH, lastMode: 'conversation' });

                await temporaryOf(cardOf(page, 'assistant-tewi')).click();

                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                expect(await currentAvatar(page)).toBe(TEWI);
                expect((await conversationOf(page, TEWI)).open).toBe(false);
                expect(world.chatSaves).toEqual([]);
            });
        });

        test.describe('New Chat in the other mode, from the Assistant Menu', () => {
            test('opens a fresh Conversation when Roleplay was the last mode', async ({ page }) => {
                await boot(page, { library: BOTH, lastMode: 'roleplay' });
                await startThread(page, REISEN);
                const before = await conversationOf(page, REISEN);

                await menuOf(cardOf(page, 'assistant-reisen')).click();
                await page.getByRole('menuitem', { name: 'New Chat in Conversation' }).click();

                await expect.poll(() => conversationOf(page, REISEN)).toMatchObject({ open: true, selected: REISEN, enabled: true, branches: before.branches + 1 });
                expect(await stored(page, MODE_KEY)).toBe('conversation');
            });

            test('opens a new Roleplay chat when Conversation was the last mode', async ({ page }) => {
                await boot(page, { library: BOTH, lastMode: 'conversation' });

                await menuOf(cardOf(page, 'assistant-tewi')).click();
                await page.getByRole('menuitem', { name: 'New Chat in Roleplay' }).click();

                await expect.poll(() => currentAvatar(page)).toBe(TEWI);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Tewi - /);
                expect((await conversationOf(page, TEWI)).open).toBe(false);
            });

            test('a new Roleplay chat closes the Conversation workspace that is open', async ({ page }) => {
                await boot(page, { library: BOTH, lastMode: 'conversation' });
                await startThread(page, REISEN);
                await overlayOf(cardOf(page, 'assistant-reisen')).click();
                await expect.poll(() => conversationOf(page, REISEN)).toMatchObject({ open: true });
                // Home turns off a moment after the workspace opens, and a layout change closes an open menu.
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', 'on');

                // The workspace covers Home, so the menu button of the card is pressed through the page.
                await menuOf(cardOf(page, 'assistant-tewi')).dispatchEvent('click');
                await page.getByRole('menuitem', { name: 'New Chat in Roleplay' }).click();

                await expect.poll(async () => (await conversationOf(page, REISEN)).open).toBe(false);
                await expect.poll(() => currentAvatar(page)).toBe(TEWI);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Tewi - /);
            });

            test('the menu offers nothing for a card with no file, so the card has no menu button', async ({ page }) => {
                await boot(page, { library: [REISEN] });

                await expect(menuOf(cardOf(page, 'assistant-tewi'))).toHaveCount(0);
                await expect(menuOf(cardOf(page, 'assistant-reisen'))).toHaveCount(1);
            });
        });

        test.describe('a card whose character has left the library since Home rendered', () => {
            test('tells the user with the placeholder toast when New Chat is pressed, and Home stays', async ({ page }) => {
                const world = await boot(page, { library: BOTH });
                await showToasts(page);
                await page.evaluate(async (avatar) => {
                    const { characters } = await import('/script.js');
                    characters.splice(characters.findIndex(character => character.avatar === avatar), 1);
                }, REISEN);

                await startOf(cardOf(page, 'assistant-reisen')).click();

                const toast = page.locator('#toast-container .toast-message[data-sb-copy-slot="AS-ACTION-ERROR"]');
                await expect(toast).toBeVisible();
                await expect(toast).toHaveAttribute('data-sb-copy-placeholder', 'true');
                await expect(toast).toHaveText(COPY_PLACEHOLDER);
                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
                expect(world.chatSaves).toEqual([]);
            });
        });

        test.describe('Nahida after Install', () => {
            test('has no card until she is installed, and Install in Bundled Extras adds her card to Home', async ({ page }) => {
                const world = await boot(page, { library: BOTH });
                await expect(cardOf(page, 'assistant-nahida')).toHaveCount(0);

                await page.locator(`${HOME} .sbHomeTile[data-sb-home-key="extras"]`).click();
                const host = hosts(page);
                await expect(host).toBeVisible();
                const row = host.locator('.ds-row', { has: page.locator('.ds-row-label', { hasText: /^Nahida$/ }) });
                await row.locator('.sbBundledExtraControls button', { hasText: 'Install' }).click();

                await expect(row.locator('.sbBundledExtraState')).toHaveText('Installed');
                expect(world.imports).toHaveLength(1);
                const nahida = cardOf(page, 'assistant-nahida');
                await expect(nahida).toHaveCount(1);
                await expect(nahida.locator('.sbHomeCardName')).toHaveText('Nahida');
                await expect(nahida.locator('.sbHomeCardSub')).toHaveAttribute('data-sb-copy-slot', 'AS-NAHIDA-SUB');
                await expect(nahida.locator('.sbHomeArt img')).toHaveAttribute('src', /file=default_AssistantNahida\.png/);
                await expect(overlayOf(nahida)).toBeEnabled();
                await expect(startOf(nahida)).toBeEnabled();
                await expect(menuOf(nahida)).toHaveCount(1);
            });

            test('her card is last of the assistant cards, before More Assistants', async ({ page }) => {
                await boot(page, { library: [...BOTH, NAHIDA] });

                const keys = await page.locator(`${HOME} .sbHomeCards > .sbHomeCard`).evaluateAll(nodes => nodes.map(node => node.dataset.sbHomeKey));
                expect(keys).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-nahida', 'assistants-more']);
            });
        });
    });
}
