import { expect, test } from '@playwright/test';
import { OPEN_ACTION_SHEET } from './helpers/action-sheet.js';
import { resetConversations, seedConversation, uniquePersona } from './helpers/conversation-seed.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';

/*
 * Selection mode on the messages of the conversation timeline, driven the way a person does. Roleplay's "Delete messages"
 * takes the same mode (sillybunny-editor/message-selection.js) and is in message-selection-roleplay.e2e.js.
 */

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const ROW = '.sb-conversation-message[data-message-id]';
const CHECKED = '.sb-conversation-message.is-selection-selected';
const MESSAGE_COUNT = 12;

/** Routes the page the way the other conversation specs do, so that the page sees only conversations of its own persona. */
async function routePage(page, baseURL, persona) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let settingsVersion = Date.now();
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
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
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/') || url.pathname.startsWith('/api/sillybunny-conversation/')) {
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
}

async function loadApp(page, baseURL) {
    await routePage(page, baseURL, uniquePersona());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

async function seraphinaAvatar(page) {
    return page.evaluate(() => {
        const character = window.SillyTavern.getContext().characters.find(entry => /Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) throw new Error('No bundled character found.');
        return character.avatar;
    });
}

/** Opens a direct conversation whose messages are `Message 0` to `Message 11`, alternating character and user, all read. */
async function openConversation(page, baseURL, { count = MESSAGE_COUNT, messages } = {}) {
    await loadApp(page, baseURL);
    const avatar = await seraphinaAvatar(page);
    await resetConversations(page);
    await seedConversation(page, {
        avatar,
        replace: true,
        chats: [{
            messages: messages ?? Array.from({ length: count }, (_, index) => ({
                id: `sel-${index}`,
                role: index % 2 === 0 ? 'character' : 'user',
                name: index % 2 === 0 ? 'Seraphina' : 'Tester',
                mes: `Message ${index}`,
            })),
        }],
    });
    await page.evaluate(async (avatarFile) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { ensureConversationChatLoaded } = await import('/scripts/sillybunny-conversation/conversation-store.js');
        await openConversationWorkspaceForAvatar(avatarFile, { showToast: false });
        await ensureConversationChatLoaded(avatarFile);
        stopConversationAutoWorker();
    }, avatar);
    await expect(page.locator(ROW)).toHaveCount(messages?.length ?? count);
    return avatar;
}

const row = (page, index) => page.locator(`.sb-conversation-message[data-message-id="sel-${index}"]`);

/** Opens the message menu of a row from its toolbar and chooses an item. */
async function chooseFromMessageMenu(page, index, label) {
    const target = row(page, index);
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await target.locator('.sb-conversation-message-menu').click();
    await page.locator('.sb-action-popover .sb-action-menu-item', { hasText: label }).click();
}

async function selectedIds(page) {
    return page.locator(CHECKED).evaluateAll(rows => rows.map(node => node.getAttribute('data-message-id')));
}

const title = page => page.locator('#sb_conversation_selection_header .sb-selection-title');
const deleteButton = page => page.locator('#sb_conversation_selection_actions [data-action-id="delete"]');

async function messageIdsInChat(page) {
    return page.evaluate(async () => {
        const { getConversationMessages } = await import('/scripts/sillybunny-conversation/conversation-store.js');
        const { getCurrentCharAvatar } = await import('/scripts/sillybunny-conversation/context.js');
        return getConversationMessages(getCurrentCharAvatar()).map(message => message.id);
    });
}

