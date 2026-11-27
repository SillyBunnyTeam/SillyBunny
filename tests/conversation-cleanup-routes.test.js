/* global globalThis */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createCardPng, createV2Card } from './util/card-corpus.js';
import { startCharacterRouter } from './util/character-router-harness.js';
import { header, line } from './util/conversation-store-sandbox.js';

const { createConversation, readCharacterState, readConversation, loadChat, updateCharacterState } = await import('../src/conversation-store.js');
const { conversationIndex } = await import('../src/conversation-index.js');

const CARD = createCardPng(createV2Card());
const PERSONA = 'persona-one.png';

/** Seeds one conversation with one chat of two lines. */
function seed(user, id, kind, characters, extra = {}) {
    return createConversation(user, {
        id,
        kind,
        personaId: PERSONA,
        characters,
        chats: [{ id: 'main', name: 'Main', records: [header(), line('u1', 'Hello', { user: true }), { ...line('c1', 'Hi', { minute: 1 }), role: 'member', extra: { member_avatar: characters[0] } }] }],
        ...extra,
    }).conversation;
}

describe('the character routes call the conversation store', () => {
    let harness;
    let user;
    let previousDataRoot;

    beforeAll(async () => {
        harness = await startCharacterRouter('sillybunny-conversation-cleanup-', { requestTimeoutMs: 10_000 });
    });

    beforeEach(() => {
        harness.reset();
        previousDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = harness.root;
        harness.directories.conversations = path.join(harness.root, 'conversations');
        fs.mkdirSync(harness.directories.conversations);
        user = { profile: { handle: 'cleanup-routes-user' }, directories: harness.directories };
        fs.writeFileSync(path.join(harness.directories.characters, 'Probe.png'), CARD);
        fs.writeFileSync(path.join(harness.directories.characters, 'Other.png'), CARD);
        for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        conversationIndex.close();
        globalThis.DATA_ROOT = previousDataRoot;
        harness.remove();
    });

    afterAll(async () => {
        await harness.close();
    });

    const post = (route, body) => harness.postJson(`/api/characters/${route}`, body);
    const conversationFolders = () => fs.readdirSync(harness.directories.conversations).filter(name => name.startsWith('conv_'));

    describe('POST /api/characters/delete', () => {
        test('with delete_chats, deletes the direct conversations of the card and takes it out of the groups', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
            seed(user, 'conv_2_other', 'direct', ['Other.png']);
            seed(user, 'conv_3_trio', 'group', ['Probe.png', 'Other.png', 'Third.png']);
            updateCharacterState(user, 'Probe.png', { statusOverride: 'dnd' });

            const answer = await post('delete', { avatar_url: 'Probe.png', delete_chats: true });

            expect(answer.status).toBe(200);
            expect(fs.existsSync(path.join(harness.directories.characters, 'Probe.png'))).toBe(false);
            expect(conversationFolders().sort()).toEqual(['conv_2_other', 'conv_3_trio']);
            expect(readConversation(user, 'conv_3_trio').characters).toEqual(['Other.png', 'Third.png']);
            expect(readCharacterState(user).characters).toEqual({});
        });

        test('with delete_chats, converts a group of two into the direct conversation of the other card', async () => {
            seed(user, 'conv_1_duoo', 'group', ['Probe.png', 'Other.png'], { name: 'Duo' });

            expect((await post('delete', { avatar_url: 'Probe.png', delete_chats: true })).status).toBe(200);

            const [id] = conversationFolders();
            expect(id).not.toBe('conv_1_duoo');
            expect(readConversation(user, id)).toMatchObject({ kind: 'direct', characters: ['Other.png'] });
        });

        test.each([
            ['without delete_chats', {}],
            ['with delete_chats false', { delete_chats: false }],
        ])('%s, changes no conversation', async (_name, extra) => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
            seed(user, 'conv_3_trio', 'group', ['Probe.png', 'Other.png', 'Third.png']);

            expect((await post('delete', { avatar_url: 'Probe.png', ...extra })).status).toBe(200);

            expect(conversationFolders().sort()).toEqual(['conv_1_direct', 'conv_3_trio']);
            expect(readConversation(user, 'conv_3_trio').characters).toEqual(['Probe.png', 'Other.png', 'Third.png']);
        });

        test('changes no conversation when the card does not exist or the name is not an avatar', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);

            expect((await post('delete', { avatar_url: 'Missing.png', delete_chats: true })).status).toBe(400);
            expect((await post('delete', { avatar_url: '../Probe.png', delete_chats: true })).status).toBeGreaterThanOrEqual(400);

            expect(conversationFolders()).toEqual(['conv_1_direct']);
        });

        test('still deletes the card and answers 200 when a conversation cannot be deleted', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
            const remove = fs.rmSync;
            jest.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
                if (String(target).endsWith('conv_1_direct')) {
                    throw new Error('disk exploded');
                }
                return remove(target, ...rest);
            });

            const answer = await post('delete', { avatar_url: 'Probe.png', delete_chats: true });

            expect(answer.status).toBe(200);
            expect(fs.existsSync(path.join(harness.directories.characters, 'Probe.png'))).toBe(false);
        });

        test('keeps the conversations when the card cannot be deleted', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
            const unlink = fs.unlinkSync;
            jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
                if (String(target).endsWith('Probe.png')) {
                    throw new Error('locked');
                }
                return unlink(target);
            });

            expect((await post('delete', { avatar_url: 'Probe.png', delete_chats: true })).status).toBe(500);

            expect(conversationFolders()).toEqual(['conv_1_direct']);
        });
    });

    describe('POST /api/characters/rename', () => {
        test('renames the card in the conversations, in the state of characters and on the lines that it wrote', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
            seed(user, 'conv_3_trio', 'group', ['Probe.png', 'Other.png']);
            updateCharacterState(user, 'Probe.png', { statusOverride: 'dnd' });

            const answer = await post('rename', { avatar_url: 'Probe.png', new_name: 'Renamed' });

            expect(answer).toEqual({ status: 200, body: { avatar: 'Renamed.png' } });
            expect(readConversation(user, 'conv_1_direct').characters).toEqual(['Renamed.png']);
            expect(readConversation(user, 'conv_3_trio').characters).toEqual(['Renamed.png', 'Other.png']);
            expect(loadChat(user, 'conv_3_trio', 'main')[2].extra.member_avatar).toBe('Renamed.png');
            expect(readCharacterState(user).characters).toEqual({ 'Renamed.png': { statusOverride: 'dnd' } });
        });

        test('still renames the card and answers with the new name when a conversation cannot be changed', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);
            const rename = fs.renameSync;
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (String(to).endsWith(path.join('conv_1_direct', 'conversation.json'))) {
                    throw new Error('disk exploded');
                }
                return rename(from, to);
            });

            const answer = await post('rename', { avatar_url: 'Probe.png', new_name: 'Renamed' });

            expect(answer).toEqual({ status: 200, body: { avatar: 'Renamed.png' } });
            expect(fs.existsSync(path.join(harness.directories.characters, 'Renamed.png'))).toBe(true);
        });

        test('changes no conversation when the rename is refused', async () => {
            seed(user, 'conv_1_direct', 'direct', ['Probe.png']);

            expect((await post('rename', { avatar_url: 'Probe.png', new_name: 5 })).status).toBe(400);

            expect(readConversation(user, 'conv_1_direct').characters).toEqual(['Probe.png']);
        });
    });
});
