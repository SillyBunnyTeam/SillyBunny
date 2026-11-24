import { describe, expect, test } from '@jest/globals';

import { createSerialQueue } from '../public/scripts/sillybunny-conversation/conversation-data-queue.js';
import { describeSyncedMessages, rebaseChat } from '../public/scripts/sillybunny-conversation/conversation-data-merge.js';

const msg = (id, mes, created = Number(id.replace(/\D/g, '')) || 0, extra = {}) => ({ id, role: 'character', name: 'Her', mes, created_at: created, extra, ...extra });
const header = (integrity = 's1', memory = null) => ({ chat_metadata: { integrity, ...(memory ? { sb_conversation: memory } : {}) }, user_name: 'unused', character_name: 'unused' });

describe('rebaseChat', () => {
    const base = [msg('m1', 'one'), msg('m2', 'two')];
    const synced = describeSyncedMessages(base);

    test('keeps the messages that the server has and adds the ones that only this page wrote', () => {
        const server = [header('s2'), ...base, msg('m3', 'three, from the server')];
        const local = [...base, msg('m4', 'four, mine')];

        const result = rebaseChat({ localMessages: local, localHeader: header('s1'), synced, serverRecords: server });

        expect(result.messages.map(item => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
        expect(result.header.chat_metadata.integrity).toBe('s2');
        expect(result).toMatchObject({ appended: 1, lostEdits: 0, lostDeletes: 0 });
    });

    test('puts a local message among the server messages by its time and keeps equal times in order', () => {
        const server = [header('s2'), msg('m1', 'one', 10), msg('m3', 'three', 30), msg('m5', 'five', 50)];
        const local = [msg('m1', 'one', 10), msg('m4', 'four', 40), msg('m6', 'six', 50)];

        const result = rebaseChat({ localMessages: local, localHeader: header(), synced: describeSyncedMessages([msg('m1', 'one', 10)]), serverRecords: server });

        expect(result.messages.map(item => item.id)).toEqual(['m1', 'm3', 'm4', 'm5', 'm6']);
    });

    test('lets the server win over a local edit and counts it', () => {
        const server = [header('s2'), msg('m1', 'one'), msg('m2', 'two, edited elsewhere')];
        const local = [msg('m1', 'one, edited here'), msg('m2', 'two')];

        const result = rebaseChat({ localMessages: local, localHeader: header(), synced, serverRecords: server });

        expect(result.messages.map(item => item.mes)).toEqual(['one', 'two, edited elsewhere']);
        expect(result.lostEdits).toBe(1);
    });

    test('does not count a message that changed only on the server as a lost edit', () => {
        const server = [header('s2'), msg('m1', 'one'), msg('m2', 'two, edited elsewhere')];

        const result = rebaseChat({ localMessages: base, localHeader: header(), synced, serverRecords: server });

        expect(result.lostEdits).toBe(0);
        expect(result.messages[1].mes).toBe('two, edited elsewhere');
    });

    test('brings back a message that was deleted here and still exists on the server, and counts it', () => {
        const server = [header('s2'), ...base];

        const result = rebaseChat({ localMessages: [base[0]], localHeader: header(), synced, serverRecords: server });

        expect(result.messages.map(item => item.id)).toEqual(['m1', 'm2']);
        expect(result.lostDeletes).toBe(1);
    });

    test('drops a message that another writer deleted and that this page did not touch', () => {
        const server = [header('s2'), base[0]];

        const result = rebaseChat({ localMessages: base, localHeader: header(), synced, serverRecords: server });

        expect(result.messages.map(item => item.id)).toEqual(['m1']);
        expect(result).toMatchObject({ appended: 0, lostEdits: 0, lostDeletes: 0 });
    });

    test('keeps the newer memory summary of the two headers', () => {
        const newer = { memory_summary: 'mine', memory_message_count: 4, memory_updated_at: 200 };
        const older = { memory_summary: 'theirs', memory_message_count: 2, memory_updated_at: 100 };

        expect(rebaseChat({ localMessages: base, localHeader: header('s1', newer), synced, serverRecords: [header('s2', older), ...base] }).header.chat_metadata.sb_conversation).toEqual(newer);
        expect(rebaseChat({ localMessages: base, localHeader: header('s1', older), synced, serverRecords: [header('s2', newer), ...base] }).header.chat_metadata.sb_conversation).toEqual(newer);
    });

    test('does not change the arrays that it was given', () => {
        const local = [...base, msg('m4', 'four')];
        const server = [header('s2'), ...base];
        const before = JSON.stringify({ local, server });

        rebaseChat({ localMessages: local, localHeader: header(), synced, serverRecords: server });

        expect(JSON.stringify({ local, server })).toBe(before);
    });
});

describe('createSerialQueue', () => {
    test('runs tasks one after another in the order they were added', async () => {
        const queue = createSerialQueue();
        const log = [];
        const first = queue.run(async () => {
            log.push('first start');
            await Promise.resolve();
            await Promise.resolve();
            log.push('first end');
            return 1;
        });
        const second = queue.run(async () => {
            log.push('second');
            return 2;
        });

        expect(await Promise.all([first, second])).toEqual([1, 2]);
        expect(log).toEqual(['first start', 'first end', 'second']);
    });

    test('goes on after a task that failed, and gives its error to its own caller only', async () => {
        const queue = createSerialQueue();
        const failing = queue.run(async () => {
            throw new Error('nope');
        });
        const next = queue.run(async () => 'ok');

        await expect(failing).rejects.toThrow('nope');
        await expect(next).resolves.toBe('ok');
    });

    test('says when it is idle, and how many tasks are waiting or running', async () => {
        const queue = createSerialQueue();
        expect(queue.size).toBe(0);
        let release;
        const task = queue.run(() => new Promise((resolve) => {
            release = resolve;
        }));
        expect(queue.size).toBe(1);
        const idle = queue.idle();
        await new Promise(resolve => setTimeout(resolve, 0));
        release();
        await task;
        await idle;
        expect(queue.size).toBe(0);
    });
});
