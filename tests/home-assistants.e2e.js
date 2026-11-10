import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { makeCharacterCard, withoutAssistantAccount } from './helpers/assistant-library.js';
import { HOME_COPY } from './helpers/copy-home.js';
import { TC_COPY } from './helpers/copy-temporary-chat.js';
import { installFixtureChats, registerFixtureChat } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const SUBTITLES = {
    reisen: 'Did you need help with setup or troubleshooting? Leave it to me!',
    tewi: 'Gege~ Are you a little down on your luck? Ask me anything!',
    pointer: 'Chosen from your character library.',
    own: 'Pick any character from your library as a third assistant.',
};
const actionErrorToast = page => page.locator('#toast-container .toast-message', { hasText: HOME_COPY.assistantActionError });
const THUMBNAIL = readFileSync(new URL('../public/img/ai4.png', import.meta.url));

const VIEWPORTS = [
    { name: 'desktop 1440x900', portrait: 128, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', portrait: 64, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const NAHIDA = 'default_AssistantNahida.png';
const NAMES = { [REISEN]: 'Assistant Reisen', [TEWI]: 'Assistant Tewi', [NAHIDA]: 'Assistant Nahida', 'Alice.png': 'Alice', 'Bob.png': 'Bob' };
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
 * @param {{ library: string[], accountStorage?: Record<string, string>, lastMode?: 'roleplay' | 'conversation', exact?: boolean }} options
 *   `exact` drops the characters that the data root holds, so the picker lists the library of the test and nothing else.
 */
async function boot(page, { library, accountStorage = {}, lastMode = 'roleplay', exact = false, missingThumbnails = [] }) {
    const world = { library: new Set(library), chatSaves: [], lastChats: [], thumbnailRequests: [] };
    const bundled = [REISEN, TEWI, NAHIDA];

    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() !== 'POST') return;
        if (pathname === '/api/chats/save') world.chatSaves.push(request.url());
        if (pathname === '/api/characters/last-chat') world.lastChats.push(request.postDataJSON());
    });

    await protectMaintainerServer(page);
    await installFixtureChats(page);
    // Every character already has a chat, so a new chat is told from the one that opens with the character.
    for (const avatar of library) {
        registerFixtureChat(page, { avatar, name: NAMES[avatar] ?? avatar, chat: `qa-${avatar}` });
    }
    // The server answers 404 when it cannot make a thumbnail, and a card of a character that was deleted meanwhile is the same.
    await page.route('**/thumbnail?*', (route) => {
        const url = new URL(route.request().url());
        world.thumbnailRequests.push(url.search);
        if (missingThumbnails.includes(url.searchParams.get('file'))) {
            return route.fulfill({ status: 404, body: '' });
        }
        return route.fulfill({ contentType: 'image/png', body: THUMBNAIL });
    });
    await page.route('**/api/characters/all', async (route) => {
        if (exact) return route.fulfill({ json: [...world.library].map(card) });
        const real = await fetchJsonOrSkip(route);
        if (!real) return;
        return route.fulfill({ json: [...real.filter(entry => !bundled.includes(entry.avatar)), ...[...world.library].map(card)] });
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
        // Only the tests that measure a portrait or a card use `test`; the rest do not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        test.describe('the cards', () => {
            sizeFreeTest('are Reisen, Tewi and the character of the pointer, each with its subtitle', async ({ page }) => {
                await boot(page, { library: [...BOTH, NAHIDA, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });

                const keys = await page.locator(`${HOME} .sbHomeCards > .sbHomeCard`).evaluateAll(nodes => nodes.map(node => node.dataset.sbHomeKey));
                expect(keys).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
                await expect(page.locator(`${HOME} .sbHomeCardName`)).toHaveText(['Reisen', 'Tewi', 'Alice']);
                for (const [key, text] of [['assistant-reisen', SUBTITLES.reisen], ['assistant-tewi', SUBTITLES.tewi], ['assistant-own', SUBTITLES.pointer]]) {
                    const subtitle = cardOf(page, key).locator('.sbHomeCardSub');
                    await expect(subtitle, key).toHaveText(text);
                    await expect(subtitle, key).not.toHaveAttribute('data-sb-copy-placeholder', /./);
                }
            });

            test('show the thumbnail of their own card on every card: Reisen, Tewi and the pointer character', async ({ page }) => {
                await boot(page, { library: [...BOTH, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });
                const thumbnailOf = avatar => page.evaluate(async file => (await import('/script.js')).getMobileThumbnailUrl('avatar', file), avatar);

                for (const [key, avatar, art] of [['assistant-reisen', REISEN, 'row-reisen'], ['assistant-tewi', TEWI, 'row-tewi'], ['assistant-own', 'Alice.png', 'row-pointer']]) {
                    const image = cardOf(page, key).locator(`.sbHomeArt[data-sb-art-placeholder="${art}"] img`);
                    await expect(image, key).toHaveAttribute('src', await thumbnailOf(avatar));
                    await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth), key).toBeGreaterThan(0);
                }

                // Every portrait has the same box: the one pixel scale of the screen, the same corners, and a thumbnail that covers it, cropped alike.
                const boxes = await page.locator(`${HOME} .sbHomeCard:not(.sbHomeCard--choose) .sbHomeArt`).evaluateAll(nodes => nodes.map((node) => {
                    const box = node.getBoundingClientRect();
                    const image = node.querySelector('img');
                    const imageBox = image.getBoundingClientRect();
                    return {
                        art: node.dataset.sbArtPlaceholder,
                        size: [Math.round(box.width), Math.round(box.height)],
                        radius: getComputedStyle(node).borderTopLeftRadius,
                        rendering: [getComputedStyle(node).imageRendering, getComputedStyle(image).imageRendering],
                        image: { size: [Math.round(imageBox.width), Math.round(imageBox.height)], fit: getComputedStyle(image).objectFit, position: getComputedStyle(image).objectPosition },
                    };
                }));
                expect(boxes.map(box => box.art)).toEqual(['row-reisen', 'row-tewi', 'row-pointer']);
                const pointer = boxes.find(box => box.art === 'row-pointer');
                expect(pointer.size).toEqual([portrait, portrait]);
                for (const box of boxes) {
                    expect(box.size, `${box.art} box`).toEqual(pointer.size);
                    expect(box.radius, `${box.art} corners`).toBe(pointer.radius);
                    // The portraits are smooth pictures: they are scaled with the smooth filter, not drawn as pixel art.
                    expect(box.rendering, `${box.art} is not drawn as pixel art`).toEqual(['auto', 'auto']);
                    expect(box.image, `${box.art} picture`).toEqual({ size: pointer.size, fit: 'cover', position: pointer.image.position });
                }
            });

            test('show no art name as text: a box that has no picture is empty, and so is every other', async ({ page }) => {
                await boot(page, { library: [REISEN, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeArt img')).toHaveCount(1);

                const shown = await page.evaluate(() => {
                    const panel = document.querySelector('#chat > .welcomePanel');
                    const boxes = [...panel.querySelectorAll('[data-sb-art-placeholder]')];
                    return {
                        names: boxes.map(box => box.dataset.sbArtPlaceholder),
                        text: panel.innerText,
                        withText: boxes.filter(box => box.textContent.trim() !== '').map(box => box.dataset.sbArtPlaceholder),
                    };
                });

                expect(shown.names).toEqual(expect.arrayContaining(['row-reisen', 'row-tewi', 'row-pointer']));
                expect(shown.withText).toEqual([]);
                for (const artName of shown.names) {
                    expect(shown.text, artName).not.toContain(artName);
                }
            });

            test('keep the box of their art once a window has opened, because the art rules of a window stay inside the window', async ({ page }) => {
                await boot(page, { library: [...BOTH, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });
                const boxes = () => page.locator(`${HOME} .sbHomeCard:not(.sbHomeCard--choose) .sbHomeArt`).evaluateAll(nodes => nodes.map((node) => {
                    const box = node.getBoundingClientRect();
                    return { art: node.dataset.sbArtPlaceholder, size: [Math.round(box.width), Math.round(box.height)] };
                }));
                const before = await boxes();
                expect(before.map(box => box.size)).toEqual(Array(3).fill([portrait, portrait]));

                await page.locator(`${HOME} .sbHomeTile[data-sb-home-key="extras"]`).click();
                await expect(hosts(page)).toBeVisible();
                await expect(page.locator('#deferred-windows-css')).toBeAttached();
                await page.keyboard.press('Escape');
                await expect(hosts(page)).toHaveCount(0);

                expect(await boxes()).toEqual(before);
            });

            sizeFreeTest('are sensitive when the library has the card: the card button, both footer buttons and the menu button are enabled', async ({ page }) => {
                await boot(page, { library: BOTH });

                for (const key of ['assistant-reisen', 'assistant-tewi']) {
                    await expect(cardOf(page, key).locator('button:not(.sbHomeCardConnect)')).toHaveCount(4);
                    for (const control of await cardOf(page, key).locator('button:not(.sbHomeCardConnect)').all()) {
                        await expect(control, key).toBeEnabled();
                    }
                    await expect(cardOf(page, key).locator('[data-sb-stub]')).toHaveCount(0);
                }
            });
        });

        test.describe('the thumbnails', () => {
            const thumbnailUrl = avatar => `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}&preset=mobile`;

            test('are the small mobile preset at every viewport, and the full-size file is never fetched for a card', async ({ page }) => {
                const world = await boot(page, { library: [...BOTH, 'Alice.png'], accountStorage: { assistant: 'Alice.png' } });

                for (const [key, avatar] of [['assistant-reisen', REISEN], ['assistant-tewi', TEWI], ['assistant-own', 'Alice.png']]) {
                    await expect(cardOf(page, key).locator('.sbHomeArt img'), key).toHaveAttribute('src', thumbnailUrl(avatar));
                }
                const requested = world.thumbnailRequests.filter(search => /file=(default_Assistant|Alice)/.test(search));
                expect(requested.length).toBeGreaterThanOrEqual(3);
                expect(requested.filter(search => !search.includes('preset=mobile'))).toEqual([]);
            });

            test('are the same in the picker', async ({ page }) => {
                await boot(page, { library: [...BOTH, 'Alice.png'], exact: true });

                await overlayOf(cardOf(page, 'assistant-own')).click();

                await expect(hosts(page)).toBeVisible();
                await expect(hosts(page).locator('img.sbAssistantPickerThumb')).toHaveAttribute('src', thumbnailUrl('Alice.png'));
            });

            test('leave the box of a card whose thumbnail cannot be made empty, with no picture and no text', async ({ page }) => {
                const world = await boot(page, { library: [...BOTH, 'Alice.png'], accountStorage: { assistant: 'Alice.png' }, missingThumbnails: [TEWI, 'Alice.png'] });

                await expect.poll(() => world.thumbnailRequests.filter(search => search.includes(`file=${TEWI}`)).length).toBeGreaterThan(0);
                for (const [key, art] of [['assistant-tewi', 'row-tewi'], ['assistant-own', 'row-pointer']]) {
                    const box = cardOf(page, key).locator(`.sbHomeArt[data-sb-art-placeholder="${art}"]`);
                    await expect(box, key).toBeVisible();
                    await expect(box.locator('img'), key).toHaveCount(0);
                    await expect(box, key).toHaveText('');
                    expect(await box.evaluate(node => getComputedStyle(node).backgroundColor), key).not.toBe('rgba(0, 0, 0, 0)');
                }
                await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeArt img')).toHaveCount(1);
            });
        });

        test.describe('a card with no file', () => {
            sizeFreeTest('is insensitive when the library never had the card: its buttons are disabled and it has no menu', async ({ page }) => {
                await boot(page, { library: [REISEN] });
                const tewi = cardOf(page, 'assistant-tewi');

                await expect(overlayOf(tewi)).toBeDisabled();
                await expect(startOf(tewi)).toBeDisabled();
                await expect(temporaryOf(tewi)).toBeDisabled();
                await expect(menuOf(tewi)).toHaveCount(0);
                await expect(tewi.locator('.sbHomeCardFooter > *')).toHaveCount(2);
                await expect(overlayOf(cardOf(page, 'assistant-reisen'))).toBeEnabled();
            });

            test('shows a tinted box of the size of the portraits, with no picture and no text, in place of its art', async ({ page }) => {
                await boot(page, { library: [REISEN] });
                await expect(overlayOf(cardOf(page, 'assistant-reisen'))).toBeEnabled();
                const art = cardOf(page, 'assistant-tewi').locator('.sbHomeArt[data-sb-art-placeholder="row-tewi"]');

                await expect(art).toBeVisible();
                await expect(art).toHaveAttribute('aria-hidden', 'true');
                await expect(art).toHaveText('');
                await expect(art.locator('img')).toHaveCount(0);
                const box = await art.boundingBox();
                expect([Math.round(box.width), Math.round(box.height)]).toEqual([portrait, portrait]);
                expect(await art.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
            });

            sizeFreeTest('is insensitive in the same way when the account recorded that the card was deleted', async ({ page }) => {
                await boot(page, { library: [TEWI], accountStorage: { bundledAssistantReisenDeleted: 'true' } });
                const reisen = cardOf(page, 'assistant-reisen');

                await expect(overlayOf(reisen)).toBeDisabled();
                await expect(startOf(reisen)).toBeDisabled();
                await expect(temporaryOf(reisen)).toBeDisabled();
                await expect(menuOf(reisen)).toHaveCount(0);
            });

            sizeFreeTest('keeps its name, its subtitle and its footer labels, and adds no text', async ({ page }) => {
                await boot(page, { library: [] });
                const reisen = cardOf(page, 'assistant-reisen');

                await expect(reisen.locator('.sbHomeCardName')).toHaveText('Reisen');
                await expect(reisen.locator('.sbHomeCardSub')).toHaveText(SUBTITLES.reisen);
                await expect(reisen.locator('.sbHomeFootLabel')).toHaveText(['Start New Chat', 'Temporary Chat']);
                await expect(reisen.locator('[data-sb-copy-placeholder="true"]')).toHaveCount(0);
            });

            sizeFreeTest('opens nothing when it is pressed', async ({ page }) => {
                const world = await boot(page, { library: [REISEN] });
                const tewi = cardOf(page, 'assistant-tewi');

                await overlayOf(tewi).dispatchEvent('click');
                await startOf(tewi).dispatchEvent('click');
                await temporaryOf(tewi).dispatchEvent('click');

                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
                expect(await currentAvatar(page)).toBeNull();
                expect(world.chatSaves).toEqual([]);
            });

            sizeFreeTest('becomes sensitive on the next render of Home once its card is in the library', async ({ page }) => {
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
            sizeFreeTest('Start New Chat selects the character and opens a new chat of hers', async ({ page }) => {
                const world = await boot(page, { library: BOTH });

                await startOf(cardOf(page, 'assistant-reisen')).click();

                await expect.poll(() => currentAvatar(page)).toBe(REISEN);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Reisen - /);
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', 'on');
                // The chat is recorded as the last one of the character after the new chat has opened.
                await expect.poll(() => world.lastChats.at(-1)).toMatchObject({ avatar: REISEN, chat: expect.stringMatching(/^Assistant Reisen - /) });
                expect(await isTemporary(page)).toBe(false);
            });

            sizeFreeTest('the card button does the same for Tewi', async ({ page }) => {
                await boot(page, { library: BOTH });

                await overlayOf(cardOf(page, 'assistant-tewi')).click();

                await expect.poll(() => currentAvatar(page)).toBe(TEWI);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Tewi - /);
            });

            sizeFreeTest('opens one chat when the button is pressed twice in a row', async ({ page }) => {
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
            sizeFreeTest('makes a new branch of the thread, turns Conversation on for the character and opens it', async ({ page }) => {
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

            sizeFreeTest('a second New Chat is a second fresh branch, not the one before', async ({ page }) => {
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
            sizeFreeTest('opens a temporary chat with the character: the banner shows and nothing is saved', async ({ page }) => {
                const world = await boot(page, { library: BOTH });

                await temporaryOf(cardOf(page, 'assistant-reisen')).click();

                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                expect(await currentAvatar(page)).toBe(REISEN);
                expect(await isTemporary(page)).toBe(true);
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', 'on');
                expect(world.chatSaves).toEqual([]);
                expect(world.lastChats).toEqual([]);
            });

            sizeFreeTest('a new chat asks before it leaves a temporary chat that was written in, and Cancel keeps the chat unsaved', async ({ page }) => {
                const world = await boot(page, { library: BOTH });
                await temporaryOf(cardOf(page, 'assistant-reisen')).click();
                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                await page.evaluate(async () => {
                    const script = await import('/script.js');
                    script.chat.push({ name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'Hello there', extra: {} });
                    window.qaNewChat = script.doNewChat({ deleteCurrentChat: false });
                });

                const alert = page.locator('[role="alertdialog"]');
                await expect(alert.locator('.sb-dialog__heading')).toHaveText(TC_COPY.leaveHead);
                await alert.getByRole('button', { name: 'Cancel' }).click();
                await page.evaluate(() => window.qaNewChat);

                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                expect(await isTemporary(page)).toBe(true);
                expect(world.chatSaves).toEqual([]);
                expect(world.lastChats).toEqual([]);
            });

            sizeFreeTest('opens in Roleplay even when Conversation was the last mode', async ({ page }) => {
                const world = await boot(page, { library: BOTH, lastMode: 'conversation' });

                await temporaryOf(cardOf(page, 'assistant-tewi')).click();

                await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                expect(await currentAvatar(page)).toBe(TEWI);
                expect((await conversationOf(page, TEWI)).open).toBe(false);
                expect(world.chatSaves).toEqual([]);
            });
        });

        test.describe('New Chat in the other mode, from the Assistant Menu', () => {
            sizeFreeTest('opens a fresh Conversation when Roleplay was the last mode', async ({ page }) => {
                await boot(page, { library: BOTH, lastMode: 'roleplay' });
                await startThread(page, REISEN);
                const before = await conversationOf(page, REISEN);

                await menuOf(cardOf(page, 'assistant-reisen')).click();
                await page.getByRole('menuitem', { name: 'New Chat in Conversation' }).click();

                await expect.poll(() => conversationOf(page, REISEN)).toMatchObject({ open: true, selected: REISEN, enabled: true, branches: before.branches + 1 });
                expect(await stored(page, MODE_KEY)).toBe('conversation');
            });

            sizeFreeTest('opens a new Roleplay chat when Conversation was the last mode', async ({ page }) => {
                await boot(page, { library: BOTH, lastMode: 'conversation' });

                await menuOf(cardOf(page, 'assistant-tewi')).click();
                await page.getByRole('menuitem', { name: 'New Chat in Roleplay' }).click();

                await expect.poll(() => currentAvatar(page)).toBe(TEWI);
                await expect.poll(() => currentChat(page)).toMatch(/^Assistant Tewi - /);
                expect((await conversationOf(page, TEWI)).open).toBe(false);
            });

            sizeFreeTest('a new Roleplay chat closes the Conversation workspace that is open', async ({ page }) => {
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

            sizeFreeTest('the menu offers nothing for a card with no file, so the card has no menu button', async ({ page }) => {
                await boot(page, { library: [REISEN] });

                await expect(menuOf(cardOf(page, 'assistant-tewi'))).toHaveCount(0);
                await expect(menuOf(cardOf(page, 'assistant-reisen'))).toHaveCount(1);
            });
        });

        test.describe('a card whose character has left the library since Home rendered', () => {
            sizeFreeTest('tells the user with the placeholder toast when New Chat is pressed, and Home stays', async ({ page }) => {
                const world = await boot(page, { library: BOTH });
                await showToasts(page);
                await page.evaluate(async (avatar) => {
                    const { characters } = await import('/script.js');
                    characters.splice(characters.findIndex(character => character.avatar === avatar), 1);
                }, REISEN);

                await startOf(cardOf(page, 'assistant-reisen')).click();

                const toast = actionErrorToast(page);
                await expect(toast).toBeVisible();
                await expect(toast).toHaveText(HOME_COPY.assistantActionError);
                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
                expect(world.chatSaves).toEqual([]);
            });
        });

        test.describe('the third slot', () => {
            const ownCard = page => cardOf(page, 'assistant-own');
            const chooseOf = page => overlayOf(ownCard(page));
            const LIBRARY = [...BOTH, NAHIDA, 'Alice.png', 'Bob.png'];
            const expectChooseCard = async (page) => {
                const own = ownCard(page);

                await expect(own.locator('.sbHomeCardName')).toHaveText('Choose Assistant');
                await expect(own.locator('.sbHomeCardSub')).toHaveText(SUBTITLES.own);
                await expect(own.locator('.sbHomeCardSub')).not.toHaveAttribute('data-sb-copy-placeholder', /./);
                await expect(own.locator('.sbHomeCardFooter')).toHaveCount(0);
                await expect(menuOf(own)).toHaveCount(0);
                await expect(own.locator('button')).toHaveCount(1);
                await expect(chooseOf(page)).toHaveAccessibleName('Choose Assistant');
                await expect(chooseOf(page)).toHaveAttribute('aria-haspopup', 'dialog');
                await expect(own.locator('.sbHomeChooseIcon i.fa-user-plus')).toHaveCount(1);
            };
            const expectPointerCard = async (page) => {
                const own = ownCard(page);

                await expect(own.locator('.sbHomeCardName')).toHaveText('Alice');
                await expect(own.locator('.sbHomeCardSub')).toHaveText(SUBTITLES.pointer);
                await expect(own.locator('.sbHomeArt[data-sb-art-placeholder="row-pointer"] img')).toHaveAttribute('src', /file=Alice\.png/);
                await expect(own.locator('button:not(.sbHomeCardConnect)')).toHaveCount(4);
                await expect(own.locator('.sbHomeFootLabel')).toHaveText(['Start New Chat', 'Temporary Chat']);
                await expect(menuOf(own)).toHaveCount(1);
                await expect(own.locator('.sbHomeChooseIcon')).toHaveCount(0);
                const art = await sizeOf(own.locator('.sbHomeArt'));
                expect([art.width, art.height]).toEqual([portrait, portrait]);
            };
            const openFromChooseCard = page => chooseOf(page).click();
            const openFromMenu = async (page) => {
                await menuOf(ownCard(page)).click();
                await page.getByRole('menuitem', { name: 'Choose Another Assistant…' }).click();
            };
            const ROOTS = [
                { name: 'no pointer', accountStorage: {}, kind: 'choose', expectCard: expectChooseCard, openPicker: openFromChooseCard },
                { name: 'a pointer to a user card', accountStorage: { assistant: 'Alice.png' }, kind: 'pointer', expectCard: expectPointerCard, openPicker: openFromMenu },
                { name: 'a pointer to Reisen', accountStorage: { assistant: REISEN }, kind: 'choose', expectCard: expectChooseCard, openPicker: openFromChooseCard },
                { name: 'a pointer to a missing avatar', accountStorage: { assistant: 'Gone.png' }, kind: 'choose', expectCard: expectChooseCard, openPicker: openFromChooseCard },
            ];
            const sizeOf = locator => locator.evaluate((node) => {
                const box = node.getBoundingClientRect();
                return { width: box.width, height: box.height };
            });

            const MODE_LABELS = { full: 'Full', compact: 'Compact' };
            for (const mode of Object.keys(MODE_LABELS)) {
                test(`keeps the height of every card the same whether the third slot is empty or chosen, in ${MODE_LABELS[mode]} mode`, async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    await page.locator(`${HOME} .sbHomeMenuButton`).click();
                    await page.getByRole('menuitemradio', { name: MODE_LABELS[mode], exact: true }).click();
                    await expect(page.locator(HOME)).toHaveAttribute('data-home-panel-mode', mode);
                    const heights = () => page.locator(`${HOME} .sbHomeCards > .sbHomeCard`).evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height));
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');
                    const empty = await heights();

                    await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).setAssistantPointer('Alice.png'));
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'pointer');
                    const chosen = await heights();

                    expect(empty).toHaveLength(3);
                    expect(chosen).toHaveLength(3);
                    expect(Math.max(...empty) - Math.min(...empty), 'the cards of one state are as tall as each other').toBeLessThanOrEqual(1);
                    expect(Math.max(...chosen) - Math.min(...chosen)).toBeLessThanOrEqual(1);
                    expect(Math.abs(empty[0] - chosen[0]), `Reisen is ${empty[0]}px tall with the slot empty and ${chosen[0]}px with it chosen`).toBeLessThanOrEqual(1);
                });
            }

            for (const { name: rootName, accountStorage, kind, expectCard, openPicker } of ROOTS) {
                test.describe(`with ${rootName}`, () => {
                    test(`is ${kind === 'choose' ? 'the Choose Assistant card' : 'the card of the chosen character'}, third of three, the size of the card of Reisen`, async ({ page }) => {
                        await boot(page, { library: LIBRARY, accountStorage, exact: true });

                        await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`)).toHaveCount(3);
                        await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`).nth(2)).toHaveAttribute('data-sb-home-key', 'assistant-own');
                        await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', kind);
                        await expect(cardOf(page, 'assistant-reisen')).toHaveAttribute('data-sb-assistant-kind', 'bundled');
                        const own = await sizeOf(ownCard(page));
                        const reisen = await sizeOf(cardOf(page, 'assistant-reisen'));
                        expect(Math.abs(own.width - reisen.width), 'width').toBeLessThanOrEqual(1);
                        expect(Math.abs(own.height - reisen.height), 'height').toBeLessThanOrEqual(1);
                    });

                    // eslint-disable-next-line playwright/expect-expect -- The state of the card has its assertions in `expectCard`.
                    test('has the controls and the text of its state', async ({ page }) => {
                        await boot(page, { library: LIBRARY, accountStorage, exact: true });

                        await expectCard(page);
                    });

                    sizeFreeTest('lists Reisen and Tewi once each, and the same characters in the picker whatever the pointer names', async ({ page }) => {
                        await boot(page, { library: LIBRARY, accountStorage, exact: true });

                        await expect(cardOf(page, 'assistant-reisen')).toHaveCount(1);
                        await expect(cardOf(page, 'assistant-tewi')).toHaveCount(1);
                        await openPicker(page);

                        const host = hosts(page);
                        await expect(host).toBeVisible();
                        await expect(host).toHaveAccessibleName('Choose Assistant');
                        await expect(host.locator('.ds-row-label')).toHaveText(['Alice', 'Assistant Nahida', 'Bob']);
                    });
                });
            }

            test.describe('the picker', () => {
                const openPicker = async (page) => {
                    await chooseOf(page).click();
                    const host = hosts(page);
                    await expect(host).toBeVisible();
                    return host;
                };
                const rowOf = (host, page, label) => host.locator('.ds-row', { has: page.locator('.ds-row-label', { hasText: new RegExp(`^${label}$`) }) });
                const searchInputOf = host => host.locator('.sb-dialog__search input');

                sizeFreeTest('has a thumbnail of the card for each character, and leaves Reisen and Tewi out', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });

                    const host = await openPicker(page);

                    await expect(host.locator('.ds-row-label')).not.toContainText(['Assistant Reisen', 'Assistant Tewi']);
                    for (const [label, avatar] of [['Alice', 'Alice.png'], ['Bob', 'Bob.png'], ['Assistant Nahida', NAHIDA]]) {
                        const image = rowOf(host, page, label).locator('img.sbAssistantPickerThumb');
                        await expect(image, label).toHaveAttribute('src', new RegExp(`file=${avatar.replace('.', '\\.')}`));
                        await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth), label).toBeGreaterThan(0);
                        // A row chooses a character and opens nothing, so it has no chevron.
                        await expect(rowOf(host, page, label).locator('.ds-row__chevron'), label).toBeHidden();
                    }
                });

                sizeFreeTest('applies the first row pressed when a second one is pressed before the window has closed', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    await openPicker(page);

                    await page.evaluate(() => {
                        const rowOf = avatar => document.querySelector(`dialog.sb-dialog-host .ds-row[data-sb-assistant-avatar="${avatar}"]`);
                        // The window may leave the page at once, so both rows are found before the first one is pressed.
                        const [alice, bob] = [rowOf('Alice.png'), rowOf('Bob.png')];
                        alice.click();
                        bob.click();
                    });

                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'pointer');
                    await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Alice');
                    expect(await stored(page, 'assistant')).toBe('Alice.png');
                });

                test.describe('with a long library', () => {
                    const CHARACTERS = Array.from({ length: 400 }, (_, index) => `Char${String(index).padStart(3, '0')}.png`);
                    const LONG = [...BOTH, ...CHARACTERS];
                    const builtRows = page => page.locator('dialog.sb-dialog-host .ds-row[data-sb-assistant-avatar]');

                    sizeFreeTest('builds the first rows at once and the rest in chunks, always in the order of the list', async ({ page }) => {
                        await boot(page, { library: LONG, exact: true });
                        await page.evaluate(() => {
                            window.qaRowCounts = [];
                            new MutationObserver(() => {
                                window.qaRowCounts.push(document.querySelectorAll('dialog.sb-dialog-host .ds-row[data-sb-assistant-avatar]').length);
                            }).observe(document.body, { childList: true, subtree: true });
                        });

                        await openPicker(page);

                        await expect(builtRows(page)).toHaveCount(CHARACTERS.length);
                        const counts = await page.evaluate(() => window.qaRowCounts);
                        const afterOpening = counts.filter(count => count > 0);
                        expect(afterOpening[0], 'rows in the first paint').toBeLessThan(CHARACTERS.length);
                        expect(afterOpening.length, 'steps from the first paint to the whole list').toBeGreaterThan(2);
                        expect(afterOpening).toEqual([...afterOpening].sort((a, b) => a - b));
                        expect(await builtRows(page).evaluateAll(rows => rows.map(row => row.dataset.sbAssistantAvatar))).toEqual(CHARACTERS);
                    });

                    sizeFreeTest('searches the whole library at once, also the rows that are still to come', async ({ page }) => {
                        await boot(page, { library: LONG, exact: true });
                        const host = await openPicker(page);

                        await host.getByRole('button', { name: 'Search Characters' }).click();
                        await searchInputOf(host).fill('char39');

                        await expect(builtRows(page)).toHaveCount(CHARACTERS.length);
                        await expect(host.locator('.ds-row[data-sb-assistant-avatar]:not([hidden]) .ds-row-label')).toHaveText(CHARACTERS.slice(390));
                    });

                    sizeFreeTest('puts the focus on the selected row far down the list, and keeps it there while the rest arrives', async ({ page }) => {
                        await boot(page, { library: LONG, accountStorage: { assistant: 'Char350.png' }, exact: true });
                        await menuOf(ownCard(page)).click();
                        await page.getByRole('menuitem', { name: 'Choose Another Assistant…' }).click();

                        await expect(builtRows(page).filter({ hasText: 'Char350.png' })).toBeFocused();
                        await expect(builtRows(page)).toHaveCount(CHARACTERS.length);
                        await expect(builtRows(page).filter({ hasText: 'Char350.png' })).toBeFocused();
                        await expect(builtRows(page).filter({ hasText: 'Char350.png' })).toHaveAttribute('aria-current', 'true');
                        await expect(page.locator('dialog.sb-dialog-host .sbAssistantPickerSelected')).toHaveCount(1);
                    });
                });

                sizeFreeTest('marks the character of the pointer as selected, and puts focus on its row', async ({ page }) => {
                    await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Bob.png' }, exact: true });
                    await menuOf(ownCard(page)).click();
                    await page.getByRole('menuitem', { name: 'Choose Another Assistant…' }).click();

                    const host = hosts(page);
                    await expect(host).toBeVisible();
                    await expect(host.locator('.ds-row[aria-current="true"]')).toHaveCount(1);
                    await expect(rowOf(host, page, 'Bob')).toHaveAttribute('aria-current', 'true');
                    await expect(rowOf(host, page, 'Bob').locator('.sbAssistantPickerSelected')).toBeVisible();
                    await expect(host.locator('.sbAssistantPickerSelected')).toHaveCount(1);
                    await expect(rowOf(host, page, 'Bob')).toBeFocused();
                });

                sizeFreeTest('marks no row while the pointer names nobody of the list', async ({ page }) => {
                    await boot(page, { library: LIBRARY, accountStorage: { assistant: REISEN }, exact: true });

                    const host = await openPicker(page);

                    await expect(host.locator('.ds-row[aria-current]')).toHaveCount(0);
                    await expect(host.locator('.sbAssistantPickerSelected')).toHaveCount(0);
                });

                sizeFreeTest('searches by name, says No results, and takes one Escape to clear the search, one to close it and one to close the window', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    const host = await openPicker(page);

                    await host.getByRole('button', { name: 'Search Characters' }).click();
                    await searchInputOf(host).fill('bo');
                    await expect(host.locator('.ds-row:not([hidden]) .ds-row-label')).toHaveText(['Bob']);
                    await expect(rowOf(host, page, 'Alice')).toBeHidden();
                    await expect(rowOf(host, page, 'Bob')).toBeVisible();

                    await searchInputOf(host).fill('zzz');
                    await expect(host.locator('.ds-row:not([hidden])')).toHaveCount(0);
                    await expect(host.locator('.sb-status-page__title', { hasText: 'No results' })).toBeVisible();

                    await page.keyboard.press('Escape');
                    await expect(searchInputOf(host)).toHaveValue('');
                    await expect(host.locator('.ds-row:not([hidden])')).toHaveCount(3);
                    await expect(hosts(page)).toBeVisible();
                    await expect(searchInputOf(host)).toBeVisible();
                    await page.keyboard.press('Escape');
                    await expect(searchInputOf(host)).toBeHidden();
                    await expect(hosts(page)).toBeVisible();
                    await page.keyboard.press('Escape');
                    await expect(hosts(page)).toHaveCount(0);
                    await expect(chooseOf(page)).toBeFocused();
                });

                sizeFreeTest('shows its status and no rows while the library holds only Reisen and Tewi', async ({ page }) => {
                    await boot(page, { library: BOTH, exact: true });

                    const host = await openPicker(page);

                    await expect(host.locator('.ds-row')).toHaveCount(0);
                    const title = host.locator('.sb-status-page__title', { hasText: HOME_COPY.pickerEmptyHead });
                    await expect(title).toBeVisible();
                    await expect(title).toHaveText(HOME_COPY.pickerEmptyHead);
                });

                sizeFreeTest('Escape closes it without a change and returns focus to the Choose Assistant card', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    await openPicker(page);

                    await page.keyboard.press('Escape');

                    await expect(hosts(page)).toHaveCount(0);
                    await expect(chooseOf(page)).toBeFocused();
                    expect(await stored(page, 'assistant')).toBeNull();
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');
                });

                sizeFreeTest('choosing a character writes the pointer and turns the card into the card of that character', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    const host = await openPicker(page);

                    await rowOf(host, page, 'Bob').click();

                    await expect(hosts(page)).toHaveCount(0);
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'pointer');
                    await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Bob');
                    await expect(ownCard(page).locator('.sbHomeArt img')).toHaveAttribute('src', /file=Bob\.png/);
                    expect(await stored(page, 'assistant')).toBe('Bob.png');
                    await expect(ownCard(page).locator(':focus')).toHaveCount(1);
                });

                sizeFreeTest('choosing the character that is already chosen changes nothing', async ({ page }) => {
                    await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' }, exact: true });
                    await menuOf(ownCard(page)).click();
                    await page.getByRole('menuitem', { name: 'Choose Another Assistant…' }).click();
                    const host = hosts(page);

                    await rowOf(host, page, 'Alice').click();

                    await expect(hosts(page)).toHaveCount(0);
                    expect(await stored(page, 'assistant')).toBe('Alice.png');
                    await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Alice');
                });

                sizeFreeTest('a character that left the library before the choice is told with the placeholder toast, and the pointer stays', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    await showToasts(page);
                    const host = await openPicker(page);
                    await page.evaluate(async () => {
                        const { characters } = await import('/script.js');
                        characters.splice(characters.findIndex(character => character.avatar === 'Bob.png'), 1);
                    });

                    await rowOf(host, page, 'Bob').click();

                    const toast = actionErrorToast(page);
                    await expect(toast).toBeVisible();
                    await expect(toast).toHaveText(HOME_COPY.assistantActionError);
                    expect(await stored(page, 'assistant')).toBeNull();
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');
                });
            });

            test.describe('the card of the chosen character', () => {
                const chosen = { library: LIBRARY, accountStorage: { assistant: 'Alice.png' }, exact: true };

                sizeFreeTest('has the chat item in the other mode, Choose Another Assistant and Remove Assistant, and Reisen keeps one item', async ({ page }) => {
                    await boot(page, chosen);

                    await menuOf(ownCard(page)).click();
                    await expect(page.getByRole('menu', { name: 'Assistant Menu' }).getByRole('menuitem')).toHaveText(['New Chat in Conversation', 'Choose Another Assistant…', 'Remove Assistant']);
                    await page.keyboard.press('Escape');
                    await expect(page.locator('.sb-action-popover, .sb-action-sheet')).toHaveCount(0);

                    await menuOf(cardOf(page, 'assistant-reisen')).click();
                    await expect(page.getByRole('menu', { name: 'Assistant Menu' }).getByRole('menuitem')).toHaveText(['New Chat in Conversation']);
                });

                sizeFreeTest('Choose Another Assistant opens the picker, and Escape returns focus to the menu button of the card', async ({ page }) => {
                    await boot(page, chosen);
                    await menuOf(ownCard(page)).click();

                    await page.getByRole('menuitem', { name: 'Choose Another Assistant…' }).click();
                    await expect(hosts(page)).toHaveAccessibleName('Choose Assistant');
                    await page.keyboard.press('Escape');

                    await expect(hosts(page)).toHaveCount(0);
                    await expect(menuOf(ownCard(page))).toBeFocused();
                });

                sizeFreeTest('Choose Another Assistant changes the character of the card', async ({ page }) => {
                    await boot(page, chosen);
                    await menuOf(ownCard(page)).click();
                    await page.getByRole('menuitem', { name: 'Choose Another Assistant…' }).click();

                    await hosts(page).locator('.ds-row', { has: page.locator('.ds-row-label', { hasText: /^Bob$/ }) }).click();

                    await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Bob');
                    expect(await stored(page, 'assistant')).toBe('Bob.png');
                });

                sizeFreeTest('Remove Assistant clears the pointer and returns the slot to the Choose Assistant card, with focus kept on the slot', async ({ page }) => {
                    await boot(page, chosen);
                    await menuOf(ownCard(page)).click();

                    await page.getByRole('menuitem', { name: 'Remove Assistant' }).click();

                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');
                    await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Choose Assistant');
                    expect(await stored(page, 'assistant')).toBeNull();
                    await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`)).toHaveCount(3);
                    await expect(ownCard(page).locator(':focus')).toHaveCount(1);
                });

                sizeFreeTest('Remove Assistant deletes no character', async ({ page }) => {
                    await boot(page, chosen);
                    const requests = [];
                    page.on('request', request => request.method() === 'POST' && /\/api\/characters\/delete/.test(request.url()) && requests.push(request.url()));
                    await menuOf(ownCard(page)).click();

                    await page.getByRole('menuitem', { name: 'Remove Assistant' }).click();
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');

                    expect(requests).toEqual([]);
                    await expect(page.locator(`${HOME} .sbHomeCards`)).toBeVisible();
                });

                sizeFreeTest('Start New Chat opens a new chat of the character', async ({ page }) => {
                    await boot(page, chosen);

                    await startOf(ownCard(page)).click();

                    await expect.poll(() => currentAvatar(page)).toBe('Alice.png');
                    await expect.poll(() => currentChat(page)).toMatch(/^Alice - /);
                });

                sizeFreeTest('Temporary Chat opens a temporary chat with the character', async ({ page }) => {
                    const world = await boot(page, chosen);

                    await temporaryOf(ownCard(page)).click();

                    await expect(page.locator('#sb-temporary-chat-banner')).toBeVisible();
                    expect(await currentAvatar(page)).toBe('Alice.png');
                    expect(world.chatSaves).toEqual([]);
                });

                test.describe('a user who installed Nahida with an earlier version', () => {
                    sizeFreeTest('has no card of her own while the pointer does not name her', async ({ page }) => {
                        await boot(page, { library: LIBRARY, exact: true });

                        await expect(cardOf(page, 'assistant-nahida')).toHaveCount(0);
                        await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`)).toHaveCount(3);
                        await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');
                    });

                    sizeFreeTest('sees her card in the third slot like any other character once the pointer names her', async ({ page }) => {
                        await boot(page, { library: LIBRARY, accountStorage: { assistant: NAHIDA }, exact: true });

                        await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'pointer');
                        await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Assistant Nahida');
                        await expect(ownCard(page).locator('.sbHomeCardSub')).toHaveText(SUBTITLES.pointer);
                        await expect(ownCard(page).locator('.sbHomeArt[data-sb-art-placeholder="row-pointer"] img')).toHaveAttribute('src', /file=default_AssistantNahida\.png/);
                        await expect(page.locator(`${HOME} .sbHomeCards > .sbHomeCard`)).toHaveCount(3);
                        await expect(cardOf(page, 'assistant-nahida')).toHaveCount(0);
                    });

                    sizeFreeTest('opens a new chat with her from Start New Chat, as with any character', async ({ page }) => {
                        await boot(page, { library: LIBRARY, accountStorage: { assistant: NAHIDA }, exact: true });

                        await startOf(ownCard(page)).click();

                        await expect.poll(() => currentAvatar(page)).toBe(NAHIDA);
                        await expect.poll(() => currentChat(page)).toMatch(/^Assistant Nahida - /);
                    });

                    sizeFreeTest('finds her in the picker among the other characters', async ({ page }) => {
                        await boot(page, { library: LIBRARY, exact: true });

                        await chooseOf(page).click();

                        await expect(hosts(page).locator('.ds-row-label')).toContainText(['Alice', 'Assistant Nahida', 'Bob']);
                    });
                });
            });

            test.describe('the pointer written elsewhere', () => {
                const setAsAssistant = (page, avatar) => page.evaluate(async (target) => {
                    const { characters } = await import('/script.js');
                    const { assignCharacterAsAssistant } = await import('/scripts/welcome-screen.js');
                    assignCharacterAsAssistant(String(characters.findIndex(character => character.avatar === target)));
                }, avatar);

                sizeFreeTest('Set as assistant on a character shows it in the third slot, and again on the same character brings the Choose Assistant card back', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');

                    await setAsAssistant(page, 'Bob.png');

                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'pointer');
                    await expect(ownCard(page).locator('.sbHomeCardName')).toHaveText('Bob');
                    expect(await stored(page, 'assistant')).toBe('Bob.png');

                    await setAsAssistant(page, 'Bob.png');

                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'choose');
                    expect(await stored(page, 'assistant')).toBeNull();
                });

                sizeFreeTest('Set as assistant shows the badge in the character list on the new assistant and takes it from the old one, again when toggled off', async ({ page }) => {
                    await boot(page, { library: LIBRARY, accountStorage: { assistant: 'Alice.png' }, exact: true });
                    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
                    await expect(page.locator('.sb-character-list[data-mounted="true"]')).toBeVisible();
                    const badged = () => page.locator('.sb-character-list .character_select', { has: page.locator('.ch_assistant') }).locator('.ch_name');
                    await expect(badged()).toHaveText(['Alice']);

                    await setAsAssistant(page, 'Bob.png');

                    await expect(badged()).toHaveText(['Bob']);

                    await setAsAssistant(page, 'Bob.png');

                    await expect(badged()).toHaveText(['Assistant Reisen']);
                });

                for (const { name: action, accountStorage, after } of [
                    { name: 'Set as assistant', accountStorage: {}, after: 'Bob.png' },
                    { name: 'Set as assistant on the assistant again', accountStorage: { assistant: 'Bob.png' }, after: null },
                ]) {
                    sizeFreeTest(`${action} tells a render of Home that fails with the placeholder toast, and leaves no rejection unhandled`, async ({ page }) => {
                        await boot(page, { library: LIBRARY, accountStorage, exact: true });
                        await showToasts(page);
                        const unhandled = [];
                        page.on('pageerror', error => unhandled.push(error.message));
                        // Home reads the scroll position of #chat before it renders again, so the render fails after the pointer is written.
                        await page.evaluate(() => {
                            Object.defineProperty(document.getElementById('chat'), 'scrollTop', { configurable: true, get() { throw new Error('QA render failure'); } });
                        });

                        await setAsAssistant(page, 'Bob.png');

                        const toast = actionErrorToast(page);
                        await expect(toast).toBeVisible();
                        await expect(toast).toHaveText(HOME_COPY.assistantActionError);
                        expect(await stored(page, 'assistant')).toBe(after);
                        expect(unhandled).toEqual([]);
                    });
                }

                sizeFreeTest('the character that the picker chose is the one a new assistant chat opens', async ({ page }) => {
                    await boot(page, { library: LIBRARY, exact: true });
                    await chooseOf(page).click();
                    await hosts(page).locator('.ds-row', { has: page.locator('.ds-row-label', { hasText: /^Bob$/ }) }).click();
                    await expect(ownCard(page)).toHaveAttribute('data-sb-assistant-kind', 'pointer');

                    await page.evaluate(async () => (await import('/script.js')).newAssistantChat({ temporary: false }));

                    await expect.poll(() => currentAvatar(page)).toBe('Bob.png');
                });
            });
        });
    });
}
