import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let cards = {};

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => cards[avatar] ?? null,
}));

const { getEffectivePatienceMinutes, getTalkativeness } = await import('../public/scripts/sillybunny-conversation/worker-talkativeness.js');

beforeEach(() => {
    cards = {};
});

describe('the talkativeness that the worker reads from a card', () => {
    test('is the value of the card, read each time, and 0.5 when the card has none', () => {
        cards['nova.png'] = { talkativeness: '0.8' };
        expect(getTalkativeness('nova.png')).toBe(0.8);
        cards['nova.png'].talkativeness = 0.2;
        expect(getTalkativeness('nova.png')).toBe(0.2);
        cards['nova.png'].talkativeness = '0';
        expect(getTalkativeness('nova.png')).toBe(0);
        expect(getTalkativeness('missing.png')).toBe(0.5);
        cards['plain.png'] = {};
        expect(getTalkativeness('plain.png')).toBe(0.5);
    });

    test('stays between 0 and 1 whatever the card holds', () => {
        cards['odd.png'] = { talkativeness: '7' };
        expect(getTalkativeness('odd.png')).toBe(1);
        cards['odd.png'].talkativeness = 'abc';
        expect(getTalkativeness('odd.png')).toBe(0.5);
    });
});

describe('the effective patience', () => {
    const conversation = { settings: { inactivity_threshold: 120 } };

    test('is the patience at 0.5, scaled by 1.5 minus the talkativeness elsewhere', () => {
        cards['quiet.png'] = { talkativeness: 0 };
        cards['mid.png'] = { talkativeness: 0.5 };
        cards['chatty.png'] = { talkativeness: 1 };

        expect(getEffectivePatienceMinutes(conversation, 'quiet.png')).toBe(180);
        expect(getEffectivePatienceMinutes(conversation, 'mid.png')).toBe(120);
        expect(getEffectivePatienceMinutes(conversation, 'chatty.png')).toBe(60);
    });

    test('uses the default patience when the conversation sets none, and keeps the setting between its limits', () => {
        cards['mid.png'] = { talkativeness: 0.5 };

        expect(getEffectivePatienceMinutes({ settings: {} }, 'mid.png')).toBe(120);
        expect(getEffectivePatienceMinutes(null, 'mid.png')).toBe(120);
        expect(getEffectivePatienceMinutes({ settings: { inactivity_threshold: 1 } }, 'mid.png')).toBe(15);
        expect(getEffectivePatienceMinutes({ settings: { inactivity_threshold: 99999 } }, 'mid.png')).toBe(360);
    });
});
