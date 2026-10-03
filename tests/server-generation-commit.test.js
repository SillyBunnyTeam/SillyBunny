import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import { encodeCommitPlan, getMessageIdentity, hashCommitText } from '../public/scripts/generation-commit-plan.js';
import { parseGenerationReply } from '../src/generation-reply-parser.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

/** @type {import('../src/generation-commit.js')} */
let commit;
/** @type {import('../src/resumable-generations.js')} */
let registry;

beforeAll(async () => {
    commit = await import('../src/generation-commit.js');
    registry = await import('../src/resumable-generations.js');
});

const STARTED = '2026-10-03T10:00:00.000Z';
const FINISHED = new Date('2026-10-03T10:00:30.000Z');
const HEADER = { user_name: 'User', character_name: 'Seraphina', chat_metadata: { integrity: 'slug-1' } };

function message(name, isUser, mes, sendDate, extra = {}) {
    return { name, is_user: isUser, send_date: sendDate, mes, extra };
}

function chatRecords() {
    return [
        structuredClone(HEADER),
        message('Seraphina', false, 'Greetings.', '2026-10-03T09:00:00.000Z'),
        message('User', true, 'Hello there.', '2026-10-03T09:59:00.000Z'),
    ];
}

function plan(overrides = {}) {
    const records = chatRecords();
    return {
        v: 1,
        chat: { avatar: 'Seraphina.png' },
        file: 'Seraphina - chat',
        kind: 'append',
        index: 2,
        anchor: getMessageIdentity(records[2]),
        replaces: null,
        target: null,
        swipes: 0,
        prefix: null,
        prefix_length: 0,
        started: STARTED,
        page: 'page-a',
        message: { name: 'Seraphina', force_avatar: null, original_avatar: null, extra: { api: 'openai', model: 'gpt-test', reasoning_effort: null, gen_id: 7 } },
        ...overrides,
    };
}

const REPLY = { text: 'The forest stirs.', reasoning: 'Think first.', error: false };
const CONTEXT = { id: 'gen-1', finishedAt: FINISHED };

describe('parseGenerationReply', () => {
    test('joins streamed content and reasoning deltas', () => {
        const body = [
            'data: {"choices":[{"delta":{"reasoning_content":"Think "}}]}',
            'data: {"choices":[{"delta":{"reasoning_content":"first."}}]}',
            'data: {"choices":[{"delta":{"content":"The forest "}}]}',
            'data: {"choices":[{"delta":{"content":"stirs."}}]}',
            'data: [DONE]',
            '',
        ].join('\n\n');
        expect(parseGenerationReply(Buffer.from(body), 'text/event-stream')).toEqual(REPLY);
    });

    test('reads a complete chat completion', () => {
        const body = JSON.stringify({ choices: [{ message: { content: 'The forest stirs.', reasoning_content: 'Think first.' } }] });
        expect(parseGenerationReply(Buffer.from(body), 'application/json')).toEqual(REPLY);
    });

    test('reads a complete text completion', () => {
        const body = JSON.stringify({ choices: [{ text: 'The forest stirs.' }] });
        expect(parseGenerationReply(Buffer.from(body), 'application/json')).toMatchObject({ text: 'The forest stirs.', error: false });
    });

    test('flags an error reply instead of returning its message as text', () => {
        const body = JSON.stringify({ error: { message: 'Rate limited' } });
        expect(parseGenerationReply(Buffer.from(body), 'application/json')).toMatchObject({ text: '', error: true });
    });
});

