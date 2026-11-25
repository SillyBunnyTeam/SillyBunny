import { describe, expect, test } from '@jest/globals';

import { parseCommandArgs } from '../public/scripts/sillybunny-conversation/generation-utils.js';
import { buildPendingBubbles, buildReplySteps, splitMemberChatroomMessages } from '../public/scripts/sillybunny-conversation/reply-steps.js';
import { readPendingReply } from '../public/scripts/sillybunny-conversation/pending-reply.js';
import { pendingReply } from './util/conversation-pending-reply.js';

const ASTER = { avatar: 'aster.png', name: 'Aster' };
const NOVA = { avatar: 'nova.png', name: 'Nova' };
const ALL_COMMANDS = { schedule_command_enabled: true, selfie_command_enabled: true };

const plan = (rawText, options = {}) => buildReplySteps(rawText, { speaker: ASTER, mode: 'character', speakers: [], settings: ALL_COMMANDS, ...options });

describe('a reply from the character of a direct conversation', () => {
    test('is one group per paragraph, and a single line break stays inside its bubble', () => {
        const groups = plan('First bubble\n\nSecond bubble\nstill the second');

        expect(groups.map(group => group.bubbles)).toEqual([['First bubble'], ['Second bubble\nstill the second']]);
        expect(groups.every(group => group.speaker === ASTER && group.speakerAvatar === 'aster.png')).toBe(true);
    });

    test('loses the name of the speaker at the start of a line', () => {
        expect(plan('Aster: hello there')[0].bubbles).toEqual(['hello there']);
        expect(plan('**Aster**: hello there')[0].bubbles).toEqual(['hello there']);
    });

    test('answers no group for an empty reply', () => {
        expect(plan('')).toEqual([]);
        expect(plan('  \n ')).toEqual([]);
    });

    test('takes the commands out of the text and keeps them with the bubbles that they came with', () => {
        const [group] = plan('Later [schedule_update: status="dnd" activity="working"] [reminder: 15m | check in] [selfie: context="at my desk"]');

        expect(group.bubbles).toEqual(['Later']);
        expect(group.commandParts).toMatchObject({
            scheduleUpdates: [expect.stringContaining('status=')],
            reminders: [{ delay: '15m', memo: 'check in' }],
            selfieRequests: ['at my desk'],
        });
        expect(group.commandMetadata).toEqual({
            selfieRequests: ['at my desk'],
            scheduleUpdates: group.commandParts.scheduleUpdates,
            reminders: [{ delay: '15m', memo: 'check in' }],
        });
    });

    // The name of the speaker is stripped from the line before the commands are read, and that step also removes every
    // double quote, so `parseCommandArgs()` finds no `key="value"` pair. The old path behaves the same; this pins it
    // for the day that the order of the two steps is fixed.
    test.failing('keeps the quotes of the arguments of a schedule_update command, so that they can be read', () => {
        const [group] = plan('Later [schedule_update: status="dnd" activity="working"]');

        expect(parseCommandArgs(group.commandParts.scheduleUpdates[0])).toEqual({ status: 'dnd', activity: 'working' });
    });

    test('leaves the commands that the settings turn off in the text, and always reads a reminder', () => {
        const [group] = plan('Hi [selfie: context="x"] [reminder: 1h | tea]', { settings: {} });

        expect(group.commandParts.selfieRequests).toEqual([]);
        expect(group.commandParts.reminders).toEqual([{ delay: '1h', memo: 'tea' }]);
        expect(group.bubbles).toEqual(['Hi [selfie: context=x]']);
    });

    test('keeps a reply that is only a command as its text, because stripping commands never blanks a reply', () => {
        const [group] = plan('[selfie: context="at the beach"]');

        expect(group.bubbles).toEqual(['[selfie: context=at the beach]']);
        expect(group.commandParts.selfieRequests).toEqual(['at the beach']);
    });
});

