import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { OPEN_ACTION_SHEET } from './helpers/action-sheet.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { DETAILS_HOST, shownPage } from './helpers/conversation-details.js';
import { seedConversation } from './helpers/conversation-seed.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

// Pins of a conversation: the Pinned mark under a bubble, the line between the messages that says a message was pinned, the
// time of the pin that the line is drawn from, and Pinned Messages in the header menu. The line is never a record of the chat,
// so the tests also look at what reads the chat: the prompt, the summary of the list and a reply that the server wrote.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const COMPOSER = '#sb_conversation_input';
const TIMELINE = '#sb_conversation_timeline';
const CONVERSATION_MENU = '#sb_conversation_header [data-sb-conversation-action="open-conversation-menu"]';
const ROUTE_PREFIX = '/api/sillybunny-conversation';
const MARK = '.sb-conversation-message-pinned';
const LINE = '.sb-conversation-event';
const SEE_ALL = '[data-sb-conversation-action="open-pinned-messages"]';
const SHOW = '[data-sb-conversation-action="show-pinned-message"]';

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

/** The app on a page whose persona the test owns, pointed at the fake model. Returns the first two characters of the library. */
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
    return page.evaluate(async (base) => {
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
        return context.characters.filter(character => character.avatar).slice(0, 2).map(character => ({ avatar: character.avatar, name: character.name }));
    }, `http://127.0.0.1:${model.port}`);
}

const MINUTE = 60_000;

/**
 * A conversation whose characters answer at once. The messages are in the past, a minute apart from `start`, so that a pin that the
 * test makes now falls after all of them, and a pin that a message carries falls where its time says.
 * @param {object[]} messages Each with `at`: the minute after `start` that it was sent.
 */
async function seed(page, characters, messages) {
    const start = Date.now() - 6 * 60 * MINUTE;
    const { conversationId, chatIds } = await seedConversation(page, {
        avatar: characters[0].avatar,
        replace: true,
        chats: [{ messages: messages.map(({ at, ...message }) => ({ ...message, created_at: start + at * MINUTE })) }],
    });
    await page.evaluate(async (id) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        conversationData.patchConversation(id, { settings: { reply_delay_multiplier: 0 } });
        await conversationData.flush();
    }, conversationId);
    return { conversationId, chatId: chatIds[0], avatar: characters[0].avatar, start };
}

async function openConversation(page, { avatar }) {
    await page.evaluate(async (id) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        await openConversationWorkspaceForAvatar(id, { showToast: false });
    }, avatar);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(COMPOSER)).toBeEnabled();
}

async function settleWrites(page) {
    await page.waitForFunction(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        return !conversationData.hasPendingWrites();
    }, null, { timeout: 30_000 });
}

async function closeTab(page) {
    await settleWrites(page);
    await page.close({ runBeforeUnload: true });
    await new Promise(resolve => setTimeout(resolve, 400));
}

/** The records of the chat as the server holds them, without its header. */
async function serverMessages(page, { conversationId, chatId }) {
    return page.evaluate(async ({ conversationId, chatId, routePrefix }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`${routePrefix}/chat/get`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: conversationId, chatId }) });
        return ((await response.json().catch(() => ({}))).chat ?? []).slice(1);
    }, { conversationId, chatId, routePrefix: ROUTE_PREFIX });
}

