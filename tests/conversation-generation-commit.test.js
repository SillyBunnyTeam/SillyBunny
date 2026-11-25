import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createSandboxUser, header, PERSONA } from './util/conversation-store-sandbox.js';
import {
    CONTEXT,
    CONVERSATION,
    FINISHED,
    RAW_TEXT,
    REPLY,
    TOKEN,
    chatMessages,
    chatRecords,
    message,
    plan,
    revisionOf,
    settled,
    stampOf,
    startGeneration as startRegistryGeneration,
} from './util/conversation-reply-fixture.js';
import { hashCommitText, normalizeCommitPlan } from '../public/scripts/generation-commit-plan.js';

const { conversationIndex } = await import('../src/conversation-index.js');
const { createConversation, deleteChat, deleteConversation, listConversations, saveChat, updateConversation } = await import('../src/conversation-store.js');
const { applyConversationReply } = await import('../src/conversation-generation-commit.js');
const { applyGenerationReply, commitGenerationReply, revertGenerationCommit } = await import('../src/generation-commit.js');
const journal = await import('../src/generation-journal.js');
const registry = await import('../src/resumable-generations.js');

function applied(records, planned = plan(), reply = REPLY, context = CONTEXT) {
    return applyConversationReply(records, planned, reply, context);
}

describe('applyConversationReply', () => {
    test('appends one pending message that holds the speaker, the raw text and the marker', () => {
        const result = applied(chatRecords());

        expect('records' in result).toBe(true);
        expect(result.records).toHaveLength(5);
        expect(result.records[4]).toEqual({
            id: `${FINISHED.getTime()}-${TOKEN.slice(0, 8)}`,
            role: 'character',
            name: 'Nova',
            is_user: false,
            is_system: false,
            mes: RAW_TEXT,
            send_date: FINISHED.toISOString(),
            created_at: FINISHED.getTime(),
            extra: {
                reply_token: TOKEN,
                server_generation: {
                    id: 'gen-1',
                    kind: 'reply',
                    pending: true,
                    token: TOKEN,
                    origin: 'reply',
                    route: 'profile',
                    speaker: 'Nova.png',
                    anchor: 'Nova.png',
                    round: ['Orion.png'],
                    round_started: 1760000000000,
                    triggers: ['m2', 'm3'],
                    target: null,
                },
            },
        });
        expect(result.records[0]).toEqual(chatRecords()[0]);
    });

    test('gives a speaker other than the anchor the member role and its avatar', () => {
        const result = applied(chatRecords(), plan({ message: { name: 'Orion' }, reply: { speaker: 'Orion.png', anchor: 'Nova.png' } }));

        expect(result.records[4]).toMatchObject({ role: 'member', name: 'Orion', extra: { member_avatar: 'Orion.png', server_generation: { speaker: 'Orion.png', anchor: 'Nova.png' } } });
    });

    test('keeps the anchor reply free of a member avatar', () => {
        expect(applied(chatRecords()).records[4].extra).not.toHaveProperty('member_avatar');
    });

    test('keeps the text exactly as the model wrote it, and drops reasoning and extra completions', () => {
        const written = applied(chatRecords()).records[4];

        expect(written.mes).toBe(RAW_TEXT);
        expect(JSON.stringify(written)).not.toContain('Think first.');
        expect(JSON.stringify(written)).not.toContain('An extra completion.');
        expect(written).not.toHaveProperty('swipes');
    });

    test('names the explicit target of the reply in the marker', () => {
        const target = stampOf(chatMessages()[0]);

        expect(applied(chatRecords(), plan({ reply: { target } })).records[4].extra.server_generation.target).toBe('m1');
    });

    test('leaves the records it was given as they were', () => {
        const records = chatRecords();
        const before = structuredClone(records);

        applied(records);

        expect(records).toEqual(before);
    });

    test('lands after a message that the user sent while the reply was written, as the queue does', () => {
        const records = chatRecords([...chatMessages(), message('m4', 'user', 'Still waiting.', 4)]);

        const result = applied(records);

        expect(result.records.map(item => item.id)).toEqual([undefined, 'm1', 'm2', 'm3', 'm4', `${FINISHED.getTime()}-${TOKEN.slice(0, 8)}`]);
    });

    test('does not depend on how long the chat was when the plan was made', () => {
        expect('records' in applied(chatRecords(), plan({ index: 0 }))).toBe(true);
        expect('records' in applied(chatRecords(), plan({ index: 400 }))).toBe(true);
    });

    test('a trigger revision from the browser is the one the server computes, whatever a save adds to the message', () => {
        const original = chatMessages()[1];
        const stamp = stampOf(original);
        const roundTripped = JSON.parse(JSON.stringify(original));
        roundTripped.extra.reply_token = TOKEN;
        roundTripped.extra.conversation_round = { remaining: [], started: 1 };

        expect(revisionOf(roundTripped)).toBe(stamp.rev);
        expect(stamp.rev).toMatch(/^[0-9a-f]{8}$/);
    });

    test('a trigger revision is the 8-hex hash of the canonical JSON of the fields that identify a message', () => {
        const known = { id: 'm2', name: 'You', role: 'user', mes: 'Hello there.', created_at: 1, extra: {} };

        expect(revisionOf(known)).toBe(hashCommitText(JSON.stringify({
            created_at: 1,
            extra: { attachments: [], conversation_reply_to: null, files: [], image_url: '', inline_image: false, media: [], media_display: '', media_index: '', member_avatar: '' },
            id: 'm2',
            mes: 'Hello there.',
            name: 'You',
            role: 'user',
        })));
    });

    describe('refuses', () => {
        test('reply-landed: a message already carries the token of the reply', () => {
            const records = chatRecords([...chatMessages(), message('m4', 'character', 'Saved by the page.', 4, { reply_token: TOKEN })]);

            expect(applied(records)).toEqual({ reason: 'reply-landed' });
        });

        test('reply-landed: a pending message of the server carries the token', () => {
            const first = applied(chatRecords());

            expect(applied(first.records)).toEqual({ reason: 'reply-landed' });
        });

        test('reply-landed: a pending message that a page already split into bubbles leaves the token on each', () => {
            const records = chatRecords([...chatMessages(), message('m4.0', 'character', 'Hello there.', 4, { reply_token: TOKEN }), message('m4.1', 'character', 'Second.', 5, { reply_token: TOKEN })]);

            expect(applied(records)).toEqual({ reason: 'reply-landed' });
        });

        test('trigger-changed: a trigger message is gone', () => {
            const records = chatRecords(chatMessages().filter(item => item.id !== 'm3'));

            expect(applied(records)).toEqual({ reason: 'trigger-changed' });
        });

        test('trigger-changed: a trigger message was edited', () => {
            const messages = chatMessages();
            messages[1] = { ...messages[1], mes: 'Hello there, edited.' };

            expect(applied(chatRecords(messages))).toEqual({ reason: 'trigger-changed' });
        });

        test('trigger-changed: a trigger message got an attachment', () => {
            const messages = chatMessages();
            messages[2] = { ...messages[2], extra: { attachments: [{ name: 'a.png' }] } };

            expect(applied(chatRecords(messages))).toEqual({ reason: 'trigger-changed' });
        });

        test('target-changed: the explicit target is gone', () => {
            const target = stampOf(chatMessages()[0]);
            const records = chatRecords(chatMessages().filter(item => item.id !== 'm1'));

            expect(applied(records, plan({ reply: { target } }))).toEqual({ reason: 'target-changed' });
        });

        test('target-changed: the explicit target was edited', () => {
            const target = stampOf(chatMessages()[0]);
            const messages = chatMessages();
            messages[0] = { ...messages[0], mes: 'Greetings, edited.' };

            expect(applied(chatRecords(messages), plan({ reply: { target } }))).toEqual({ reason: 'target-changed' });
        });

        test.each([
            ['a user message', 'user'],
            ['a system message', 'system'],
        ])('target-changed: the explicit target is %s', (_name, role) => {
            const messages = chatMessages();
            messages[0] = message('m1', role, 'Greetings.', 1);

            expect(applied(chatRecords(messages), plan({ reply: { target: stampOf(messages[0]) } }))).toEqual({ reason: 'target-changed' });
        });

        test('no-user-message: the reply needs a user message and the chat has none', () => {
            const records = chatRecords([message('m1', 'character', 'Greetings.', 1)]);

            expect(applied(records, plan({ reply: { needs_user: true, triggers: [] } }))).toEqual({ reason: 'no-user-message' });
        });

        test('nothing: the same plan with a user message in the chat lands', () => {
            expect('records' in applied(chatRecords(), plan({ reply: { needs_user: true, triggers: [] } }))).toBe(true);
        });

        test('in the order of the rule: landed, then triggers, then target, then user message', () => {
            const messages = chatMessages().filter(item => item.id === 'm1');
            const landed = [...messages, message('m4', 'character', 'Saved by the page.', 4, { reply_token: TOKEN })];
            const stale = plan({ reply: { target: { id: 'gone', rev: '00000000' }, needs_user: true } });

            expect(applied(chatRecords(landed), stale)).toEqual({ reason: 'reply-landed' });
            expect(applied(chatRecords(messages), stale)).toEqual({ reason: 'trigger-changed' });
            expect(applied(chatRecords(messages), plan({ reply: { target: { id: 'gone', rev: '00000000' }, needs_user: true, triggers: [] } }))).toEqual({ reason: 'target-changed' });
            expect(applied(chatRecords(messages), plan({ reply: { needs_user: true, triggers: [] } }))).toEqual({ reason: 'no-user-message' });
        });
    });
});

