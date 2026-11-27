import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { resetConversations, seedConversation, uniquePersona } from './helpers/conversation-seed.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// New Chat, Branch from Here, Delete Chat, Delete Conversation and the download of a chat, from the surfaces that the
// mode has today. The members, the worker and the replies that a deletion stops are in `conversation-chatter-after-delete.e2e.js`.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const CONVERSATION_MENU = '#sb_conversation_header [data-sb-conversation-action="open-conversation-menu"]';
const ALL_MESSAGES = '#sb_conversation_timeline .sb-conversation-message';
const COMPOSER = '#sb_conversation_input';
const MEMORY = { memory_summary: 'They said hello and talked about the weekend.', memory_message_count: 4, memory_updated_at: 5 };

const TALK = [
    { role: 'character', mes: 'Good morning!' },
    { role: 'user', mes: 'Morning, did you sleep well?' },
    { role: 'character', mes: 'Like a log. And you?' },
    { role: 'user', mes: 'Not really.' },
];

/** @param {import('@playwright/test').Page} page */
async function openApp(page) {
    await protectMaintainerServer(page);
    const persona = uniquePersona();
    await page.route('**/api/settings/get', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.user_avatar = persona;
        await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60_000 });
    await waitForAppReady(page);
    const avatar = await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        return context.characters.find(character => character.avatar)?.avatar ?? '';
    });
    expect(avatar, 'the library has a character').not.toBe('');
    await resetConversations(page);
    return avatar;
}

/**
 * Seeds a direct conversation whose chat has a memory summary, and opens it. The worker is stopped so that nothing
 * answers on its own.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openTalk(page, avatar) {
    const { conversationId, chatIds } = await seedConversation(page, { avatar, chats: [{ name: 'Main', messages: TALK }] });
    await page.evaluate(async ({ avatar, conversationId, chatId, memory }) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await openConversationWorkspaceForAvatar(avatar, { showToast: false });
        stopConversationAutoWorker();
        const address = { conversationId, chatId };
        await conversationData.loadChat(address);
        conversationData.commitChat(address, (draft) => {
            draft.header.chat_metadata.sb_conversation = memory;
        });
        await conversationData.flush();
    }, { avatar, conversationId, chatId: chatIds[0], memory: MEMORY });
    await expect(page.locator(ALL_MESSAGES)).toHaveCount(TALK.length);
    return { conversationId, chatId: chatIds[0] };
}

/**
 * The conversation as the server stores it, and the headers of its chats.
 * @param {import('@playwright/test').Page} page
 * @param {string} conversationId
 */