async function serverSummary(page, conversationId) {
    return page.evaluate(async ({ conversationId, routePrefix }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`${routePrefix}/list`, { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        return ((await response.json()).conversations ?? []).find(entry => entry.id === conversationId) ?? null;
    }, { conversationId, routePrefix: ROUTE_PREFIX });
}

/** What the timeline has, in order: the id of a message, `event:<id>` for the line of a pin, and nothing for a day divider. */
async function order(page) {
    return page.locator(TIMELINE).evaluate(timeline => [...timeline.children]
        .filter(node => node.classList.contains('sb-conversation-message') || node.classList.contains('sb-conversation-event'))
        .filter(node => !node.classList.contains('sb-conversation-typing-indicator'))
        .map(node => `${node.classList.contains('sb-conversation-event') ? 'event:' : ''}${node.dataset.messageId}`));
}

const messageOf = (page, id) => page.locator(`.sb-conversation-message[data-message-id="${id}"]`);

/** Pins or unpins a message with a pointer: the message's own menu, which the menu button of the toolbar opens. */
async function pinWithPointer(page, id, label) {
    const message = messageOf(page, id);
    await message.locator('.sb-conversation-message-bubble').hover();
    await message.locator('.sb-conversation-message-menu').click();
    await page.getByRole('menuitem', { name: label }).click();
}

async function pinWithTouch(page, id, label) {
    await messageOf(page, id).locator('.sb-conversation-mobile-menu-trigger').tap();
    await expect(page.locator(OPEN_ACTION_SHEET)).toBeVisible();
    await page.locator(OPEN_ACTION_SHEET).getByRole('menuitem', { name: label }).tap();
    await expect(page.locator(OPEN_ACTION_SHEET)).toHaveCount(0);
}

const CHAT = [
    { id: 'm1', role: 'character', name: 'Seraphina', mes: 'Good morning.', at: 0 },
    { id: 'm2', role: 'user', name: 'Tester', mes: 'Morning! The plan is the old oak at noon.', at: 1 },
    { id: 'm3', role: 'character', name: 'Seraphina', mes: 'I will bring the map.', at: 2 },
];

test.describe('pinning with a pointer', () => {
    test('a pin shows the Pinned mark and one line after the last message, and the chat keeps the boolean and the time and no record of the line', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, CHAT);
        await openConversation(page, target);
        await expect(page.locator(`${TIMELINE} ${MARK}`)).toHaveCount(0);
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(0);

        const before = Date.now();
        await pinWithPointer(page, 'm2', 'Pin Message');

        await expect(messageOf(page, 'm2').locator(MARK)).toHaveText('Pinned');
        await expect(messageOf(page, 'm2')).toHaveAttribute('data-pinned', 'true');
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(1);
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toContainText('You pinned a message.');
        expect(await order(page)).toEqual(['m1', 'm2', 'm3', 'event:m2']);
        await settleWrites(page);

        const saved = await serverMessages(page, target);
        expect(saved.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
        expect(saved[1].extra.conversation_pinned).toBe(true);
        expect(saved[1].extra.conversation_pinned_at).toBeGreaterThanOrEqual(before);
        expect(saved[1].extra.conversation_pinned_at).toBeLessThanOrEqual(Date.now());
        expect(saved.every(message => !/pinned/i.test(String(message.mes ?? '')))).toBe(true);
        expect(saved.some(message => message.role === 'system' || message.is_system)).toBe(false);
    });

    test('the line falls where the time of the pin says, between the messages that came before it and after it, and keeps its place after a reload', async ({ page }) => {
        const characters = await openApp(page);
        const start = Date.now() - 6 * 60 * MINUTE;
        const target = await seed(page, characters, [
            { id: 'm1', role: 'character', name: 'Seraphina', mes: 'Good morning.', at: 0 },
            { id: 'm2', role: 'user', name: 'Tester', mes: 'The plan is the old oak at noon.', at: 1, extra: { conversation_pinned: true, conversation_pinned_at: start + 3.5 * MINUTE } },
            { id: 'm3', role: 'character', name: 'Seraphina', mes: 'I will bring the map.', at: 2 },
            { id: 'm4', role: 'user', name: 'Tester', mes: 'Great.', at: 3 },
            { id: 'm5', role: 'character', name: 'Seraphina', mes: 'See you there.', at: 4 },
        ]);
        await openConversation(page, target);

        expect(await order(page)).toEqual(['m1', 'm2', 'm3', 'm4', 'event:m2', 'm5']);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await openConversation(page, target);
        expect(await order(page)).toEqual(['m1', 'm2', 'm3', 'm4', 'event:m2', 'm5']);
    });

    test('more messages after the pin leave the line where it was', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, CHAT);
        await openConversation(page, target);
        await pinWithPointer(page, 'm1', 'Pin Message');
        expect(await order(page)).toEqual(['m1', 'm2', 'm3', 'event:m1']);

        await page.locator(COMPOSER).fill('Something later.');
        await page.locator(COMPOSER).press('Enter');
        await model.waitForRequests(1);
        model.answer(0, 'Noted.');
        await expect(page.locator(`${TIMELINE} .sb-conversation-message-text`).filter({ hasText: 'Noted.' })).toBeVisible();

        const ids = await order(page);
        expect(ids.slice(0, 4)).toEqual(['m1', 'm2', 'm3', 'event:m1']);
        expect(ids).toHaveLength(6);
        expect(ids.filter(id => id.startsWith('event:'))).toEqual(['event:m1']);
    });

    test('an old pin has the mark and no line, and unpinning takes the mark and the line away, and the time from the chat', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, [
            { ...CHAT[0], extra: { conversation_pinned: true } },
            CHAT[1],
            CHAT[2],
        ]);
        await openConversation(page, target);
        await expect(messageOf(page, 'm1').locator(MARK)).toHaveText('Pinned');
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(0);

        await pinWithPointer(page, 'm2', 'Pin Message');
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(1);
        await settleWrites(page);
        expect((await serverMessages(page, target))[1].extra.conversation_pinned_at).toEqual(expect.any(Number));

        await pinWithPointer(page, 'm2', 'Unpin Message');
        await expect(messageOf(page, 'm2').locator(MARK)).toHaveCount(0);
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(0);
        await expect(messageOf(page, 'm1').locator(MARK)).toHaveText('Pinned');
        await settleWrites(page);
        const saved = (await serverMessages(page, target))[1];
        expect(saved.extra.conversation_pinned).toBe(false);
        expect(saved.extra).not.toHaveProperty('conversation_pinned_at');
    });

    test('a message that continues a group shows the mark although its name row is hidden, and the message after a line starts a group', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, [
            { id: 'a1', role: 'character', name: 'Seraphina', mes: 'First thought.', at: 0 },
            { id: 'a2', role: 'character', name: 'Seraphina', mes: 'Second thought, pinned.', at: 1, extra: { conversation_pinned: true, conversation_pinned_at: Date.now() - 6 * 60 * MINUTE + 1.5 * MINUTE } },
            { id: 'a3', role: 'character', name: 'Seraphina', mes: 'Third thought.', at: 2 },
        ]);
        await openConversation(page, target);

        expect(await order(page)).toEqual(['a1', 'a2', 'event:a2', 'a3']);
        await expect(messageOf(page, 'a2')).not.toHaveAttribute('data-show-header', 'true');
        await expect(messageOf(page, 'a2').locator('.sb-conversation-message-meta')).toBeHidden();
        await expect(messageOf(page, 'a2').locator(MARK)).toBeVisible();
        await expect(messageOf(page, 'a3')).toHaveAttribute('data-show-header', 'true');
        await expect(messageOf(page, 'a3')).toHaveAttribute('data-group-position', 'single');
    });

    test('See All Pinned opens Details on the Pinned page and gives the focus back to the button, and Show Message brings the message into view', async ({ page }) => {
        const characters = await openApp(page);
        const many = Array.from({ length: 30 }, (_, index) => ({ id: `n${index}`, role: index % 2 ? 'user' : 'character', name: index % 2 ? 'Tester' : 'Seraphina', mes: `Message number ${index} with enough words to fill a line of the timeline.`, at: index }));
        many[1].extra = { conversation_pinned: true, conversation_pinned_at: Date.now() - 6 * 60 * MINUTE + 1.5 * MINUTE };
        const target = await seed(page, characters, many);
        await openConversation(page, target);

        const line = page.locator(`${TIMELINE} ${LINE}`);
        await line.scrollIntoViewIfNeeded();
        await expect(line.locator(SEE_ALL)).toHaveText('See All Pinned');
        await line.locator(SEE_ALL).click();

        const details = page.locator(DETAILS_HOST);
        await expect(details).toBeVisible();
        await expect(shownPage(page).locator('.sb-details-page--pinned')).toBeVisible();
        await expect(shownPage(page).getByText('Message number 1 with enough words')).toBeVisible();
        // Escape goes back one page of Details and then closes the window.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(details).toHaveCount(0);
        await expect(line.locator(SEE_ALL)).toBeFocused();

        await page.locator(TIMELINE).evaluate(timeline => { timeline.scrollTop = timeline.scrollHeight; });
        await line.scrollIntoViewIfNeeded();
        await page.locator(TIMELINE).evaluate(timeline => { timeline.scrollTop = timeline.scrollHeight; });
        await expect(messageOf(page, 'n1')).not.toBeInViewport();
        await line.locator(SHOW).click();
        await expect(messageOf(page, 'n1')).toBeInViewport();
    });

    test('Pinned Messages is in the header menu only while the open chat has a pinned message, and opens the Pinned page', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, CHAT);
        await openConversation(page, target);

        await page.locator(CONVERSATION_MENU).click();
        await expect(page.getByRole('menuitem', { name: 'Details' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Pinned Messages' })).toHaveCount(0);
        await page.keyboard.press('Escape');

        await pinWithPointer(page, 'm2', 'Pin Message');
        await page.locator(CONVERSATION_MENU).click();
        await expect(page.getByRole('menuitem')).toContainText(['Details', 'Pinned Messages', 'New Chat']);
        await page.getByRole('menuitem', { name: 'Pinned Messages' }).click();
        await expect(shownPage(page).locator('.sb-details-page--pinned')).toBeVisible();
        await expect(shownPage(page).getByText('The plan is the old oak at noon.')).toBeVisible();
    });

    test('draws no line while a search filters the timeline, and draws it again when the search is cleared', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, CHAT);
        await openConversation(page, target);
        await pinWithPointer(page, 'm2', 'Pin Message');
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(1);

        await page.evaluate(async () => {
            const { updateConversationSearchQuery } = await import('/scripts/sillybunny-conversation/timeline-render.js');
            updateConversationSearchQuery('oak');
        });
        await expect(page.locator(`${TIMELINE} .sb-conversation-message`)).toHaveCount(1);
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(0);
        await expect(messageOf(page, 'm2').locator(MARK)).toHaveText('Pinned');

        await page.evaluate(async () => {
            const { updateConversationSearchQuery } = await import('/scripts/sillybunny-conversation/timeline-render.js');
            updateConversationSearchQuery('');
        });
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(1);
    });
});

