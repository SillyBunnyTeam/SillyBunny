import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { ChatNotLoadedError, createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { isPendingServerReply } from '../public/scripts/sillybunny-conversation/pending-reply.js';
import { createReplyFinalizer } from '../public/scripts/sillybunny-conversation/reply-finalizer.js';
import { createFakeLocks } from './util/fake-web-locks.js';
import { seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { pendingReply } from './util/conversation-pending-reply.js';
import { addCharacters, PERSONA } from './util/conversation-store-sandbox.js';

const DIRECT_ID = 'conv_1_direct01';
const GROUP_ID = 'conv_2_group001';
const ADDRESS = { conversationId: DIRECT_ID, chatId: 'main' };
const GROUP_ADDRESS = { conversationId: GROUP_ID, chatId: 'main' };
const COMMANDS_ON = { schedule_command_enabled: true, selfie_command_enabled: true };

let server;
let tabs;
let locks;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png']);
    tabs = [];
    locks = createFakeLocks();
});

afterEach(async () => {
    for (const tab of tabs) {
        tab.destroy();
    }
    await server.stop();
});

/** What the page gives the finalizer, as spies. */
function makePage(overrides = {}) {
    return {
        context: jest.fn((view, reply) => ({
            anchorAvatar: reply.anchor || view.characters[0],
            groupId: view.kind === 'group' ? view.id : '',
            personaId: view.personaId,
            speakersFor: fallback => (view.kind === 'group' ? [fallback, ...view.characters.map(avatar => ({ avatar, name: avatar.replace('.png', '') }))] : []),
            settingsFor: () => COMMANDS_ON,
        })),
        cleanUpText: jest.fn((_route, text) => text),
        buildReference: jest.fn(message => ({ messageId: message.id, name: message.name, role: message.role, text: message.mes })),
        afterIncoming: jest.fn(),
        runCommands: jest.fn(),
        makeSelfie: jest.fn(async () => true),
        acknowledge: jest.fn(),
        ...overrides,
    };
}

/** One page: its own data module on the shared server, and its own finalizer. */
async function openPage(page = makePage(), options = {}) {
    const data = createConversationData(server.adapter());
    tabs.push(data);
    await data.start();
    const finalizer = createReplyFinalizer({ data, page, getLocks: () => locks, ...options });
    return { data, page, finalizer };
}

