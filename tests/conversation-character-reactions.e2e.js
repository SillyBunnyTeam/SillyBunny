import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { openDetails, openDetailsApp, readStored, seedAndOpen, shownPage } from './helpers/conversation-details.js';
import { seedConversation } from './helpers/conversation-seed.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

// A character reacts when it replies: the reply carries [react: <emoji>], which is taken out of the text and shown as a
// reaction under the message of the user that the reply answers. The tests answer from a fake model, on the path where
// the page writes the reply and on the path where the page is closed and the server writes it.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const COMPOSER = '#sb_conversation_input';
const CHIP = '.sb-conversation-message-reaction-chip';
const ROUTE_PREFIX = '/api/sillybunny-conversation';

/** An OpenAI-compatible model that holds each request until the test answers it, and keeps what it was asked. */
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
                this.requests.push({ body, text: JSON.stringify(body.messages ?? []), response });
            });
        });
        await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.port = this.server.address().port;
    }

    async stop() {
        this.server?.closeAllConnections?.();
        await new Promise(resolve => this.server?.close(resolve) ?? resolve());
    }

    answer(index, text) {
        const { response } = this.requests[index];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: text } }], created: 0, model: 'fake-model' }));
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
 * Opens the app on a page whose persona the test owns, and points it at the fake model.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ avatar: string, name: string }[]>} The first three characters of the library.
 */
async function openApp(page) {
    await protectMaintainerServer(page, { conversationPrefix: prefix });
    await page.route('**/api/settings/get', async (settingsRoute) => {
        const response = await settingsRoute.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.user_avatar = persona;
        await settingsRoute.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60_000 });
    await waitForAppReady(page);
    await showToasts(page);
    const characters = await page.evaluate(async (base) => {
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
    expect(characters, 'the library has three characters for a group').toHaveLength(3);
    return characters;
}

/**
 * A conversation that answers at once, with a greeting and a message of the user as its history. The route that makes it
 * writes no settings, which is what a conversation made before Characters React looks like; `react` turns it on.
 */
async function seedConversationThatAnswers(page, characters, { group = false, react = true } = {}) {
    const { conversationId, chatIds } = await seedConversation(page, {
        avatar: characters[0].avatar,
        ...(group ? { members: [characters[1].avatar, characters[2].avatar], name: 'Reactions' } : {}),
        replace: true,
        chats: [{ messages: [{ id: 'greeting', role: 'character', mes: 'Hello there.' }, { id: 'hello', role: 'user', mes: 'Hi, it is me.', name: 'Tester' }] }],
    });
    await page.evaluate(async ({ id, react }) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        conversationData.patchConversation(id, { settings: { reply_delay_multiplier: 0, ...(react ? { characters_react: true } : {}) } });
        await conversationData.flush();
    }, { id: conversationId, react });
    return { conversationId, chatId: chatIds[0], avatar: characters[0].avatar, groupId: group ? conversationId : '' };
}

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

async function settleWrites(page) {
    await page.waitForFunction(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        return !conversationData.hasPendingWrites();
    }, null, { timeout: 30_000 });
}

/** Closes a page the way a user closes a tab, which hands its replies to the server, and waits for the page to be gone. */
async function closeTab(page) {
    await settleWrites(page);
    await page.close({ runBeforeUnload: true });
    await new Promise(resolve => setTimeout(resolve, 400));
}

async function serverMessages(page, { conversationId, chatId }) {
    return page.evaluate(async ({ conversationId, chatId, routePrefix }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`${routePrefix}/chat/get`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: conversationId, chatId }) });
        return ((await response.json().catch(() => ({}))).chat ?? []).slice(1);
    }, { conversationId, chatId, routePrefix: ROUTE_PREFIX });
}

const reactionsOf = async (page, target, messageId) => (await serverMessages(page, target)).find(message => message.id === messageId)?.extra?.conversation_reactions;

async function messagesOf(page, { conversationId, chatId }) {
    return page.evaluate(async ({ conversationId, chatId }) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        const chat = conversationData.chat({ conversationId, chatId });
        return (chat?.messages ?? []).map(message => ({ id: message.id, role: message.role, mes: message.mes, extra: message.extra }));
    }, { conversationId, chatId });
}

const userChip = page => page.locator(`.sb-conversation-message[data-role="user"] ${CHIP}`);
const bubbleTexts = async page => page.locator('.sb-conversation-message:not([data-role="user"]) .sb-conversation-message-text').allTextContents();