test.describe('conversation timeline', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the message menu starts it with that message selected, and Cancel ends it', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await chooseFromMessageMenu(page, 4, 'Select Message');

        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
        await expect(title(page)).toHaveText('1 Selected');
        expect(await selectedIds(page)).toEqual(['sel-4']);
        // The header and the composer give way to the selection header and the action bar.
        await expect(page.locator('#sb_conversation_header')).toBeHidden();
        await expect(page.locator('#sb_conversation_form')).toBeHidden();
        await expect(deleteButton(page)).toBeVisible();

        await page.locator('#sb_conversation_selection_header .sb-selection-cancel').click();
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');
        await expect(page.locator('#sb_conversation_header')).toBeVisible();
        await expect(page.locator('#sb_conversation_form')).toBeVisible();
        await expect(page.locator('.sb-selection-check')).toHaveCount(0);
    });

    test('Select Message is in the message menu and not in the hover toolbar, which stays one row with every action shown', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await page.evaluate(() => document.body.classList.add('expandMessageActions'));
        const target = row(page, 4);
        await target.hover();
        const toolbar = target.locator('.sb-conversation-message-actions');
        await expect(toolbar).toHaveCSS('opacity', '1');
        // A thirteenth button would pass the 30rem that the toolbar may take and wrap to a second row over the message above.
        expect(await toolbar.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(48);
        await expect(toolbar.locator('[data-sb-conversation-action="select-message"]')).toBeHidden();
        await toolbar.locator('.sb-conversation-message-menu').click();
        await expect(page.locator('.sb-action-popover .sb-action-menu-item', { hasText: 'Select Message' })).toBeVisible();
    });

    test('the header menu starts it with nothing selected, and Delete waits for a selection', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await page.locator('#sb_conversation_header [data-sb-conversation-action="open-conversation-menu"]').click();
        await page.locator('.sb-action-popover .sb-action-menu-item', { hasText: 'Select Messages' }).click();

        await expect(title(page)).toHaveText('0 Selected');
        await expect(deleteButton(page)).toBeDisabled();
        await row(page, 2).click();
        await expect(deleteButton(page)).toBeEnabled();
    });

    test('a click toggles a message, Shift-click takes a range, and Select All takes every message', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await chooseFromMessageMenu(page, 2, 'Select Message');

        await row(page, 5).click({ modifiers: ['Shift'] });
        expect(await selectedIds(page)).toEqual(['sel-2', 'sel-3', 'sel-4', 'sel-5']);
        await expect(title(page)).toHaveText('4 Selected');

        // Messages that are not next to each other are fine.
        await row(page, 9).click();
        await row(page, 3).click();
        expect(await selectedIds(page)).toEqual(['sel-2', 'sel-4', 'sel-5', 'sel-9']);

        await page.locator('#sb_conversation_selection_header .sb-selection-select-all').click();
        await expect(title(page)).toHaveText(`${MESSAGE_COUNT} Selected`);
        expect(await selectedIds(page)).toHaveLength(MESSAGE_COUNT);
    });

    test('a message and everything after it is a Shift-click on the last message', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await chooseFromMessageMenu(page, 8, 'Select Message');
        await row(page, MESSAGE_COUNT - 1).click({ modifiers: ['Shift'] });
        expect(await selectedIds(page)).toEqual(['sel-8', 'sel-9', 'sel-10', 'sel-11']);
    });

    test('Space and Shift+Space select from the keyboard, and Escape ends the mode from anywhere', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await chooseFromMessageMenu(page, 3, 'Select Message');

        await row(page, 3).focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Space');
        expect(await selectedIds(page)).toEqual(['sel-3', 'sel-4']);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Shift+Space');
        expect(await selectedIds(page)).toEqual(['sel-3', 'sel-4', 'sel-5', 'sel-6']);

        // Focus outside the chat column: Escape still ends the mode.
        await page.evaluate(() => document.activeElement?.blur());
        await page.locator('body').press('Escape');
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');
    });

    test('while it is on, the toolbar, the menu trigger and the message menu are off, and rows do not select text', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await chooseFromMessageMenu(page, 4, 'Select Message');

        const target = row(page, 6);
        await target.hover();
        await expect(target.locator('.sb-conversation-message-actions')).toBeHidden();
        await expect(target.locator('.sb-conversation-mobile-menu-trigger')).toBeHidden();
        await target.locator('.sb-conversation-message-name').click({ button: 'right' });
        await expect(page.locator('.sb-action-popover')).toHaveCount(0);
        await target.focus();
        await page.keyboard.press('Shift+F10');
        await expect(page.locator('.sb-action-popover')).toHaveCount(0);

        const style = await target.evaluate((node) => {
            const computed = getComputedStyle(node);
            return { standard: computed.userSelect, webkit: computed.webkitUserSelect };
        });
        expect(style.standard).toBe('none');
        expect(style.webkit).toBe('none');
    });

    test('Delete asks first, Cancel keeps the selection, and confirming deletes those messages and ends the mode', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await chooseFromMessageMenu(page, 2, 'Select Message');
        await row(page, 4).click({ modifiers: ['Shift'] });
        await row(page, 8).click();

        await deleteButton(page).click();
        const alert = page.locator('dialog[open]');
        await expect(alert).toContainText('Delete 4 Messages?');
        await expect(alert).toContainText('TODO(copy)');
        await alert.getByRole('button', { name: 'Cancel' }).click();
        await expect(title(page)).toHaveText('4 Selected');
        expect(await messageIdsInChat(page)).toHaveLength(MESSAGE_COUNT);

        await deleteButton(page).click();
        await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');
        await expect(page.locator(ROW)).toHaveCount(MESSAGE_COUNT - 4);
        expect(await messageIdsInChat(page)).toEqual(['sel-0', 'sel-1', 'sel-5', 'sel-6', 'sel-7', 'sel-9', 'sel-10', 'sel-11']);
    });

    test('deleting the replied-to message clears the reply target, drops the queued reply that it triggered, and the list keeps a right preview and unread count', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        await page.evaluate(async () => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            const { getConversationAddress } = await import('/scripts/sillybunny-conversation/context.js');
            const { getCurrentCharAvatar } = await import('/scripts/sillybunny-conversation/context.js');
            const address = getConversationAddress(getCurrentCharAvatar());
            // Messages after sel-8 are unread.
            conversationData.patchConversation(address.conversationId, { chats: { [address.chatId]: { readThrough: 'sel-8' } } });
            // Two replies wait in the send queue: one was triggered by sel-8, the other by sel-5.
            const { sendQueue } = await import('/scripts/sillybunny-conversation/state.js');
            sendQueue.length = 0;
            sendQueue.push({ chatId: address.chatId, messageIds: ['sel-8'], text: 'drop me' }, { chatId: address.chatId, messageIds: ['sel-5'], text: 'keep me' });
        });
        await chooseFromMessageMenu(page, 6, 'Reply');
        await expect(page.locator('#sb_conversation_reply_preview')).toBeVisible();

        await chooseFromMessageMenu(page, 6, 'Select Message');
        await row(page, 8).click();
        await row(page, 11).click();
        await deleteButton(page).click();
        await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');

        await expect(page.locator('#sb_conversation_reply_preview')).toBeHidden();
        const summary = await page.evaluate(async () => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            const { getConversationAddress, getCurrentCharAvatar } = await import('/scripts/sillybunny-conversation/context.js');
            const address = getConversationAddress(getCurrentCharAvatar());
            const entry = conversationData.get(address.conversationId).chats.find(item => item.id === address.chatId);
            return { readThrough: entry.readThrough, unread: entry.unread, preview: entry.preview, count: entry.messageCount };
        });
        // sel-8 went, so the marker moved to the message before it, and the character message sel-10 after it is still unread.
        expect(summary).toEqual({ readThrough: 'sel-7', unread: 1, preview: 'Message 10', count: MESSAGE_COUNT - 3 });
        const queued = await page.evaluate(async () => (await import('/scripts/sillybunny-conversation/state.js')).sendQueue.map(item => item.text));
        expect(queued).toEqual(['keep me']);
    });
});

