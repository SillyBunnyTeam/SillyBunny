import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { seedConversation } from './helpers/conversation-seed.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

// A reply that a page started is the server's once the page closes: the server writes it into the chat as one pending
// message, and the next page that loads the chat splits it into bubbles. These tests close a page in the middle of a
// reply, with a fake model that answers when the test says so, and look at what the next page finds.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const COMPOSER = '#sb_conversation_input';
const MINUTE = 60_000;
const ROUTE_PREFIX = '/api/sillybunny-conversation';

/**
 * An OpenAI-compatible model that holds each request until the test answers it, and keeps what it was asked.
 */
class GatedModel {
    constructor() {
        this.requests = [];
        this.server = null;
    }

    async start() {
        this.server = http.createServer((request, response) => {
            if (request.method === 'GET' && request.url.endsWith('/models')) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
                return;
            }
            const chunks = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                let body = {};
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                } catch {
                    // The request body was not JSON; the entry keeps an empty body.
                }
                this.requests.push({ body, text: JSON.stringify(body.messages ?? []), response, answered: false });
            });
            // A page that leaves does not end this connection: the server of the app holds it until the model answers.
        });
        await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.port = this.server.address().port;
    }

    async stop() {
        this.server?.closeAllConnections?.();
        await new Promise(resolve => this.server?.close(resolve) ?? resolve());
    }

    /** Answers the request at `index` with `text` as the whole completion. */
    answer(index, text) {
        const entry = this.requests[index];
        entry.answered = true;
        entry.response.writeHead(200, { 'Content-Type': 'application/json' });
        entry.response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: text } }], created: 0, model: 'fake-model' }));
    }

    async waitForRequests(count) {
        await expect.poll(() => this.requests.length, { message: `the model has ${count} request(s)`, timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(count);
    }
}

/** @type {GatedModel} */
let model;
let prefix;
const persona = `qa-persona-${randomUUID().slice(0, 8)}.png`;

test.beforeEach(async () => {
    model = new GatedModel();
    await model.start();
    prefix = `qa-${randomUUID().slice(0, 8)}-`;
});

test.afterEach(async () => {
    await model.stop();
});

/**
 * Opens the app on a page of the test: the persona and the conversations are the test's, so that a page that opens later sees what an earlier one made.
 * @param {import('@playwright/test').Page} page
 * @param {{ clockAt?: number, route?: (page: import('@playwright/test').Page) => Promise<void> }} [options]
 * @returns {Promise<string[]>} The avatars of the first three characters of the library.
 */
async function openApp(page, { clockAt, route } = {}) {
    await protectMaintainerServer(page, { conversationPrefix: prefix });
    await page.route('**/api/settings/get', async (settingsRoute) => {
        const response = await settingsRoute.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.user_avatar = persona;
        await settingsRoute.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await route?.(page);
    if (clockAt) {
        await page.clock.install({ time: new Date(clockAt) });
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60_000 });
    await waitForAppReady(page);
    await showToasts(page);
    const avatars = await page.evaluate(async (base) => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const script = await import('/script.js');
        const { oai_settings } = await import('/scripts/openai.js');
        $('#main_api').val('openai').trigger('change');
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = `${base}/v1`;
        oai_settings.custom_model = 'fake-model';
        oai_settings.stream_openai = false;
        script.setOnlineStatus('Valid');
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        return context.characters.filter(character => character.avatar).slice(0, 3).map(character => ({ avatar: character.avatar, name: character.name }));
    }, `http://127.0.0.1:${model.port}`);
    expect(avatars, 'the library has three characters for a group').toHaveLength(3);
    return avatars;
}

/**
 * Makes a conversation that answers at once, with a greeting and a message of the user as its history.
 * @param {import('@playwright/test').Page} page
 * @param {{ avatar: string }[]} characters
 * @param {{ group?: boolean }} [options]
 * @returns {Promise<{ conversationId: string, chatId: string, avatar: string, groupId: string }>}
 */
async function seedConversationThatAnswers(page, characters, { group = false } = {}) {
    const { conversationId, chatIds } = await seedConversation(page, {
        avatar: characters[0].avatar,
        ...(group ? { members: [characters[1].avatar, characters[2].avatar], name: 'Server replies' } : {}),
        replace: true,
        chats: [{ messages: [{ role: 'character', mes: 'Hello there.' }, { role: 'user', mes: 'Hi, it is me.', name: 'Tester' }] }],
    });
    await page.evaluate(async (id) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        conversationData.patchConversation(id, { settings: { enabled: true, reply_delay_multiplier: 0, availability: 'online' } });
        await conversationData.flush();
    }, conversationId);
    return { conversationId, chatId: chatIds[0], avatar: characters[0].avatar, groupId: group ? conversationId : '' };
}