test.describe('on the page that writes the reply', () => {
    test('shows the reaction under the message that the reply answers, and no marker in the bubble', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);

        await send(page, 'I got the job!');
        await model.waitForRequests(1);
        model.answer(0, '[react: 🎉] That is wonderful news!');

        await expect(userChip(page).last()).toHaveText('🎉');
        await expect(userChip(page).last()).toHaveAttribute('aria-pressed', 'false');
        await expect(userChip(page).last()).toHaveAccessibleName('🎉, 1 reaction');
        await expect.poll(() => bubbleTexts(page)).toContain('That is wonderful news!');
        expect((await bubbleTexts(page)).join(' ')).not.toContain('[react');
        const sent = (await messagesOf(page, target)).find(message => message.mes === 'I got the job!');
        expect(sent.extra.conversation_reactions).toEqual([{ emoji: '🎉', by: characters[0].avatar, at: expect.any(Number) }]);
    });

    test('is the whole reply when the reply is only the marker: a reaction and no bubble', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);

        await send(page, 'Dinner is on me tonight.');
        await model.waitForRequests(1);
        const before = (await messagesOf(page, target)).length;
        model.answer(0, '[react: ❤️]');

        await expect(userChip(page).last()).toHaveText('❤️');
        expect((await messagesOf(page, target)).length, 'no bubble came after the reaction').toBe(before);
    });

    test('is taken out and not shown when the conversation does not let its characters react', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters, { react: false });
        await openConversation(page, target);

        await send(page, 'I got the job!');
        await model.waitForRequests(1);
        model.answer(0, '[react: 🎉] That is wonderful news!');

        await expect.poll(() => bubbleTexts(page)).toContain('That is wonderful news!');
        await expect(userChip(page)).toHaveCount(0);
        expect((await bubbleTexts(page)).join(' ')).not.toContain('[react');
    });

    test('is ignored when the marker holds no emoji, and the text stays', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);

        await send(page, 'Tell me a joke.');
        await model.waitForRequests(1);
        model.answer(0, '[react: laughing] Why did the chicken cross the road?');

        await expect.poll(() => bubbleTexts(page)).toContain('Why did the chicken cross the road?');
        await expect(userChip(page)).toHaveCount(0);
    });

    test('is one of the character, so that a forced second reply adds none', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);

        await send(page, 'Big news.');
        await model.waitForRequests(1);
        model.answer(0, '[react: 😮] Really?');
        await expect(userChip(page).last()).toHaveText('😮');

        await page.evaluate(async () => {
            const { runConversationAction } = await import('/scripts/sillybunny-conversation/chrome.js');
            await runConversationAction('force-response');
        });
        await model.waitForRequests(2);
        model.answer(1, '[react: 🎉] Tell me more.');
        await expect.poll(() => bubbleTexts(page)).toContain('Tell me more.');

        await expect(userChip(page).last()).toHaveText('😮');
        await expect(userChip(page)).toHaveCount(1);
    });

    test('is written once for each member of a group that replies, and the chip counts them', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters, { group: true });
        await openConversation(page, target);

        await send(page, `${characters[0].name} and ${characters[1].name}, look at this!`);
        await model.waitForRequests(1);
        model.answer(0, '[react: ❤️] I love it.');
        await model.waitForRequests(2);
        model.answer(1, '[react: ❤️] Me too.');

        await expect(userChip(page).last()).toHaveText('❤️2');
        await expect(userChip(page).last()).toHaveAttribute('title', `${characters[0].name}, ${characters[1].name}`);
        await expect(userChip(page).last()).toHaveAccessibleName('red heart, 2 reactions');
    });

    test('is told to the model as a command only in a conversation that lets its characters react', async ({ page }) => {
        const characters = await openApp(page);
        const withReactions = await seedConversationThatAnswers(page, characters, { react: true });
        await openConversation(page, withReactions);
        await send(page, 'First question?');
        await model.waitForRequests(1);
        model.answer(0, 'First answer.');
        await expect.poll(() => bubbleTexts(page)).toContain('First answer.');

        const without = await seedConversationThatAnswers(page, characters, { react: false });
        await openConversation(page, without);
        await send(page, 'Second question?');
        await model.waitForRequests(2);

        expect(model.requests[0].text).toContain('[react: <emoji>]');
        expect(model.requests[1].text).not.toContain('[react:');
    });

    test('tells the model what the user reacted to, in the next request', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);
        await send(page, 'Question one?');
        await model.waitForRequests(1);
        expect(model.requests[0].text).not.toContain('Recent reactions');
        model.answer(0, 'Answer one.');
        await expect.poll(() => bubbleTexts(page)).toContain('Answer one.');

        const answer = page.locator('.sb-conversation-message').filter({ hasText: 'Answer one.' });
        await answer.hover();
        await answer.locator('.sb-conversation-message-actions > .sb-conversation-reaction-button').first().click();
        await expect(answer.locator(CHIP)).toHaveText('❤️');
        await send(page, 'Question two?');
        await model.waitForRequests(2);

        expect(model.requests[1].text).toContain('Recent reactions:');
        expect(model.requests[1].text).toMatch(/reacted ❤️ to your message: \\"Answer one\.\\"/);
    });

    test('does not drop a reply when the user reacts while it is being written', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seedConversationThatAnswers(page, characters);
        await openConversation(page, target);
        await send(page, 'Are you there?');
        await model.waitForRequests(1);

        const greeting = page.locator('.sb-conversation-message').filter({ hasText: 'Hello there.' });
        await greeting.hover();
        await greeting.locator('.sb-conversation-message-actions > .sb-conversation-reaction-button').first().click();
        await expect(greeting.locator(CHIP)).toHaveText('❤️');
        model.answer(0, 'Yes, I am here.');

        await expect.poll(() => bubbleTexts(page)).toContain('Yes, I am here.');
        expect(model.requests, 'the reaction did not ask for the reply again').toHaveLength(1);
    });
});

