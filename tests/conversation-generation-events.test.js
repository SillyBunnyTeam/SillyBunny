import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createSandboxUser, header, PERSONA } from './util/conversation-store-sandbox.js';
import { CONVERSATION, TOKEN, chatMessages, plan, settled, startGeneration as startRegistryGeneration } from './util/conversation-reply-fixture.js';

const { createConversation, saveChat } = await import('../src/conversation-store.js');
const journal = await import('../src/generation-journal.js');
const registry = await import('../src/resumable-generations.js');

const CHAT_KEY = `conversation:${CONVERSATION}:main`;
const OTHER_TOKEN = 'b'.repeat(16);
const roleplayPlan = () => ({
    v: 1,
    chat: { avatar: 'Seraphina.png' },
    file: 'Seraphina - chat',
    kind: 'append',
    index: 0,
    anchor: null,
    started: '2026-10-03T10:00:00.000Z',
    page: 'page-a',
    message: { name: 'Seraphina' },
});

describe('the event stream of the conversations of a user', () => {
    let sandbox;
    let user;
    /** @type {{ close: () => Promise<void> }[]} */
    let open;

    const chatFile = (chatId = 'main') => path.join(user.directories.conversations, CONVERSATION, 'chats', `${chatId}.jsonl`);
    const readChat = (chatId = 'main') => fs.readFileSync(chatFile(chatId), 'utf8').trim().split('\n').map(text => JSON.parse(text));
    const startGeneration = (planned, id, asUser = user) => startRegistryGeneration(registry, asUser, planned, id);

    async function seed() {
        createConversation(user, {
            kind: 'group',
            personaId: PERSONA,
            characters: ['Nova.png', 'Orion.png'],
            id: CONVERSATION,
            chats: [{ id: 'main', name: 'Main', createdAt: 100 }, { id: 'other', name: 'Other', createdAt: 200 }],
        });
        await saveChat(user, CONVERSATION, 'main', [header(), ...chatMessages()]);
    }

    /** What a server restart leaves behind: an empty registry, and journals read fresh from disk. */
    function restartServer() {
        registry.testExports.generations.clear();
        journal.testExports.forgetLoadedJournals();
    }

    /**
     * @param {object} asUser The profile that the requests are authenticated as
     * @returns {Promise<string>} Base URL of the router
     */
    async function serve(asUser = user) {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = asUser;
            next();
        });
        app.use('/api/resumable-generations', registry.router);
        const server = await new Promise(resolve => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        open.push({
            async close() {
                server.closeAllConnections?.();
                await new Promise(resolve => server.close(resolve));
            },
        });
        return `http://127.0.0.1:${server.address().port}/api/resumable-generations`;
    }

    /**
     * Follows an events stream as a page load would.
     * @param {Record<string, string>} query Query of the events route
     * @param {object} [asUser] The profile that the request is authenticated as
     */
    async function follow(query, asUser = user) {
        const base = await serve(asUser);
        const controller = new AbortController();
        const response = await fetch(`${base}/events?${new URLSearchParams(query)}`, { signal: controller.signal });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const stream = {
            base,
            status: response.status,
            contentType: response.headers.get('content-type'),
            async next() {
                while (!buffer.includes('\n\n')) {
                    const { value, done } = await /** @type {ReadableStreamDefaultReader} */ (reader).read();
                    if (done) {
                        throw new Error('Event stream ended');
                    }
                    buffer += decoder.decode(value, { stream: true });
                }
                const end = buffer.indexOf('\n\n');
                const event = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = event.split('\n').find(line => line.startsWith('data: '));
                return data ? JSON.parse(data.slice(6)).pending : this.next();
            },
            /** Reads events until one satisfies the predicate. */
            async until(predicate) {
                let pending;
                do {
                    pending = await this.next();
                } while (!predicate(pending));
                return pending;
            },
            async close() {
                controller.abort();
            },
        };
        open.push(stream);
        return stream;
    }

    const conversationEvents = (page = 'page-b', asUser = user) => follow({ owner: 'conversations', page }, asUser);

    beforeEach(() => {
        // The regular chat backup is throttled, and a second save inside the window leaves a timer that would fire after the test.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        sandbox = createSandboxUser();
        user = sandbox.user;
        open = [];
    });

    afterEach(async () => {
        for (const item of open) {
            await item.close().catch(() => undefined);
        }
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        registry.testExports.generations.clear();
        registry.testExports.setTotalBufferedBytes(0);
        journal.testExports.forgetLoadedJournals();
        sandbox.cleanup();
    });

    describe('what it sends', () => {
        test('every conversation reply of the user, each with its conversation and chat', async () => {
            startGeneration(plan(), '1'.repeat(32));
            startGeneration(plan({ file: 'other', reply: { token: OTHER_TOKEN } }), '2'.repeat(32));

            const events = await conversationEvents();

            expect(events.contentType).toContain('text/event-stream');
            expect(await events.next()).toEqual([
                { id: '1'.repeat(32), state: 'running', kind: 'reply', reason: '', page: 'page-a', conversation: CONVERSATION, chat: 'main' },
                { id: '2'.repeat(32), state: 'running', kind: 'reply', reason: '', page: 'page-a', conversation: CONVERSATION, chat: 'other' },
            ]);
        });

        test('a reply from its start to its commit, and the commit is in the chat', async () => {
            await seed();
            const { generation, finish } = startGeneration(plan(), '3'.repeat(32));
            const events = await conversationEvents();
            expect(await events.next()).toEqual([expect.objectContaining({ state: 'running', conversation: CONVERSATION, chat: 'main' })]);

            generation.detach();
            finish();
            const pending = await events.until(items => items[0]?.state === 'committed');

            expect(pending).toEqual([expect.objectContaining({ id: '3'.repeat(32), state: 'committed', kind: 'reply', conversation: CONVERSATION, chat: 'main' })]);
            expect(readChat().at(-1)).toMatchObject({ extra: { reply_token: TOKEN, server_generation: { pending: true } } });
        });

        test('a refused commit is reported as failed with the reason of the rule', async () => {
            await seed();
            const { generation, finish } = startGeneration(plan({ reply: { triggers: [{ id: 'gone', rev: '00000000' }] } }), '4'.repeat(32));
            const events = await conversationEvents();
            await events.next();

            generation.detach();
            finish();
            const pending = await events.until(items => items[0]?.state === 'failed');

            expect(pending).toEqual([expect.objectContaining({ state: 'failed', reason: 'trigger-changed', conversation: CONVERSATION })]);
        });

        test('a reply that a page acknowledged is not sent again', async () => {
            await seed();
            const { generation, finish } = startGeneration(plan(), '5'.repeat(32));
            const first = await conversationEvents('page-b');
            await first.next();
            generation.detach();
            finish();
            await first.until(items => items[0]?.state === 'committed');

            const answer = await fetch(`${first.base}/acknowledge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: ['5'.repeat(32)] }),
            });
            const second = await conversationEvents('page-c');

            expect(answer.status).toBe(204);
            expect(await second.next()).toEqual([]);
        });

        test('nothing of another profile', async () => {
            const other = { profile: { handle: 'someone-else' }, directories: { root: fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-events-other-')) } };
            try {
                startGeneration(plan(), '6'.repeat(32), other);
                startGeneration(plan({ reply: { token: OTHER_TOKEN } }), '7'.repeat(32));

                const events = await conversationEvents();

                expect(await events.next()).toEqual([expect.objectContaining({ id: '7'.repeat(32) })]);
                const theirs = await conversationEvents('page-b', other);
                expect(await theirs.next()).toEqual([expect.objectContaining({ id: '6'.repeat(32) })]);
            } finally {
                fs.rmSync(other.directories.root, { recursive: true, force: true });
            }
        });
    });

    describe('next to the stream of a roleplay chat', () => {
        const roleplayQuery = { avatar: 'Seraphina.png', file: 'Seraphina - chat', page: 'page-b' };

        test('each stream gets its own replies and no others', async () => {
            startGeneration(plan(), '8'.repeat(32));
            startGeneration(roleplayPlan(), '9'.repeat(32));

            const conversations = await conversationEvents();
            const roleplay = await follow(roleplayQuery);

            expect(await conversations.next()).toEqual([expect.objectContaining({ id: '8'.repeat(32), kind: 'reply' })]);
            expect(await roleplay.next()).toEqual([expect.objectContaining({ id: '9'.repeat(32), kind: 'append' })]);
        });

        test('a roleplay item has the same fields as before, and no conversation field', async () => {
            startGeneration(roleplayPlan(), 'a'.repeat(32));

            const roleplay = await follow(roleplayQuery);

            const [item] = await roleplay.next();
            expect(Object.keys(item).sort()).toEqual(['id', 'kind', 'page', 'reason', 'state']);
        });

        test('a roleplay stream still needs a chat, and the route answers 400 without one', async () => {
            expect((await follow({ page: 'page-b' })).status).toBe(400);
            expect((await follow({ avatar: 'Seraphina.png', page: 'page-b' })).status).toBe(400);
            expect((await follow({ file: 'Seraphina - chat', page: 'page-b' })).status).toBe(400);
        });

        test('an owner that the route does not know is refused', async () => {
            expect((await follow({ owner: 'groups', page: 'page-b' })).status).toBe(400);
            expect((await follow({ owner: '', page: 'page-b' })).status).toBe(400);
        });
    });

    describe('which page writes a finished reply', () => {
        test('a reply that no page follows any more is committed when a conversation stream opens', async () => {
            await seed();
            const { generation, finish } = startGeneration(plan(), 'c'.repeat(32));
            finish();
            expect(generation.commit.state).toBe('waiting');

            const events = await conversationEvents('page-b');

            await events.until(items => items[0]?.state === 'committed');
            expect(readChat().at(-1)).toMatchObject({ extra: { reply_token: TOKEN } });
        });

        test('a conversation stream of the page that started the reply leaves the reply to that page', async () => {
            await seed();
            const { generation, finish } = startGeneration(plan(), 'd'.repeat(32));
            finish();

            const events = await conversationEvents('page-a');

            expect(await events.next()).toEqual([expect.objectContaining({ state: 'waiting' })]);
            expect(generation.commit.state).toBe('waiting');
            expect(readChat()).toHaveLength(4);
        });

        test('a second page leaves a finished reply to its page while that page follows, and commits it once that page goes', async () => {
            await seed();
            const { finish } = startGeneration(plan(), 'e'.repeat(32));
            const owner = await conversationEvents('page-a');
            const other = await conversationEvents('page-b');
            await other.next();

            finish();
            await other.until(items => items[0]?.state === 'waiting');
            expect(readChat()).toHaveLength(4);

            await owner.close();
            await other.until(items => items[0]?.state === 'committed');
            expect(readChat()).toHaveLength(5);
        });

        test('a stream of the page for one conversation protects its replies in every other chat', async () => {
            await seed();
            const { finish } = startGeneration(plan({ file: 'other', reply: { token: OTHER_TOKEN, triggers: [] } }), 'f'.repeat(32));
            const owner = await conversationEvents('page-a');
            const other = await conversationEvents('page-b');
            await other.next();

            finish();
            const pending = await other.until(items => items[0]?.state === 'waiting');

            expect(pending).toEqual([expect.objectContaining({ chat: 'other', state: 'waiting' })]);
            expect(readChat('other')).toHaveLength(1);
            await owner.close();
        });

        test('does not push to a watcher that disconnects or whose response ends before setImmediate runs', async () => {
            const connectSynthetic = (page) => {
                const request = Object.assign(new EventEmitter(), {
                    method: 'GET',
                    url: `/events?owner=conversations&page=${page}`,
                    query: { owner: 'conversations', page },
                    user,
                });
                const response = Object.assign(new EventEmitter(), {
                    writableEnded: false,
                    destroyed: false,
                    status: jest.fn(() => response),
                    set: jest.fn(() => response),
                    flushHeaders: jest.fn(),
                    write: jest.fn(),
                });
                registry.router(request, response, () => {});
                return { request, response };
            };

            const disconnected = connectSynthetic('page-gone');
            const ended = connectSynthetic('page-ended');
            expect(disconnected.response.write).toHaveBeenCalledTimes(1);
            expect(ended.response.write).toHaveBeenCalledTimes(1);

            // Schedule notifications for both watchers, then disconnect one and mark the other's stream ended before setImmediate runs.
            startGeneration(plan(), 'a'.repeat(32));
            disconnected.response.writableEnded = true;
            disconnected.request.emit('close');
            ended.response.writableEnded = true;

            await new Promise(resolve => setImmediate(resolve));

            expect(disconnected.response.write).toHaveBeenCalledTimes(1);
            expect(ended.response.write).toHaveBeenCalledTimes(1);
            ended.request.emit('close');
        });
    });

    describe('after a server restart', () => {
        test('a reply that was in flight is sent as lost, with what a regeneration needs', async () => {
            await seed();
            startGeneration(plan(), '1'.repeat(32));
            restartServer();

            const events = await conversationEvents();

            expect(await events.next()).toEqual([{
                id: '1'.repeat(32),
                chatKey: CHAT_KEY,
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
                state: 'lost',
                reason: 'server-restart',
                conversation: CONVERSATION,
                chat: 'main',
            }]);
            expect(readChat()).toHaveLength(4);
        });

        test('the lost replies of every chat of the user are sent, and a roleplay stream gets none of them', async () => {
            startGeneration(plan(), '1'.repeat(32));
            startGeneration(plan({ file: 'other', reply: { token: OTHER_TOKEN } }), '2'.repeat(32));
            restartServer();

            const conversations = await conversationEvents();
            const roleplay = await follow({ avatar: 'Seraphina.png', file: 'Seraphina - chat', page: 'page-b' });

            const lost = await conversations.next();
            expect(lost.map(item => [item.chat, item.state])).toEqual([['main', 'lost'], ['other', 'lost']]);
            expect(await roleplay.next()).toEqual([]);
        });

        test('a lost reply stays until a page has acknowledged it', async () => {
            startGeneration(plan(), '1'.repeat(32));
            restartServer();
            const first = await conversationEvents();
            await first.next();

            restartServer();
            expect((await (await conversationEvents('page-c')).next()).map(item => item.id)).toEqual(['1'.repeat(32)]);

            const answer = await fetch(`${first.base}/acknowledge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: ['1'.repeat(32)] }),
            });
            restartServer();

            expect(answer.status).toBe(204);
            expect(await (await conversationEvents('page-d')).next()).toEqual([]);
        });

        test('a reply that was committed, claimed or stopped is not lost', async () => {
            await seed();
            const committed = startGeneration(plan(), '1'.repeat(32));
            committed.generation.detach();
            committed.finish();
            await settled(committed.generation);
            const claimed = startGeneration(plan({ reply: { token: OTHER_TOKEN } }), '2'.repeat(32));
            claimed.finish();
            await claimed.generation.claim();

            restartServer();

            expect(journal.getLostGenerationsByPrefix(user, 'conversation:')).toEqual([]);
        });
    });
});