/** Opens the conversation in the workspace, the way a user who clicks its row does. */
async function openConversation(page, { avatar, groupId }) {
    await page.evaluate(async ({ avatar, groupId }) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        await openConversationWorkspaceForAvatar(avatar, { groupId: groupId || null, showToast: false });
    }, { avatar, groupId });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(COMPOSER)).toBeEnabled();
}

async function send(page, text) {
    await page.locator(COMPOSER).fill(text);
    await page.locator(COMPOSER).press('Enter');
}

/** Waits until the page has nothing to write, so that closing it asks no question. */
async function settleWrites(page) {
    await page.waitForFunction(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        return !conversationData.hasPendingWrites();
    }, null, { timeout: 30_000 });
}

/**
 * Closes a page the way a user closes a tab, which hands its replies to the server. The browser reports a page closed a
 * little before its renderer has run `pagehide` and dropped its connections, and a reply that ends in that moment is read
 * and claimed by a page that is about to die. The test waits that moment out, so that it answers a page that is gone.
 */
async function closeTab(page) {
    await settleWrites(page);
    await page.close({ runBeforeUnload: true });
    await new Promise(resolve => setTimeout(resolve, 400));
}

/** The chat as the server holds it. */
async function serverChat(page, { conversationId, chatId }) {
    return page.evaluate(async ({ conversationId, chatId, prefix: routePrefix }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`${routePrefix}/chat/get`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: conversationId, chatId }) });
        return { status: response.status, records: (await response.json().catch(() => ({}))).chat ?? [] };
    }, { conversationId, chatId, prefix: ROUTE_PREFIX });
}

/**
 * Waits until the server has the reply in the chat, as a pending message or, when a page was quicker, as bubbles. Which
 * of the two it is depends on whether a page loaded the chat in the meantime, which a test must not rely on.
 */
async function waitForServerReply(page, target, text) {
    await expect.poll(async () => (await serverChat(page, target)).records.some(record => String(record.mes ?? '').includes(text)), { message: `the server wrote "${text}" into the chat`, timeout: 30_000 }).toBe(true);
}

/** Loads the chat in the page's data module, without opening it in the workspace, so that nothing marks it read. */
async function loadChatQuietly(page, { conversationId, chatId }) {
    await page.evaluate(async ({ conversationId, chatId }) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.whenReady();
        await conversationData.loadChat({ conversationId, chatId });
    }, { conversationId, chatId });
}

async function messagesOf(page, { conversationId, chatId }) {
    return page.evaluate(async ({ conversationId, chatId }) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        const chat = conversationData.chat({ conversationId, chatId });
        return (chat?.messages ?? []).map(message => ({ id: message.id, role: message.role, name: message.name, mes: message.mes, extra: message.extra }));
    }, { conversationId, chatId });
}

const isPending = message => Boolean(message.extra?.server_generation?.pending);