const DIRECT = (record, extraMessages = []) => ({ id: DIRECT_ID, characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello', 'hi there', ...extraMessages, { record }], readThrough: 'main-1' }] });
const GROUP = record => ({ id: GROUP_ID, kind: 'group', characters: ['Nova.png', 'Orion.png'], chats: [{ id: 'main', messages: ['hello', 'hi there', { record }], readThrough: 'main-1' }] });

const ids = data => data.chat(ADDRESS).messages.map(message => message.id);
const byId = (data, id, address = ADDRESS) => data.chat(address).messages.find(message => message.id === id);

async function serverChat(address = ADDRESS) {
    const reader = createConversationData(server.adapter());
    tabs.push(reader);
    await reader.start();
    await reader.loadChat(address);
    return reader.chat(address).messages;
}

describe('landing a pending reply', () => {
    test('replaces the pending message with its bubbles, in its place, and saves them', async () => {
        const pending = pendingReply({ text: 'one\n\ntwo', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        const landed = await finalizer.finalize(ADDRESS);

        expect(ids(data)).toEqual(['main-0', 'main-1', `${pending.id}.0`, `${pending.id}.1`]);
        expect(data.chat(ADDRESS).messages.some(isPendingServerReply)).toBe(false);
        expect((await serverChat()).map(message => message.id)).toEqual(ids(data));
        expect(landed).toHaveLength(1);
        expect(landed[0]).toMatchObject({ bubbleIds: [`${pending.id}.0`, `${pending.id}.1`] });
    });

    test('gives the first bubble a reply card for the message that the reply answers, and every bubble the token', async () => {
        const pending = pendingReply({ text: 'one\n\ntwo', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);

        expect(byId(data, `${pending.id}.0`).extra).toMatchObject({ conversation_mode_reply: true, conversation_reply_to: { messageId: 'main-1' }, reply_token: pending.extra.reply_token });
        expect(byId(data, `${pending.id}.1`).extra).not.toHaveProperty('conversation_reply_to');
        expect(byId(data, `${pending.id}.1`).extra.reply_token).toBe(pending.extra.reply_token);
    });

    test('gives each line of a group reply to the member whose name starts it', async () => {
        const pending = pendingReply({ text: 'Nova: hi\nOrion: yo', speaker: 'Nova.png', anchor: 'Nova.png', name: 'Nova', triggers: ['main-1'] });
        seedConversations(server, [GROUP(pending)]);
        const { data, finalizer } = await openPage();
        await data.loadChat(GROUP_ADDRESS);

        await finalizer.finalize(GROUP_ADDRESS);

        const bubbles = data.chat(GROUP_ADDRESS).messages.slice(2);
        expect(bubbles.map(bubble => [bubble.name, bubble.role, bubble.mes, bubble.extra.member_avatar])).toEqual([
            ['Nova', 'character', 'hi', undefined],
            ['Orion', 'member', 'yo', 'Orion.png'],
        ]);
    });

    test('cleans the text by the route of the request, with what the page says, and splits the clean text', async () => {
        const raw = pendingReply({ text: 'RAW one\n\nRAW two', route: 'raw', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(raw)]);
        const page = makePage({ cleanUpText: jest.fn((route, text) => `${route}:${text}`.replace('RAW two', 'second')) });
        const { data, finalizer } = await openPage(page);
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);

        expect(page.cleanUpText).toHaveBeenCalledWith('raw', 'RAW one\n\nRAW two');
        expect(data.chat(ADDRESS).messages.slice(2).map(message => message.mes)).toEqual(['raw:RAW one', 'second']);
    });

    test('removes a pending message whose text is empty after the clean-up, and still acknowledges it', async () => {
        const pending = pendingReply({ text: 'only a stop string', generationId: 'g-empty', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const page = makePage({ cleanUpText: jest.fn(() => '') });
        const { data, finalizer } = await openPage(page);
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);

        expect(ids(data)).toEqual(['main-0', 'main-1']);
        expect((await serverChat()).map(message => message.id)).toEqual(['main-0', 'main-1']);
        expect(page.afterIncoming).not.toHaveBeenCalled();
        expect(page.acknowledge).toHaveBeenCalledWith(['g-empty']);
    });

    test('puts the rest of the round on the last bubble', async () => {
        const pending = pendingReply({ text: 'one\n\ntwo', round: ['Orion.png'], triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);

        const [first, last] = data.chat(ADDRESS).messages.slice(2);
        expect(first.extra).not.toHaveProperty('conversation_round');
        expect(last.extra.conversation_round).toEqual({ remaining: ['Orion.png'], started: pending.extra.server_generation.round_started, triggers: ['main-1'] });
    });
});

describe('what the page does after a reply landed', () => {
    test('runs the effects of an incoming message for each bubble, and notifies and schedules the memory summary once, for the last', async () => {
        const pending = pendingReply({ text: 'one\n\ntwo\n\nthree', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, page, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);

        expect(page.afterIncoming.mock.calls.map(([avatar, message, options]) => [avatar, message.mes, options.notify, options.scheduleMemory])).toEqual([
            ['Nova.png', 'one', false, false],
            ['Nova.png', 'two', false, false],
            ['Nova.png', 'three', true, true],
        ]);
        expect(page.afterIncoming.mock.calls[0][2]).toMatchObject({ address: ADDRESS, chatId: 'main', groupId: '', personaId: PERSONA });
    });

    test('runs a command of the reply once, and gives its reminders ids that every page derives the same way', async () => {
        const pending = pendingReply({ text: 'Later [reminder: 15m | tea]', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, page, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);

        expect(page.runCommands).toHaveBeenCalledTimes(1);
        const [commandParts, speakerAvatar, options] = page.runCommands.mock.calls[0];
        expect(commandParts.reminders).toEqual([{ delay: '15m', memo: 'tea' }]);
        expect(speakerAvatar).toBe('Nova.png');
        expect(options).toMatchObject({ chatId: 'main', groupId: '', personaId: PERSONA, reminderAvatar: 'Nova.png', reminderIdPrefix: `rem_${pending.id}_g0` });
    });

    test('asks for a selfie after the lock is let go, with the id that the picture message will have', async () => {
        const pending = pendingReply({ text: 'Look [selfie: context="beach"]', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        let lockHeldDuringSelfie = null;
        const page = makePage({
            makeSelfie: jest.fn(async () => {
                lockHeldDuringSelfie = locks.held.size > 0;
                return true;
            }),
        });
        const { data, finalizer } = await openPage(page);
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);
        await finalizer.idle();

        expect(page.makeSelfie).toHaveBeenCalledTimes(1);
        const [request, context] = page.makeSelfie.mock.calls[0];
        expect(request).toMatchObject({ id: `${pending.id}.s0`, context: 'beach', speakerAvatar: 'Nova.png' });
        expect(context).toMatchObject({ anchorAvatar: 'Nova.png', address: ADDRESS, settings: COMMANDS_ON });
        expect(lockHeldDuringSelfie).toBe(false);
    });

    test('acknowledges the generation to the server, and remembers it as landed', async () => {
        const pending = pendingReply({ text: 'hello', generationId: 'gen-42', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, page, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        expect(finalizer.wasLanded('gen-42')).toBe(false);
        await finalizer.finalize(ADDRESS);

        expect(page.acknowledge).toHaveBeenCalledWith(['gen-42']);
        expect(finalizer.wasLanded('gen-42')).toBe(true);
    });
});

describe('landing more than once', () => {
    test('finds nothing to do the second time, so that no effect runs twice', async () => {
        const pending = pendingReply({ text: 'one\n\ntwo', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, page, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);
        const before = structuredClone(data.chat(ADDRESS).messages);
        const second = await finalizer.finalize(ADDRESS);

        expect(second).toEqual([]);
        expect(data.chat(ADDRESS).messages).toEqual(before);
        expect(page.afterIncoming).toHaveBeenCalledTimes(2);
        expect(page.acknowledge).toHaveBeenCalledTimes(1);
    });

    test('lets calls that arrive together share one run, and answers each with the reply that landed', async () => {
        const pending = pendingReply({ text: 'one', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, page, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        const [first, second] = await Promise.all([finalizer.finalize(ADDRESS), finalizer.finalize(ADDRESS)]);

        expect(page.acknowledge).toHaveBeenCalledTimes(1);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect(ids(data)).toEqual(['main-0', 'main-1', `${pending.id}.0`]);
    });

    test('does nothing for a chat that is not loaded, and does not load it', async () => {
        const pending = pendingReply({ text: 'one', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, finalizer } = await openPage();

        await expect(finalizer.finalize(ADDRESS)).resolves.toEqual([]);

        expect(data.chat(ADDRESS)).toBeNull();
    });

    test('does nothing, and does not throw, when the chat goes away between the scan and the write', async () => {
        const pending = pendingReply({ text: 'one', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, page } = await openPage();
        await data.loadChat(ADDRESS);
        const vanishing = {
            ...data,
            commitChat: () => {
                throw new ChatNotLoadedError(ADDRESS);
            },
        };
        const finalizer = createReplyFinalizer({ data: vanishing, page, getLocks: () => locks });

        await expect(finalizer.finalize(ADDRESS)).resolves.toEqual([]);

        expect(page.acknowledge).not.toHaveBeenCalled();
    });
});

describe('a selfie that a reply asks for', () => {
    test('does not hold the landing: finalize() answers while the picture is still being made, so that a prompt is not kept waiting for it', async () => {
        const pending = pendingReply({ text: 'Look [selfie: context="beach"]', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        let finishSelfie;
        const page = makePage({ makeSelfie: jest.fn(() => new Promise((resolve) => { finishSelfie = resolve; })) });
        const { data, finalizer } = await openPage(page);
        await data.loadChat(ADDRESS);

        const landed = await finalizer.finalize(ADDRESS);

        expect(landed).toHaveLength(1);
        expect(page.makeSelfie).toHaveBeenCalledTimes(1);
        finishSelfie(true);
        await finalizer.idle();
    });

    test('can itself wait for the replies of the chat, because the landing that it came from is over', async () => {
        const first = pendingReply({ text: 'Look [selfie: context="beach"]', triggers: ['main-1'], token: 'aaaaaaaa11111111' });
        const second = pendingReply({ text: 'a second reply that arrived meanwhile', triggers: ['main-1'], token: 'bbbbbbbb22222222', finishedAt: first.created_at + 5000, generationId: 'gen-2' });
        seedConversations(server, [DIRECT(first)]);
        let finalizer;
        let landedFromSelfie;
        const page = makePage({
            makeSelfie: jest.fn(async () => {
                tabs[0].commitChat(ADDRESS, (draft) => {
                    draft.messages.push(second);
                });
                landedFromSelfie = await finalizer.finalize(ADDRESS);
                return true;
            }),
        });
        const opened = await openPage(page);
        finalizer = opened.finalizer;
        await opened.data.loadChat(ADDRESS);

        await finalizer.finalize(ADDRESS);
        await finalizer.idle();

        expect(landedFromSelfie).toHaveLength(1);
        expect(ids(opened.data)).toContain(`${second.id}.0`);
    });
});

describe('two pages that load the same chat', () => {
    async function twoPages() {
        const pending = pendingReply({ text: 'one\n\ntwo\n\nLook [selfie: context="beach"]', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const pages = [await openPage(), await openPage()];
        await Promise.all(pages.map(({ data }) => data.loadChat(ADDRESS)));
        return { pending, pages };
    }

    test('land it once under a Web Lock: the page that waited finds it landed, and runs no effect', async () => {
        const { pending, pages: [first, second] } = await twoPages();

        const [firstLanded, secondLanded] = await Promise.all([first.finalizer.finalize(ADDRESS), second.finalizer.finalize(ADDRESS)]);

        expect(firstLanded).toHaveLength(1);
        expect(secondLanded).toEqual([]);
        expect((await serverChat()).map(message => message.id)).toEqual(['main-0', 'main-1', `${pending.id}.0`, `${pending.id}.1`, `${pending.id}.2`]);
        expect(ids(second.data)).toEqual(ids(first.data));
        await Promise.all([first.finalizer.idle(), second.finalizer.idle()]);
        expect(second.page.afterIncoming).not.toHaveBeenCalled();
        expect(second.page.makeSelfie).not.toHaveBeenCalled();
        expect(first.page.makeSelfie).toHaveBeenCalledTimes(1);
    });

    test('leave one copy of each bubble where there are no Web Locks, because the bubbles have the ids of the pending message', async () => {
        const { pending, pages: [first, second] } = await twoPages();
        locks = undefined;

        await Promise.all([first.finalizer.finalize(ADDRESS), second.finalizer.finalize(ADDRESS)]);
        await Promise.all([first.data.flush(), second.data.flush()]);

        const expected = ['main-0', 'main-1', `${pending.id}.0`, `${pending.id}.1`, `${pending.id}.2`];
        expect((await serverChat()).map(message => message.id)).toEqual(expected);
        expect(ids(first.data)).toEqual(expected);
        expect(ids(second.data)).toEqual(expected);
    });

    test('lands the reply without a lock where the browser has the API but refuses to grant a lock (a page with an opaque origin)', async () => {
        const pending = pendingReply({ text: 'one', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        locks = { request: () => Promise.reject(Object.assign(new Error('The document\'s origin is opaque.'), { name: 'SecurityError' })) };
        const { data, finalizer } = await openPage();
        await data.loadChat(ADDRESS);

        await expect(finalizer.finalize(ADDRESS)).resolves.toHaveLength(1);

        expect(ids(data)).toEqual(['main-0', 'main-1', `${pending.id}.0`]);
    });

    test('gives up on a lock that is held too long, leaves the message pending, and lets a later call land it', async () => {
        const pending = pendingReply({ text: 'one', triggers: ['main-1'] });
        seedConversations(server, [DIRECT(pending)]);
        const { data, finalizer } = await openPage(makePage(), { lockTimeoutMs: 30 });
        await data.loadChat(ADDRESS);
        let release;
        const held = locks.request(`sb-conversation-finalize:${DIRECT_ID}:main`, () => new Promise((resolve) => {
            release = resolve;
        }));

        await expect(finalizer.finalize(ADDRESS)).resolves.toEqual([]);
        expect(data.chat(ADDRESS).messages.some(isPendingServerReply)).toBe(true);

        release();
        await held;
        await expect(finalizer.finalize(ADDRESS)).resolves.toHaveLength(1);
    });
});