test.describe('what reads the chat does not see the line', () => {
    test('the prompt of the next reply has nothing of the pin, and the reply comes after the line', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, CHAT);
        await openConversation(page, target);
        await pinWithPointer(page, 'm2', 'Pin Message');
        await expect(page.locator(`${TIMELINE} ${LINE}`)).toHaveCount(1);

        await page.locator(COMPOSER).fill('Shall we go?');
        await page.locator(COMPOSER).press('Enter');
        await model.waitForRequests(1);
        const asked = model.requests[0].text;
        expect(asked).toContain('The plan is the old oak at noon.');
        expect(asked).not.toMatch(/pinned/i);
        expect(asked).not.toContain('conversation_pinned');
        model.answer(0, 'Yes, lead the way.');
        await expect(page.locator(`${TIMELINE} .sb-conversation-message-text`).filter({ hasText: 'Yes, lead the way.' })).toBeVisible();

        const ids = await order(page);
        expect(ids.slice(0, 4)).toEqual(['m1', 'm2', 'm3', 'event:m2']);
        await settleWrites(page);
        const saved = await serverMessages(page, target);
        expect(saved).toHaveLength(5);
        expect(saved.every(message => !/pinned/i.test(String(message.mes ?? '')))).toBe(true);
    });

    test('a reply that the server wrote lands after the line, and the summary of the list counts the messages and shows the reply', async ({ context }) => {
        const first = await context.newPage();
        const characters = await openApp(first);
        const target = await seed(first, characters, CHAT);
        await openConversation(first, target);
        await pinWithPointer(first, 'm2', 'Pin Message');
        await expect(first.locator(`${TIMELINE} ${LINE}`)).toHaveCount(1);
        await first.locator(COMPOSER).fill('Shall we go?');
        await first.locator(COMPOSER).press('Enter');
        await model.waitForRequests(1);
        await closeTab(first);

        model.answer(0, 'Yes, lead the way.');
        const second = await context.newPage();
        await openApp(second);
        await expect.poll(async () => (await serverMessages(second, target)).some(message => String(message.mes ?? '').includes('lead the way')), { timeout: 30_000 }).toBe(true);
        const summary = await serverSummary(second, target.conversationId);
        const records = await serverMessages(second, target);
        expect(summary.messageCount).toBe(records.length);
        expect(summary.preview).toBe('Yes, lead the way.');
        expect(summary.unread).toBe(1);
        expect(records.every(message => !/pinned/i.test(String(message.mes ?? '')))).toBe(true);

        await openConversation(second, target);
        await expect.poll(async () => (await serverMessages(second, target)).some(message => message.extra?.server_generation?.pending), { timeout: 30_000 }).toBe(false);
        await expect(second.locator(`${TIMELINE} .sb-conversation-message-text`).filter({ hasText: 'Yes, lead the way.' })).toBeVisible();
        const ids = await order(second);
        expect(ids.slice(0, 4)).toEqual(['m1', 'm2', 'm3', 'event:m2']);
        expect(ids.filter(id => id.startsWith('event:'))).toEqual(['event:m2']);
        const saved = await serverMessages(second, target);
        expect(saved.map(message => message.extra?.conversation_pinned_at).filter(Boolean)).toHaveLength(1);
        expect(saved.every(message => !/pinned/i.test(String(message.mes ?? '')))).toBe(true);
    });
});