test.describe('a reply that the page started and the server finished', () => {
    test('is in the chat, split into bubbles and unread, when the page comes back', async ({ context }) => {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seedConversationThatAnswers(first, characters);
        await openConversation(first, target);
        await send(first, 'Tell me about your day.');
        await model.waitForRequests(1);
        await closeTab(first);

        model.answer(0, 'First paragraph of the reply.\n\nSecond paragraph, which is its own bubble.');
        const second = await context.newPage();
        await openApp(second);
        await waitForServerReply(second, target, 'First paragraph of the reply.');

        await loadChatQuietly(second, target);
        await expect.poll(async () => (await messagesOf(second, target)).some(isPending), { message: 'the finalizer landed the pending message', timeout: 30_000 }).toBe(false);

        const messages = await messagesOf(second, target);
        expect(messages.slice(-2).map(message => message.mes)).toEqual(['First paragraph of the reply.', 'Second paragraph, which is its own bubble.']);
        const view = await second.evaluate(async (id) => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            return { unread: conversationData.get(id).unread };
        }, target.conversationId);
        expect(view.unread).toBe(2);
        await expect.poll(async () => (await serverChat(second, target)).records.slice(1).some(isPending), { message: 'the split reply is saved', timeout: 30_000 }).toBe(false);
        const saved = (await serverChat(second, target)).records.slice(1);
        expect(saved.slice(-2).map(message => message.mes)).toEqual(['First paragraph of the reply.', 'Second paragraph, which is its own bubble.']);
        expect(new Set(saved.map(message => message.id)).size).toBe(saved.length);

        const pending = await second.evaluate(() => new Promise((resolve) => {
            const stream = new EventSource(`/api/resumable-generations/events?owner=conversations&page=probe-${Date.now()}`);
            stream.addEventListener('message', (event) => {
                stream.close();
                resolve(JSON.parse(event.data).pending);
            });
        }));
        expect(pending.filter(item => item.conversation === target.conversationId), 'the server was told that the reply was seen').toEqual([]);
    });

    test('is landed once when two tabs open the chat together', async ({ context }) => {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seedConversationThatAnswers(first, characters);
        await openConversation(first, target);
        await send(first, 'Tell me more.');
        await model.waitForRequests(1);
        await closeTab(first);
        model.answer(0, 'Reply, first bubble.\n\nReply, second bubble.\n\nReply, third bubble.');

        const tabs = [await context.newPage(), await context.newPage()];
        await Promise.all(tabs.map(tab => openApp(tab)));
        await waitForServerReply(tabs[0], target, 'Reply, first bubble.');
        await Promise.all(tabs.map(tab => loadChatQuietly(tab, target)));
        await expect.poll(async () => Promise.all(tabs.map(async tab => (await messagesOf(tab, target)).some(isPending))), { timeout: 30_000 }).toEqual([false, false]);
        await Promise.all(tabs.map(tab => settleWrites(tab)));

        const saved = (await serverChat(tabs[0], target)).records.slice(1);
        expect(saved.filter(message => message.extra?.conversation_mode_reply).map(message => message.mes)).toEqual(['Reply, first bubble.', 'Reply, second bubble.', 'Reply, third bubble.']);
        expect(new Set(saved.map(message => message.id)).size).toBe(saved.length);
        for (const tab of tabs) {
            expect((await messagesOf(tab, target)).map(message => message.id)).toEqual(saved.map(message => message.id));
        }
    });
});

test.describe('a group round that the page closed in the middle of', () => {
    /** A group of three, two of whom are named in the message, so that both answer. */
    async function startRound(context) {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seedConversationThatAnswers(first, characters, { group: true });
        await openConversation(first, target);
        await send(first, `${characters[0].name} and ${characters[1].name}, what do you think?`);
        await model.waitForRequests(1);
        await closeTab(first);
        model.answer(0, 'My view comes first.');
        return { characters, target };
    }

    test('continues when the page that opens it is within 30 minutes of its start, and the second member reads the first reply', async ({ context }) => {
        const { characters, target } = await startRound(context);

        const second = await context.newPage();
        await openApp(second);
        await waitForServerReply(second, target, 'My view comes first.');
        await openConversation(second, target);

        await model.waitForRequests(2);
        expect(model.requests[1].text, 'the second member is asked with the first reply in the chat').toContain('My view comes first.');
        model.answer(1, 'And mine comes second.');
        await expect.poll(async () => (await messagesOf(second, target)).map(message => message.mes).filter(text => /comes (first|second)/.test(text)), { timeout: 30_000 }).toEqual(['My view comes first.', 'And mine comes second.']);
        const messages = await messagesOf(second, target);
        expect(messages.some(isPending)).toBe(false);
        expect(messages.at(-1).extra.member_avatar).toBe(characters[1].avatar);
        expect(model.requests).toHaveLength(2);
    });

    test('does not continue when the page opens after 30 minutes', async ({ context }) => {
        const { target } = await startRound(context);

        const second = await context.newPage();
        await openApp(second, { clockAt: Date.now() + 31 * MINUTE });
        await waitForServerReply(second, target, 'My view comes first.');
        await openConversation(second, target);
        await expect.poll(async () => (await messagesOf(second, target)).some(message => message.mes === 'My view comes first.'), { timeout: 30_000 }).toBe(true);
        await second.waitForTimeout(4000);

        expect(model.requests, 'no second member was asked').toHaveLength(1);
    });
});

