import { describe, expect, test } from '@jest/globals';

const { buildSearchIndex, foldText, searchRows } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-search.js');

// A row is [emoji, name, keywords joined with "|", group, version, variants?].
const ROWS = [
    ['❤️', 'red heart', 'love|heart|valentine', 7, 0.6],
    ['💔', 'broken heart', 'heartbreak|sad|break', 7, 0.6],
    ['😍', 'smiling face with heart-eyes', 'love|crush|eyes', 0, 0.6],
    ['🫀', 'anatomical heart', 'organ|cardiology', 1, 13],
    ['🍎', 'red apple', 'fruit|apple', 3, 0.6],
    ['🇫🇷', 'drapeau : France', 'drapeau|français', 8, 0.6],
    ['👋', '手を振る', 'バイバイ|こんにちは', 1, 0.6],
];
const index = buildSearchIndex(ROWS);
const find = query => searchRows(index, query).map(i => ROWS[i][0]);

describe('foldText', () => {
    test('drops accents and case', () => {
        expect(foldText('Français')).toBe('francais');
        expect(foldText('  ÉCOLE ')).toBe('ecole');
    });

    test('keeps a script that has no case, with its marks that carry meaning', () => {
        expect(foldText('手を振る')).toBe('手を振る');
    });
});

describe('searchRows', () => {
    test('finds nothing for an empty query or one that matches nothing', () => {
        expect(find('')).toEqual([]);
        expect(find('   ')).toEqual([]);
        expect(find('zebra')).toEqual([]);
    });

    test('puts an exact name first, then names that start with the query, then words of a name', () => {
        expect(find('red heart')).toEqual(['❤️']);
        expect(find('heart')).toEqual(['❤️', '💔', '😍', '🫀']);
        expect(find('red')).toEqual(['❤️', '🍎']);
    });

    test('ranks a name that starts with the query before a name that only has the word', () => {
        const rows = [['A', 'big red heart', 'x', 0, 1], ['B', 'heart red', 'x', 0, 1], ['C', 'heart', 'x', 0, 1]];
        const ranked = searchRows(buildSearchIndex(rows), 'heart').map(i => rows[i][0]);
        expect(ranked).toEqual(['C', 'B', 'A']);
    });

    test('finds a row by a keyword, after the rows whose name matches', () => {
        expect(find('valentine')).toEqual(['❤️']);
        expect(find('love')).toEqual(['❤️', '😍']);
        expect(find('apple')).toEqual(['🍎']);
    });

    test('matches inside a word, which is how a language without spaces is found', () => {
        expect(find('振る')).toEqual(['👋']);
        expect(find('rt')).toEqual(['❤️', '💔', '😍', '🫀']);
    });

    test('needs every word of the query', () => {
        expect(find('red apple')).toEqual(['🍎']);
        expect(find('broken apple')).toEqual([]);
    });

    test('ignores case and accents of the query and of the data', () => {
        expect(find('FRANCE')).toEqual(['🇫🇷']);
        expect(find('francais')).toEqual(['🇫🇷']);
    });

    test('keeps the order of the table among equal ranks, and stops at the limit', () => {
        expect(searchRows(index, 'heart', { limit: 2 }).map(i => ROWS[i][0])).toEqual(['❤️', '💔']);
    });
});
