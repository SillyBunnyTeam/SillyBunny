import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { createRoundResumer } from '../public/scripts/sillybunny-conversation/round-resume.js';
import { createRoundMemory } from '../public/scripts/sillybunny-conversation/rounds.js';
import { createFakeLocks } from './util/fake-web-locks.js';
import { seedConversations, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters, PERSONA } from './util/conversation-store-sandbox.js';

const GROUP_ID = 'conv_2_group001';
const DIRECT_ID = 'conv_1_direct01';
const ADDRESS = { conversationId: GROUP_ID, chatId: 'main' };
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const MINUTE = 60_000;

let server;
let tabs;
let locks;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png', 'Pip.png']);
    tabs = [];
    locks = createFakeLocks();
});

afterEach(async () => {
    for (const tab of tabs) {
        tab.destroy();
    }
    await server.stop();
});

const line = (id, role, text, extra = {}) => ({
    record: { id, role, name: role === 'user' ? 'You' : 'Nova', is_user: role === 'user', is_system: false, mes: text, send_date: new Date(NOW).toISOString(), created_at: NOW - 1000, extra },
});
const marker = (overrides = {}) => ({ remaining: ['Orion.png'], started: NOW - 5 * MINUTE, triggers: ['u1'], ...overrides });

const GROUP = (messages = [line('g1', 'character', 'Hi.'), line('u1', 'user', 'hello'), line('c1', 'character', 'one', { conversation_round: marker() })]) => ({
    id: GROUP_ID,
    kind: 'group',
    characters: ['Nova.png', 'Orion.png'],
    chats: [{ id: 'main', messages, readThrough: 'c1' }],
});

async function openPage(options = {}) {
    const data = createConversationData(server.adapter());
    tabs.push(data);
    await data.start();
    await data.loadChat(ADDRESS);
    const enqueue = jest.fn(() => Promise.resolve());
    const resumer = createRoundResumer({
        data,
        enqueue,
        getLocks: () => locks,
        now: () => NOW,
        getPersonaId: () => PERSONA,
        getAnchor: view => view.characters[0],
        hasQueuedReply: () => false,
        rounds: createRoundMemory(),
        ...options,
    });
    return { data, enqueue, resumer };
}

