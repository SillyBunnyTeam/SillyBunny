import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { normalizeCommitPlan } from '../public/scripts/generation-commit-plan.js';
import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { markReminderDelivered } from '../public/scripts/sillybunny-conversation/reminders.js';
import { createReplyFinalizer } from '../public/scripts/sillybunny-conversation/reply-finalizer.js';
import { isPendingServerReply } from '../public/scripts/sillybunny-conversation/pending-reply.js';
import { createWorld, installAutoEngineMocks, MINUTE, NOW } from './util/auto-engine-harness.js';
import { seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters, PERSONA } from './util/conversation-store-sandbox.js';

// The real data module, the real routes, the real chat file and the real finalizer; the page around the worker is the
// harness. A page that closes while the model is still writing leaves its request to the server, which writes the
// reply into the chat file (`commitGenerationReply`); the next page lands it. What the tests ask is whether that
// next page sends the same message a second time.
const world = createWorld(jest);
await installAutoEngineMocks(jest, world);

const { conversationModeAutoMessageWorker, checkConversationReminders } = await import('../public/scripts/sillybunny-conversation/auto-engine.js');
const { commitGenerationReply } = await import('../src/generation-commit.js');

const { generateConversationReply, postCharacterReply } = world.spies;
const DIRECT_ID = 'conv_1_direct01';
const ADDRESS = { conversationId: DIRECT_ID, chatId: 'main' };
const DIRECT = {
    id: DIRECT_ID,
    characters: ['char.png'],
    settings: { proactive_messaging: true, inactivity_threshold: 60 },
    chats: [{ id: 'main', name: 'Main', messages: ['hello', 'hi there'], readThrough: 'main-1' }],
};

let server;
let pages;
let clock;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['char.png', 'birch.png']);
    pages = [];
    clock = NOW;
    world.reset();
    world.personaId = PERSONA;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    world.addCharacter('char.png', { name: 'Aster' });
    world.addCharacter('birch.png', { name: 'birch' });
});

afterEach(async () => {
    for (const page of pages) {
        page.data.destroy();
    }
    await server.stop();
    jest.restoreAllMocks();
});

/** A page: its own data module on the shared server, with its finalizer, as the worker would find it. */
async function openPage() {
    const data = createConversationData(server.adapter());
    await data.start();
    await data.whenReady();
    await data.loadChat(ADDRESS);
    const acknowledged = [];
    const finalizer = createReplyFinalizer({
        data,
        getLocks: () => undefined,
        page: {
            context: (view, reply) => ({
                anchorAvatar: reply.anchor || view.characters[0],
                groupId: view.kind === 'group' ? view.id : '',
                personaId: view.personaId,
                speakersFor: () => [],
                settingsFor: () => ({}),
            }),
            cleanUpText: (_route, text) => text,
            buildReference: () => null,
            afterIncoming: jest.fn(),
            runCommands: jest.fn(),
            makeSelfie: jest.fn(async () => true),
            acknowledge: ids => acknowledged.push(...ids),
            markReminderDelivered: (conversationId, reminderId) => data.patchReminder(conversationId, reminderId, markReminderDelivered(clock)),
        },
    });
    const page = { data, finalizer, acknowledged };
    pages.push(page);
    return page;
}

/** Points the worker at a page, as the page that is open now. */
function switchTo(page) {
    // What the page before it kept in memory is gone with that page, such as the flag of a request that never ended.
    for (const key of Object.keys(world.state.conversationState)) {
        delete world.state.conversationState[key];
    }
    world.useData(page.data);
    world.railItems = world.data.list().map(view => world.railItemFor(view));
    world.spies.ensureConversationChatLoaded.mockImplementation(async (_avatar, { chatId = 'main' } = {}) => {
        await page.data.loadChat({ conversationId: DIRECT_ID, chatId });
        await page.finalizer.finalize({ conversationId: DIRECT_ID, chatId });
        return { conversationId: DIRECT_ID, chatId };
    });
}

/** The page writes the reply the way the live path does: bubbles in the chat, each with the token. */
function postLikeTheLivePath() {
    postCharacterReply.mockImplementation(async (text, _settings, { extra }) => {
        const [page] = pages.slice(-1);
        page.data.commitChat(ADDRESS, (draft) => {
            draft.messages.push({ id: `live-${draft.messages.length}`, role: 'character', name: 'Aster', is_user: false, is_system: false, mes: text, send_date: new Date(clock).toISOString(), created_at: clock, extra });
        });
        return text;
    });
}

