import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const cards = new Map();

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => cards.get(avatar) ?? null,
}));

const { getEffectivePatienceMinutes, getTalkativeness } = await import('../public/scripts/sillybunny-conversation/talkativeness.js');

beforeEach(() => {
    cards.clear();
});

describe('getTalkativeness()', () => {
    test('reads the value of the card, as the character editor stores it', () => {
        cards.set('quiet.png', { avatar: 'quiet.png', talkativeness: '0.2' });
        cards.set('loud.png', { avatar: 'loud.png', talkativeness: 0.9 });
        cards.set('mute.png', { avatar: 'mute.png', talkativeness: 0 });
        cards.set('text-zero.png', { avatar: 'text-zero.png', talkativeness: '0' });

        expect(getTalkativeness('quiet.png')).toBe(0.2);
        expect(getTalkativeness('loud.png')).toBe(0.9);
        expect(getTalkativeness('mute.png')).toBe(0);
        expect(getTalkativeness('text-zero.png')).toBe(0);
    });

    test('stays between 0 and 1 whatever the card holds', () => {
        cards.set('odd.png', { avatar: 'odd.png', talkativeness: '7' });
        cards.set('text.png', { avatar: 'text.png', talkativeness: 'abc' });

        expect(getTalkativeness('odd.png')).toBe(1);
        expect(getTalkativeness('text.png')).toBe(0.5);
    });

    test('reads the card again on every call, so that an edit of the card is felt at once', () => {
        const card = { avatar: 'a.png', talkativeness: 0.3 };
        cards.set('a.png', card);
        expect(getTalkativeness('a.png')).toBe(0.3);

        card.talkativeness = 0.8;

        expect(getTalkativeness('a.png')).toBe(0.8);
    });

    test('falls back to the value of the extensions block of a card that the list has not filled in', () => {
        cards.set('a.png', { avatar: 'a.png', data: { extensions: { talkativeness: 0.7 } } });

        expect(getTalkativeness('a.png')).toBe(0.7);
    });

    test('is 0.5 for a character that is missing or has no value', () => {
        cards.set('plain.png', { avatar: 'plain.png' });

        expect(getTalkativeness('plain.png')).toBe(0.5);
        expect(getTalkativeness('gone.png')).toBe(0.5);
        expect(getTalkativeness('')).toBe(0.5);
    });
});

describe('getEffectivePatienceMinutes()', () => {
    const conversation = patience => ({ id: 'conversation_a', kind: 'direct', settings: patience === undefined ? {} : { inactivity_threshold: patience } });

    test('is the patience of the conversation times 1.5 - t, from the card of the character', () => {
        cards.set('quiet.png', { avatar: 'quiet.png', talkativeness: 0 });
        cards.set('plain.png', { avatar: 'plain.png', talkativeness: 0.5 });
        cards.set('loud.png', { avatar: 'loud.png', talkativeness: 1 });

        expect(getEffectivePatienceMinutes(conversation(60), 'quiet.png')).toBe(90);
        expect(getEffectivePatienceMinutes(conversation(60), 'plain.png')).toBe(60);
        expect(getEffectivePatienceMinutes(conversation(60), 'loud.png')).toBe(30);
    });

    test('is the patience as it is set for a card at the default value', () => {
        cards.set('plain.png', { avatar: 'plain.png' });

        expect(getEffectivePatienceMinutes(conversation(45), 'plain.png')).toBe(45);
    });

    test('starts from 120 minutes when the conversation has set none, and holds the setting to the range of the control', () => {
        cards.set('plain.png', { avatar: 'plain.png', talkativeness: 0.5 });

        expect(getEffectivePatienceMinutes(conversation(), 'plain.png')).toBe(120);
        expect(getEffectivePatienceMinutes(null, 'plain.png')).toBe(120);
        expect(getEffectivePatienceMinutes(conversation(0), 'plain.png')).toBe(120);
        expect(getEffectivePatienceMinutes(conversation(-30), 'plain.png')).toBe(120);
        expect(getEffectivePatienceMinutes(conversation(5), 'plain.png')).toBe(15);
        expect(getEffectivePatienceMinutes(conversation(9999), 'plain.png')).toBe(360);
    });

    test('answers for each member of a group from the card of that member', () => {
        cards.set('quiet.png', { avatar: 'quiet.png', talkativeness: 0 });
        cards.set('loud.png', { avatar: 'loud.png', talkativeness: 1 });
        const group = { id: 'conversation_g', kind: 'group', settings: { inactivity_threshold: 100 } };

        expect(getEffectivePatienceMinutes(group, 'quiet.png')).toBe(150);
        expect(getEffectivePatienceMinutes(group, 'loud.png')).toBe(50);
    });

    test('also reads a settings object that already merged the defaults', () => {
        cards.set('loud.png', { avatar: 'loud.png', talkativeness: 1 });

        expect(getEffectivePatienceMinutes({ inactivity_threshold: 80 }, 'loud.png')).toBe(40);
    });
});