describe('a round that is cut off when a page opens the chat', () => {
    test('is carried on by a queue item for the members that remain, with the messages that the round answers and the start that it had', async () => {
        seedConversations(server, [GROUP()]);
        const { enqueue, resumer } = await openPage();

        await expect(resumer.resume(ADDRESS)).resolves.toBe(true);

        expect(enqueue).toHaveBeenCalledTimes(1);
        const [item] = enqueue.mock.calls[0];
        expect(item).toMatchObject({
            avatar: 'Nova.png',
            chatId: 'main',
            groupId: GROUP_ID,
            conversationKey: GROUP_ID,
            personaId: PERSONA,
            messageIds: ['u1'],
            coalesced: true,
            force: false,
            round: { remaining: ['Orion.png'], started: NOW - 5 * MINUTE },
        });
        expect(item.messageRevisions).toHaveLength(1);
        expect(item.messageRevisions[0].messageId).toBe('u1');
    });

    test('is carried on once per page: the same round is not started again by a later load, a conflict or a reload', async () => {
        seedConversations(server, [GROUP()]);
        const { enqueue, resumer } = await openPage();

        await resumer.resume(ADDRESS);
        await expect(resumer.resume(ADDRESS)).resolves.toBe(false);

        expect(enqueue).toHaveBeenCalledTimes(1);
    });

    test('is not carried on by the page that ran it live, which noted its start', async () => {
        seedConversations(server, [GROUP()]);
        const rounds = createRoundMemory();
        const { enqueue, resumer } = await openPage({ rounds });
        rounds.note(NOW - 5 * MINUTE);

        await expect(resumer.resume(ADDRESS)).resolves.toBe(false);

        expect(enqueue).not.toHaveBeenCalled();
    });

    test('is not carried on after 30 minutes', async () => {
        seedConversations(server, [GROUP([line('u1', 'user', 'hello'), line('c1', 'character', 'one', { conversation_round: marker({ started: NOW - 31 * MINUTE }) })])]);
        const stale = await openPage();
        await expect(stale.resumer.resume(ADDRESS)).resolves.toBe(false);
    });

    test('is not carried on when somebody wrote after the marker', async () => {
        seedConversations(server, [GROUP([line('u1', 'user', 'hello'), line('c1', 'character', 'one', { conversation_round: marker() }), line('c2', 'character', 'two')])]);
        const { enqueue, resumer } = await openPage();

        await expect(resumer.resume(ADDRESS)).resolves.toBe(false);

        expect(enqueue).not.toHaveBeenCalled();
    });

    test('is not carried on for another persona, in a direct conversation, or while a reply of this chat waits in the queue', async () => {
        seedConversations(server, [GROUP()]);
        const other = await openPage({ getPersonaId: () => 'someone-else.png' });
        await expect(other.resumer.resume(ADDRESS)).resolves.toBe(false);

        const queued = await openPage({ hasQueuedReply: () => true });
        await expect(queued.resumer.resume(ADDRESS)).resolves.toBe(false);
        expect(queued.enqueue).not.toHaveBeenCalled();
    });

    test('is not carried on in a direct conversation', async () => {
        seedConversations(server, [{ id: DIRECT_ID, characters: ['Nova.png'], chats: [{ id: 'main', messages: [line('u1', 'user', 'hello'), line('c1', 'character', 'one', { conversation_round: marker() })] }] }]);
        const data = createConversationData(server.adapter());
        tabs.push(data);
        await data.start();
        await data.loadChat({ conversationId: DIRECT_ID, chatId: 'main' });
        const enqueue = jest.fn(() => Promise.resolve());
        const resumer = createRoundResumer({ data, enqueue, getLocks: () => locks, now: () => NOW, getPersonaId: () => PERSONA, getAnchor: view => view.characters[0], hasQueuedReply: () => false, rounds: createRoundMemory() });

        await expect(resumer.resume({ conversationId: DIRECT_ID, chatId: 'main' })).resolves.toBe(false);

        expect(enqueue).not.toHaveBeenCalled();
    });

    test('is not carried on for a chat that is not loaded, or after the conversation went away', async () => {
        seedConversations(server, [GROUP()]);
        const { data, enqueue, resumer } = await openPage();

        await expect(resumer.resume({ conversationId: GROUP_ID, chatId: 'other' })).resolves.toBe(false);
        await data.deleteConversation(GROUP_ID);
        await expect(resumer.resume(ADDRESS)).resolves.toBe(false);

        expect(enqueue).not.toHaveBeenCalled();
    });
});

describe('two pages that open the chat', () => {
    test('start the round once under a Web Lock, which the first page holds until its reply is done', async () => {
        seedConversations(server, [GROUP()]);
        let finishFirst;
        const first = await openPage({ enqueue: jest.fn(() => new Promise((resolve) => { finishFirst = resolve; })) });
        const second = await openPage();

        const started = first.resumer.resume(ADDRESS);
        await new Promise(resolve => setImmediate(resolve));
        await expect(second.resumer.resume(ADDRESS)).resolves.toBe(false);
        finishFirst();

        await expect(started).resolves.toBe(true);
        expect(second.enqueue).not.toHaveBeenCalled();
    });

    test('can both carry it on where there are no Web Locks, which is the gap that the lock exists to close', async () => {
        seedConversations(server, [GROUP()]);
        locks = undefined;
        const first = await openPage();
        const second = await openPage();

        await first.resumer.resume(ADDRESS);
        await second.resumer.resume(ADDRESS);

        expect(first.enqueue).toHaveBeenCalledTimes(1);
        expect(second.enqueue).toHaveBeenCalledTimes(1);
    });
});