describe('applyGenerationReply', () => {
    test('hands a conversation plan to the conversation rule and leaves the roleplay kinds alone', () => {
        const direct = applyConversationReply(chatRecords(), plan(), REPLY, CONTEXT);
        const generic = applyGenerationReply(chatRecords(), plan(), REPLY, CONTEXT);

        expect(generic).toEqual(direct);
    });
});

describe('commitGenerationReply for a conversation', () => {
    let sandbox;
    let user;

    const chatFile = (chatId = 'main') => path.join(user.directories.conversations, CONVERSATION, 'chats', `${chatId}.jsonl`);
    const conversationFile = () => path.join(user.directories.conversations, CONVERSATION, 'conversation.json');
    const readChat = (chatId = 'main') => fs.readFileSync(chatFile(chatId), 'utf8').trim().split('\n').map(text => JSON.parse(text));

    async function seed(overrides = {}) {
        createConversation(user, {
            kind: 'group',
            personaId: PERSONA,
            characters: ['Nova.png', 'Orion.png'],
            id: CONVERSATION,
            chats: [{ id: 'main', name: 'Main', createdAt: 100 }, { id: 'other', name: 'Other', createdAt: 200 }],
            ...overrides,
        });
        await saveChat(user, CONVERSATION, 'main', [header(), ...chatMessages()]);
    }

    beforeEach(() => {
        // The regular chat backup is throttled, and a second save inside the window leaves a timer that would fire after the test.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        sandbox = createSandboxUser();
        user = sandbox.user;
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        registry.testExports.generations.clear();
        journal.testExports.forgetLoadedJournals();
        sandbox.cleanup();
    });

    test('writes the pending message at the end of the chat file', async () => {
        await seed();
        const before = readChat();

        const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);

        expect(result.committed).toBe(true);
        const after = readChat();
        expect(after).toHaveLength(before.length + 1);
        expect(after.slice(1, -1)).toEqual(before.slice(1));
        expect(after.at(-1)).toMatchObject({ role: 'character', name: 'Nova', mes: RAW_TEXT, extra: { reply_token: TOKEN, server_generation: { pending: true, id: 'gen-1', kind: 'reply' } } });
        expect(after[0].chat_metadata.integrity).not.toBe(before[0].chat_metadata.integrity);
    });

    test('writes the index row, so that the list answers from it without reading the file', async () => {
        await seed();

        await commitGenerationReply(user, plan(), REPLY, CONTEXT);

        const cached = conversationIndex.get(chatFile(), fs.statSync(chatFile()), '');
        expect(cached).toEqual({ messageCount: 4, lastMessageAt: FINISHED.getTime(), preview: 'Hello there. Nova: a second line, left raw.', unread: 2, lastMessageRole: 'character', hasUserMessage: true });
        const listed = listConversations(user).conversations[0];
        expect(listed.chats.find(item => item.id === 'main')).toMatchObject({ messageCount: 4, lastMessageRole: 'character' });
        expect(listed.preview).toContain('Hello there.');
    });

    test('counts the pending message as unread by the read marker of the chat', async () => {
        await seed();
        updateConversation(user, CONVERSATION, { chats: { main: { readThrough: 'm3' } } });

        await commitGenerationReply(user, plan(), REPLY, CONTEXT);

        const listed = listConversations(user).conversations[0];
        expect(listed.chats.find(item => item.id === 'main')).toMatchObject({ unread: 1 });
        expect(listed.unread).toBe(1);
    });

    test('leaves conversation.json as it was', async () => {
        await seed();
        const before = fs.readFileSync(conversationFile());

        await commitGenerationReply(user, plan(), REPLY, CONTEXT);

        expect(fs.readFileSync(conversationFile())).toEqual(before);
    });

    test('does not write a second time for a token that already landed', async () => {
        await seed();
        await commitGenerationReply(user, plan(), REPLY, CONTEXT);
        const bytes = fs.readFileSync(chatFile());

        const again = await commitGenerationReply(user, plan(), REPLY, { id: 'gen-2', finishedAt: new Date(FINISHED.getTime() + 5000) });

        expect(again).toEqual({ committed: false, reason: 'reply-landed' });
        expect(fs.readFileSync(chatFile())).toEqual(bytes);
    });

    test('does not write a reply that its page already saved itself, as when the claim request failed', async () => {
        await seed();
        const loaded = readChat();
        await saveChat(user, CONVERSATION, 'main', [loaded[0], ...loaded.slice(1), message('m4.0', 'character', 'Hello there.', 4, { reply_token: TOKEN })]);
        const bytes = fs.readFileSync(chatFile());

        const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);

        expect(result).toEqual({ committed: false, reason: 'reply-landed' });
        expect(fs.readFileSync(chatFile())).toEqual(bytes);
    });

    test('refuses a reply for a chat that moved on, and writes nothing', async () => {
        await seed();
        const bytes = fs.readFileSync(chatFile());
        const messages = chatMessages();
        messages[1] = { ...messages[1], mes: 'Hello there, edited.' };
        const loaded = readChat();
        await saveChat(user, CONVERSATION, 'main', [loaded[0], ...messages]);
        const edited = fs.readFileSync(chatFile());

        const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);

        expect(result).toEqual({ committed: false, reason: 'trigger-changed' });
        expect(fs.readFileSync(chatFile())).toEqual(edited);
        expect(edited).not.toEqual(bytes);
    });

    describe('the speaker', () => {
        test('a member of a group may speak', async () => {
            await seed();

            expect((await commitGenerationReply(user, plan({ message: { name: 'Orion' }, reply: { speaker: 'Orion.png' } }), REPLY, CONTEXT)).committed).toBe(true);
        });

        test('a member who left the group is refused as speaker-gone, and nothing is written', async () => {
            await seed();
            const bytes = fs.readFileSync(chatFile());

            const result = await commitGenerationReply(user, plan({ message: { name: 'Lyra' }, reply: { speaker: 'Lyra.png' } }), REPLY, CONTEXT);

            expect(result).toEqual({ committed: false, reason: 'speaker-gone' });
            expect(fs.readFileSync(chatFile())).toEqual(bytes);
        });

        test('the character and the extras of a direct conversation may speak, and nobody else', async () => {
            createConversation(user, { kind: 'direct', personaId: PERSONA, characters: ['Nova.png'], extras: ['Orion.png'], id: CONVERSATION, chats: [{ id: 'main', name: 'Main', createdAt: 100 }] });
            await saveChat(user, CONVERSATION, 'main', [header(), ...chatMessages()]);

            const direct = await commitGenerationReply(user, plan(), REPLY, CONTEXT);
            const extra = await commitGenerationReply(user, plan({ message: { name: 'Orion' }, reply: { token: 'b'.repeat(16), speaker: 'Orion.png' } }), REPLY, CONTEXT);
            const stranger = await commitGenerationReply(user, plan({ message: { name: 'Lyra' }, reply: { token: 'c'.repeat(16), speaker: 'Lyra.png' } }), REPLY, CONTEXT);

            expect(direct.committed).toBe(true);
            expect(extra.committed).toBe(true);
            expect(stranger).toEqual({ committed: false, reason: 'speaker-gone' });
            expect(readChat().at(-1)).toMatchObject({ role: 'member', name: 'Orion' });
        });
    });

    describe('a target that is gone', () => {
        test('a deleted conversation gets nothing, and its folder does not come back', async () => {
            await seed();
            deleteConversation(user, CONVERSATION);

            const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);

            expect(result).toEqual({ committed: false, reason: 'missing' });
            expect(fs.existsSync(path.join(user.directories.conversations, CONVERSATION))).toBe(false);
        });

        test('a deleted chat gets nothing, and its file does not come back', async () => {
            await seed();
            deleteChat(user, CONVERSATION, 'main');

            const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);

            expect(result).toEqual({ committed: false, reason: 'missing' });
            expect(fs.existsSync(chatFile())).toBe(false);
        });

        test('a chat file that no chat of the conversation names is left alone', async () => {
            await seed();
            fs.writeFileSync(chatFile('stray'), `${JSON.stringify(header({ integrity: 'x' }))}\n${JSON.stringify(chatMessages()[1])}\n`);
            const bytes = fs.readFileSync(chatFile('stray'));

            const result = await commitGenerationReply(user, plan({ file: 'stray' }), REPLY, CONTEXT);

            expect(result).toEqual({ committed: false, reason: 'missing' });
            expect(fs.readFileSync(chatFile('stray'))).toEqual(bytes);
        });

        test('a conversation whose file cannot be read is missing, not an error', async () => {
            await seed();
            fs.writeFileSync(conversationFile(), '{ not json');

            expect(await commitGenerationReply(user, plan(), REPLY, CONTEXT)).toEqual({ committed: false, reason: 'missing' });
        });

        test('a conversation id that is no id is an invalid target and reaches no file', async () => {
            await seed();
            const bytes = fs.readFileSync(chatFile());

            const result = await commitGenerationReply(user, { ...plan(), chat: { conversation: '../escape' } }, REPLY, CONTEXT);

            expect(result).toEqual({ committed: false, reason: 'invalid-target' });
            expect(fs.readFileSync(chatFile())).toEqual(bytes);
            expect(fs.existsSync(path.join(user.directories.conversations, '..', 'escape'))).toBe(false);
        });

        test.each([
            ['a chat id that is no id', '../escape'],
            ['a chat id that names a Windows device', 'CON'],
        ])('%s names no chat of the conversation and reaches no file', async (_name, file) => {
            await seed();
            const bytes = fs.readFileSync(chatFile());

            const result = await commitGenerationReply(user, { ...plan(), file }, REPLY, CONTEXT);

            expect(result).toEqual({ committed: false, reason: 'missing' });
            expect(fs.readFileSync(chatFile())).toEqual(bytes);
            expect(fs.existsSync(path.join(user.directories.conversations, CONVERSATION, 'escape.jsonl'))).toBe(false);
        });
    });

    describe('undo', () => {
        test('puts the chat back byte for byte, with the slug of before, while nothing saved over the commit', async () => {
            await seed();
            const bytes = fs.readFileSync(chatFile());
            const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);
            expect(fs.readFileSync(chatFile())).not.toEqual(bytes);

            const reverted = await revertGenerationCommit(user, plan(), result.undo);

            expect(reverted).toBe(true);
            expect(fs.readFileSync(chatFile(), 'utf8')).toBe(bytes.toString('utf8'));
        });

        test('leaves the chat alone once another save went over the commit', async () => {
            await seed();
            const result = await commitGenerationReply(user, plan(), REPLY, CONTEXT);
            const loaded = readChat();
            await saveChat(user, CONVERSATION, 'main', [loaded[0], ...loaded.slice(1), message('m9', 'user', 'A page saved this.', 20)]);
            const bytes = fs.readFileSync(chatFile());

            expect(await revertGenerationCommit(user, plan(), result.undo)).toBe(false);
            expect(fs.readFileSync(chatFile())).toEqual(bytes);
        });
    });

    const GENERATION_ID = 'g'.repeat(32);
    const startGeneration = (planned = plan(), id = GENERATION_ID) => startRegistryGeneration(registry, user, planned, id);

    describe('through the registry', () => {
        test('a detached reply is written into the conversation chat when it finishes', async () => {
            await seed();
            const { generation, finish } = startGeneration();
            generation.detach();
            finish();
            await settled(generation);

            expect(generation.commit.state).toBe('committed');
            expect(readChat().at(-1)).toMatchObject({ mes: RAW_TEXT, extra: { server_generation: { pending: true, id: GENERATION_ID } } });
            expect(conversationIndex.get(chatFile(), fs.statSync(chatFile()), '')).toMatchObject({ messageCount: 4, lastMessageRole: 'character' });
        });

        test('a page that claims the reply before the commit keeps the chat to itself', async () => {
            await seed();
            const bytes = fs.readFileSync(chatFile());
            const { generation, finish } = startGeneration();
            finish();

            await expect(generation.claim()).resolves.toBe('claimed');
            jest.advanceTimersByTime(registry.testExports.COMMIT_GRACE_MS + 1);
            await settled(generation);

            expect(fs.readFileSync(chatFile())).toEqual(bytes);
        });

        test('a late claim takes the commit back, so the page saves its own copy', async () => {
            await seed();
            const bytes = fs.readFileSync(chatFile());
            const { generation, finish } = startGeneration();
            generation.detach();
            finish();
            await settled(generation);
            expect(readChat()).toHaveLength(5);

            await expect(generation.claim()).resolves.toBe('claimed');

            expect(fs.readFileSync(chatFile(), 'utf8')).toBe(bytes.toString('utf8'));
        });

        test('a late claim leaves the commit alone once another save went over it', async () => {
            await seed();
            const { generation, finish } = startGeneration();
            generation.detach();
            finish();
            await settled(generation);
            const loaded = readChat();
            await saveChat(user, CONVERSATION, 'main', [...loaded, message('m9', 'user', 'A page saved this.', 20)]);

            await expect(generation.claim()).resolves.toBe('committed');

            expect(readChat().map(item => item.id)).toContain('m9');
            expect(readChat().some(item => item.extra?.reply_token === TOKEN)).toBe(true);
        });

        test('a stop from the page takes back what the server wrote while the page was away', async () => {
            await seed();
            const bytes = fs.readFileSync(chatFile());
            const { generation, finish } = startGeneration();
            generation.detach();
            finish();
            await settled(generation);

            await generation.stop();

            expect(fs.readFileSync(chatFile(), 'utf8')).toBe(bytes.toString('utf8'));
        });

        test('a deleted conversation gets nothing from a detached reply, and the generation fails as missing', async () => {
            await seed();
            const { generation, finish } = startGeneration();
            deleteConversation(user, CONVERSATION);
            generation.detach();
            finish();
            await settled(generation);

            expect(generation.commit.state).toBe('failed');
            expect(generation.commit.reason).toBe('missing');
            expect(fs.existsSync(path.join(user.directories.conversations, CONVERSATION))).toBe(false);
        });
    });

    describe('the journal', () => {
        const chatKey = `conversation:${CONVERSATION}:main`;

        test('lists a reply in flight with its speaker, round, triggers and token, and reports it lost after a restart', async () => {
            await seed();
            startGeneration(plan(), 'j'.repeat(32));

            journal.testExports.forgetLoadedJournals();

            expect(journal.getLostGenerations(user, chatKey)).toEqual([{
                id: 'j'.repeat(32),
                chatKey,
                kind: 'reply',
                index: 4,
                anchor: null,
                target: null,
                started: '2026-10-03T10:00:00.000Z',
                page: 'page-a',
                member: 'Nova.png',
                round: ['Orion.png'],
                triggers: ['m2', 'm3'],
                token: TOKEN,
                lost: true,
            }]);
        });

        test('a roleplay entry gains no field', () => {
            journal.recordGeneration(user, 'r'.repeat(32), normalizeCommitPlan({
                v: 1, chat: { avatar: 'Seraphina.png' }, file: 'chat', kind: 'append', index: 2, anchor: 'abcd1234',
                started: 's', page: 'p', message: { name: 'Seraphina' },
            }));
            journal.testExports.forgetLoadedJournals();

            const [entry] = journal.getLostGenerations(user, 'character:Seraphina.png:chat');
            expect(Object.keys(entry).sort()).toEqual(['anchor', 'chatKey', 'id', 'index', 'kind', 'lost', 'member', 'page', 'round', 'started', 'target']);
        });
    });
});