const tick = () => conversationModeAutoMessageWorker({ signal: new AbortController().signal });
const messagesOf = page => page.data.chat(ADDRESS).messages;
/** The messages that an automatic reply made, not the greeting that the chat started with. */
const repliesOf = page => messagesOf(page).filter(message => message.extra?.reply_token);

/** The server finishes the reply that the closed page asked for. */
async function serverFinishes(plan, text) {
    return commitGenerationReply(server.user, normalizeCommitPlan(plan), { text, reasoning: '', error: false }, { id: 'gen-auto-1', finishedAt: new Date(clock) });
}

describe('a page that closes while an automatic message is being written', () => {
    test('leaves the server to write it, and the next page lands it and does not send it again', async () => {
        seedConversations(server, [DIRECT]);
        const first = await openPage();
        first.data.patchConversation(DIRECT_ID, { chats: { main: { lastActivity: NOW - 100 * MINUTE } } });
        switchTo(first);
        let capturedPlan;
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            capturedPlan = commit.createPlan('raw');
            return new Promise(() => {});
        });

        void tick();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        // The page is closing: what it holds is written to the server first.
        await first.data.flush({ keepalive: true });
        const committed = await serverFinishes(capturedPlan, 'Hey, are you still there?');
        expect(committed.committed).toBe(true);

        const second = await openPage();
        expect(messagesOf(second).some(isPendingServerReply)).toBe(true);
        await second.finalizer.finalize(ADDRESS);

        const landed = repliesOf(second);
        expect(messagesOf(second).some(isPendingServerReply)).toBe(false);
        expect(landed.map(message => message.mes)).toEqual(['Hey, are you still there?']);
        expect(landed[0].extra).toMatchObject({ conversation_mode_auto: true, reply_token: capturedPlan.reply.token });
        expect(second.acknowledged).toEqual(['gen-auto-1']);

        // The next page does not write the same message again, a few minutes later or at the next tick.
        generateConversationReply.mockReset();
        generateConversationReply.mockResolvedValue('A second message.');
        postLikeTheLivePath();
        switchTo(second);
        for (const minutes of [1, 5, 30, 100]) {
            clock = NOW + minutes * MINUTE;
            await tick();
        }

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(repliesOf(second).map(message => message.mes)).toEqual(['Hey, are you still there?']);
    });

    test('the next message comes once the doubled patience has passed since the first one, and it is another message', async () => {
        seedConversations(server, [DIRECT]);
        const first = await openPage();
        first.data.patchConversation(DIRECT_ID, { chats: { main: { lastActivity: NOW - 100 * MINUTE } } });
        switchTo(first);
        let capturedPlan;
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            capturedPlan = commit.createPlan('raw');
            return new Promise(() => {});
        });
        void tick();
        await new Promise(resolve => setTimeout(resolve, 20));
        await first.data.flush({ keepalive: true });
        await serverFinishes(capturedPlan, 'Hey, are you still there?');

        const second = await openPage();
        await second.finalizer.finalize(ADDRESS);
        generateConversationReply.mockReset();
        generateConversationReply.mockResolvedValue('Still nothing?');
        postLikeTheLivePath();
        switchTo(second);
        clock = NOW + 119 * MINUTE;
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();
        clock = NOW + 120 * MINUTE;
        await tick();

        expect(generateConversationReply).toHaveBeenCalledTimes(1);
        const replies = repliesOf(second);
        expect(replies.map(message => message.mes)).toEqual(['Hey, are you still there?', 'Still nothing?']);
        expect(replies[1].extra.reply_token).not.toBe(replies[0].extra.reply_token);
    });

    test('the server refuses its copy when the page lived to write the message itself', async () => {
        seedConversations(server, [DIRECT]);
        const page = await openPage();
        page.data.patchConversation(DIRECT_ID, { chats: { main: { lastActivity: NOW - 100 * MINUTE } } });
        switchTo(page);
        let capturedPlan;
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            capturedPlan = commit.createPlan('raw');
            return 'Hey, are you still there?';
        });
        postLikeTheLivePath();

        await tick();
        await page.data.flush();
        const late = await serverFinishes(capturedPlan, 'Hey, are you still there?');

        expect(late).toEqual({ committed: false, reason: 'reply-landed' });
        expect(repliesOf(page)).toHaveLength(1);
    });

    test('the server writes nothing for a chat that has no message from the user, which a deleted chat leaves behind', async () => {
        seedConversations(server, [{ ...DIRECT, chats: [{ id: 'main', name: 'Main', messages: [] }] }]);
        const page = await openPage();
        const plan = normalizeCommitPlan({
            v: 1,
            chat: { conversation: DIRECT_ID },
            file: 'main',
            kind: 'reply',
            index: 0,
            started: new Date(NOW).toISOString(),
            page: 'page-gone',
            round: [],
            message: { name: 'Aster' },
            reply: { token: 'abcdef0123456789', speaker: 'char.png', anchor: 'char.png', origin: 'auto', route: 'raw', triggers: [], target: null, needs_user: true, round_started: NOW },
        });

        const result = await commitGenerationReply(server.user, plan, { text: 'Hey?', reasoning: '', error: false }, { id: 'gen-x', finishedAt: new Date(NOW) });

        expect(result).toEqual({ committed: false, reason: 'no-user-message' });
        await page.data.reloadChat(ADDRESS);
        expect(messagesOf(page)).toHaveLength(0);
    });
});

