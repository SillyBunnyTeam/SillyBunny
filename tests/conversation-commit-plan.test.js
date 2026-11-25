import { describe, expect, test } from '@jest/globals';

import {
    GENERATION_COMMIT_KINDS,
    decodeCommitPlan,
    encodeCommitPlan,
    getCommitChatKey,
    normalizeCommitPlan,
} from '../public/scripts/generation-commit-plan.js';
import { parseConversationChatKey } from '../public/scripts/conversation-commit-plan.js';

const CONVERSATION = 'conv_1700000000000_abcdef0123';
const TOKEN = 'a1b2c3d4e5f60718';
const REMINDER = 'rem_1760000000000_abc123';
const STARTED = '2026-10-03T10:00:00.000Z';

function conversationPlan(overrides = {}) {
    return {
        v: 1,
        chat: { conversation: CONVERSATION },
        file: 'main',
        kind: 'reply',
        index: 4,
        started: STARTED,
        page: 'page-a',
        round: ['Lyra.png'],
        message: { name: 'Nova', force_avatar: null, original_avatar: 'Nova.png', extra: { api: '', model: '', reasoning_effort: null, gen_id: null } },
        reply: {
            token: TOKEN,
            speaker: 'Nova.png',
            anchor: 'Nova.png',
            origin: 'reply',
            route: 'profile',
            triggers: [{ id: '1760000000000-abc123', rev: '0a1b2c3d' }],
            target: null,
            needs_user: false,
            round_started: 1760000000000,
        },
        ...overrides,
    };
}

function withReply(patch) {
    return conversationPlan({ reply: { ...conversationPlan().reply, ...patch } });
}

