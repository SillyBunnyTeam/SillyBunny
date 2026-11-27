import { describe, expect, test } from '@jest/globals';

import {
    buildLibraryItems,
    isFavoriteCard,
    listTagChips,
    matchesAllTags,
} from '../../public/scripts/sillybunny-conversation/character-library.js';

const card = (avatar, name, extra = {}) => ({ avatar, name, ...extra });

describe('character library: items', () => {
    test('are keyed by the card\'s avatar file name, not by its place in the array', () => {
        const items = buildLibraryItems([card('b.png', 'Bea'), card('a.png', 'Ann')]);

        expect(items.map(item => item.value)).toEqual(['a.png', 'b.png']);
        expect(items.every(item => typeof item.value === 'string')).toBe(true);
    });

    test('leave out a card that has no avatar file, and give a card without a name the word Character', () => {
        const items = buildLibraryItems([card('', 'Ghost'), card(undefined, 'Ghost'), null, card('x.png', ''), card('y.png', undefined)]);

        expect(items.map(item => [item.value, item.label])).toEqual([['x.png', 'Character'], ['y.png', 'Character']]);
    });

    test('carry a search key that is the name in lower case, made once', () => {
        const [item] = buildLibraryItems([card('a.png', 'Seraphina THE Bold')]);

        expect(item.searchText).toBe('seraphina the bold');
    });

    test('read the tags of a card from the tag map by avatar, and none when the map has no entry', () => {
        const items = buildLibraryItems([card('a.png', 'Ann'), card('b.png', 'Bea'), card('c.png', 'Cat')], { tagMap: { 'a.png': ['t1', 't2'], 'b.png': null } });

        expect(items.map(item => item.tagIds)).toEqual([['t1', 't2'], [], []]);
    });

    test('do not change the cards they read', () => {
        const cards = Object.freeze([Object.freeze(card('a.png', 'Ann', Object.freeze({ fav: 'true' })))]);

        expect(() => buildLibraryItems(cards, { tagMap: Object.freeze({}) })).not.toThrow();
    });
});

describe('character library: order', () => {
    test('puts favourites first, whichever way the card says it', () => {
        const items = buildLibraryItems([
            card('1.png', 'Alpha'),
            card('2.png', 'Beta', { fav: true }),
            card('3.png', 'Gamma', { fav: 'true' }),
            card('4.png', 'Delta', { data: { extensions: { fav: true } } }),
            card('5.png', 'Epsilon', { fav: 'false' }),
        ]);

        expect(items.map(item => item.label)).toEqual(['Beta', 'Delta', 'Gamma', 'Alpha', 'Epsilon']);
        expect(items.map(item => item.favorite)).toEqual([true, true, true, false, false]);
    });

    test('sorts each group by name with a locale collator that ignores case and accents', () => {
        const items = buildLibraryItems([card('z.png', 'Zed'), card('e.png', 'Émile'), card('b.png', 'bob'), card('a.png', 'Alice')]);

        expect(items.map(item => item.label)).toEqual(['Alice', 'bob', 'Émile', 'Zed']);
    });

    test('is total: two cards with the same name keep a fixed order by avatar', () => {
        const forward = buildLibraryItems([card('b.png', 'Same'), card('a.png', 'Same'), card('c.png', 'same')]);
        const reversed = buildLibraryItems([card('c.png', 'same'), card('a.png', 'Same'), card('b.png', 'Same')]);

        expect(forward.map(item => item.value)).toEqual(['a.png', 'b.png', 'c.png']);
        expect(reversed.map(item => item.value)).toEqual(forward.map(item => item.value));
    });

    test('sorts 3,000 cards fast enough to stay on the open\'s critical path', () => {
        const cards = Array.from({ length: 3000 }, (_, index) => card(`card-${index}.png`, `Name ${(index * 7919) % 3000}`, { fav: index % 29 === 0 }));
        const started = performance.now();

        const items = buildLibraryItems(cards);

        expect(items).toHaveLength(3000);
        expect(items[0].favorite).toBe(true);
        expect(performance.now() - started).toBeLessThan(250);
    });
});

describe('character library: favourites', () => {
    test.each([
        [{ fav: true }, true],
        [{ fav: 'true' }, true],
        [{ fav: 'false' }, false],
        [{ fav: false }, false],
        [{}, false],
        [{ data: { extensions: { fav: true } } }, true],
        [{ fav: false, data: { extensions: { fav: true } } }, true],
        [null, false],
    ])('%j is %s', (input, expected) => {
        expect(isFavoriteCard(input)).toBe(expected);
    });
});

describe('character library: the tag filter', () => {
    const tags = [
        { id: 'fan', name: 'Fantasy', color: '#ff0000' },
        { id: 'ani', name: 'anime', color: '' },
        { id: 'unused', name: 'Nobody has it' },
    ];
    const items = buildLibraryItems(
        [card('a.png', 'Ann'), card('b.png', 'Bea'), card('c.png', 'Cat')],
        { tagMap: { 'a.png': ['fan', 'ani'], 'b.png': ['fan'], 'c.png': ['gone'] } },
    );

    test('offers only the tags that a listed character carries, sorted by name', () => {
        expect(listTagChips(items, tags)).toEqual([
            { value: 'ani', label: 'anime', color: '' },
            { value: 'fan', label: 'Fantasy', color: '#ff0000' },
        ]);
    });

    test('offers none when no character is tagged', () => {
        expect(listTagChips(buildLibraryItems([card('a.png', 'Ann')]), tags)).toEqual([]);
    });

    test('keeps a character only when it has every selected tag', () => {
        const byLabel = selected => items.filter(item => matchesAllTags(item, new Set(selected))).map(item => item.label);

        expect(byLabel([])).toEqual(['Ann', 'Bea', 'Cat']);
        expect(byLabel(['fan'])).toEqual(['Ann', 'Bea']);
        expect(byLabel(['fan', 'ani'])).toEqual(['Ann']);
        expect(byLabel(['ani', 'missing'])).toEqual([]);
    });
});