async function readStored(page, conversationId) {
    return page.evaluate(async (id) => {
        const { getRequestHeaders } = await import('/script.js');
        const post = async (path, body) => {
            const response = await fetch(`/api/sillybunny-conversation${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            return { status: response.status, json: await response.json().catch(() => null) };
        };
        const conversation = await post('/get', { id });
        if (conversation.status !== 200) {
            return { status: conversation.status, chats: [] };
        }
        const chats = [];
        for (const entry of conversation.json.conversation.chats) {
            const chat = await post('/chat/get', { id, chatId: entry.id });
            chats.push({ ...entry, header: chat.json.chat[0], messages: chat.json.chat.slice(1).map(record => record.mes) });
        }
        return { status: 200, activeChatId: conversation.json.conversation.activeChatId, chats };
    }, conversationId);
}

test('New Chat starts blank, with no messages and no memory summary, and the other chat stays as it was', async ({ page }) => {
    const avatar = await openApp(page);
    const { conversationId, chatId } = await openTalk(page, avatar);

    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: 'New Chat', exact: true }).click();

    await expect(page.locator(ALL_MESSAGES)).toHaveCount(0);
    await expect(page.locator(COMPOSER)).toBeEnabled();
    await expect.poll(async () => (await readStored(page, conversationId)).chats.length).toBe(2);
    const stored = await readStored(page, conversationId);
    const created = stored.chats.find(chat => chat.id !== chatId);
    expect(stored.activeChatId, 'the new chat opens').toBe(created.id);
    expect(created.messages).toEqual([]);
    expect(created.header.chat_metadata.sb_conversation, 'a new chat carries no memory summary').toBeUndefined();
    const source = stored.chats.find(chat => chat.id === chatId);
    expect(source.messages).toEqual(TALK.map(message => message.mes));
    expect(source.header.chat_metadata.sb_conversation.memory_summary).toBe(MEMORY.memory_summary);
});

test('Branch from Here makes a read chat with the messages up to the chosen one and the memory summary, and opens it', async ({ page }) => {
    const avatar = await openApp(page);
    const { conversationId, chatId } = await openTalk(page, avatar);

    const message = page.locator(ALL_MESSAGES).nth(1);
    await message.hover();
    await message.locator(':is(.sb-conversation-message-menu, .sb-conversation-mobile-menu-trigger)').filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: /Branch/ }).click();

    await expect(page.locator(ALL_MESSAGES)).toHaveCount(2);
    await expect(page.locator(ALL_MESSAGES).last()).toContainText('Morning, did you sleep well?');
    await expect.poll(async () => (await readStored(page, conversationId)).chats.length).toBe(2);
    const stored = await readStored(page, conversationId);
    const branch = stored.chats.find(chat => chat.id !== chatId);
    expect(stored.activeChatId, 'the branch opens').toBe(branch.id);
    expect(branch.messages).toEqual([TALK[0].mes, TALK[1].mes]);
    expect(branch.header.chat_metadata.sb_conversation.memory_summary, 'the summary of the source goes with the branch').toBe(MEMORY.memory_summary);
    expect(branch.readThrough, 'the messages of the branch are read').not.toBe('');
    const unread = await page.evaluate(async (id) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        return conversationData.get(id).chats.map(chat => ({ id: chat.id, unread: chat.unread }));
    }, conversationId);
    expect(unread.every(chat => chat.unread === 0), 'no chat has unread messages').toBe(true);
});

test('Delete Chat on the only chat leaves one empty chat, and the user stays in the conversation', async ({ page }) => {
    const avatar = await openApp(page);
    const { conversationId, chatId } = await openTalk(page, avatar);

    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: /Delete Chat/ }).click();
    const confirm = page.locator('dialog.sb-conversation-dialog[open]');
    await expect(confirm.locator('[data-sb-copy-placeholder="true"]')).toHaveCount(1);
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator(ALL_MESSAGES)).toHaveCount(0);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(COMPOSER)).toBeEnabled();
    const stored = await readStored(page, conversationId);
    expect(stored.chats, 'one empty chat').toHaveLength(1);
    expect(stored.chats[0].id).not.toBe(chatId);
    expect(stored.chats[0].messages).toEqual([]);
});

test('Delete Conversation goes to the list, not Home, and removes the conversation from the server', async ({ page }) => {
    const avatar = await openApp(page);
    const { conversationId } = await openTalk(page, avatar);

    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: /Delete Conversation/ }).click();
    await page.locator('dialog.sb-conversation-dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator('.sb-conversation-list-item')).toHaveCount(0);
    await expect(page.locator(ALL_MESSAGES)).toHaveCount(0);
    expect((await readStored(page, conversationId)).status, 'the conversation is gone from the server').toBe(404);
});

test('a chat is downloaded as the JSONL file that the server stores, named after the chat', async ({ page }) => {
    const avatar = await openApp(page);
    const { conversationId, chatId } = await openTalk(page, avatar);

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(async (address) => {
            const { downloadConversationChat } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            await downloadConversationChat(address);
        }, { conversationId, chatId }),
    ]);

    expect(download.suggestedFilename()).toBe('Main.jsonl');
    const text = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
    const lines = text.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines.slice(1).map(record => record.mes)).toEqual(TALK.map(message => message.mes));
    expect(lines[0].chat_metadata.sb_conversation.memory_summary).toBe(MEMORY.memory_summary);
});
