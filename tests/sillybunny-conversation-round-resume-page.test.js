import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters, PERSONA } from './util/conversation-store-sandbox.js';

let data;
const conversationData = new Proxy({}, { get: (_target, key) => data[key] });
const enqueueConversationReply = jest.fn(async () => {});
const finalizePendingReplies = jest.fn(async () => []);
const sendQueue = [];
const cards = new Set(['Orion.png']);

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/send-queue.js', () => ({ enqueueConversationReply }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({ getConversationPersonaId: () => PERSONA }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: avatar => (cards.has(avatar) ? { avatar } : null) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/reply-finalizer-browser.js', () => ({ finalizePendingReplies }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ sendQueue }));

const { installRoundResume } = await import('../public/scripts/sillybunny-conversation/round-resume-browser.js');
const { roundMemory } = await import('../public/scripts/sillybunny-conversation/rounds.js');

const ADDRESS = { conversationId: 'conv_2_group001', chatId: 'main' };
let server;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png']);
    enqueueConversationReply.mockClear();
    finalizePendingReplies.mockClear();
    sendQueue.length = 0;
    roundMemory.clear();
});

afterEach(async () => {
    data?.destroy();
    await server.stop();
});

const now = Date.now();
const record = (id, role, extra = {}) => ({ record: { id, role, name: 'x', is_user: role === 'user', is_system: false, mes: id, send_date: new Date(now).toISOString(), created_at: now - 1000, extra } });

async function startData(extra = {}) {
    seedConversations(server, [{ id: ADDRESS.conversationId, kind: 'group', characters: ['Nova.png', 'Orion.png'], chats: [{ id: 'main', messages: [record('u1', 'user'), record('c1', 'character', { conversation_round: { remaining: ['Orion.png'], started: now - 60_000, triggers: ['u1'], ...extra } })], readThrough: 'c1' }] }]);
    data = createConversationData(server.adapter());
    await data.start();
}

describe('the round resumer of this page', () => {
    // The hook is installed once per page and listens on the data module that exists then, so one test runs the whole path.
    test('carries a cut-off round on when the data module reads the chat, after the replies of the server are landed, anchored on the first member that has a card', async () => {
        await startData();
        installRoundResume();
        installRoundResume();

        await data.loadChat(ADDRESS);
        await settle();

        expect(finalizePendingReplies).toHaveBeenCalledWith(ADDRESS);
        expect(enqueueConversationReply).toHaveBeenCalledTimes(1);
        const [item] = enqueueConversationReply.mock.calls[0];
        expect(item).toMatchObject({ avatar: 'Orion.png', groupId: ADDRESS.conversationId, chatId: 'main', personaId: PERSONA, coalesced: true, round: { remaining: ['Orion.png'] } });
    });
});

describe('the wiring of the mode', () => {
    test('installs the hook when the mode starts', async () => {
        const { readFileSync } = await import('node:fs');
        expect(readFileSync(new URL('../public/scripts/sillybunny-conversation/init.js', import.meta.url), 'utf8')).toContain('installRoundResume();');
    });
});
