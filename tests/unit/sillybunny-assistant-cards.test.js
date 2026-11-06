/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import { getAssistantCards, getAssistantPickerEntries } from '../../public/scripts/sillybunny-home/assistant-cards.js';

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';

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
        listCharacters: jest.fn(() => Object.entries(characters).map(([avatar, name]) => ({ avatar, name }))),
    };
}

const NONE = { filename: null, restore: false, update: null };
const BOTH = { [REISEN]: 'Assistant Reisen', [TEWI]: 'Assistant Tewi' };
const keysOf = cards => cards.map(card => card.key);
const stateOf = (cards, id) => cards.find(card => card.id === id)?.state;

describe('the order of the assistant cards', () => {
    test.each([
        ['there is no pointer', null],
        ['the pointer names Reisen', REISEN],
        ['the pointer names Tewi', TEWI],
        ['the pointer names a character that is not in the library', 'Gone.png'],
        ['the pointer is empty', ''],
    ])('is Reisen, Tewi, then the card to choose from, when %s', (_case, pointerAvatar) => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
        expect(cards[2]).toMatchObject({ kind: 'choose', id: 'own' });
    });

    test('is Reisen, Tewi, then the character that the pointer names, which does not take the first place', () => {
        const library = createLibrary({ characters: { ...BOTH, 'Alice.png': 'Alice' } });

        const cards = getAssistantCards({ library, pointerAvatar: 'Alice.png' });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
        expect(cards[2]).toMatchObject({ kind: 'pointer', id: 'pointer', name: 'Alice', avatar: 'Alice.png', state: 'available' });
    });

    test('has the same three cards when Reisen and Tewi have no card in the library', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: { 'Alice.png': 'Alice' } }), pointerAvatar: 'Alice.png' });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
        expect(cards.map(card => card.kind)).toEqual(['bundled', 'bundled', 'pointer']);
    });

    test('knows Reisen by the avatar her card has now, so a renamed card is not offered as the third one', () => {
        const library = createLibrary({ characters: { 'My Reisen.png': 'My Reisen', [TEWI]: 'Tewi' }, renamed: { reisen: 'My Reisen.png' } });

        const cards = getAssistantCards({ library, pointerAvatar: 'My Reisen.png' });

        expect(keysOf(cards)).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
        expect(stateOf(cards, 'reisen')).toBe('available');
        expect(cards[2].kind).toBe('choose');
    });

    test('lists the card of a user who installed Nahida earlier, once the pointer names it, as a pointer card like any other', () => {
        const library = createLibrary({ characters: { ...BOTH, 'default_AssistantNahida.png': 'Assistant Nahida' } });

        const cards = getAssistantCards({ library, pointerAvatar: 'default_AssistantNahida.png' });

        expect(cards[2]).toMatchObject({ kind: 'pointer', name: 'Assistant Nahida', art: { name: 'row-pointer', avatar: 'default_AssistantNahida.png' } });
    });

    test('gives the card of Nahida no card of her own while the pointer does not name her', () => {
        const library = createLibrary({ characters: { ...BOTH, 'default_AssistantNahida.png': 'Assistant Nahida' } });

        expect(keysOf(getAssistantCards({ library, pointerAvatar: null }))).toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
    });
});

describe('the state of an assistant card', () => {
    test('is available while the library has the card of the assistant', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null });

        expect(cards.slice(0, 2).map(card => card.state)).toEqual(['available', 'available']);
    });

    test('is missing when the library has no card and the account did not delete it', () => {
        const cards = getAssistantCards({ library: createLibrary(), pointerAvatar: null });

        expect(cards.slice(0, 2).map(card => [card.id, card.state])).toEqual([['reisen', 'missing'], ['tewi', 'missing']]);
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

        expect(cards.slice(0, 2).map(card => card.avatar)).toEqual([null, TEWI]);
    });

    test('is read from the library each time, not remembered', () => {
        const library = createLibrary();
        expect(stateOf(getAssistantCards({ library, pointerAvatar: null }), 'reisen')).toBe('missing');

        library.findCard.mockImplementation(assistant => (assistant.id === 'reisen' ? { avatar: REISEN, name: 'Reisen' } : null));

        expect(stateOf(getAssistantCards({ library, pointerAvatar: null }), 'reisen')).toBe('available');
    });
});