test.describe('a conversation that is deleted while a reply is being written', () => {
    test('gets nothing from a reply that the open page was waiting for', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);
        await send(page, 'Will you answer this?');
        await model.waitForRequests(1);

        await page.evaluate(async (id) => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            await conversationData.deleteConversation(id);
        }, target.conversationId);
        model.answer(0, 'A reply for a conversation that is gone.');
        // The assertion is that nothing arrives, so there is no state to poll for.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(3000);

        expect((await serverChat(page, target)).status).toBe(404);
        const listed = await page.evaluate(async (prefixPath) => {
            const { getRequestHeaders } = await import('/script.js');
            const response = await fetch(`${prefixPath}/list`, { method: 'POST', headers: getRequestHeaders(), body: '{}' });
            return (await response.json()).conversations.map(conversation => conversation.id);
        }, ROUTE_PREFIX);
        expect(listed).not.toContain(target.conversationId);
    });

    test('gets nothing from a reply that the server finished after the page was closed', async ({ context }) => {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seedConversationThatAnswers(first, characters);
        await openConversation(first, target);
        await send(first, 'Will you answer this too?');
        await model.waitForRequests(1);
        await closeTab(first);

        const second = await context.newPage();
        await openApp(second);
        await second.evaluate(async (id) => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            await conversationData.whenReady();
            await conversationData.deleteConversation(id);
        }, target.conversationId);
        model.answer(0, 'A reply that the server finishes for nobody.');
        await second.waitForTimeout(3000);

        expect((await serverChat(second, target)).status).toBe(404);
        const stray = await second.evaluate(async (prefixPath) => {
            const { getRequestHeaders } = await import('/script.js');
            const response = await fetch(`${prefixPath}/list`, { method: 'POST', headers: getRequestHeaders(), body: '{}' });
            return (await response.json()).conversations.length;
        }, ROUTE_PREFIX);
        expect(stray, 'no conversation came back').toBe(0);
    });
});

test.describe('a message that the user writes in the middle of a round', () => {
    test('stops the round: the second member of the first message does not start, and the new message gets its own reply', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters, { group: true });
        await openConversation(page, target);
        await send(page, `${characters[0].name} and ${characters[1].name}, first question?`);
        await model.waitForRequests(1);

        await send(page, `${characters[0].name} and ${characters[2].name}, wait, a second question?`);
        model.answer(0, 'Answer to the first question.');
        // The queue waits for the burst of messages to end before it starts on the second one.
        await model.waitForRequests(2);

        expect(model.requests[1].text, 'the next request is for the new message').toContain('a second question');
        model.answer(1, 'Answer to the second question.');
        await model.waitForRequests(3);
        model.answer(2, 'Another answer to the second question.');
        await expect.poll(async () => (await messagesOf(page, target)).filter(message => message.role !== 'user').map(message => message.mes).slice(-3), { timeout: 30_000 }).toEqual(['Answer to the first question.', 'Answer to the second question.', 'Another answer to the second question.']);
        const speakers = (await messagesOf(page, target)).filter(message => /question\./.test(message.mes ?? '')).map(message => message.extra?.member_avatar ?? characters[0].avatar);
        expect(speakers).not.toContain(characters[1].avatar);
    });
});

test.describe('a reply that a server restart lost', () => {
    test('is offered again, and Regenerate asks for it once', async ({ page }) => {
        const lost = { ...{ id: 'lost-reply-1', state: 'lost', kind: 'reply', reason: 'server-restart', started: Date.now() }, conversation: '', chat: '', member: '', round: [], triggers: ['seed-0-1'], token: 'abcdef0123456789' };
        let target;
        let characters;
        await page.route('**/api/resumable-generations/events**', async (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get('owner') !== 'conversations' || !target) {
                return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'data: {"pending":[]}\n\n' });
            }
            return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: `data: ${JSON.stringify({ pending: [{ ...lost, conversation: target.conversationId, chat: target.chatId, member: characters[0].avatar }] })}\n\n` });
        });
        characters = await openApp(page);
        target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);

        const toast = page.locator('.toast', { hasText: 'Reply lost' });
        await expect(toast).toBeVisible({ timeout: 30_000 });
        await toast.getByRole('link', { name: 'Regenerate' }).click();
        await model.waitForRequests(1);
        model.answer(0, 'The reply, again.');

        await expect.poll(async () => (await messagesOf(page, target)).some(message => message.mes === 'The reply, again.'), { timeout: 30_000 }).toBe(true);
        expect(model.requests).toHaveLength(1);
        await expect(page.locator('.toast', { hasText: 'Reply lost' })).toHaveCount(0);
    });
});
