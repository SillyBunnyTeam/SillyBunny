import { expect, test } from '@playwright/test';
import { OPEN_ACTION_SHEET } from './helpers/action-sheet.js';
import { resetConversations, seedConversation, uniquePersona } from './helpers/conversation-seed.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { TOAST_MESSAGE_SELECTOR } from './helpers/toasts.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';

// Reactions of a conversation: the chips under a message, the two quick emoji and More Reactions of the toolbar, the six and
// More of the menu and the phone sheet, the list of who reacted, and the old object that the first version stored.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const ROUTE_PREFIX = '/api/sillybunny-conversation';
const CHIP = '.sb-conversation-message-reaction-chip';
const TOOLBAR_REACTION = '.sb-conversation-message-actions > .sb-conversation-reaction-button';
const MESSAGE_ID = 'react-target';

/** The module that the real chooser will be, as a test double that records how it was opened. */
const FAKE_CHOOSER = `
export function openEmojiChooser(options) {
    (window.__chooserCalls ??= []).push({ kind: options.kind, triggerLabel: options.trigger?.getAttribute('aria-label') ?? '', picked: options.isPicked('😂') });
    window.__chooser = options;
    return { close() {}, isOpen: true };
}
`;

/**
 * Opens the app on a page that has its own persona, with a conversation of one character whose messages the test gives.
 * @param {import('@playwright/test').Page} page
 * @param {string} baseURL
 * @param {object} [options]
 * @param {object[]} [options.messages] Messages of the chat; the character's message with the id `react-target` is the one that the tests react to.
 * @param {boolean} [options.chooser] Answers the chooser's module with a test double.
 */
async function openConversation(page, baseURL, { messages, chooser = false } = {}) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let settingsVersion = Date.now();
    const persona = uniquePersona();
    const saves = [];
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
            return route.abort();
        }
        if (url.pathname.endsWith('/sillybunny-conversation/emoji/emoji-chooser.js') && chooser) {
            return route.fulfill({ contentType: 'text/javascript', body: FAKE_CHOOSER });
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
            settings.user_avatar = persona;
            settings.power_user.auto_connect = false;
            settings.power_user.reduced_motion = false;
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            saves.push(request.postDataJSON());
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/') || url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
            return route.continue();
        }
        if (url.pathname.startsWith('/api/backends/')) {
            return route.fulfill({ json: { data: [] } });
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60_000 });
    const avatar = await page.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const character = window.SillyTavern.getContext().characters.find(entry => /Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) throw new Error('No bundled Conversation character found.');
        return character.avatar;
    });
    await resetConversations(page);
    // A reactor that is the character of the conversation is written `$AVATAR`, because the file name is known only now.
    const chatMessages = JSON.parse(JSON.stringify(messages ?? [
        { id: 'react-first', role: 'character', name: 'Seraphina', mes: 'Good morning.' },
        { id: MESSAGE_ID, role: 'character', name: 'Seraphina', mes: 'A message to react to.' },
    ]).replaceAll('$AVATAR', avatar));
    const seeded = await seedConversation(page, { avatar, chats: [{ messages: chatMessages }] });
    await page.evaluate(async (id) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        await openConversationWorkspaceForAvatar(id, { showToast: false });
        stopConversationAutoWorker();
    }, avatar);
    const message = page.locator(`.sb-conversation-message[data-message-id="${MESSAGE_ID}"]`);
    await expect(message).toBeVisible();
    return { message, avatar, saves, conversationId: seeded.conversationId, chatId: seeded.chatIds[0] };
}

/** What the server holds of a message, once the page has written it. */
async function storedReactions(page, { conversationId, chatId }) {
    await page.evaluate(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.flush();
    });
    return page.evaluate(async ({ conversationId, chatId, prefix }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`${prefix}/chat/get`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: conversationId, chatId }) });
        const records = (await response.json()).chat ?? [];
        return records.find(record => record.id === 'react-target')?.extra?.conversation_reactions;
    }, { conversationId, chatId, prefix: ROUTE_PREFIX });
}

const hoverBubble = async (page, message) => {
    await page.mouse.move(2, 2);
    const bubble = await message.locator('.sb-conversation-message-bubble').boundingBox();
    await page.mouse.move(bubble.x + Math.min(bubble.width / 2, 40), bubble.y + bubble.height / 2);
    await expect(message.locator('.sb-conversation-message-actions')).toHaveCSS('opacity', '1');
};

