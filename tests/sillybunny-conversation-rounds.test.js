import { describe, expect, test } from '@jest/globals';

import {
    ROUND_RESUME_WINDOW_MS,
    createRoundMarker,
    findRoundToResume,
    roundMayContinue,
} from '../public/scripts/sillybunny-conversation/rounds.js';
import { createConversationMessageRevisionEntries, createConversationQueueItem } from '../public/scripts/sillybunny-conversation/send-queue-utils.js';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const MINUTE = 60_000;

const message = (id, role, text = id, extra = {}) => ({ id, role, name: role === 'user' ? 'You' : 'Nova', mes: text, created_at: NOW, extra });
const marker = (overrides = {}) => ({ remaining: ['Orion.png'], started: NOW - 5 * MINUTE, triggers: ['u1'], ...overrides });

describe('the marker of a round', () => {
    test('names the members still to speak, when the round began and the messages that it answers', () => {
        expect(createRoundMarker({ remaining: ['Orion.png'], started: 7, triggers: ['u1', 'u2'] })).toEqual({ remaining: ['Orion.png'], started: 7, triggers: ['u1', 'u2'] });
    });

    test('is a copy, so that a later change to the lists of the round does not reach a message', () => {
        const remaining = ['Orion.png'];
        const made = createRoundMarker({ remaining, started: 7, triggers: [] });
        remaining.push('Pip.png');

        expect(made.remaining).toEqual(['Orion.png']);
    });
});

describe('a round that a page can resume', () => {
    const chat = (...extra) => [message('g1', 'character'), message('u1', 'user'), ...extra];

    test('is found on the last message of the chat, within 30 minutes of its start, when it answers the last user message', () => {
        const messages = chat(message('c1', 'character', 'one', { conversation_round: marker() }));

        expect(findRoundToResume(messages, NOW)).toEqual(marker());
    });

    test('is not found once the 30 minutes are over, and is found at the very end of them', () => {
        const messages = chat(message('c1', 'character', 'one', { conversation_round: marker({ started: NOW - ROUND_RESUME_WINDOW_MS }) }));

        expect(findRoundToResume(messages, NOW)).not.toBeNull();
        expect(findRoundToResume(messages, NOW + 1)).toBeNull();
    });

    test('is not found when the marker is not on the last message: somebody wrote after it', () => {
        const messages = chat(message('c1', 'character', 'one', { conversation_round: marker() }), message('c2', 'character', 'two'));

        expect(findRoundToResume(messages, NOW)).toBeNull();
    });

    test('is not found when the user wrote again after the messages that the round answers', () => {
        const messages = chat(message('u2', 'user', 'a second question'), message('c1', 'character', 'one', { conversation_round: marker({ triggers: ['u1'] }) }));

        expect(findRoundToResume(messages, NOW)).toBeNull();
    });

    test('is found when the user message that it answers is the last one of several that it answers', () => {
        const messages = [message('u1', 'user'), message('u2', 'user'), message('c1', 'character', 'one', { conversation_round: marker({ triggers: ['u1', 'u2'] }) })];

        expect(findRoundToResume(messages, NOW)).not.toBeNull();
    });

    test('is not found when nobody is left to speak, or the marker is not well formed', () => {
        for (const broken of [marker({ remaining: [] }), { remaining: 'Orion.png', started: NOW, triggers: ['u1'] }, { remaining: ['Orion.png'], started: 'soon', triggers: ['u1'] }, { remaining: [3], started: NOW, triggers: ['u1'] }, null, 'x']) {
            expect(findRoundToResume(chat(message('c1', 'character', 'one', { conversation_round: broken })), NOW)).toBeNull();
        }
    });

    test('is not found in an empty chat or a chat whose last message has no marker', () => {
        expect(findRoundToResume([], NOW)).toBeNull();
        expect(findRoundToResume(chat(message('c1', 'character')), NOW)).toBeNull();
    });

    test('is not found for a round that began in the future of this clock by more than a minute', () => {
        const messages = chat(message('c1', 'character', 'one', { conversation_round: marker({ started: NOW + 2 * MINUTE }) }));

        expect(findRoundToResume(messages, NOW)).toBeNull();
    });
});

describe('whether a round goes on to its next member', () => {
    const trigger = message('u1', 'user', 'hello');
    const item = (overrides = {}) => createConversationQueueItem({
        avatar: 'Nova.png',
        chatId: 'main',
        conversationKey: 'conv_1',
        messageIds: ['u1'],
        messageRevisions: createConversationMessageRevisionEntries([trigger]),
        ...overrides,
    });
    const may = (messages, queue = []) => roundMayContinue({ queueItem: item(), messages, queue });

    test('does when nothing changed since the round began', () => {
        expect(may([message('g1', 'character'), trigger, message('c1', 'character', 'first member')])).toBe(true);
    });

    test('does not when the user wrote a newer message', () => {
        expect(may([trigger, message('c1', 'character'), message('u2', 'user', 'wait')])).toBe(false);
    });

    test('does not when a message that the round answers was edited or deleted', () => {
        expect(may([{ ...trigger, mes: 'hello, edited' }, message('c1', 'character')])).toBe(false);
        expect(may([message('c1', 'character')])).toBe(false);
    });

    test('does not when a reply of this conversation and chat waits in the queue, forced or not, and does for one of another chat', () => {
        const messages = [trigger, message('c1', 'character')];

        expect(may(messages, [item({ conversationKey: 'conv_1', chatId: 'main', force: true })])).toBe(false);
        expect(may(messages, [item({ conversationKey: 'conv_1', chatId: 'main' })])).toBe(false);
        expect(may(messages, [item({ conversationKey: 'conv_1', chatId: 'trip' })])).toBe(true);
        expect(may(messages, [item({ conversationKey: 'conv_2', chatId: 'main' })])).toBe(true);
    });

    test('does for a round that answers a forced reply with no new message, which names the last user message', () => {
        const forced = createConversationQueueItem({ avatar: 'Nova.png', chatId: 'main', conversationKey: 'conv_1', force: true, messageIds: ['u1'], messageRevisions: createConversationMessageRevisionEntries([trigger]) });

        expect(roundMayContinue({ queueItem: forced, messages: [trigger, message('c1', 'character')], queue: [] })).toBe(true);
    });
});

describe('a queue item that carries a round', () => {
    test('keeps the members that remain and when the round began, and has none otherwise', () => {
        const resumed = createConversationQueueItem({ avatar: 'Nova.png', chatId: 'main', round: { remaining: ['Orion.png', 7, ''], started: 12 } });

        expect(resumed.round).toEqual({ remaining: ['Orion.png'], started: 12 });
        expect(createConversationQueueItem({ avatar: 'Nova.png', chatId: 'main' }).round).toBeNull();
        expect(createConversationQueueItem({ avatar: 'Nova.png', chatId: 'main', round: { remaining: [], started: 12 } }).round).toBeNull();
    });
});
