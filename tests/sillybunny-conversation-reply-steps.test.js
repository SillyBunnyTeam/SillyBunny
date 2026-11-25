import { describe, expect, test } from '@jest/globals';

import { parseCommandArgs } from '../public/scripts/sillybunny-conversation/generation-utils.js';
import { buildReplySteps, splitMemberChatroomMessages } from '../public/scripts/sillybunny-conversation/reply-steps.js';

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
