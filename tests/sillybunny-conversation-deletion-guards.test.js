import { readFileSync } from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

import {
    createGenerationTargets,
    createTargetCheck,
    dropQueuedReplies,
    installPageLeaveEffects,
    installRemovalEffects,
    isTargetOfRemoval,
    removeQueueItems,
} from '../public/scripts/sillybunny-conversation/deletion-guards.js';

const item = (conversationKey, chatId, extra = {}) => ({ conversationKey, chatId, avatar: 'Nova.png', messageIds: [], ...extra });

describe('which items a removal takes', () => {
    test('a removed conversation takes every chat of it', () => {
        expect(isTargetOfRemoval({ conversationId: 'conv_a' }, { conversationId: 'conv_a', chatId: 'one' })).toBe(true);
        expect(isTargetOfRemoval({ conversationId: 'conv_a' }, { conversationId: 'conv_b', chatId: 'one' })).toBe(false);
    });

    test('a removed chat takes only that chat', () => {
        expect(isTargetOfRemoval({ conversationId: 'conv_a', chatId: 'one' }, { conversationId: 'conv_a', chatId: 'one' })).toBe(true);
        expect(isTargetOfRemoval({ conversationId: 'conv_a', chatId: 'one' }, { conversationId: 'conv_a', chatId: 'two' })).toBe(false);
    });
});

describe('removing items from the queue', () => {
    test('takes the items that match out of the queue in place, and answers them in the order of the queue', () => {
        const queue = [item('conv_a', 'one'), item('conv_b', 'two'), item('conv_a', 'three')];
        const same = queue;

        const removed = removeQueueItems(queue, queued => queued.conversationKey === 'conv_a');

        expect(queue).toBe(same);
        expect(queue).toEqual([item('conv_b', 'two')]);
        expect(removed.map(queued => queued.chatId)).toEqual(['one', 'three']);
    });

    test('leaves the queue alone when nothing matches', () => {
        const queue = [item('conv_a', 'one')];

        expect(removeQueueItems(queue, () => false)).toEqual([]);
        expect(queue).toHaveLength(1);
    });
});

describe('the replies that wait in the queue', () => {
    test('are dropped for a removed conversation, including a forced reply that names no message', () => {
        const queue = [
            item('conv_a', 'one', { messageIds: ['m1'] }),
            item('conv_a', 'two', { force: true }),
            item('conv_b', 'one', { messageIds: ['m9'] }),
        ];

        const dropped = dropQueuedReplies(queue, { conversationId: 'conv_a' });

        expect(dropped).toBe(2);
        expect(queue).toEqual([item('conv_b', 'one', { messageIds: ['m9'] })]);
    });

    test('are dropped for a removed chat only, and the queue is changed in place', () => {
        const queue = [item('conv_a', 'one', { force: true }), item('conv_a', 'two'), item('conv_a', 'one')];
        const same = queue;

        expect(dropQueuedReplies(queue, { conversationId: 'conv_a', chatId: 'one' })).toBe(2);

        expect(queue).toBe(same);
        expect(queue).toEqual([item('conv_a', 'two')]);
    });

    test('are left alone when nothing matches', () => {
        const queue = [item('conv_b', 'one')];

        expect(dropQueuedReplies(queue, { conversationId: 'conv_a' })).toBe(0);
        expect(queue).toHaveLength(1);
    });
});

describe('the replies that are being generated', () => {
    test('are cancelled for a removed conversation, whatever the chat, and not for another conversation', () => {
        const targets = createGenerationTargets();
        const first = targets.begin({ conversationId: 'conv_a', chatId: 'one' });
        const second = targets.begin({ conversationId: 'conv_a', chatId: 'two' });
        const other = targets.begin({ conversationId: 'conv_b', chatId: 'one' });

        targets.cancel({ conversationId: 'conv_a' });

        expect([first.signal.aborted, second.signal.aborted, other.signal.aborted]).toEqual([true, true, false]);
    });

    test('are cancelled for a removed chat only', () => {
        const targets = createGenerationTargets();
        const first = targets.begin({ conversationId: 'conv_a', chatId: 'one' });
        const second = targets.begin({ conversationId: 'conv_a', chatId: 'two' });

        targets.cancel({ conversationId: 'conv_a', chatId: 'one' });

        expect([first.signal.aborted, second.signal.aborted]).toEqual([true, false]);
    });

    test('are forgotten when they end, so that a later cancel does not touch them', () => {
        const targets = createGenerationTargets();
        const running = targets.begin({ conversationId: 'conv_a', chatId: 'one' });
        running.end();

        targets.cancel({ conversationId: 'conv_a' });

        expect(running.signal.aborted).toBe(false);
        expect(targets.size).toBe(0);
    });

    test('a generation that has no conversation yet is not tracked and never cancelled', () => {
        const targets = createGenerationTargets();

        const untracked = targets.begin(null);

        expect(untracked.signal.aborted).toBe(false);
        expect(targets.size).toBe(0);
        expect(() => untracked.end()).not.toThrow();
    });
});