describe('what a card offers from the managed content', () => {
    const entry = (filename, overrides = {}) => ({ filename, type: 'character', version: 2, status: 'modified', updateAvailable: true, ...overrides });
    const offersOf = (cards, id) => cards.find(card => card.id === id)?.offers;

    test('is Restore on a deleted card whose bundled file the server reports as deleted', () => {
        const library = createLibrary({ characters: { [TEWI]: 'Tewi' }, deleted: ['reisen'] });
        const managed = { items: [entry(REISEN, { status: 'deleted', updateAvailable: false })], dismissed: new Map() };

        const cards = getAssistantCards({ library, pointerAvatar: null, managed });

        expect(offersOf(cards, 'reisen')).toEqual({ filename: REISEN, restore: true, update: null });
        expect(offersOf(cards, 'tewi')).toEqual({ filename: null, restore: false, update: null });
    });

    test('is Restore on a card with no file that the account never deleted, when the server reports the bundled file as deleted', () => {
        const managed = { items: [entry(REISEN, { status: 'deleted', updateAvailable: false })], dismissed: new Map() };

        const cards = getAssistantCards({ library: createLibrary({ characters: { [TEWI]: 'Tewi' } }), pointerAvatar: null, managed });

        expect(stateOf(cards, 'reisen')).toBe('missing');
        expect(offersOf(cards, 'reisen')).toEqual({ filename: REISEN, restore: true, update: null });
    });

    test('is Update Available on an available card the server reports as modified with a newer bundled version', () => {
        const managed = { items: [entry(TEWI, { version: 4 })], dismissed: new Map() };

        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null, managed });

        expect(offersOf(cards, 'tewi')).toEqual({ filename: TEWI, restore: false, update: { version: 4 } });
        expect(offersOf(cards, 'reisen').update).toBeNull();
    });

    test('reads the versions that the user kept, so a kept version is not offered again', () => {
        const managed = { items: [entry(TEWI, { version: 4 })], dismissed: new Map([[TEWI, 4]]) };

        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null, managed });

        expect(offersOf(cards, 'tewi').update).toBeNull();
    });

    test('looks up the bundled file by the default avatar, also when the user renamed the card', () => {
        const library = createLibrary({ characters: { 'My Reisen.png': 'My Reisen', [TEWI]: 'Tewi' }, renamed: { reisen: 'My Reisen.png' } });
        const managed = { items: [entry(REISEN)], dismissed: new Map() };

        const cards = getAssistantCards({ library, pointerAvatar: null, managed });

        expect(offersOf(cards, 'reisen').update).toEqual({ version: 2 });
    });

    test('is nothing for any card while the status is not known, and when no status is given', () => {
        const library = createLibrary({ characters: BOTH, deleted: [] });

        const unknown = getAssistantCards({ library, pointerAvatar: null, managed: { items: null, dismissed: new Map() } });
        const absent = getAssistantCards({ library, pointerAvatar: null });

        for (const cards of [unknown, absent]) {
            expect(cards.map(card => card.offers)).toEqual([NONE, NONE, NONE]);
        }
    });

    test('is nothing for the card of the third slot, whichever character it holds', () => {
        const library = createLibrary({ characters: { ...BOTH, 'Alice.png': 'Alice' } });
        const managed = { items: [entry('Alice.png')], dismissed: new Map() };

        const pointer = getAssistantCards({ library, pointerAvatar: 'Alice.png', managed });
        const choose = getAssistantCards({ library, pointerAvatar: null, managed });

        expect(pointer[2]).toMatchObject({ kind: 'pointer', offers: NONE });
        expect(choose[2]).toMatchObject({ kind: 'choose', offers: NONE });
    });
});