describe('applyGenerationReply', () => {
    test('appends a new reply after the anchor and marks it pending', () => {
        const result = commit.applyGenerationReply(chatRecords(), plan(), REPLY, CONTEXT);
        expect('records' in result).toBe(true);
        const added = result.records[3];
        expect(added).toMatchObject({
            name: 'Seraphina',
            is_user: false,
            mes: 'The forest stirs.',
            gen_started: STARTED,
            gen_finished: FINISHED.toISOString(),
            swipe_id: 0,
            swipes: ['The forest stirs.'],
        });
        expect(added.extra).toMatchObject({ reasoning: 'Think first.', model: 'gpt-test', gen_id: 7, server_generation: { id: 'gen-1', kind: 'append', pending: true } });
        expect(result.records).toHaveLength(4);
    });

    test('replaces a streaming placeholder of the same generation that a save put on disk', () => {
        const records = [...chatRecords(), { ...message('Seraphina', false, 'The for', ''), gen_started: STARTED }];
        const result = commit.applyGenerationReply(records, plan(), REPLY, CONTEXT);
        expect(result.records).toHaveLength(4);
        expect(result.records[3].mes).toBe('The forest stirs.');
    });

    test('replaces the regenerated message it was asked to replace', () => {
        const old = message('Seraphina', false, 'Old reply.', '2026-10-03T09:59:30.000Z');
        const records = [...chatRecords(), old];
        const result = commit.applyGenerationReply(records, plan({ replaces: getMessageIdentity(old) }), REPLY, CONTEXT);
        expect(result.records).toHaveLength(4);
        expect(result.records[3].mes).toBe('The forest stirs.');
    });

    test('refuses when the chat moved on while the reply was generated', () => {
        const records = [...chatRecords(), message('User', true, 'Never mind.', '2026-10-03T10:00:10.000Z')];
        expect(commit.applyGenerationReply(records, plan(), REPLY, CONTEXT)).toEqual({ reason: 'chat-changed' });
    });

    test('refuses when the message before the reply is not the anchor', () => {
        const records = chatRecords();
        records[2].mes = 'Edited into something else.';
        records[2].send_date = '2026-10-03T09:59:59.000Z';
        expect(commit.applyGenerationReply(records, plan(), REPLY, CONTEXT)).toEqual({ reason: 'anchor-changed' });
    });

    test('adds a swipe to the target message', () => {
        const target = { ...message('Seraphina', false, 'First take.', '2026-10-03T09:59:30.000Z'), swipe_id: 0, swipes: ['First take.'], swipe_info: [{}] };
        const records = [...chatRecords(), target];
        const swipePlan = plan({ kind: 'swipe', index: 2, anchor: null, target: getMessageIdentity(target), swipes: 1 });
        const result = commit.applyGenerationReply(records, swipePlan, REPLY, CONTEXT);
        expect(result.records[3]).toMatchObject({ swipe_id: 1, swipes: ['First take.', 'The forest stirs.'], mes: 'The forest stirs.' });
    });

    test('replaces the swipe slot its own streaming placeholder already added', () => {
        const target = {
            ...message('Seraphina', false, 'The for', ''),
            gen_started: STARTED,
            swipe_id: 1,
            swipes: ['First take.', 'The for'],
            swipe_info: [{}, {}],
        };
        const records = [...chatRecords(), target];
        const swipePlan = plan({ kind: 'swipe', index: 2, anchor: null, target: 'identity-before-the-swipe-started', swipes: 1 });
        const result = commit.applyGenerationReply(records, swipePlan, REPLY, CONTEXT);
        expect(result.records[3].swipes).toEqual(['First take.', 'The forest stirs.']);
    });

    test('continues the target message from the exact prefix', () => {
        const target = message('Seraphina', false, 'The forest', '2026-10-03T09:59:30.000Z');
        const records = [...chatRecords(), target];
        const continuePlan = plan({ kind: 'continue', index: 2, anchor: null, target: getMessageIdentity(target), prefix: hashCommitText('The forest'), prefix_length: 10 });
        const result = commit.applyGenerationReply(records, continuePlan, { ...REPLY, text: ' stirs.' }, CONTEXT);
        expect(result.records[3].mes).toBe('The forest stirs.');
        expect(result.records[3].extra.server_generation.prefix_length).toBe(10);
    });

    test('refuses to continue a message whose text was edited', () => {
        const target = message('Seraphina', false, 'The forest', '2026-10-03T09:59:30.000Z');
        const records = [...chatRecords(), { ...target, mes: 'The meadow' }];
        const continuePlan = plan({ kind: 'continue', index: 2, anchor: null, target: getMessageIdentity(target), prefix: hashCommitText('The forest'), prefix_length: 10 });
        expect(commit.applyGenerationReply(records, continuePlan, REPLY, CONTEXT)).toEqual({ reason: 'text-changed' });
    });
});