test.describe('conversation timeline on a touch screen', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    const LONG_PRESS_WAIT_MS = 700;
    // A person needs longer than the swallow of the click after a long press to reach an item of the sheet.
    const AFTER_RELEASE_MS = 450;
    const sheet = page => page.locator(OPEN_ACTION_SHEET);
    const wait = (page, ms) => page.evaluate(duration => new Promise(resolve => setTimeout(resolve, duration)), ms);

    /** A finger on the page over the DevTools protocol, so that the browser sends the touch events and applies its own long-press behaviour. */
    async function startFinger(page) {
        const client = await page.context().newCDPSession(page);
        return {
            down: (x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
            move: (x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }),
            up: () => client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
            detach: () => client.detach(),
        };
    }

    const centre = async (locator) => {
        const box = await locator.boundingBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    /** Presses a message with a finger, holds it for the long-press time and lifts the finger; the sheet may be open by then. */
    async function pressAndHold(page, locator, holdMs = LONG_PRESS_WAIT_MS) {
        await locator.scrollIntoViewIfNeeded();
        const { x, y } = await centre(locator);
        const finger = await startFinger(page);
        await finger.down(x, y);
        await wait(page, holdMs);
        await finger.up();
        await finger.detach();
    }

    async function openSheetByLongPress(page, index) {
        await row(page, index).locator('.sb-conversation-message-text').scrollIntoViewIfNeeded();
        const { x, y } = await centre(row(page, index).locator('.sb-conversation-message-text'));
        const finger = await startFinger(page);
        await finger.down(x, y);
        // The menu opens while the finger is still down.
        await expect(sheet(page)).toBeVisible();
        await finger.up();
        await finger.detach();
        return sheet(page);
    }

    test.describe('with the touch events of the browser', () => {
        test.beforeEach(({ browserName }) => {
            test.skip(browserName !== 'chromium', 'The long press is sent as a touch event over the DevTools protocol.');
        });

        test('a long press on a message opens the menu as a sheet while the finger is down, with the quick row first and Delete last, and the sheet stays open', async ({ page, baseURL }) => {
            await openConversation(page, baseURL);

            const menu = await openSheetByLongPress(page, 5);

            await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');
            const reactions = menu.locator('.sb-action-menu-reaction');
            await expect(reactions).toHaveCount(7);
            await expect(reactions.last()).toHaveAccessibleName('More Reactions');
            const items = menu.locator('.sb-action-menu-item:not(.sb-action-menu-reaction)');
            await expect(items.first()).toHaveAccessibleName('Reply');
            await expect(menu.getByRole('menuitem', { name: 'Select Message' })).toBeVisible();
            await expect(items.last()).toHaveAccessibleName('Delete Message');
            await expect(row(page, 5)).toHaveClass(/has-open-menu/);

            // The click that ends the press is swallowed: the sheet is still there, and nothing was selected or toggled.
            await wait(page, LONG_PRESS_WAIT_MS);
            await expect(menu).toBeVisible();
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');
            expect(await selectedIds(page)).toEqual([]);
        });

        test('Select Message in that sheet starts selection with the message selected, taps toggle, and Select to End takes the rest of the chat', async ({ page, baseURL }) => {
            await openConversation(page, baseURL);

            const menu = await openSheetByLongPress(page, 5);
            await wait(page, AFTER_RELEASE_MS);
            await menu.getByRole('menuitem', { name: 'Select Message' }).tap();

            await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
            expect(await selectedIds(page)).toEqual(['sel-5']);

            await row(page, 7).locator('.sb-conversation-message-text').tap();
            expect(await selectedIds(page)).toEqual(['sel-5', 'sel-7']);

            const toEnd = page.locator('#sb_conversation_selection_actions [data-action-id="select-to-end"]');
            await expect(toEnd).toBeVisible();
            await toEnd.tap();
            expect(await selectedIds(page)).toEqual(['sel-5', 'sel-6', 'sel-7', 'sel-8', 'sel-9', 'sel-10', 'sel-11']);
            await expect(title(page)).toHaveText('7 Selected');
        });

        test('a long press while messages are being selected opens no menu, because a tap toggles a row', async ({ page, baseURL }) => {
            await openConversation(page, baseURL);
            const menu = await openSheetByLongPress(page, 5);
            await wait(page, AFTER_RELEASE_MS);
            await menu.getByRole('menuitem', { name: 'Select Message' }).tap();
            await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');

            await pressAndHold(page, row(page, 7).locator('.sb-conversation-message-text'));

            await expect(sheet(page)).toHaveCount(0);
            await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
        });

        test('a swipe over a message and a tap on it open no menu', async ({ page, baseURL }) => {
            await openConversation(page, baseURL);
            const text = row(page, 5).locator('.sb-conversation-message-text');
            await text.scrollIntoViewIfNeeded();
            const { x, y } = await centre(text);

            const finger = await startFinger(page);
            await finger.down(x, y);
            await finger.move(x, y + 30);
            await wait(page, LONG_PRESS_WAIT_MS);
            await finger.up();
            await finger.detach();
            await expect(sheet(page)).toHaveCount(0);

            await text.tap();
            await wait(page, LONG_PRESS_WAIT_MS);
            await expect(sheet(page)).toHaveCount(0);
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');
        });

        test('a long press on a link keeps the platform\'s link menu, one on an image opens the message menu, and one on a selection of the text opens nothing', async ({ page, baseURL }) => {
            await openConversation(page, baseURL, { messages: [
                { id: 'sel-0', role: 'character', name: 'Seraphina', mes: 'Read [the notes](https://example.test/notes) before you go.' },
                { id: 'sel-1', role: 'user', name: 'Tester', mes: 'Here is the picture.', extra: { image_url: '/img/No-Image-Placeholder.svg', image_prompt: 'a placeholder' } },
                { id: 'sel-2', role: 'character', name: 'Seraphina', mes: 'Some words that a person may select.' },
            ] });

            await pressAndHold(page, row(page, 0).locator('.sb-conversation-message-text a'));
            await expect(sheet(page)).toHaveCount(0);

            await pressAndHold(page, row(page, 1).locator('.sb-conversation-image-preview img'));
            await expect(sheet(page)).toBeVisible();
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');
            await page.keyboard.press('Escape');
            await expect(sheet(page)).toHaveCount(0);

            await page.evaluate(() => {
                const text = document.querySelector('.sb-conversation-message[data-message-id="sel-2"] .sb-conversation-message-text');
                const range = document.createRange();
                range.selectNodeContents(text);
                getSelection().removeAllRanges();
                getSelection().addRange(range);
            });
            await pressAndHold(page, row(page, 2).locator('.sb-conversation-message-text'));
            await expect(sheet(page)).toHaveCount(0);
        });
    });

    test('a long press by synthetic touch pointer events opens the sheet and Select Message in it starts selection, in every engine', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        const text = row(page, 5).locator('.sb-conversation-message-text');
        await text.scrollIntoViewIfNeeded();
        const { x, y } = await centre(text);
        const finger = { pointerType: 'touch', pointerId: 11, isPrimary: true, clientX: x, clientY: y };

        await text.dispatchEvent('pointerdown', finger);
        await expect(sheet(page)).toBeVisible({ timeout: 3000 });
        await text.dispatchEvent('pointerup', finger);
        await text.dispatchEvent('click');
        await wait(page, 150);
        await expect(sheet(page)).toBeVisible();
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');

        await wait(page, AFTER_RELEASE_MS);
        await sheet(page).getByRole('menuitem', { name: 'Select Message' }).tap();
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
        expect(await selectedIds(page)).toEqual(['sel-5']);
    });

    test('a mouse press and hold on a message does nothing, and a short press of a finger is a tap', async ({ page, baseURL }) => {
        await openConversation(page, baseURL);
        const text = row(page, 5).locator('.sb-conversation-message-text');
        await text.scrollIntoViewIfNeeded();
        const { x, y } = await centre(text);

        await text.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: x, clientY: y });
        await wait(page, LONG_PRESS_WAIT_MS);
        await text.dispatchEvent('pointerup', { pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: x, clientY: y });
        await expect(sheet(page)).toHaveCount(0);

        const finger = { pointerType: 'touch', pointerId: 12, isPrimary: true, clientX: x, clientY: y };
        await text.dispatchEvent('pointerdown', finger);
        await wait(page, 120);
        await text.dispatchEvent('pointerup', finger);
        await wait(page, LONG_PRESS_WAIT_MS);
        await expect(sheet(page)).toHaveCount(0);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');
    });
});