test.describe('on the path where the server writes the reply', () => {
    test('shows the reaction when a page that opens later lands the reply, as it shows the bubbles', async ({ context }) => {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seedConversationThatAnswers(first, characters);
        await openConversation(first, target);
        await send(first, 'Guess what happened?');
        await model.waitForRequests(1);
        await closeTab(first);

        model.answer(0, '[react: 😮] Go on, tell me everything.');
        const second = await context.newPage();
        await openApp(second);
        await expect.poll(async () => (await serverMessages(second, target)).some(message => String(message.mes ?? '').includes('tell me everything')), { timeout: 30_000 }).toBe(true);
        await openConversation(second, target);

        await expect(userChip(second).last()).toHaveText('😮');
        await expect.poll(async () => (await serverMessages(second, target)).some(message => message.extra?.server_generation?.pending), { timeout: 30_000 }).toBe(false);
        const saved = await serverMessages(second, target);
        const answered = saved.find(message => message.mes === 'Guess what happened?');
        expect(answered.extra.conversation_reactions).toEqual([{ emoji: '😮', by: characters[0].avatar, at: expect.any(Number) }]);
        expect(saved.find(message => message.mes === 'Go on, tell me everything.')).toBeDefined();
        expect(saved.every(message => !String(message.mes ?? '').includes('[react'))).toBe(true);
    });

    test('is not shown, and the marker is not either, when the conversation does not let its characters react', async ({ context }) => {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seedConversationThatAnswers(first, characters, { react: false });
        await openConversation(first, target);
        await send(first, 'Guess what happened?');
        await model.waitForRequests(1);
        await closeTab(first);

        model.answer(0, '[react: 😮] Go on, tell me everything.');
        const second = await context.newPage();
        await openApp(second);
        await expect.poll(async () => (await serverMessages(second, target)).some(message => String(message.mes ?? '').includes('tell me everything')), { timeout: 30_000 }).toBe(true);
        await openConversation(second, target);
        await expect.poll(async () => (await serverMessages(second, target)).some(message => message.extra?.server_generation?.pending), { timeout: 30_000 }).toBe(false);

        const saved = await serverMessages(second, target);
        expect(saved.find(message => message.mes === 'Go on, tell me everything.')).toBeDefined();
        expect(await reactionsOf(second, target, 'hello')).toBeUndefined();
        await expect(userChip(second)).toHaveCount(0);
    });
});

test.describe('the Characters React switch', () => {
    test('is on in a conversation that the app makes and off in one that was made without it, and saves as the other rows do', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId: existing } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ messages: [{ role: 'user', mes: 'hi' }] }] });
        const made = await page.evaluate(async (avatar) => {
            const { ensureDirectConversation } = await import('/scripts/sillybunny-conversation/context.js');
            return (await ensureDirectConversation(avatar)).id;
        }, avatars[1]);

        await openDetails(page, existing, { page: 'behaviour' });
        const switchOf = () => shownPage(page).getByRole('switch', { name: 'Characters React' });
        await expect(switchOf()).not.toBeChecked();
        expect((await readStored(page, existing)).settings).not.toHaveProperty('characters_react');
        await expect(shownPage(page).locator('[data-sb-copy-placeholder="true"]')).toHaveCount(2);
        await switchOf().check();
        await expect.poll(async () => (await readStored(page, existing)).settings.characters_react).toBe(true);
        await switchOf().uncheck();
        await expect.poll(async () => (await readStored(page, existing)).settings).not.toHaveProperty('characters_react');

        await page.keyboard.press('Escape');
        await openDetails(page, made, { page: 'behaviour' });
        await expect(switchOf()).toBeChecked();
        expect((await readStored(page, made)).settings).toEqual({ characters_react: true });
    });

    test('is on in a group that Add Member starts from a direct conversation', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ messages: [{ role: 'user', mes: 'hi' }] }] });

        const added = await page.evaluate(async ({ id, avatar, prefixPath }) => {
            const { getRequestHeaders } = await import('/script.js');
            const response = await fetch(`${prefixPath}/members/add`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id, characters: [avatar] }) });
            return (await response.json()).conversation;
        }, { id: conversationId, avatar: avatars[1], prefixPath: ROUTE_PREFIX });

        expect(added.kind).toBe('group');
        expect(added.settings).toEqual({ characters_react: true });
    });
});