describe('server-owned generation lifecycle', () => {
    let root;
    let user;
    let chatFile;

    function readChat() {
        return fs.readFileSync(chatFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    }

    function startGeneration(id) {
        const headers = {
            'x-generation-id': id,
            'x-generation-commit': encodeCommitPlan(plan()),
        };
        const request = {
            method: 'POST',
            path: '/api/backends/chat-completions/generate',
            headers,
            socket: new EventEmitter(),
            user,
            get(name) {
                return headers[String(name).toLowerCase()];
            },
        };
        const response = new PassThrough();
        response.statusCode = 200;
        response.statusMessage = '';
        response.socket = {};
        response.getHeader = name => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : undefined);
        registry.resumableGenerationMiddleware(request, response, jest.fn());
        const generation = request.resumableGeneration;
        response.resume();
        return {
            generation,
            response,
            finish() {
                response.write('data: {"choices":[{"delta":{"content":"The forest stirs."}}]}\n\n');
                response.end('data: [DONE]\n\n');
            },
        };
    }

    async function settled(generation) {
        await new Promise(resolve => setImmediate(resolve));
        await generation.commit.work;
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-server-commit-'));
        user = {
            profile: { handle: 'tester' },
            directories: {
                chats: path.join(root, 'chats'),
                groupChats: path.join(root, 'group chats'),
                backups: path.join(root, 'backups'),
            },
        };
        for (const directory of Object.values(user.directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.mkdirSync(path.join(user.directories.chats, 'Seraphina'));
        chatFile = path.join(user.directories.chats, 'Seraphina', 'Seraphina - chat.jsonl');
        fs.writeFileSync(chatFile, chatRecords().map(record => JSON.stringify(record)).join('\n'));
    });

    afterEach(() => {
        jest.useRealTimers();
        registry.testExports.generations.clear();
        registry.testExports.setTotalBufferedBytes(0);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('a detached generation writes its reply into the chat when it finishes', async () => {
        const { generation, finish } = startGeneration('a'.repeat(32));
        generation.detach();
        finish();
        await settled(generation);

        expect(generation.commit.state).toBe('committed');
        const records = readChat();
        expect(records).toHaveLength(4);
        expect(records[3]).toMatchObject({ mes: 'The forest stirs.', extra: { server_generation: { pending: true } } });
        expect(records[0].chat_metadata.integrity).not.toBe('slug-1');
    });

    test('a page that claims the finished reply keeps the chat to itself', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const { generation, finish } = startGeneration('b'.repeat(32));
        finish();
        expect(generation.commit.state).toBe('waiting');
        await expect(generation.claim()).resolves.toBe('claimed');

        jest.advanceTimersByTime(registry.testExports.COMMIT_GRACE_MS + 1);
        await settled(generation);
        expect(readChat()).toHaveLength(3);
    });

    test('an unclaimed reply is committed after the grace period', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const { generation, finish } = startGeneration('c'.repeat(32));
        finish();
        jest.advanceTimersByTime(registry.testExports.COMMIT_GRACE_MS + 1);
        await settled(generation);
        expect(readChat()).toHaveLength(4);
    });

    test('a late claim takes the commit back so the page can save its own copy', async () => {
        const original = fs.readFileSync(chatFile, 'utf8');
        const { generation, finish } = startGeneration('d'.repeat(32));
        generation.detach();
        finish();
        await settled(generation);
        expect(readChat()).toHaveLength(4);

        await expect(generation.claim()).resolves.toBe('claimed');
        const records = readChat();
        expect(records).toHaveLength(3);
        expect(records[0].chat_metadata.integrity).toBe('slug-1');
        expect(records).toEqual(original.trim().split('\n').map(line => JSON.parse(line)));
    });

    test('a late claim leaves the commit alone once something else saved over it', async () => {
        const { generation, finish } = startGeneration('e'.repeat(32));
        generation.detach();
        finish();
        await settled(generation);
        const records = readChat();
        records[0].chat_metadata.integrity = 'someone-else';
        fs.writeFileSync(chatFile, records.map(record => JSON.stringify(record)).join('\n'));

        await expect(generation.claim()).resolves.toBe('committed');
        expect(readChat()).toHaveLength(4);
    });

    test('a detached generation does not overwrite a chat that moved on', async () => {
        const { generation, finish } = startGeneration('f'.repeat(32));
        generation.detach();
        const records = [...chatRecords(), message('User', true, 'Never mind.', '2026-10-03T10:00:10.000Z')];
        fs.writeFileSync(chatFile, records.map(record => JSON.stringify(record)).join('\n'));
        finish();
        await settled(generation);

        expect(generation.commit).toMatchObject({ state: 'failed', reason: 'chat-changed' });
        expect(readChat()).toEqual(records);
    });

    test('stop-and-keep commits what was generated before the stop', async () => {
        const { generation, response } = startGeneration('0'.repeat(31) + '1');
        response.write('data: {"choices":[{"delta":{"content":"The forest"}}]}\n\n');
        generation.stopAndCommit();
        // The provider handler ends the response once its upstream request is aborted.
        response.end();
        await settled(generation);

        expect(generation.commit.state).toBe('committed');
        expect(readChat()[3].mes).toBe('The forest');
    });
});