describe('what a card shows', () => {
    test('keeps the names and placeholder art that Reisen and Tewi had', () => {
        const cards = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null });

        expect(cards.slice(0, 2).map(({ name, art }) => ({ name, art }))).toEqual([
            { name: 'Reisen', art: { name: 'row-reisen', avatar: null } },
            { name: 'Tewi', art: { name: 'row-tewi', avatar: null } },
        ]);
    });

    test('shows the pointer character with its card as the art', () => {
        const library = createLibrary({ characters: { 'Alice.png': 'Alice' } });

        const pointer = getAssistantCards({ library, pointerAvatar: 'Alice.png' })[2];

        expect(pointer.art).toEqual({ name: 'row-pointer', avatar: 'Alice.png' });
    });

    test('has no name, art or avatar for the card to choose from, which the view labels', () => {
        const choose = getAssistantCards({ library: createLibrary({ characters: BOTH }), pointerAvatar: null })[2];

        expect(choose).toEqual({ key: 'assistant-own', id: 'own', kind: 'choose', name: null, art: null, avatar: null, state: 'available', offers: NONE });
    });

    test('has the same key for the card of the third slot in both of its states, so focus finds it after the pointer changes', () => {
        const library = createLibrary({ characters: { ...BOTH, 'Alice.png': 'Alice' } });

        const keys = [null, 'Alice.png'].map(pointerAvatar => getAssistantCards({ library, pointerAvatar })[2].key);

        expect(keys).toEqual(['assistant-own', 'assistant-own']);
    });
});

describe('the characters that the picker offers', () => {
    const library = () => createLibrary({ characters: { ...BOTH, 'bob.png': 'Bob', 'alice.png': 'alice', 'Zed.png': 'Zed' } });

    test('are the characters of the library by name, without Reisen and Tewi', () => {
        const entries = getAssistantPickerEntries({ library: library(), pointerAvatar: null });

        expect(entries.map(entry => entry.name)).toEqual(['alice', 'Bob', 'Zed']);
        expect(entries.map(entry => entry.avatar)).toEqual(['alice.png', 'bob.png', 'Zed.png']);
    });

    test('put characters of one name, however it is cased, in the order of their avatars, whatever the order of the library', () => {
        const same = createLibrary({ characters: { 'sam-c.png': 'sam', 'sam-b.png': 'Sam', 'sam-a.png': 'SAM', 'ann.png': 'Ann' } });

        const entries = getAssistantPickerEntries({ library: same, pointerAvatar: null });

        expect(entries.map(entry => entry.avatar)).toEqual(['ann.png', 'sam-a.png', 'sam-b.png', 'sam-c.png']);
    });

    test('list the card of Nahida like any other character, and mark it when the pointer names it', () => {
        const withNahida = createLibrary({ characters: { ...BOTH, 'default_AssistantNahida.png': 'Assistant Nahida', 'bob.png': 'Bob' } });

        const unchosen = getAssistantPickerEntries({ library: withNahida, pointerAvatar: null });
        const chosen = getAssistantPickerEntries({ library: withNahida, pointerAvatar: 'default_AssistantNahida.png' });

        expect(unchosen.map(entry => [entry.name, entry.selected])).toEqual([['Assistant Nahida', false], ['Bob', false]]);
        expect(chosen.map(entry => [entry.name, entry.selected])).toEqual([['Assistant Nahida', true], ['Bob', false]]);
    });

    test('mark the character that the pointer names as selected', () => {
        const entries = getAssistantPickerEntries({ library: library(), pointerAvatar: 'bob.png' });

        expect(entries.map(entry => [entry.name, entry.selected])).toEqual([['alice', false], ['Bob', true], ['Zed', false]]);
    });

    test('mark nothing when the pointer names Reisen, who is left out, or a character that is not there', () => {
        const selections = [REISEN, 'Gone.png', null]
            .map(pointerAvatar => getAssistantPickerEntries({ library: library(), pointerAvatar }).filter(entry => entry.selected));

        expect(selections).toEqual([[], [], []]);
    });

    test('leave Reisen out by the avatar her card has now, not by her default file name', () => {
        const renamed = createLibrary({ characters: { 'My Reisen.png': 'My Reisen', [TEWI]: 'Tewi', 'bob.png': 'Bob' }, renamed: { reisen: 'My Reisen.png' } });

        expect(getAssistantPickerEntries({ library: renamed, pointerAvatar: null }).map(entry => entry.name)).toEqual(['Bob']);
    });

    test('are empty when the library holds nothing but Reisen and Tewi', () => {
        expect(getAssistantPickerEntries({ library: createLibrary({ characters: BOTH }), pointerAvatar: null })).toEqual([]);
    });

    test('are read from the library each time', () => {
        const source = library();
        getAssistantPickerEntries({ library: source, pointerAvatar: null });
        getAssistantPickerEntries({ library: source, pointerAvatar: null });

        expect(source.listCharacters).toHaveBeenCalledTimes(2);
    });
});
