import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';

import {
    coalesceConversationQueueItems,
    drainSameThreadItems,
    isSameConversationQueueThread,
    mergeConversationQueueItems,
} from '../public/scripts/sillybunny-conversation/send-queue-utils.js';

function makeItem(text, overrides = {}) {
    return {
        avatar: 'charA.png',
        groupId: '',
        text,
        attachmentContext: '',
        createdAt: Date.now(),
        ...overrides,
    };
}

describe('sillybunny conversation send-queue utils', () => {
    describe('isSameConversationQueueThread', () => {
        test('matches same avatar and group', () => {
            const a = makeItem('hi');
            const b = makeItem('yo');
            expect(isSameConversationQueueThread(a, b)).toBe(true);
        });

        test('differs on avatar', () => {
            expect(isSameConversationQueueThread(makeItem('a'), makeItem('b', { avatar: 'charB.png' }))).toBe(false);
        });

        test('differs on groupId', () => {
            expect(isSameConversationQueueThread(makeItem('a', { groupId: 'g1' }), makeItem('b', { groupId: 'g2' }))).toBe(false);
        });

        test('differs when either is forced', () => {
            expect(isSameConversationQueueThread(makeItem('a', { force: true }), makeItem('b'))).toBe(false);
            expect(isSameConversationQueueThread(makeItem('a'), makeItem('b', { force: true }))).toBe(false);
        });

        test('handles null inputs', () => {
            expect(isSameConversationQueueThread(null, makeItem('a'))).toBe(false);
            expect(isSameConversationQueueThread(makeItem('a'), null)).toBe(false);
        });
    });

    describe('mergeConversationQueueItems', () => {
        test('returns the single item as-is for a one-element array', () => {
            const item = makeItem('only');
            expect(mergeConversationQueueItems([item])).toBe(item);
        });

        test('returns null for an empty array', () => {
            expect(mergeConversationQueueItems([])).toBe(null);
        });

        test('joins texts and attachment contexts with a blank line', () => {
            const merged = mergeConversationQueueItems([
                makeItem('one', { attachmentContext: 'att1' }),
                makeItem('two', { attachmentContext: 'att2' }),
                makeItem('three', { attachmentContext: '' }),
            ]);
            expect(merged.text).toBe('one\n\ntwo\n\nthree');
            expect(merged.attachmentContext).toBe('att1\n\natt2');
            expect(merged.messageCount).toBe(3);
        });

        test('preserves earliest createdAt and records latest as latestQueuedAt', () => {
            const merged = mergeConversationQueueItems([
                makeItem('one', { createdAt: 1000 }),
                makeItem('two', { createdAt: 3000 }),
                makeItem('three', { createdAt: 2000 }),
            ]);
            expect(merged.createdAt).toBe(1000);
            expect(merged.latestQueuedAt).toBe(2000);
        });
    });

    describe('drainSameThreadItems', () => {
        test('shifts consecutive same-thread items off the queue front', () => {
            const queue = [makeItem('b'), makeItem('c')];
            const items = drainSameThreadItems(makeItem('a'), queue);
            expect(items.map(i => i.text)).toEqual(['a', 'b', 'c']);
            expect(queue).toHaveLength(0);
        });

        test('stops at a different-thread item, leaving it in the queue', () => {
            const queue = [makeItem('b'), makeItem('c', { avatar: 'charB.png' }), makeItem('d')];
            const items = drainSameThreadItems(makeItem('a'), queue);
            expect(items.map(i => i.text)).toEqual(['a', 'b']);
            expect(queue.map(i => i.text)).toEqual(['c', 'd']);
        });
    });

    describe('coalesceConversationQueueItems', () => {
        test('returns null for falsy first item', async () => {
            const result = await coalesceConversationQueueItems(null, [], { timeoutRef: () => 0 });
            expect(result).toBe(null);
        });

        test('returns force items immediately without waiting', async () => {
            let waited = false;
            const timeoutRef = () => { waited = true; return 0; };
            const item = makeItem('forced', { force: true });
            const result = await coalesceConversationQueueItems(item, [], { timeoutRef });
            expect(result).toBe(item);
            expect(waited).toBe(false);
        });

        test('skips waiting when windowMs <= 0', async () => {
            let waited = false;
            const timeoutRef = () => { waited = true; return 0; };
            const item = makeItem('a');
            const result = await coalesceConversationQueueItems(item, [], { windowMs: 0, timeoutRef });
            expect(result).toBe(item);
            expect(waited).toBe(false);
        });

        test('returns a single item when no follow-ups arrive within the window', async () => {
            const timeoutRef = (resolve) => { setTimeout(resolve, 0); return 0; };
            const result = await coalesceConversationQueueItems(makeItem('only'), [], { timeoutRef });
            expect(result.text).toBe('only');
            expect(result.messageCount).toBeUndefined();
        });

        test('merges follow-up messages that are already queued (accumulated during generation)', async () => {
            const timeoutRef = (resolve) => { setTimeout(resolve, 0); return 0; };
            const queue = [makeItem('second'), makeItem('third')];
            const result = await coalesceConversationQueueItems(makeItem('first'), queue, { timeoutRef });
            expect(result.text).toBe('first\n\nsecond\n\nthird');
            expect(result.messageCount).toBe(3);
            expect(queue).toHaveLength(0);
        });

        test('does not merge items from a different thread', async () => {
            const timeoutRef = (resolve) => { setTimeout(resolve, 0); return 0; };
            const queue = [makeItem('other', { avatar: 'charB.png' })];
            const result = await coalesceConversationQueueItems(makeItem('first'), queue, { timeoutRef });
            expect(result.text).toBe('first');
            expect(queue).toHaveLength(1);
        });

        test('extends the window when a new message arrives mid-wait', async () => {
            let rounds = 0;
            const timeoutRef = (resolve) => {
                rounds++;
                setTimeout(resolve, 0);
                return 0;
            };

            const queue = [];
            const firstItem = makeItem('first');
            const promise = coalesceConversationQueueItems(firstItem, queue, { windowMs: 1500, timeoutRef });

            queue.push(makeItem('second'));
            const result = await promise;

            expect(result.text).toBe('first\n\nsecond');
            expect(result.messageCount).toBe(2);
            expect(rounds).toBeGreaterThanOrEqual(2);
        });
    });

    describe('coalesceConversationQueueItems with fake timers', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => {
            jest.runOnlyPendingTimers();
            jest.useRealTimers();
        });

        test('waits the full window when no follow-ups arrive', async () => {
            const queue = [];
            const promise = coalesceConversationQueueItems(makeItem('only'), queue, { windowMs: 1500 });
            await jest.advanceTimersByTimeAsync(1500);
            const result = await promise;
            expect(result.text).toBe('only');
            expect(queue).toHaveLength(0);
        });

        test('coalesces a message that arrives during the window and extends it', async () => {
            const queue = [];
            const promise = coalesceConversationQueueItems(makeItem('first'), queue, { windowMs: 1500 });

            await jest.advanceTimersByTimeAsync(500);
            queue.push(makeItem('second'));

            await jest.advanceTimersByTimeAsync(1000);
            await jest.advanceTimersByTimeAsync(1500);

            const result = await promise;
            expect(result.text).toBe('first\n\nsecond');
            expect(result.messageCount).toBe(2);
        });

        test('coalesces a burst of messages arriving during successive windows', async () => {
            const queue = [];
            const promise = coalesceConversationQueueItems(makeItem('msg1'), queue, { windowMs: 1500 });

            await jest.advanceTimersByTimeAsync(300);
            queue.push(makeItem('msg2'));

            await jest.advanceTimersByTimeAsync(1500);
            queue.push(makeItem('msg3'));

            await jest.advanceTimersByTimeAsync(1500);
            await jest.advanceTimersByTimeAsync(1500);

            const result = await promise;
            expect(result.text).toBe('msg1\n\nmsg2\n\nmsg3');
            expect(result.messageCount).toBe(3);
        });
    });
});