function roleplayPlan(overrides = {}) {
    return {
        v: 1,
        chat: { avatar: 'Seraphina.png' },
        file: 'Seraphina - chat',
        kind: 'append',
        index: 2,
        anchor: 'abcd1234',
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

describe('normalizeCommitPlan for a conversation reply', () => {
    test('keeps the envelope of a roleplay plan and adds the reply object', () => {
        expect(normalizeCommitPlan(conversationPlan())).toEqual({
            v: 1,
            chat: { conversation: CONVERSATION },
            file: 'main',
            kind: 'reply',
            index: 4,
            anchor: null,
            replaces: null,
            target: null,
            swipes: 0,
            prefix: null,
            prefix_length: 0,
            started: STARTED,
            page: 'page-a',
            round: ['Lyra.png'],
            message: { name: 'Nova', force_avatar: null, original_avatar: 'Nova.png', extra: { api: '', model: '', reasoning_effort: null, gen_id: null } },
            reply: {
                token: TOKEN,
                speaker: 'Nova.png',
                anchor: 'Nova.png',
                origin: 'reply',
                route: 'profile',
                triggers: [{ id: '1760000000000-abc123', rev: '0a1b2c3d' }],
                target: null,
                needs_user: false,
                round_started: 1760000000000,
            },
        });
    });

    test('takes the speaker avatar for the message from the reply, whatever the page put in the envelope', () => {
        const plan = normalizeCommitPlan(conversationPlan({ message: { name: 'Nova', extra: { api: 'openai', model: 'x', gen_id: 3 } } }));
        expect(plan?.message).toEqual({ name: 'Nova', force_avatar: null, original_avatar: 'Nova.png', extra: { api: '', model: '', reasoning_effort: null, gen_id: null } });
    });

    test('refuses an envelope that names another speaker than the reply does', () => {
        expect(normalizeCommitPlan(conversationPlan({ message: { name: 'Nova', original_avatar: 'Lyra.png' } }))).toBeNull();
    });

    test('forces the roleplay-only fields to their empty values', () => {
        const plan = normalizeCommitPlan(conversationPlan({ anchor: 'x', replaces: 'y', target: 'z', prefix: 'p', prefix_length: 9, swipes: 3 }));
        expect(plan).toMatchObject({ anchor: null, replaces: null, target: null, prefix: null, prefix_length: 0, swipes: 0 });
    });

    test('accepts an explicit reply target, a plan with no trigger and a plan with no round', () => {
        const target = { id: '1760000000001-def456', rev: 'ffffffff' };
        expect(normalizeCommitPlan(withReply({ target }))?.reply.target).toEqual(target);
        expect(normalizeCommitPlan(withReply({ triggers: [] }))?.reply.triggers).toEqual([]);
        expect(normalizeCommitPlan(conversationPlan({ round: undefined }))?.round).toEqual([]);
    });

    test('accepts every origin and both routes that the format names', () => {
        for (const origin of ['reply', 'auto', 'auto_chat']) {
            expect(normalizeCommitPlan(withReply({ origin }))?.reply.origin).toBe(origin);
        }
        expect(normalizeCommitPlan(withReply({ origin: 'reminder', reminder: REMINDER }))?.reply.origin).toBe('reminder');
        for (const route of ['profile', 'raw']) {
            expect(normalizeCommitPlan(withReply({ route }))?.reply.route).toBe(route);
        }
    });

    test('refuses the origin chime, which no message of the mode has', () => {
        expect(normalizeCommitPlan(withReply({ origin: 'chime' }))).toBeNull();
    });

    test('a plan for an automatic message answers no message, and needs a message from the user in the chat', () => {
        const plan = normalizeCommitPlan(withReply({ origin: 'auto', triggers: [], target: null, needs_user: true }));

        expect(plan?.reply).toMatchObject({ origin: 'auto', triggers: [], target: null, needs_user: true });
    });

    test('a reminder plan names its reminder, and a plan of any other origin names none', () => {
        expect(normalizeCommitPlan(withReply({ origin: 'reminder', reminder: REMINDER }))?.reply.reminder).toBe(REMINDER);
        expect(normalizeCommitPlan(withReply({ origin: 'reminder' }))).toBeNull();
        expect(normalizeCommitPlan(withReply({ origin: 'reminder', reminder: '' }))).toBeNull();
        expect(normalizeCommitPlan(withReply({ origin: 'reminder', reminder: 'r'.repeat(65) }))).toBeNull();
        expect(normalizeCommitPlan(withReply({ origin: 'reminder', reminder: 42 }))).toBeNull();
        expect(normalizeCommitPlan(withReply({ origin: 'auto', reminder: REMINDER }))).toBeNull();
        expect(normalizeCommitPlan(withReply({ origin: 'reply', reminder: REMINDER }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan())?.reply).not.toHaveProperty('reminder');
    });

    test('is one owner or the other: a conversation with an avatar or a group is invalid', () => {
        expect(normalizeCommitPlan(conversationPlan({ chat: { conversation: CONVERSATION, avatar: 'Nova.png' } }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan({ chat: { conversation: CONVERSATION, group: 'g1' } }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan({ chat: { conversation: 12 } }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan({ chat: { conversation: '' } }))).toBeNull();
    });

    test('the reply kind belongs to the conversation owner and the roleplay kinds do not', () => {
        for (const kind of ['append', 'swipe', 'continue']) {
            expect(normalizeCommitPlan(conversationPlan({ kind, target: 't', swipes: 1, prefix: 'p', prefix_length: 1 }))).toBeNull();
        }
        expect(normalizeCommitPlan(roleplayPlan({ kind: 'reply' }))).toBeNull();
        expect(normalizeCommitPlan(roleplayPlan({ kind: 'reply', chat: { group: 'g1' } }))).toBeNull();
        expect(GENERATION_COMMIT_KINDS).toEqual(['append', 'swipe', 'continue']);
    });

    test('refuses a plan without its reply object', () => {
        expect(normalizeCommitPlan(conversationPlan({ reply: undefined }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan({ reply: 'x' }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan({ reply: [] }))).toBeNull();
    });

    test.each([
        ['a chat id with a colon, which would split the key two ways', { file: 'a:b' }],
        ['a conversation id with a colon', { chat: { conversation: 'conv:1' } }],
        ['a chat id of more than 64 characters', { file: 'x'.repeat(65) }],
        ['a conversation id of more than 64 characters', { chat: { conversation: 'x'.repeat(65) } }],
        ['an empty chat id', { file: '' }],
        ['a negative index', { index: -1 }],
        ['a fractional index', { index: 1.5 }],
        ['a version other than 1', { v: 2 }],
        ['an empty speaker name', { message: { name: '', original_avatar: 'Nova.png' } }],
        ['a speaker name of more than 120 characters', { message: { name: 'n'.repeat(121), original_avatar: 'Nova.png' } }],
        ['a round entry that is not text', { round: [4] }],
        ['an empty round entry', { round: [''] }],
        ['a round entry of more than 255 characters', { round: ['a'.repeat(256)] }],
        ['a round of three members', { round: ['A.png', 'B.png', 'C.png'] }],
        ['a round that is not a list', { round: 'Lyra.png' }],
    ])('refuses %s', (_name, overrides) => {
        expect(normalizeCommitPlan(conversationPlan(overrides))).toBeNull();
    });

    test.each([
        ['a token that is not hex', { token: 'g'.repeat(16) }],
        ['a token of 15 characters', { token: 'a'.repeat(15) }],
        ['a token of 33 characters', { token: 'a'.repeat(33) }],
        ['an upper-case token', { token: 'A1B2C3D4E5F60718' }],
        ['a missing token', { token: undefined }],
        ['a missing speaker', { speaker: undefined }],
        ['an anchor of more than 255 characters', { anchor: 'a'.repeat(256) }],
        ['an empty anchor', { anchor: '' }],
        ['an unknown origin', { origin: 'worker' }],
        ['an unknown route', { route: 'horde' }],
        ['25 triggers', { triggers: Array.from({ length: 25 }, (_, index) => ({ id: `m${index}`, rev: '0a1b2c3d' })) }],
        ['triggers that are not a list', { triggers: 'm1' }],
        ['a trigger without a revision', { triggers: [{ id: 'm1' }] }],
        ['a trigger revision that is not 8 hex characters', { triggers: [{ id: 'm1', rev: '0a1b2c' }] }],
        ['a trigger id of more than 64 characters', { triggers: [{ id: 'm'.repeat(65), rev: '0a1b2c3d' }] }],
        ['an empty trigger id', { triggers: [{ id: '', rev: '0a1b2c3d' }] }],
        ['a target that names no revision', { target: { id: 'm1' } }],
        ['a target that is not an object or null', { target: 'm1' }],
        ['needs_user that is not a boolean', { needs_user: 'no' }],
        ['a round start that is not a whole number', { round_started: 1.5 }],
        ['a negative round start', { round_started: -1 }],
        ['a missing round start', { round_started: undefined }],
    ])('refuses %s', (_name, patch) => {
        expect(normalizeCommitPlan(withReply(patch))).toBeNull();
    });

    test('refuses a speaker that is empty or longer than 255 characters, as the envelope and as the reply', () => {
        const long = 'a'.repeat(256);
        expect(normalizeCommitPlan(conversationPlan({ message: { name: 'Nova', original_avatar: long }, reply: { ...conversationPlan().reply, speaker: long } }))).toBeNull();
        expect(normalizeCommitPlan(conversationPlan({ message: { name: 'Nova', original_avatar: '' }, reply: { ...conversationPlan().reply, speaker: '' } }))).toBeNull();
        const exact = 'a'.repeat(255);
        expect(normalizeCommitPlan(conversationPlan({ message: { name: 'Nova', original_avatar: exact }, reply: { ...conversationPlan().reply, speaker: exact } }))?.reply.speaker).toBe(exact);
    });

    test('accepts a token of 16 and of 32 characters and 24 triggers', () => {
        expect(normalizeCommitPlan(withReply({ token: 'f'.repeat(32) }))?.reply.token).toBe('f'.repeat(32));
        expect(normalizeCommitPlan(withReply({ token: '0'.repeat(16) }))?.reply.token).toBe('0'.repeat(16));
        const triggers = Array.from({ length: 24 }, (_, index) => ({ id: `m${index}`, rev: '0a1b2c3d' }));
        expect(normalizeCommitPlan(withReply({ triggers }))?.reply.triggers).toHaveLength(24);
    });

    test('does not hand out the objects of the input', () => {
        const input = conversationPlan();
        const plan = normalizeCommitPlan(input);
        input.reply.triggers.push({ id: 'late', rev: '00000000' });
        input.round.push('Late.png');
        expect(plan?.reply.triggers).toHaveLength(1);
        expect(plan?.round).toEqual(['Lyra.png']);
    });
});

describe('the header of a conversation plan', () => {
    test('the worst case, every string at its cap, stays under the 8192-character limit', () => {
        const worst = conversationPlan({
            chat: { conversation: 'conv_9999999999999999_' + 'A'.repeat(32) },
            file: 'c'.repeat(64),
            started: 's'.repeat(1024),
            page: 'p'.repeat(1024),
            round: ['r'.repeat(255), 'q'.repeat(255)],
            message: { name: 'n'.repeat(120), original_avatar: 'a'.repeat(255) },
            reply: {
                token: 'f'.repeat(32),
                speaker: 'a'.repeat(255),
                anchor: 'b'.repeat(255),
                origin: 'auto_chat',
                route: 'profile',
                triggers: Array.from({ length: 24 }, (_, index) => ({ id: `${String(index).padStart(2, '0')}${'m'.repeat(62)}`, rev: 'ffffffff' })),
                target: { id: 't'.repeat(64), rev: 'ffffffff' },
                needs_user: true,
                round_started: 9007199254740991,
            },
        });
        const normalized = normalizeCommitPlan(worst);
        expect(normalized).not.toBeNull();
        expect(encodeCommitPlan(normalized).length).toBeLessThanOrEqual(8192);
        expect(decodeCommitPlan(encodeCommitPlan(normalized))).toEqual(normalized);
    });

    test('a plan a page builds round-trips through the header', () => {
        const normalized = normalizeCommitPlan(conversationPlan());
        expect(decodeCommitPlan(encodeCommitPlan(normalized))).toEqual(normalized);
    });
});

describe('getCommitChatKey', () => {
    test('names a conversation chat by conversation id and chat id', () => {
        expect(getCommitChatKey({ conversation: CONVERSATION }, 'main')).toBe(`conversation:${CONVERSATION}:main`);
    });

    test('leaves the roleplay keys as they were', () => {
        expect(getCommitChatKey({ avatar: 'Seraphina.png' }, 'Seraphina - chat')).toBe('character:Seraphina.png:Seraphina - chat');
        expect(getCommitChatKey({ group: 'g1' }, 'g1-chat')).toBe('group:g1:g1-chat');
    });

    test('a key that a plan gives splits back into its two ids', () => {
        const plan = normalizeCommitPlan(conversationPlan());
        expect(parseConversationChatKey(getCommitChatKey(plan.chat, plan.file))).toEqual({ conversation: CONVERSATION, chat: 'main' });
    });

    test.each([
        ['a roleplay character key', 'character:Seraphina.png:chat'],
        ['a roleplay group key', 'group:g1:chat'],
        ['a conversation key with no chat', `conversation:${CONVERSATION}`],
        ['a conversation key with a third part', `conversation:${CONVERSATION}:main:extra`],
        ['an empty key', ''],
    ])('parses %s as no conversation chat', (_name, key) => {
        expect(parseConversationChatKey(key)).toBeNull();
    });
});

describe('roleplay plans', () => {
    test('normalise to exactly what they did before conversation plans existed', () => {
        expect(normalizeCommitPlan(roleplayPlan())).toEqual({
            v: 1,
            chat: { avatar: 'Seraphina.png' },
            file: 'Seraphina - chat',
            kind: 'append',
            index: 2,
            anchor: 'abcd1234',
            replaces: null,
            target: null,
            swipes: 0,
            prefix: null,
            prefix_length: 0,
            started: STARTED,
            page: 'page-a',
            round: [],
            message: { name: 'Seraphina', force_avatar: null, original_avatar: null, extra: { api: 'openai', model: 'gpt-test', reasoning_effort: null, gen_id: 7 } },
        });
        const swipe = normalizeCommitPlan(roleplayPlan({ chat: { group: 'g1' }, kind: 'swipe', target: 'tt', swipes: 2, round: ['L.png'] }));
        expect(swipe).toEqual({
            v: 1,
            chat: { group: 'g1' },
            file: 'Seraphina - chat',
            kind: 'swipe',
            index: 2,
            anchor: 'abcd1234',
            replaces: null,
            target: 'tt',
            swipes: 2,
            prefix: null,
            prefix_length: 0,
            started: STARTED,
            page: 'page-a',
            round: ['L.png'],
            message: { name: 'Seraphina', force_avatar: null, original_avatar: null, extra: { api: 'openai', model: 'gpt-test', reasoning_effort: null, gen_id: 7 } },
        });
    });

    test('carry no reply object, even when a page sends one', () => {
        expect(normalizeCommitPlan(roleplayPlan({ reply: conversationPlan().reply }))).not.toHaveProperty('reply');
    });
});