test.describe('with a pointer', () => {
    test('the toolbar holds the two newest quick emoji and More Reactions, and nothing else of the reactions', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL);
        await hoverBubble(page, message);

        const buttons = message.locator(TOOLBAR_REACTION);
        await expect(buttons).toHaveCount(3);
        await expect(buttons.nth(0)).toHaveText('❤️');
        await expect(buttons.nth(1)).toHaveText('😂');
        await expect(buttons.nth(0)).toHaveAccessibleName('red heart');
        await expect(buttons.nth(2)).toHaveAccessibleName('More Reactions');
        await expect(buttons.nth(2)).toHaveAttribute('aria-haspopup', 'dialog');
        await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');
    });

    test('the toolbar stays one row and covers no text at every width, with the actions expanded and not', async ({ page, baseURL }) => {
        test.setTimeout(180_000);
        await openConversation(page, baseURL, { messages: [
            { id: 'react-first', role: 'character', name: 'Seraphina', mes: 'Good morning. The glade is quiet and the light is coming through the leaves in long, slow ribbons this morning.' },
            { id: MESSAGE_ID, role: 'character', name: 'Seraphina', mes: 'Short.' },
        ] });

        for (const [width, height] of [[1440, 900], [1024, 700], [768, 1024], [640, 800], [560, 800], [520, 800], [512, 800], [511, 800], [400, 800], [360, 800], [340, 800], [339, 800]]) {
            await page.setViewportSize({ width, height });
            for (const expanded of [false, true]) {
                await page.evaluate(expanded => document.body.classList.toggle('expandMessageActions', expanded), expanded);
                for (const id of ['react-first', MESSAGE_ID]) {
                    const row = page.locator(`.sb-conversation-message[data-message-id="${id}"]`);
                    await row.scrollIntoViewIfNeeded();
                    await hoverBubble(page, row);
                    const rows = await row.locator('.sb-conversation-message-actions').evaluate((toolbar) => {
                        const tops = new Set([...toolbar.querySelectorAll('button')]
                            .filter(button => button.getClientRects().length)
                            .map(button => Math.round(button.getBoundingClientRect().top)));
                        return tops.size;
                    });
                    expect(rows, `${id} at ${width}px${expanded ? ' expanded' : ''}: the toolbar is one row`).toBe(1);
                }
            }
        }
    });

    test('a quick emoji toggles the reaction of the user, shows a chip that says so, and a second press takes it back', async ({ page, baseURL }) => {
        const { message, ...chat } = await openConversation(page, baseURL);

        await hoverBubble(page, message);
        await message.locator(TOOLBAR_REACTION).first().click();
        const chip = page.locator(`.sb-conversation-message[data-message-id="${MESSAGE_ID}"] ${CHIP}`);
        await expect(chip).toHaveCount(1);
        await expect(chip).toHaveAttribute('aria-pressed', 'true');
        await expect(chip).toHaveAccessibleName('red heart, 1 reaction');
        expect(await storedReactions(page, chat)).toEqual([{ emoji: '❤️', by: 'user', at: expect.any(Number) }]);

        await chip.click();
        await expect(chip).toHaveCount(0);
        expect(await storedReactions(page, chat)).toBeUndefined();
    });

    test('keeps several distinct emoji of the user, in the order that they came, each as its own chip', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL);

        await hoverBubble(page, message);
        await message.locator(TOOLBAR_REACTION).nth(1).click();
        // The emoji that was just chosen leads the quick row, so the toolbar now starts with it and the next emoji is second.
        await hoverBubble(page, page.locator(`.sb-conversation-message[data-message-id="${MESSAGE_ID}"]`));
        const toolbar = page.locator(`.sb-conversation-message[data-message-id="${MESSAGE_ID}"] ${TOOLBAR_REACTION}`);
        await expect(toolbar.nth(0)).toHaveText('😂');
        await toolbar.nth(1).click();

        const chips = page.locator(`.sb-conversation-message[data-message-id="${MESSAGE_ID}"] ${CHIP}`);
        await expect(chips).toHaveCount(2);
        await expect(chips.nth(0)).toHaveText('😂');
        await expect(chips.nth(1)).toHaveText('❤️');
    });

    test('reads the old object as reactions of the user, and writes the array on the first change', async ({ page, baseURL }) => {
        const { message, ...chat } = await openConversation(page, baseURL, { messages: [
            { id: 'react-first', role: 'character', name: 'Seraphina', mes: 'Good morning.' },
            { id: MESSAGE_ID, role: 'character', name: 'Seraphina', mes: 'A message with the old reactions.', extra: { conversation_reactions: { heart: 1, spark: 0, laugh: 1 } } },
        ] });

        const chips = message.locator(CHIP);
        await expect(chips).toHaveCount(2);
        await expect(chips.nth(0)).toHaveText('❤️');
        await expect(chips.nth(1)).toHaveText('😂');
        await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
        expect(await storedReactions(page, chat)).toEqual({ heart: 1, spark: 0, laugh: 1 });

        await chips.nth(0).click();

        await expect(message.locator(CHIP)).toHaveCount(1);
        expect(await storedReactions(page, chat)).toEqual([{ emoji: '😂', by: 'user', at: 0 }]);
    });

    test('refuses a 21st distinct emoji with a message, and still takes a reaction back', async ({ page, baseURL }) => {
        const twenty = Array.from({ length: 20 }, (_, index) => ({ emoji: String.fromCodePoint(0x1F600 + index), by: 'user', at: index + 1 }));
        const { message, ...chat } = await openConversation(page, baseURL, { messages: [
            { id: 'react-first', role: 'character', name: 'Seraphina', mes: 'Good morning.' },
            { id: MESSAGE_ID, role: 'character', name: 'Seraphina', mes: 'Popular.', extra: { conversation_reactions: twenty } },
        ] });
        await page.evaluate(() => document.documentElement.setAttribute('data-qa-show-toasts', ''));
        await expect(message.locator(CHIP)).toHaveCount(20);

        await hoverBubble(page, message);
        await message.locator(TOOLBAR_REACTION).first().click();

        await expect(message.locator(CHIP)).toHaveCount(20);
        await expect(page.locator(TOAST_MESSAGE_SELECTOR)).toContainText('TODO(copy)');
        expect((await storedReactions(page, chat))).toHaveLength(20);

        await message.locator(CHIP).first().click();
        await expect(message.locator(CHIP)).toHaveCount(19);
    });

    test('shows a count from two reactions, and the list of who reacted opens from the secondary click and from the Menu key without a hover', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL, { messages: [
            { id: 'react-first', role: 'character', name: 'Seraphina', mes: 'Good morning.' },
            { id: MESSAGE_ID, role: 'user', name: 'Tester', mes: 'Look at this.', extra: { conversation_reactions: [{ emoji: '😂', by: 'user', at: 1 }, { emoji: '😂', by: '$AVATAR', at: 2 }, { emoji: '👍', by: 'ghost.png', at: 3 }] } },
        ] });
        const chip = message.locator(CHIP).first();
        await expect(chip).toHaveText('😂2');
        await expect(chip).toHaveAccessibleName('face with tears of joy, 2 reactions');
        await expect(message.locator(CHIP).nth(1)).toHaveAccessibleName('thumbs up, 1 reaction');

        await chip.click({ button: 'right' });
        const people = page.getByRole('dialog', { name: 'face with tears of joy' });
        await expect(people).toBeVisible();
        await expect(people.getByRole('listitem')).toHaveText(['You', 'Seraphina']);
        await page.keyboard.press('Escape');
        await expect(people).toBeHidden();
        await expect(chip).toBeFocused();

        await page.keyboard.press('ContextMenu');
        await expect(people).toBeVisible();
        await page.keyboard.press('Escape');
        await chip.press('Shift+F10');
        await expect(people).toBeVisible();
        // A reaction is toggled by the chip itself, not by opening the list.
        await expect(chip).toHaveAttribute('aria-pressed', 'true');
    });

    test('the menu holds the whole quick row, six emoji with their names and More Reactions, and an emoji of it is toggled with the keyboard', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL);
        const trigger = message.locator('.sb-conversation-message-menu');

        await trigger.focus();
        await trigger.press('Enter');
        const menu = page.getByRole('menu', { name: 'Message Actions' });
        await expect(menu).toBeVisible();
        const emoji = menu.getByRole('menuitemcheckbox');
        await expect(emoji).toHaveCount(6);
        await expect(emoji).toHaveText(['❤️', '😂', '✨', '👍', '😮', '😢']);
        await expect(emoji.nth(1)).toHaveAccessibleName('face with tears of joy');
        await expect(menu.getByRole('menuitem', { name: 'More Reactions' })).toBeVisible();

        await emoji.first().focus();
        await page.keyboard.press('ArrowRight');
        await expect(emoji.nth(1)).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');

        await expect(menu).toBeHidden();
        await expect(message.locator(CHIP)).toHaveCount(1);
        await expect(message.locator(CHIP)).toHaveAccessibleName('sparkles, 1 reaction');
        await expect(trigger).toBeFocused();
    });

    test('More Reactions opens the chooser for the message, and a pick becomes a reaction that the quick row remembers', async ({ page, baseURL }) => {
        const { message, saves } = await openConversation(page, baseURL, { chooser: true });

        await hoverBubble(page, message);
        await message.locator(TOOLBAR_REACTION).nth(2).click();
        await expect.poll(() => page.evaluate(() => window.__chooserCalls?.length)).toBe(1);
        expect(await page.evaluate(() => window.__chooserCalls[0])).toEqual({ kind: 'react', triggerLabel: 'More Reactions', picked: false });
        // The toolbar stays shown while the chooser has the pointer.
        await expect(message).toHaveClass(/has-open-menu/);

        await page.evaluate(() => window.__chooser.onPick('🎉', { name: 'party popper' }));
        await expect(message.locator(CHIP)).toHaveText('🎉');
        await expect(message.locator(CHIP)).toHaveAccessibleName('party popper, 1 reaction');
        await page.evaluate(() => window.__chooser.onClose());
        await expect(message).not.toHaveClass(/has-open-menu/);

        // The quick row now starts with the pick, in the toolbar and in the menu, and the settings that follow the user hold it.
        await page.mouse.move(2, 2);
        await hoverBubble(page, message);
        await expect(message.locator(TOOLBAR_REACTION).first()).toHaveText('🎉');
        await expect(message.locator(TOOLBAR_REACTION).first()).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => saves.some(save => save.extension_settings?.sillybunny_conversation?.recentReactions?.[0]?.e === '🎉')).toBe(true);
        const saved = saves.findLast(save => save.extension_settings?.sillybunny_conversation?.recentReactions);
        expect(saved.extension_settings.sillybunny_conversation.recentReactions).toEqual([{ e: '🎉', n: 'party popper' }]);
    });

    test('More Reactions in the menu opens the same chooser at the trigger of the menu', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL, { chooser: true });
        const trigger = message.locator('.sb-conversation-message-menu');

        await trigger.focus();
        await trigger.press('Enter');
        await page.getByRole('menuitem', { name: 'More Reactions' }).click();

        await expect.poll(() => page.evaluate(() => window.__chooserCalls?.length)).toBe(1);
        expect(await page.evaluate(() => window.__chooserCalls[0].kind)).toBe('react');
        expect(await page.evaluate(() => window.__chooserCalls[0].triggerLabel)).toBe('Message Actions');
    });

    test('keeps the recents to 24 and the newest first', async ({ page, baseURL }) => {
        const { message, saves } = await openConversation(page, baseURL, { chooser: true });
        const pickFrom = async (row, first, count) => {
            const opened = await page.evaluate(() => window.__chooserCalls?.length ?? 0);
            await hoverBubble(page, row);
            await row.locator(TOOLBAR_REACTION).nth(2).click();
            await expect.poll(() => page.evaluate(() => window.__chooserCalls?.length ?? 0)).toBe(opened + 1);
            for (let index = first; index < first + count; index++) {
                await page.evaluate(code => window.__chooser.onPick(String.fromCodePoint(code), { name: `face ${code}` }), 0x1F600 + index);
            }
            await page.evaluate(() => window.__chooser.onClose());
        };
        // A message holds 20 distinct emoji, so the 25 picks are made on two messages.
        await pickFrom(message, 0, 20);
        await pickFrom(page.locator('.sb-conversation-message[data-message-id="react-first"]'), 20, 5);

        const recentsOf = () => saves.findLast(save => save.extension_settings?.sillybunny_conversation?.recentReactions)?.extension_settings.sillybunny_conversation.recentReactions;
        await expect.poll(() => recentsOf()?.length).toBe(24);
        expect(recentsOf()[0].e).toBe(String.fromCodePoint(0x1F600 + 24));
        expect(recentsOf().map(item => item.e)).not.toContain(String.fromCodePoint(0x1F600));
    });

    test('a reaction made in the chat is there after the page is loaded again', async ({ page, baseURL }) => {
        const { message, ...chat } = await openConversation(page, baseURL);
        await hoverBubble(page, message);
        await message.locator(TOOLBAR_REACTION).first().click();
        await expect(message.locator(CHIP)).toHaveCount(1);
        expect(await storedReactions(page, chat)).toHaveLength(1);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page, { timeout: 60_000 });
        await page.evaluate(async (id) => {
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
            await openConversationWorkspaceForAvatar(id, { showToast: false });
        }, chat.avatar);

        await expect(page.locator(`.sb-conversation-message[data-message-id="${MESSAGE_ID}"] ${CHIP}`)).toHaveText('❤️');
    });
});

