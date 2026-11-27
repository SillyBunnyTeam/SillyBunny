import { describe, expect, test } from '@jest/globals';

import { chooseGroupSpeakers } from '../public/scripts/sillybunny-conversation/speaker-selection.js';

const member = (avatar, talkativeness = 0.5, mentioned = false) => ({ avatar, talkativeness, mentioned });
/** A random source that answers the given numbers in order, then 0.5. */
const rolls = (...values) => {
    const queue = [...values];
    return () => (queue.length ? queue.shift() : 0.5);
};
const avatars = speakers => speakers.map(speaker => speaker.avatar);
const TEXT = 'what do you think?';

describe('the members that are named', () => {
    test('speak, whatever their talkativeness, at most two of them', () => {
        const members = [member('a.png', 0, true), member('b.png', 1, true), member('c.png', 0.5, true)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: TEXT, random: rolls() }))).toEqual(['a.png', 'b.png']);
    });

    test('speak alone when a second speaker does not join', () => {
        const members = [member('a.png', 0, true), member('b.png', 0.5)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: TEXT, random: rolls(0.99, 0.99) }))).toEqual(['a.png']);
    });
});

describe('the member who spoke last', () => {
    const history = ['', 'b.png', '', 'a.png', ''];

    test('answers a message that names nobody when the card is at 0.5, without a roll', () => {
        const members = [member('a.png', 0.5), member('b.png', 0.5)];
        const random = () => { throw new Error('a card at 0.5 needs no roll'); };

        expect(chooseGroupSpeakers({ members, speakers: history, latestUserText: TEXT, maxSpeakers: 1, random })).toMatchObject([{ avatar: 'a.png' }]);
    });

    test('answers with the chance min(1, 2t): 0.5 for a card at 0.25', () => {
        const members = [member('a.png', 0.25), member('b.png', 0.5)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: history, latestUserText: TEXT, maxSpeakers: 1, random: rolls(0.49) }))).toEqual(['a.png']);
        // a roll of 0.51 fails; the weighted draw then decides, and a draw of 0.9 lands on b (a weighs 0.5 * 2, b 2 * 1)
        expect(avatars(chooseGroupSpeakers({ members, speakers: history, latestUserText: TEXT, maxSpeakers: 1, random: rolls(0.51, 0.9) }))).toEqual(['b.png']);
    });

    test('never answers a follow-up when the card is at 0, and the draw gives the turn to another member', () => {
        const members = [member('a.png', 0), member('b.png', 0.5)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: history, latestUserText: TEXT, maxSpeakers: 1, random: rolls(0.01, 0.01) }))).toEqual(['b.png']);
    });

    test('is not asked about a message to everyone, which goes to the draw', () => {
        const members = [member('a.png', 0.5), member('b.png', 0.5)];

        // a spoke last and would answer with certainty; the weighted draw of 0.99 lands on the last member instead
        expect(avatars(chooseGroupSpeakers({ members, speakers: history, latestUserText: 'hi everyone', maxSpeakers: 1, random: rolls(0.99) }))).toEqual(['b.png']);
    });

    test('is not asked when the user wrote no text', () => {
        const members = [member('a.png', 0.5), member('b.png', 0.5)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: history, latestUserText: '  ', maxSpeakers: 1, random: rolls(0.99) }))).toEqual(['b.png']);
    });
});

describe('the weighted draw', () => {
    test('gives a member twice the weight at 1 as at 0.5, and one at 0 none', () => {
        const members = [member('a.png', 1), member('b.png', 0.5), member('z.png', 0)];

        // nobody has spoken, so each member weighs 2t times the same number: a 2, b 1, z 0, out of 3
        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: 'hmm', maxSpeakers: 1, random: rolls(0.66) }))).toEqual(['a.png']);
        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: 'hmm', maxSpeakers: 1, random: rolls(0.67) }))).toEqual(['b.png']);
        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: 'hmm', maxSpeakers: 1, random: rolls(0.9999) }))).toEqual(['b.png']);
    });

    test('favours the member who has been silent the longest', () => {
        const members = [member('a.png'), member('b.png')];
        const speakers = ['a.png', 'b.png', 'b.png', 'b.png'];

        // a spoke 4 messages ago and b 1: weights 1 + 4 and 1 + 1, so a owns the first 5/7 of the roll
        expect(avatars(chooseGroupSpeakers({ members, speakers, latestUserText: 'everyone', maxSpeakers: 1, random: rolls(0.7) }))).toEqual(['a.png']);
        expect(avatars(chooseGroupSpeakers({ members, speakers, latestUserText: 'everyone', maxSpeakers: 1, random: rolls(0.72) }))).toEqual(['b.png']);
    });

    test('picks anyone when every member is at 0, so that a message is never left without a reply', () => {
        const members = [member('a.png', 0), member('b.png', 0)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: 'hmm', maxSpeakers: 1, random: rolls(0.9) }))).toEqual(['b.png']);
    });

    test('is empty for a group without members', () => {
        expect(chooseGroupSpeakers({ members: [], speakers: [], latestUserText: TEXT, random: rolls() })).toEqual([]);
    });
});