describe('a reply that finds its target', () => {
    const view = { id: 'conv_a', chats: [{ id: 'one', hasUserMessage: true }, { id: 'two', hasUserMessage: false }] };
    const read = id => (id === 'conv_a' ? view : null);

    test('is valid while the conversation and the chat exist', () => {
        expect(createTargetCheck(read, { conversationId: 'conv_a', chatId: 'one' })()).toBe(true);
    });

    test('is not valid once the chat is gone, or the conversation', () => {
        expect(createTargetCheck(read, { conversationId: 'conv_a', chatId: 'gone' })()).toBe(false);
        expect(createTargetCheck(read, { conversationId: 'conv_b', chatId: 'one' })()).toBe(false);
    });

    test('is not valid for an automatic message when the chat has no message from the user, and valid for one that needs none', () => {
        expect(createTargetCheck(read, { conversationId: 'conv_a', chatId: 'two' }, { needsUserMessage: true })()).toBe(false);
        expect(createTargetCheck(read, { conversationId: 'conv_a', chatId: 'two' }, { needsUserMessage: false })()).toBe(true);
        expect(createTargetCheck(read, { conversationId: 'conv_a', chatId: 'one' }, { needsUserMessage: true })()).toBe(true);
    });

    test('reads the chat again on each call, so that a deletion after the start makes it invalid', () => {
        const live = { id: 'conv_a', chats: [{ id: 'one', hasUserMessage: true }] };
        const check = createTargetCheck(() => live, { conversationId: 'conv_a', chatId: 'one' });

        expect(check()).toBe(true);
        live.chats = [];
        expect(check()).toBe(false);
    });
});

describe('installing the effects of a removal', () => {
    test('cancels the replies in progress and empties the queue of the target when the data module announces it', () => {
        const listeners = [];
        const onRemoval = jest.fn((listener) => {
            listeners.push(listener);
            return () => {};
        });
        const targets = createGenerationTargets();
        const running = targets.begin({ conversationId: 'conv_a', chatId: 'one' });
        const queue = [item('conv_a', 'one', { force: true }), item('conv_b', 'one')];

        installRemovalEffects({ onRemoval, queue, targets });
        listeners[0]({ conversationId: 'conv_a', chatId: 'one' });

        expect(running.signal.aborted).toBe(true);
        expect(queue).toEqual([item('conv_b', 'one')]);
    });

    test('returns the function that removes the listener', () => {
        const stop = jest.fn();

        const result = installRemovalEffects({ onRemoval: () => stop, queue: [], targets: createGenerationTargets() });
        result();

        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe('a page that is closing', () => {
    test('stops the replies that it is reading, so that none of them is claimed by a page that can no longer save it', () => {
        const targets = createGenerationTargets();
        const first = targets.begin({ conversationId: 'conv_a', chatId: 'one' });
        const second = targets.begin({ conversationId: 'conv_b', chatId: 'two' });

        targets.abortAll();

        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
    });

    test('does this when the page is hidden for good, and not when it goes to the back-forward cache, which can bring it back', () => {
        const targets = createGenerationTargets();
        const page = new EventTarget();
        installPageLeaveEffects({ target: page, targets });
        const kept = targets.begin({ conversationId: 'conv_a', chatId: 'one' });

        page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
        expect(kept.signal.aborted).toBe(false);

        page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
        expect(kept.signal.aborted).toBe(true);
    });

    test('stops listening when the function that it returns is called', () => {
        const targets = createGenerationTargets();
        const page = new EventTarget();
        const remove = installPageLeaveEffects({ target: page, targets });
        const running = targets.begin({ conversationId: 'conv_a', chatId: 'one' });

        remove();
        page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));

        expect(running.signal.aborted).toBe(false);
    });

    test('is wired when the mode starts', () => {
        expect(readFileSync(new URL('../public/scripts/sillybunny-conversation/init.js', import.meta.url), 'utf8')).toContain('installPageLeaveEffects({ target: window, targets: generationTargets });');
    });
});