test.describe('by touch', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    const openSheet = async (page, message) => {
        const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
        await trigger.tap();
        const sheet = page.locator(OPEN_ACTION_SHEET);
        await expect(sheet).toBeVisible();
        return { trigger, sheet };
    };

    test('the sheet holds the quick row as one row of seven buttons at 390px, six emoji and More Reactions', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL);
        const { sheet } = await openSheet(page, message);

        const buttons = sheet.locator('.sb-action-menu-reaction');
        await expect(buttons).toHaveCount(7);
        const boxes = await buttons.evaluateAll(nodes => nodes.map((node) => {
            const { top, width, height } = node.getBoundingClientRect();
            return { top: Math.round(top), width: Math.round(width), height: Math.round(height) };
        }));
        expect(new Set(boxes.map(box => box.top)).size, 'one row').toBe(1);
        expect(Math.min(...boxes.map(box => box.width)), 'cells of at least 40px').toBeGreaterThanOrEqual(40);
        expect(boxes.every(box => Math.abs(box.width - box.height) <= 1), 'round cells').toBe(true);
        await expect(buttons.last()).toHaveAccessibleName('More Reactions');
    });

    test('the sheet keeps one row of cells of at least 40px at 360 and 320px, and drops an emoji where seven do not fit', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL);

        for (const width of [360, 320]) {
            await page.setViewportSize({ width, height: 700 });
            const { sheet } = await openSheet(page, message);
            const boxes = await sheet.locator('.sb-action-menu-reaction').evaluateAll(nodes => nodes.map((node) => {
                const { top, width: cell } = node.getBoundingClientRect();
                return { top: Math.round(top), cell: Math.round(cell) };
            }));
            expect(new Set(boxes.map(box => box.top)).size, `${width}px: one row`).toBe(1);
            expect(Math.min(...boxes.map(box => box.cell)), `${width}px: cells of at least 40px`).toBeGreaterThanOrEqual(40);
            expect(boxes.length, `${width}px: the row keeps More Reactions`).toBeGreaterThanOrEqual(6);
            await expect(sheet.locator('.sb-action-menu-reaction').last()).toHaveAccessibleName('More Reactions');
            await sheet.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(sheet).toBeHidden();
        }
    });

    test('an emoji of the sheet reacts, and More Reactions opens the chooser at the trigger of the message', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL, { chooser: true });
        let { sheet, trigger } = await openSheet(page, message);

        await sheet.locator('.sb-action-menu-reaction').first().tap();
        await expect(sheet).toBeHidden();
        await expect(message.locator(CHIP)).toHaveText('❤️');
        await expect(trigger).toBeFocused();

        ({ sheet, trigger } = await openSheet(page, message));
        await sheet.getByRole('menuitem', { name: 'More Reactions' }).tap();
        await expect.poll(() => page.evaluate(() => window.__chooserCalls?.length)).toBe(1);
        expect(await page.evaluate(() => window.__chooserCalls[0])).toEqual({ kind: 'react', triggerLabel: 'Message Actions', picked: false });
    });

    test('a chip is a target of at least 32px, a tap on it toggles the reaction, and a long press opens the list of who reacted without toggling it', async ({ page, baseURL }) => {
        const { message } = await openConversation(page, baseURL, { messages: [
            { id: 'react-first', role: 'character', name: 'Seraphina', mes: 'Good morning.' },
            { id: MESSAGE_ID, role: 'user', name: 'Tester', mes: 'Look.', extra: { conversation_reactions: [{ emoji: '😂', by: 'user', at: 1 }, { emoji: '😂', by: 'someone.png', at: 2 }] } },
        ] });
        const chip = message.locator(CHIP);
        const box = await chip.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(32);

        // The finger stays where it went down: a release that moved would be a swipe, which the row of a message reads for itself.
        const finger = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: box.x + 4, clientY: box.y + 4 };
        await chip.dispatchEvent('pointerdown', finger);
        const people = page.locator('.sb-reaction-people');
        await expect(people).toBeVisible({ timeout: 3000 });
        await expect(people.getByRole('listitem')).toHaveCount(2);
        await chip.dispatchEvent('pointerup', finger);
        await chip.dispatchEvent('click');
        await expect(message.locator(CHIP)).toHaveAttribute('aria-pressed', 'true');

        await page.locator('.sb-action-sheet-close').click();
        await expect(people).toBeHidden();
        // The next tap of a person comes later than the click that ended the long press.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
        await chip.tap();
        await expect(message.locator(CHIP)).toHaveText('😂');
        await expect(message.locator(CHIP)).toHaveAttribute('aria-pressed', 'false');
    });
});