test.describe('pinning on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('pins from the sheet of the message, draws the mark and the line with buttons of 44px, and fits the screen', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, CHAT);
        await openConversation(page, target);

        await pinWithTouch(page, 'm2', 'Pin Message');

        await expect(messageOf(page, 'm2').locator(MARK)).toHaveText('Pinned');
        const line = page.locator(`${TIMELINE} ${LINE}`);
        await expect(line).toHaveCount(1);
        await expect(line).toContainText('You pinned a message.');
        for (const button of await line.locator('button').all()) {
            const box = await button.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
        const overflow = await page.evaluate(() => {
            const row = document.querySelector('.sb-conversation-event');
            const timeline = document.getElementById('sb_conversation_timeline');
            return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, row: row.scrollWidth - row.clientWidth, timeline: timeline.scrollWidth - timeline.clientWidth };
        });
        expect(overflow).toEqual({ page: 0, row: 0, timeline: 0 });

        await line.locator(SEE_ALL).tap();
        await expect(shownPage(page).locator('.sb-details-page--pinned')).toBeVisible();
        await expect(shownPage(page).getByText('The plan is the old oak at noon.')).toBeVisible();
    });

    test('the header menu offers Pinned Messages after a pin, and the line wraps its buttons under its text on a screen of 320px', async ({ page }) => {
        const characters = await openApp(page);
        const target = await seed(page, characters, [{ ...CHAT[0], extra: { conversation_pinned: true, conversation_pinned_at: Date.now() - 6 * 60 * MINUTE + 0.5 * MINUTE } }, CHAT[1], CHAT[2]]);
        await openConversation(page, target);
        await page.setViewportSize({ width: 320, height: 640 });
        const line = page.locator(`${TIMELINE} ${LINE}`);
        await expect(line).toHaveCount(1);
        const tops = await line.locator('.sb-conversation-event-text, button').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
        expect(new Set(tops).size).toBeGreaterThan(1);
        expect(await line.evaluate(row => row.scrollWidth - row.clientWidth)).toBe(0);

        await page.locator(CONVERSATION_MENU).tap();
        await expect(page.locator(OPEN_ACTION_SHEET).getByRole('menuitem', { name: 'Pinned Messages' })).toBeVisible();
    });
});