describe('a reply from a member', () => {
    const member = (rawText, options = {}) => buildReplySteps(rawText, { speaker: NOVA, mode: 'member', speakers: [], settings: ALL_COMMANDS, ...options });

    test('is one group per line', () => {
        const groups = member('one\ntwo\n\nthree');

        expect(groups.map(group => group.bubbles)).toEqual([['one'], ['two'], ['three']]);
        expect(groups.every(group => group.speaker === NOVA)).toBe(true);
    });

    test('drops the lines that are empty after clean-up', () => {
        expect(splitMemberChatroomMessages('"\n"')).toEqual([]);
        expect(splitMemberChatroomMessages('first\n\n"quoted"\nsecond')).toEqual(['first', 'quoted', 'second']);
    });
});

describe('a reply in a group', () => {
    const speakers = [NOVA, ASTER, { avatar: 'tewi.png', name: 'Tewi' }];
    const group = (rawText, options = {}) => buildReplySteps(rawText, { speaker: ASTER, mode: 'character', speakers, settings: ALL_COMMANDS, ...options });

    test('gives each line that starts with a name to that member, and attaches an unnamed line to the line before it', () => {
        const groups = group('Aster: hi\nNova: hello\nthere again\nTewi: bye');

        expect(groups.map(item => [item.speaker.name, item.speakerAvatar, item.bubbles])).toEqual([
            ['Aster', 'aster.png', ['hi']],
            ['Nova', 'nova.png', ['hello\nthere again']],
            ['Tewi', 'tewi.png', ['bye']],
        ]);
    });

    test('keeps the speaker of the reply when no line starts with a name', () => {
        const groups = group('just text\n\nmore text');

        expect(groups.map(item => [item.speakerAvatar, item.bubbles])).toEqual([['aster.png', ['just text']], ['aster.png', ['more text']]]);
    });

    test('reads names with a longer match first, so that "Anna Marie" is not "Anna"', () => {
        const names = [{ avatar: 'a.png', name: 'Anna' }, { avatar: 'am.png', name: 'Anna Marie' }];
        const groups = group('Anna Marie: hello\nAnna: hi', { speaker: names[0], speakers: names });

        expect(groups.map(item => [item.speakerAvatar, item.bubbles])).toEqual([['am.png', ['hello']], ['a.png', ['hi']]]);
    });

    test('does not read a name in a direct conversation, where the caller gives no speakers', () => {
        const [only] = plan('Nova: this is the character talking');

        expect(only.speakerAvatar).toBe('aster.png');
        expect(only.bubbles).toEqual(['Nova: this is the character talking']);
    });
});