describe('a page that closes while a reminder is being written', () => {
    const REMINDER = { id: 'rem_1_aaaaaa', avatar: 'char.png', chatId: 'main', text: 'water the plants', triggerAt: NOW - 1000, fired: false };

    test('leaves the server to write it, and the next page lands it, marks the reminder delivered and sends nothing more', async () => {
        seedConversations(server, [{ ...DIRECT, settings: {}, reminders: [REMINDER] }]);
        const first = await openPage();
        switchTo(first);
        let capturedPlan;
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            capturedPlan = commit.createPlan('raw');
            return new Promise(() => {});
        });

        void checkConversationReminders(NOW);
        await new Promise(resolve => setTimeout(resolve, 20));
        await first.data.flush({ keepalive: true });
        expect(capturedPlan.reply).toMatchObject({ origin: 'reminder', reminder: 'rem_1_aaaaaa', needs_user: false });
        await serverFinishes(capturedPlan, 'Time to water the plants!');

        const second = await openPage();
        expect(second.data.reminders(DIRECT_ID)[0]).toMatchObject({ state: 'scheduled', attempts: 1 });
        await second.finalizer.finalize(ADDRESS);

        expect(repliesOf(second).map(message => message.mes)).toEqual(['Time to water the plants!']);
        expect(second.data.reminders(DIRECT_ID)[0]).toMatchObject({ state: 'delivered', attempts: 1 });
        generateConversationReply.mockReset();
        switchTo(second);
        for (const minutes of [1, 2, 10]) {
            clock = NOW + minutes * MINUTE;
            await tick();
        }
        expect(generateConversationReply).not.toHaveBeenCalled();
    });

    test('is not sent again by the page that opens before the server finished it, and is delivered once it did', async () => {
        seedConversations(server, [{ ...DIRECT, settings: {}, reminders: [REMINDER] }]);
        const first = await openPage();
        switchTo(first);
        let capturedPlan;
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            capturedPlan = commit.createPlan('raw');
            return new Promise(() => {});
        });
        void checkConversationReminders(NOW);
        await new Promise(resolve => setTimeout(resolve, 20));
        await first.data.flush({ keepalive: true });

        // The model is still writing when a second page opens and its worker ticks within the minute of the first attempt.
        const second = await openPage();
        switchTo(second);
        generateConversationReply.mockClear();
        clock = NOW + 30_000;
        await tick();
        expect(generateConversationReply).not.toHaveBeenCalled();

        await serverFinishes(capturedPlan, 'Time to water the plants!');
        await second.data.reloadChat(ADDRESS);
        await second.finalizer.finalize(ADDRESS);
        expect(second.data.reminders(DIRECT_ID)[0].state).toBe('delivered');
    });

    test('is sent once and no more when a later attempt meets the reply of the earlier one in the chat', async () => {
        seedConversations(server, [{ ...DIRECT, settings: {}, reminders: [REMINDER] }]);
        const first = await openPage();
        switchTo(first);
        let capturedPlan;
        generateConversationReply.mockImplementation(async (_directive, _settings, { commit }) => {
            capturedPlan = commit.createPlan('raw');
            return new Promise(() => {});
        });
        void checkConversationReminders(NOW);
        await new Promise(resolve => setTimeout(resolve, 20));
        await first.data.flush({ keepalive: true });
        await serverFinishes(capturedPlan, 'Time to water the plants!');

        // A page that does not know of the finalizer's mark (the reminder is still scheduled) finds the reply in the chat.
        const second = await openPage();
        switchTo(second);
        generateConversationReply.mockClear();
        clock = NOW + 2 * MINUTE;

        await expect(checkConversationReminders(clock)).resolves.toBe(true);

        expect(generateConversationReply).not.toHaveBeenCalled();
        expect(second.data.reminders(DIRECT_ID)[0].state).toBe('delivered');
        expect(repliesOf(second)).toHaveLength(1);
    });
});
