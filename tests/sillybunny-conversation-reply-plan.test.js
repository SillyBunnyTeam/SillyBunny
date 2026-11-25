import { describe, expect, test } from '@jest/globals';

import { encodeCommitPlan, hashCommitText, normalizeCommitPlan } from '../public/scripts/generation-commit-plan.js';
import { getConversationMessageRevision } from '../public/scripts/sillybunny-conversation/message-identity-utils.js';
import { createConversationReplyPlan, createReplyToken } from '../public/scripts/sillybunny-conversation/reply-commit-plan.js';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const TOKEN = '0123456789abcdef';
const ADDRESS = { conversationId: 'conv_1732550000000_abc123', chatId: 'main' };

function message(id, role, text, extra = {}) {
    return { id, role, name: role === 'user' ? 'You' : 'Nova', mes: text, created_at: NOW - 10_000, extra };
}

const MESSAGES = [message('g1', 'character', 'Greetings.'), message('u1', 'user', 'Hello there.'), message('u2', 'user', 'Are you there?')];
const revisionHash = item => hashCommitText(getConversationMessageRevision(item));

function build(overrides = {}) {
    return createConversationReplyPlan({
        address: ADDRESS,
        queueItem: { messageIds: ['u1', 'u2'], replyTarget: null },
        speaker: { avatar: 'Nova.png', name: 'Nova' },
        anchorAvatar: 'Nova.png',
        route: 'profile',
        messages: MESSAGES,
        round: [],
        token: TOKEN,
        pageId: 'page-a',
        now: NOW,
        roundStarted: NOW - 3000,
        ...overrides,
    });
}

describe('the commit plan of a queued reply', () => {
    test('is a plan that the server accepts, with the owner, the chat, the speaker and the token', () => {
        const plan = build();

        expect(plan).not.toBeNull();
        expect(normalizeCommitPlan(plan)).not.toBeNull();
        expect(plan).toMatchObject({
            v: 1,
            chat: { conversation: ADDRESS.conversationId },
            file: 'main',
            kind: 'reply',
            index: 3,
            started: new Date(NOW).toISOString(),
            page: 'page-a',
            round: [],
            message: { name: 'Nova', original_avatar: 'Nova.png' },
            reply: { token: TOKEN, speaker: 'Nova.png', anchor: 'Nova.png', origin: 'reply', route: 'profile', target: null, needs_user: false, round_started: NOW - 3000 },
        });
    });

    test('names the messages that it answers with the hash of their revision as the page holds them now', () => {
        const plan = build();

        expect(plan.reply.triggers).toEqual([{ id: 'u1', rev: revisionHash(MESSAGES[1]) }, { id: 'u2', rev: revisionHash(MESSAGES[2]) }]);
        expect(plan.reply.triggers.every(trigger => /^[0-9a-f]{8}$/.test(trigger.rev))).toBe(true);
    });

    test('does not change its triggers when the page marks a message with the token or the round of a reply', () => {
        const before = build().reply.triggers;
        const marked = MESSAGES.map(item => ({ ...item, extra: { ...item.extra, reply_token: TOKEN, conversation_round: { remaining: [], started: 1, triggers: [] } } }));

        expect(build({ messages: marked }).reply.triggers).toEqual(before);
    });

    test('keeps the last 24 triggers of a long queue item, so that the header stays under its limit', () => {
        const many = Array.from({ length: 40 }, (_, index) => message(`user-message-${index}`, 'user', `text ${index}`));

        const plan = build({ queueItem: { messageIds: many.map(item => item.id), replyTarget: null }, messages: many });

        expect(plan.reply.triggers).toHaveLength(24);
        expect(plan.reply.triggers[0].id).toBe('user-message-16');
        expect(plan.reply.triggers[23].id).toBe('user-message-39');
    });

    test('stays under the header limit with every string at its longest', () => {
        const id = suffix => `${suffix}-${'x'.repeat(60)}`.slice(0, 64);
        const many = Array.from({ length: 24 }, (_, index) => message(id(`m${index}`), 'user', `text ${index}`));
        const plan = createConversationReplyPlan({
            address: { conversationId: `conv_${'a'.repeat(59)}`, chatId: `chat_${'b'.repeat(59)}` },
            queueItem: { messageIds: many.map(item => item.id), replyTarget: { messageId: many[0].id } },
            speaker: { avatar: `${'s'.repeat(251)}.png`, name: 'N'.repeat(120) },
            anchorAvatar: `${'a'.repeat(251)}.png`,
            route: 'raw',
            messages: many.map(item => ({ ...item, extra: { conversation_reply_to: { messageId: id('m0') } } })),
            round: [`${'r'.repeat(251)}.png`],
            token: 'f'.repeat(32),
            pageId: 'p'.repeat(32),
            now: NOW,
            roundStarted: NOW,
        });

        expect(plan).not.toBeNull();
        expect(encodeCommitPlan(plan).length).toBeLessThanOrEqual(8192);
    });

    test('carries the message that the user chose to reply to, with its revision, and none otherwise', () => {
        const target = message('g1', 'character', 'Greetings.');
        const answered = { ...MESSAGES[2], extra: { conversation_reply_to: { messageId: 'g1' } } };
        const messages = [target, MESSAGES[1], answered];

        const plan = build({ messages, queueItem: { messageIds: ['u1', 'u2'], replyTarget: { messageId: 'g1' } } });

        expect(plan.reply.target).toEqual({ id: 'g1', rev: revisionHash(target) });
        expect(build().reply.target).toBeNull();
    });

    test('lists the members that still have to speak after this reply, and a member speaks under its own avatar', () => {
        const plan = build({ speaker: { avatar: 'Orion.png', name: 'Orion' }, round: ['Pip.png'] });

        expect(plan.round).toEqual(['Pip.png']);
        expect(plan.reply).toMatchObject({ speaker: 'Orion.png', anchor: 'Nova.png' });
        expect(plan.message.original_avatar).toBe('Orion.png');
    });

    test('is none when a message that the reply answers is not in the chat, so that the page then writes the reply itself', () => {
        expect(build({ queueItem: { messageIds: ['u1', 'gone'], replyTarget: null } })).toBeNull();
        expect(build({ queueItem: { messageIds: [], replyTarget: null } })).not.toBeNull();
    });

    test('is none for a plan that the server would refuse, never a plan that is dropped on the way', () => {
        expect(build({ round: ['a.png', 'b.png', 'c.png'] })).toBeNull();
        expect(build({ token: 'not hex' })).toBeNull();
        expect(build({ address: { conversationId: 'has:colon', chatId: 'main' } })).toBeNull();
    });

    test('gives a speaker without a name a placeholder, and cuts a long name to the limit', () => {
        expect(build({ speaker: { avatar: 'Nova.png', name: '' } }).message.name).toBe('Character');
        expect(build({ speaker: { avatar: 'Nova.png', name: 'x'.repeat(300) } }).message.name).toHaveLength(120);
    });

    test('records the route, which decides how the page cleans the text that the server wrote', () => {
        expect(build({ route: 'raw' }).reply.route).toBe('raw');
    });
});

describe('the token of a reply', () => {
    test('is 16 hex characters, and two replies do not share one', () => {
        const first = createReplyToken();
        const second = createReplyToken();

        expect(first).toMatch(/^[0-9a-f]{16}$/);
        expect(second).not.toBe(first);
    });
});
