/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import { getAssistantCards } from '../../public/scripts/sillybunny-home/assistant-cards.js';

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const NAHIDA = 'default_AssistantNahida.png';

/**
 * A library over a map of avatar to character name, and a set of the assistants whose deletion the account recorded.
 * Cards are found by the default avatar of the assistant, or by the avatar in `renamed` when the user renamed the file.
 */
function createLibrary({ characters = {}, deleted = [], renamed = {} } = {}) {
    const find = avatar => (avatar in characters ? { avatar, name: characters[avatar] } : null);
    return {
        findCard: jest.fn(assistant => find(renamed[assistant.id] ?? assistant.defaultAvatar)),
        findAvatar: jest.fn(find),
        isDeleted: jest.fn(assistant => deleted.includes(assistant.id)),
    };
}

const BOTH = { [REISEN]: 'Assistant Reisen', [TEWI]: 'Assistant Tewi' };
const keysOf = cards => cards.map(card => card.key);
const stateOf = (cards, id) => cards.find(card => card.id === id)?.state;

describe('the order of the assistant cards', () => {
    test('is Reisen, then Tewi, when the account points at neither a card of its own nor Nahida', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi']);
    });

    test('starts with the character that the pointer names when it is neither Reisen nor Tewi', () => {
        const library = createLibrary({ characters: { ...BOTH, 'Alice.png': 'Alice' } });

        const cards = getAssistantCards({ library, pointerAvatar: 'Alice.png' });

        expect(keysOf(cards)).toEqual(['assistant-pointer', 'assistant-reisen', 'assistant-tewi']);
        expect(cards[0]).toMatchObject({ id: 'pointer', name: 'Alice', avatar: 'Alice.png', state: 'available', slot: 'AS-POINTER-SUB' });
    });

    test.each([
        ['Reisen', REISEN],
        ['Tewi', TEWI],
    ])('has no card for the pointer when it names %s, because she has her own', (_name, avatar) => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: avatar });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi']);
    });

    test('knows Reisen by the avatar her card has now, so a renamed card is still not shown twice', () => {
        const library = createLibrary({ characters: { 'My Reisen.png': 'My Reisen', [TEWI]: 'Tewi' }, renamed: { reisen: 'My Reisen.png' } });

        const cards = getAssistantCards({ library, pointerAvatar: 'My Reisen.png' });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi']);
        expect(stateOf(cards, 'reisen')).toBe('available');
    });

    test('has no card for a pointer whose character is not in the library', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: 'Gone.png' });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi']);
    });

    test('ends with the optional assistants that are installed', () => {
        const library = createLibrary({ characters: { ...BOTH, [NAHIDA]: 'Assistant Nahida' } });

        const cards = getAssistantCards({ library, pointerAvatar: null });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-nahida']);
    });

    test('puts the pointer first, then Reisen, Tewi and Nahida', () => {
        const library = createLibrary({ characters: { ...BOTH, [NAHIDA]: 'Assistant Nahida', 'Alice.png': 'Alice' } });

        const cards = getAssistantCards({ library, pointerAvatar: 'Alice.png' });

        expect(keysOf(cards)).toEqual(['assistant-pointer', 'assistant-reisen', 'assistant-tewi', 'assistant-nahida']);
    });

    test('shows Nahida once, first, when the pointer names her', () => {
        const library = createLibrary({ characters: { ...BOTH, [NAHIDA]: 'Assistant Nahida' } });

        const cards = getAssistantCards({ library, pointerAvatar: NAHIDA });

        expect(keysOf(cards)).toEqual(['assistant-nahida', 'assistant-reisen', 'assistant-tewi']);
    });
});

describe('the state of an assistant card', () => {
    test('is available while the library has the card of the assistant', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null });

        expect(cards.map(card => card.state)).toEqual(['available', 'available']);
    });

    test('is missing when the library has no card and the account did not delete it', () => {
        const cards = getAssistantCards({ library: createLibrary(), pointerAvatar: null });

        expect(cards.map(card => [card.id, card.state])).toEqual([['reisen', 'missing'], ['tewi', 'missing']]);
    });

    test('is deleted when the library has no card and the account recorded its deletion', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: { [TEWI]: 'Tewi' }, deleted: ['reisen'] }), pointerAvatar: null });

        expect(stateOf(cards, 'reisen')).toBe('deleted');
        expect(stateOf(cards, 'tewi')).toBe('available');
    });

    test('is available, not deleted, when the card is back although the account still holds the mark', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH, deleted: ['reisen'] }), pointerAvatar: null });

        expect(stateOf(cards, 'reisen')).toBe('available');
    });

    test('has no avatar for a card the library does not hold', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: { [TEWI]: 'Tewi' } }), pointerAvatar: null });

        expect(cards.map(card => card.avatar)).toEqual([null, TEWI]);
    });

    test('is read from the library each time, not remembered', () => {
        const library = createLibrary();
        expect(stateOf(getAssistantCards({ library, pointerAvatar: null }), 'reisen')).toBe('missing');

        library.findCard.mockImplementation(assistant => (assistant.id === 'reisen' ? { avatar: REISEN, name: 'Reisen' } : null));

        expect(stateOf(getAssistantCards({ library, pointerAvatar: null }), 'reisen')).toBe('available');
    });
});

describe('what a card shows', () => {
    test('keeps the names, subtitle slots and placeholder art that Reisen and Tewi had', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null });

        expect(cards.map(({ name, slot, art }) => ({ name, slot, art }))).toEqual([
            { name: 'Reisen', slot: 'AS-REISEN-SUB', art: { name: 'row-reisen', avatar: null } },
            { name: 'Tewi', slot: 'AS-TEWI-SUB', art: { name: 'row-tewi', avatar: null } },
        ]);
    });

    test('shows Nahida with her own name, her slot and her card as the art', () => {
        const library = createLibrary({ characters: { [NAHIDA]: 'Assistant Nahida' } });

        const nahida = getAssistantCards({ library, pointerAvatar: null }).find(card => card.id === 'nahida');

        expect(nahida).toMatchObject({ name: 'Nahida', slot: 'AS-NAHIDA-SUB', avatar: NAHIDA, state: 'available', art: { name: 'row-nahida', avatar: NAHIDA } });
    });

    test('shows the pointer character with its card as the art', () => {
        const library = createLibrary({ characters: { 'Alice.png': 'Alice' } });

        const [pointer] = getAssistantCards({ library, pointerAvatar: 'Alice.png' });

        expect(pointer.art).toEqual({ name: 'row-pointer', avatar: 'Alice.png' });
    });

    test('does not list Nahida when her card is not installed, even though the account recorded a deletion', () => {
        const library = createLibrary({ deleted: ['nahida'] });

        expect(keysOf(getAssistantCards({ library, pointerAvatar: null }))).toEqual(['assistant-reisen', 'assistant-tewi']);
    });
});
