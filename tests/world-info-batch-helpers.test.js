import { describe, expect, test } from '@jest/globals';

import { detectEmbeddedLorebookCandidates, getLinkedAuxBooks } from '../public/scripts/world-info-batch-helpers.js';

describe('detectEmbeddedLorebookCandidates', () => {
    test('returns empty array when no characters have embedded lorebooks', () => {
        const charList = [
            { chid: 0, character: { name: 'Alice', data: {} } },
            { chid: 1, character: { name: 'Bob', data: { character_book: null } } },
        ];
        const result = detectEmbeddedLorebookCandidates(charList, []);
        expect(result).toEqual([]);
    });

    test('detects characters with embedded lorebooks', () => {
        const charList = [
            { chid: 0, character: { name: 'Alice', data: { character_book: { name: 'Alice Lore', entries: [] } } } },
            { chid: 1, character: { name: 'Bob', data: {} } },
            { chid: 2, character: { name: 'Carol', data: { character_book: { name: 'Carol Lore', entries: [] } } } },
        ];
        const result = detectEmbeddedLorebookCandidates(charList, []);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ chid: 0, characterName: 'Alice', bookName: 'Alice Lore', collision: false });
        expect(result[1]).toEqual({ chid: 2, characterName: 'Carol', bookName: 'Carol Lore', collision: false });
    });

    test('uses character name fallback when book has no name', () => {
        const charList = [
            { chid: 0, character: { name: 'Alice', data: { character_book: { entries: [] } } } },
        ];
        const result = detectEmbeddedLorebookCandidates(charList, []);
        expect(result[0].bookName).toBe(`Alice's Lorebook`);
    });

    test('detects name collisions with existing worlds', () => {
        const charList = [
            { chid: 0, character: { name: 'Alice', data: { character_book: { name: 'Existing World', entries: [] } } } },
            { chid: 1, character: { name: 'Bob', data: { character_book: { name: 'New World', entries: [] } } } },
        ];
        const result = detectEmbeddedLorebookCandidates(charList, ['Existing World', 'Other World']);
        expect(result).toHaveLength(2);
        expect(result[0].collision).toBe(true);
        expect(result[1].collision).toBe(false);
    });

    test('skips characters with undefined character_book', () => {
        const charList = [
            { chid: 0, character: { name: 'Alice', data: {} } },
            { chid: 1, character: { name: 'Bob', data: { character_book: undefined } } },
            { chid: 2, character: { name: 'Carol', data: { character_book: { name: 'Carol Lore', entries: [] } } } },
        ];
        const result = detectEmbeddedLorebookCandidates(charList, []);
        expect(result).toHaveLength(1);
        expect(result[0].characterName).toBe('Carol');
    });

    test('handles empty charList', () => {
        const result = detectEmbeddedLorebookCandidates([], ['Existing']);
        expect(result).toEqual([]);
    });
});

describe('getLinkedAuxBooks', () => {
    test('returns empty array when charLore is null', () => {
        expect(getLinkedAuxBooks(null, 'alice')).toEqual([]);
    });

    test('returns empty array when fileName is empty', () => {
        expect(getLinkedAuxBooks([{ name: 'alice', extraBooks: ['book1'] }], '')).toEqual([]);
    });

    test('returns empty array when character not found', () => {
        expect(getLinkedAuxBooks([{ name: 'bob', extraBooks: ['book1'] }], 'alice')).toEqual([]);
    });

    test('returns extraBooks for matching character', () => {
        const charLore = [
            { name: 'alice', extraBooks: ['book1', 'book2'] },
            { name: 'bob', extraBooks: ['book3'] },
        ];
        expect(getLinkedAuxBooks(charLore, 'alice')).toEqual(['book1', 'book2']);
    });

    test('returns empty array when extraBooks is undefined', () => {
        expect(getLinkedAuxBooks([{ name: 'alice' }], 'alice')).toEqual([]);
    });
});
