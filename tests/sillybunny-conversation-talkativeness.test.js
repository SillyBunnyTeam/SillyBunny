import { describe, expect, test } from '@jest/globals';

import {
    DEFAULT_CARD_TALKATIVENESS,
    getFollowUpChance,
    getPatienceFactor,
    getReplyDelayFactor,
    getSecondSpeakerChance,
    getSpeakerWeightFactor,
    parseTalkativeness,
} from '../public/scripts/sillybunny-conversation/talkativeness-utils.js';

describe('the value of the card', () => {
    test('is read as a number from 0 to 1', () => {
        expect(parseTalkativeness(0.8)).toBe(0.8);
        expect(parseTalkativeness('0.25')).toBe(0.25);
        expect(parseTalkativeness(0)).toBe(0);
        expect(parseTalkativeness('0')).toBe(0);
        expect(parseTalkativeness(1)).toBe(1);
    });

    test('is the default when the card has none', () => {
        expect(DEFAULT_CARD_TALKATIVENESS).toBe(0.5);
        for (const value of [undefined, null, '', '  ', 'loud', NaN, Infinity]) {
            expect(parseTalkativeness(value)).toBe(0.5);
        }
    });

    test('is held to the range of the card editor', () => {
        expect(parseTalkativeness(7)).toBe(1);
        expect(parseTalkativeness(-3)).toBe(0);
    });
});

describe('the weight of a group member as a speaker (2t)', () => {
    test.each([[0, 0], [0.5, 1], [1, 2]])('at t = %p is %p', (t, expected) => {
        expect(getSpeakerWeightFactor(t)).toBe(expected);
    });
});

describe('the chance that the last speaker answers a follow-up (min(1, 2t))', () => {
    test.each([[0, 0], [0.25, 0.5], [0.5, 1], [0.75, 1], [1, 1]])('at t = %p is %p', (t, expected) => {
        expect(getFollowUpChance(t)).toBe(expected);
    });
});

describe('the chance of a second speaker (0.6t of the member who would join)', () => {
    test.each([[0, 0], [0.5, 0.3], [1, 0.6]])('at t = %p is %p', (t, expected) => {
        expect(getSecondSpeakerChance(t)).toBeCloseTo(expected, 12);
    });
});

describe('the factor of the reply delay (1.15 - t/2)', () => {
    test.each([[0, 1.15], [0.5, 0.9], [1, 0.65]])('at t = %p is %p', (t, expected) => {
        expect(getReplyDelayFactor(t)).toBeCloseTo(expected, 12);
    });
});

describe('the factor of the patience (1.5 - t)', () => {
    test.each([[0, 1.5], [0.5, 1], [1, 0.5]])('at t = %p is %p', (t, expected) => {
        expect(getPatienceFactor(t)).toBeCloseTo(expected, 12);
    });
});

describe('a card at the default value', () => {
    // The numbers on the right are what the mode did before talkativeness came from the card: the weight of a member
    // was not scaled, the last speaker always answered, a second speaker came with the fixed chance
    // GROUP_SECOND_REPLY_CHANCE (0.3), the delay factor was 1.15 - 50/200 and the patience was used as it was set.
    test('behaves as the mode did before', () => {
        const t = DEFAULT_CARD_TALKATIVENESS;

        expect(getSpeakerWeightFactor(t)).toBe(1);
        expect(getFollowUpChance(t)).toBe(1);
        expect(getSecondSpeakerChance(t)).toBeCloseTo(0.3, 12);
        expect(getReplyDelayFactor(t)).toBeCloseTo(1.15 - 50 / 200, 12);
        expect(getPatienceFactor(t)).toBe(1);
    });
});