describe('the second speaker', () => {
    const named = (second) => [member('a.png', 0.5, true), second];

    test.each([[0, 0], [0.5, 0.3], [1, 0.6]])('joins with the chance 0.6 t of the member who would join: t %p is %p', (t, chance) => {
        const second = member('b.png', t);
        const just = (roll) => chooseGroupSpeakers({ members: named(second), speakers: [], latestUserText: TEXT, random: rolls(0.5, roll) });

        expect(avatars(just(Math.max(0, chance - 0.01)))).toEqual(chance > 0 ? ['a.png', 'b.png'] : ['a.png']);
        expect(avatars(just(chance + 0.01))).toEqual(['a.png']);
    });

    test('is chosen by the draw among the members that did not speak yet, before the chance is rolled', () => {
        const members = [member('a.png', 0.5, true), member('b.png', 1), member('c.png', 0)];

        // the draw of 0.5 lands on b (c weighs nothing); b at 1 then joins with the chance 0.6
        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: TEXT, random: rolls(0.5, 0.59) }))).toEqual(['a.png', 'b.png']);
        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: TEXT, random: rolls(0.5, 0.61) }))).toEqual(['a.png']);
    });

    test('is none when the only members left are at 0', () => {
        const members = [member('a.png', 0.5, true), member('c.png', 0)];

        expect(avatars(chooseGroupSpeakers({ members, speakers: [], latestUserText: TEXT, random: rolls(0, 0) }))).toEqual(['a.png']);
    });

    test('is none when the first speaker is the only member', () => {
        expect(avatars(chooseGroupSpeakers({ members: [member('a.png', 1)], speakers: [], latestUserText: TEXT, random: rolls(0, 0) }))).toEqual(['a.png']);
    });
});

describe('a group of cards at the default value', () => {
    // Before talkativeness came from the card: the member who spoke last always answered, the weight of a member was
    // 1 + the messages since it spoke, and a second speaker joined with the fixed chance of 0.3.
    test('has a second speaker with the chance 0.3 over every roll', () => {
        const members = [member('a.png', 0.5, true), member('b.png', 0.5), member('c.png', 0.5)];
        let joined = 0;
        const steps = 1000;
        for (let step = 0; step < steps; step++) {
            const roll = (step + 0.5) / steps;
            joined += chooseGroupSpeakers({ members, speakers: [], latestUserText: TEXT, random: rolls(0.5, roll) }).length === 2 ? 1 : 0;
        }

        expect(joined / steps).toBeCloseTo(0.3, 2);
    });

    test('lets the member who spoke last answer every time', () => {
        const members = [member('a.png'), member('b.png'), member('c.png')];
        const speakers = ['b.png', 'c.png', 'a.png'];
        const random = rolls(0.99);

        expect(chooseGroupSpeakers({ members, speakers, latestUserText: TEXT, maxSpeakers: 1, random })[0].avatar).toBe('a.png');
    });

    test('weighs each member by 1 + the messages since it spoke', () => {
        const members = [member('a.png'), member('b.png')];
        const speakers = ['a.png', 'b.png', 'b.png'];

        // a spoke 3 messages ago (weight 4), b 1 message ago (weight 2): a owns the first 4/6 of the roll
        expect(avatars(chooseGroupSpeakers({ members, speakers, latestUserText: 'everyone', maxSpeakers: 1, random: rolls(0.66) }))).toEqual(['a.png']);
        expect(avatars(chooseGroupSpeakers({ members, speakers, latestUserText: 'everyone', maxSpeakers: 1, random: rolls(0.67) }))).toEqual(['b.png']);
    });
});
