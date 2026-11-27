import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';
import { addCharacters, PERSONA } from './util/conversation-store-sandbox.js';

let data;
const chatReadListeners = [];
const conversationData = new Proxy({}, {
    get: (_target, key) => {
        if (key === 'onChatRead') {
            return (listener) => {
                chatReadListeners.push(listener);
                return data?.onChatRead(listener);
            };
        }
        return data[key];
    },
});
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
    finalizePendingReplies.mockReset().mockResolvedValue([]);
    sendQueue.length = 0;
    roundMemory.clear();
});

afterEach(async () => {
    data?.destroy();
    await server.stop();
});

const now = Date.now();
const record = (id, role, extra = {}) => ({ record: { id, role, name: 'x', is_user: role === 'user', is_system: false, mes: id, send_date: new Date(now).toISOString(), created_at: now - 1000, extra } });

async function startData(extra = {}, messages = null) {
    const seededMessages = messages ?? [record('u1', 'user'), record('c1', 'character', { conversation_round: { remaining: ['Orion.png'], started: now - 60_000, triggers: ['u1'], ...extra } })];
    seedConversations(server, [{ id: ADDRESS.conversationId, kind: 'group', characters: ['Nova.png', 'Orion.png'], chats: [{ id: 'main', messages: seededMessages, readThrough: 'u1' }] }]);
    data = createConversationData(server.adapter());
    chatReadListeners.forEach(listener => data.onChatRead(listener));
    await data.start();
}

describe('the round resumer of this page', () => {
    test('carries a cut-off round on when the data module reads the chat, after the replies of the server are landed, anchored on the first member that has a card', async () => {
        await startData();
        installRoundResume();
        installRoundResume();

        await data.loadChat(ADDRESS);
        await settle();

        expect(chatReadListeners).toHaveLength(1);
        expect(finalizePendingReplies).toHaveBeenCalledWith(ADDRESS);
        expect(enqueueConversationReply).toHaveBeenCalledTimes(1);
        const [item] = enqueueConversationReply.mock.calls[0];
        expect(item).toMatchObject({ avatar: 'Orion.png', groupId: ADDRESS.conversationId, chatId: 'main', personaId: PERSONA, coalesced: true, round: { remaining: ['Orion.png'] } });
    });

    test('falls back to the landed reply round marker when Speaker 1 produced a reaction-only turn with no bubbles', async () => {
        const started = Date.now() - 60_000;
        await startData({}, [record('u1', 'user', { conversation_reactions: [{ emoji: '👍', by: 'Nova.png', at: started }] })]);
        installRoundResume();
        finalizePendingReplies.mockResolvedValueOnce([{
            reply: {
                generationId: 'gen-react-1',
                token: '1111222233334444',
                origin: 'reply',
                route: 'raw',
                speaker: 'Nova.png',
                anchor: 'Nova.png',
                round: ['Orion.png'],
                roundStarted: started,
                triggers: ['u1'],
                target: null,
                reminder: '',
            },
            bubbleIds: [],
        }]);

        await data.loadChat(ADDRESS);
        await settle();

        expect(enqueueConversationReply).toHaveBeenCalledTimes(1);
        const [item] = enqueueConversationReply.mock.calls[0];
        expect(item).toMatchObject({ avatar: 'Orion.png', groupId: ADDRESS.conversationId, chatId: 'main', personaId: PERSONA, coalesced: true, messageIds: ['u1'], round: { remaining: ['Orion.png'], started } });
    });

    test('does not resume a reaction-only landed reply whose round is older than 30 minutes', async () => {
        const expired = Date.now() - 31 * 60_000;
        await startData({}, [record('u1', 'user')]);
        installRoundResume();
        finalizePendingReplies.mockResolvedValueOnce([{
            reply: {
                generationId: 'gen-react-old',
                token: '5555666677778888',
                origin: 'reply',
                route: 'raw',
                speaker: 'Nova.png',
                anchor: 'Nova.png',
                round: ['Orion.png'],
                roundStarted: expired,
                triggers: ['u1'],
                target: null,
                reminder: '',
            },
            bubbleIds: [],
        }]);

        await data.loadChat(ADDRESS);
        await settle();

        expect(enqueueConversationReply).not.toHaveBeenCalled();
    });
});

describe('the wiring of the mode', () => {
    test('installs the hook when the mode starts', async () => {
        const { readFileSync } = await import('node:fs');
        expect(readFileSync(new URL('../public/scripts/sillybunny-conversation/runtime.js', import.meta.url), 'utf8')).toContain('installRoundResume();');
    });
});