describe('the bubbles that a pending reply becomes', () => {
    const REFERENCE = { messageId: 'u1', name: 'You', role: 'user', text: 'hi' };
    const GROUP_SPEAKERS = [ASTER, NOVA];

    function land({ text, pending = {}, speakers = [], mode = 'character', speaker = ASTER, reference = REFERENCE, settings = ALL_COMMANDS } = {}) {
        const message = pendingReply({ text, speaker: speaker.avatar, anchor: 'aster.png', name: speaker.name, round: [], ...pending });
        const reply = readPendingReply(message);
        const groups = buildReplySteps(text, { speaker, mode, speakers, settings });
        return { message, reply, ...buildPendingBubbles(message, reply, groups, { anchorAvatar: reply.anchor, reference }) };
    }

    test('take their ids and times from the pending message, so that two pages that land it build the same bubbles', () => {
        const first = land({ text: 'one\n\ntwo\n\nthree' });
        const second = land({ text: 'one\n\ntwo\n\nthree' });

        expect(first.bubbles.map(bubble => bubble.id)).toEqual([`${first.message.id}.0`, `${first.message.id}.1`, `${first.message.id}.2`]);
        expect(first.bubbles.map(bubble => bubble.created_at)).toEqual([0, 1, 2].map(step => first.message.created_at + step));
        expect(first.bubbles[1].send_date).toBe(new Date(first.message.created_at + 1).toISOString());
        expect(second.bubbles).toEqual(first.bubbles);
    });

    test('are shaped like the messages that the live path writes, and carry the token of the reply', () => {
        const { bubbles, message } = land({ text: 'hello' });

        expect(bubbles).toEqual([{
            id: `${message.id}.0`,
            role: 'character',
            name: 'Aster',
            is_user: false,
            is_system: false,
            mes: 'hello',
            send_date: message.send_date,
            created_at: message.created_at,
            extra: { conversation_mode_reply: true, conversation_reply_to: REFERENCE, reply_token: 'abcdef0123456789' },
        }]);
        expect(bubbles[0].extra.server_generation).toBeUndefined();
    });

    test('carry the flags of the live path for a message that a character starts, and no flag of a reply', () => {
        const auto = land({ text: 'Hey, you there?', pending: { origin: 'auto' }, reference: null }).bubbles[0].extra;
        const chat = land({ text: 'Did you see that?', pending: { origin: 'auto_chat', speaker: 'nova.png' }, speaker: NOVA, reference: null }).bubbles[0].extra;

        expect(auto).toEqual({ conversation_mode_auto: true, proactive: true, reply_token: 'abcdef0123456789' });
        expect(chat).toEqual({ conversation_mode_auto_chat: true, member_avatar: 'nova.png', reply_token: 'abcdef0123456789' });
    });

    test('carry the id of the reminder that a reminder reply delivers', () => {
        const { bubbles } = land({ text: 'Time to water the plants.', pending: { origin: 'reminder', reminder: 'rem_1_abc123' }, reference: null });

        expect(bubbles[0].extra).toEqual({ conversation_mode_reminder: true, reminder_id: 'rem_1_abc123', reply_token: 'abcdef0123456789' });
    });

    test('point back at the message that they answer on the first bubble of each speaker only', () => {
        const { bubbles } = land({ text: 'Aster: one\nNova: two\nAster: three\nNova: four', speakers: GROUP_SPEAKERS });

        expect(bubbles.map(bubble => [bubble.name, bubble.role, Boolean(bubble.extra.conversation_reply_to), bubble.extra.member_avatar])).toEqual([
            ['Aster', 'character', true, undefined],
            ['Nova', 'member', true, 'nova.png'],
            ['Aster', 'character', false, undefined],
            ['Nova', 'member', false, 'nova.png'],
        ]);
    });

    test('carry no reference when the reply answers no message that is in the chat', () => {
        const { bubbles } = land({ text: 'hello', reference: null });

        expect(bubbles[0].extra).not.toHaveProperty('conversation_reply_to');
    });

    test('keep the command metadata on the first bubble of a line, and run the command once', () => {
        const { bubbles, sideEffects } = land({ text: 'Later [reminder: 15m | tea] [selfie: context="at my desk"]' });

        expect(bubbles[0].extra.conversation_commands).toEqual({ selfieRequests: ['at my desk'], reminders: [{ delay: '15m', memo: 'tea' }] });
        expect(sideEffects).toHaveLength(1);
        expect(sideEffects[0]).toMatchObject({ speakerAvatar: 'aster.png', idPrefix: expect.stringMatching(/^rem_.*_g0$/) });
        expect(sideEffects[0].commandParts.reminders).toEqual([{ delay: '15m', memo: 'tea' }]);
    });

    test('ask for a selfie with an id of its own, and no second reply card for a speaker who has one', () => {
        const { selfieRequests, message } = land({ text: 'Look [selfie: context="beach"]\n\n[selfie: context="dusk"]' });

        expect(selfieRequests.map(request => request.id)).toEqual([`${message.id}.s0`, `${message.id}.s1`]);
        expect(selfieRequests.map(request => request.context)).toEqual(['beach', 'dusk']);
        expect(selfieRequests[0].extra).toEqual({ conversation_mode_reply: true, reply_token: 'abcdef0123456789' });
    });

    test('mark the last bubble with the rest of the round, and no other bubble', () => {
        const { bubbles, reply } = land({ text: 'one\n\ntwo', pending: { round: ['nova.png'], triggers: ['u1'] } });

        expect(bubbles[0].extra).not.toHaveProperty('conversation_round');
        expect(bubbles[1].extra.conversation_round).toEqual({ remaining: ['nova.png'], started: reply.roundStarted, triggers: ['u1'] });
    });

    test('carry no round marker when nobody is left to speak', () => {
        const { bubbles } = land({ text: 'one\n\ntwo', pending: { round: [] } });

        expect(bubbles.some(bubble => bubble.extra.conversation_round)).toBe(false);
    });

    test('are none for a reply that was only whitespace', () => {
        expect(land({ text: '   ' })).toMatchObject({ bubbles: [], selfieRequests: [], sideEffects: [] });
    });
});