describe('getLostGenerationsByPrefix', () => {
    let root;
    let user;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-journal-prefix-'));
        user = { profile: { handle: 'tester' }, directories: { root } };
    });

    afterEach(() => {
        registry.testExports.generations.clear();
        journal.testExports.forgetLoadedJournals();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('lists the lost entries whose chat key starts with the prefix, and no others', () => {
        journal.recordGeneration(user, '1'.repeat(32), plan());
        journal.recordGeneration(user, '2'.repeat(32), plan({ file: 'other', reply: { token: OTHER_TOKEN } }));
        journal.recordGeneration(user, '3'.repeat(32), roleplayPlan());
        journal.testExports.forgetLoadedJournals();

        expect(journal.getLostGenerationsByPrefix(user, 'conversation:').map(entry => entry.id)).toEqual(['1'.repeat(32), '2'.repeat(32)]);
        expect(journal.getLostGenerationsByPrefix(user, `conversation:${CONVERSATION}:other`).map(entry => entry.id)).toEqual(['2'.repeat(32)]);
        expect(journal.getLostGenerationsByPrefix(user, 'character:').map(entry => entry.id)).toEqual(['3'.repeat(32)]);
    });

    test('lists nothing for a generation that is still in flight in this process', () => {
        journal.recordGeneration(user, '1'.repeat(32), plan());

        expect(journal.getLostGenerationsByPrefix(user, 'conversation:')).toEqual([]);
    });

    test('lists nothing for a user without a data folder', () => {
        expect(journal.getLostGenerationsByPrefix({ profile: { handle: 'x' } }, 'conversation:')).toEqual([]);
    });
});
