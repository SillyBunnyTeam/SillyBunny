/* global globalThis */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createConversationData } from '../public/scripts/sillybunny-conversation/conversation-data.js';
import { seedConversations, settle, startConversationServer } from './util/conversation-data-fixture.js';
import { pendingReply } from './util/conversation-pending-reply.js';
import { addCharacters, PERSONA } from './util/conversation-store-sandbox.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relative => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n');

let data;
const conversationData = new Proxy({}, { get: (_target, key) => data[key] });
const cleanUpMessage = jest.fn(({ getMessage }) => `clean(${getMessage})`);
const removeReasoningFromString = jest.fn(text => `profile(${text})`);
const commitCharacterReplyCommands = jest.fn();
const generateSelfieFromContext = jest.fn(async () => true);
const afterIncomingMessage = jest.fn();
const getSettings = jest.fn(() => ({ schedule_command_enabled: true, selfie_command_enabled: true }));
const getConversationMemberSettings = jest.fn((_avatar, host) => ({ ...host, member: true }));

await jest.unstable_mockModule('../public/script.js', () => ({ cleanUpMessage, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
await jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({ removeReasoningFromString }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-store.js', () => ({
    buildConversationMessageReplyReference: message => ({ messageId: message.id, name: message.name, role: message.role, text: message.mes }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({
    commitCharacterReplyCommands,
    generateSelfieFromContext,
    getConversationReplySpeakers: (anchorAvatar, fallback) => [fallback, { avatar: 'Orion.png', name: 'Orion' }],
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/members.js', () => ({ getConversationMemberSettings }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/message-writer.js', () => ({ afterIncomingMessage }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings }));

const { cleanUpServerReply, finalizePendingReplies, installReplyFinalizer, wasReplyLanded } = await import('../public/scripts/sillybunny-conversation/reply-finalizer-browser.js');

let server;
let fetchCalls;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
    server = await startConversationServer();
    addCharacters(server.user, ['Nova.png', 'Orion.png']);
    for (const mock of [cleanUpMessage, removeReasoningFromString, commitCharacterReplyCommands, generateSelfieFromContext, afterIncomingMessage, getSettings, getConversationMemberSettings]) {
        mock.mockClear();
    }
    fetchCalls = [];
    // The data module talks to the throwaway server over `fetch`, so only the page's own call is caught.
    globalThis.fetch = jest.fn(async (url, init) => {
        if (String(url).startsWith('/api/')) {
            fetchCalls.push({ url, init });
            return { ok: true, json: async () => ({}) };
        }
        return originalFetch(url, init);
    });
});

afterEach(async () => {
    globalThis.fetch = originalFetch;
    data?.destroy();
    data = undefined;
    await server.stop();
});

async function startData(descriptors) {
    seedConversations(server, descriptors);
    data = createConversationData({ ...server.adapter(), fetchJson: server.adapter().fetchJson });
    await data.start();
}

const ADDRESS = { conversationId: 'conv_1_direct01', chatId: 'main' };
const GROUP_ADDRESS = { conversationId: 'conv_2_group001', chatId: 'main' };

describe('the clean-up of a reply that the server wrote', () => {
    test('is the clean-up that generateRaw() applies for a reply of the raw route, with the arguments of a Conversation reply', () => {
        const source = readSource('public/script.js');
        const generateRaw = source.slice(source.indexOf('export async function generateRaw('));
        const literal = text => Object.fromEntries([...text.matchAll(/^\s*(\w+): ([^,\n]+),?$/gm)].map(([, key, value]) => [key, value.trim()]));
        const rawCall = literal(generateRaw.slice(generateRaw.indexOf('cleanUpMessage({'), generateRaw.indexOf('});', generateRaw.indexOf('cleanUpMessage({'))));
        // generateConversationReply() passes trimNames: true, which generateRaw() spreads over two arguments.
        const expected = { ...rawCall, trimNames: 'true', trimWrongNames: 'true' };
        delete expected.getMessage;

        cleanUpServerReply('raw', 'some text');

        const [{ getMessage, ...given }] = cleanUpMessage.mock.calls[0];
        expect(getMessage).toBe('some text');
        expect(Object.fromEntries(Object.entries(given).map(([key, value]) => [key, String(value)]))).toEqual(expected);
    });

    test('is only the removal of the reasoning for a reply that came through a connection profile', () => {
        expect(cleanUpServerReply('profile', 'some text')).toBe('profile(some text)');
        expect(cleanUpMessage).not.toHaveBeenCalled();
    });
});

describe('the finalizer of this page', () => {
    test('lands a pending reply of a direct conversation with the settings of the conversation, and acknowledges it to the server', async () => {
        const pending = pendingReply({ text: 'Later [reminder: 15m | tea]\n\nsecond', route: 'raw', generationId: 'gen-9', triggers: ['main-1'] });
        await startData([{ id: ADDRESS.conversationId, characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello', 'hi there', { record: pending }] }] }]);
        await data.loadChat(ADDRESS);

        const landed = await finalizePendingReplies(ADDRESS);

        expect(landed).toHaveLength(1);
        expect(cleanUpMessage).toHaveBeenCalledTimes(1);
        expect(data.chat(ADDRESS).messages.slice(2).map(message => message.mes)).toEqual(['clean(Later', 'second)']);
        expect(getSettings).toHaveBeenCalledWith('Nova.png', { groupId: '', personaId: PERSONA });
        expect(afterIncomingMessage).toHaveBeenCalledTimes(2);
        expect(commitCharacterReplyCommands).toHaveBeenCalledTimes(1);
        expect(commitCharacterReplyCommands.mock.calls[0][2]).toMatchObject({ reminderAvatar: 'Nova.png', reminderIdPrefix: `rem_${pending.id}_g0` });
        expect(wasReplyLanded('gen-9')).toBe(true);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe('/api/resumable-generations/acknowledge');
        expect(JSON.parse(fetchCalls[0].init.body)).toEqual({ ids: ['gen-9'] });
    });

    test('reads the names of the members at the start of a line in a group, with the settings of the member that speaks', async () => {
        cleanUpMessage.mockImplementation(({ getMessage }) => getMessage);
        const pending = pendingReply({ text: 'Nova: hi\nOrion: yo', route: 'raw', speaker: 'Nova.png', anchor: 'Nova.png', triggers: ['main-1'] });
        await startData([{ id: GROUP_ADDRESS.conversationId, kind: 'group', characters: ['Nova.png', 'Orion.png'], chats: [{ id: 'main', messages: ['hello', 'hi there', { record: pending }] }] }]);
        await data.loadChat(GROUP_ADDRESS);

        await finalizePendingReplies(GROUP_ADDRESS);

        expect(data.chat(GROUP_ADDRESS).messages.slice(2).map(message => [message.name, message.mes])).toEqual([['Nova', 'hi'], ['Orion', 'yo']]);
        expect(getSettings).toHaveBeenCalledWith('Nova.png', { groupId: GROUP_ADDRESS.conversationId, personaId: PERSONA });
    });

    test('uses the settings of the member for a member that speaks in a direct conversation', async () => {
        cleanUpMessage.mockImplementation(({ getMessage }) => getMessage);
        const pending = pendingReply({ text: 'from an extra', route: 'raw', speaker: 'Orion.png', anchor: 'Nova.png', name: 'Orion', triggers: ['main-1'] });
        await startData([{ id: ADDRESS.conversationId, characters: ['Nova.png'], extras: ['Orion.png'], chats: [{ id: 'main', messages: ['hello', 'hi there', { record: pending }] }] }]);
        await data.loadChat(ADDRESS);

        await finalizePendingReplies(ADDRESS);

        expect(getConversationMemberSettings).toHaveBeenCalledWith('Orion.png', expect.any(Object), { groupId: '', personaId: PERSONA });
        expect(data.chat(ADDRESS).messages.at(-1)).toMatchObject({ role: 'member', name: 'Orion', extra: { member_avatar: 'Orion.png' } });
    });

    test('lands the replies of a chat as soon as the data module reads it, when the hook is installed, whoever loaded the chat', async () => {
        cleanUpMessage.mockImplementation(({ getMessage }) => getMessage);
        const pending = pendingReply({ text: 'one', route: 'raw', triggers: ['main-1'] });
        await startData([{ id: ADDRESS.conversationId, characters: ['Nova.png'], chats: [{ id: 'main', messages: ['hello', 'hi there', { record: pending }] }] }]);
        installReplyFinalizer();
        installReplyFinalizer();

        await data.loadChat(ADDRESS);
        await settle();

        expect(data.chat(ADDRESS).messages.map(message => message.id)).toEqual(['main-0', 'main-1', `${pending.id}.0`]);
        expect(afterIncomingMessage).toHaveBeenCalledTimes(1);
    });
});

describe('the wiring of the mode', () => {
    test('installs the hook when the mode starts', () => {
        expect(readSource('public/scripts/sillybunny-conversation/runtime.js')).toContain('installReplyFinalizer();');
    });
});
