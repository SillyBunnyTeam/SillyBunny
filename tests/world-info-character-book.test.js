import { describe, expect, test } from '@jest/globals';

import { escapeCharacterBookRegex, normalizeCharacterBookPosition, normalizeWorldInfoPosition, serializeCharacterBookKeys } from '../public/scripts/world-info-character-book.js';

const positions = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

describe('normalizeWorldInfoPosition', () => {
    test('passes through valid numeric enum positions', () => {
        expect(normalizeWorldInfoPosition(0, positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition(1, positions)).toBe(positions.after);
        expect(normalizeWorldInfoPosition(4, positions)).toBe(positions.atDepth);
    });

    test('returns undefined for out-of-enum integers', () => {
        expect(normalizeWorldInfoPosition(12, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition(-1, positions)).toBeUndefined();
    });

    test('normalizes numeric string positions', () => {
        expect(normalizeWorldInfoPosition('0', positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition('1', positions)).toBe(positions.after);
    });

    test('returns undefined for out-of-enum numeric strings', () => {
        expect(normalizeWorldInfoPosition('99', positions)).toBeUndefined();
    });

    test('maps before_char and its aliases', () => {
        expect(normalizeWorldInfoPosition('before_char', positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition('before', positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition('before character', positions)).toBe(positions.before);
    });

    test('maps after_char and its aliases', () => {
        expect(normalizeWorldInfoPosition('after_char', positions)).toBe(positions.after);
        expect(normalizeWorldInfoPosition('after', positions)).toBe(positions.after);
        expect(normalizeWorldInfoPosition('after character', positions)).toBe(positions.after);
    });

    test('maps depth aliases', () => {
        expect(normalizeWorldInfoPosition('at_depth', positions)).toBe(positions.atDepth);
        expect(normalizeWorldInfoPosition('depth', positions)).toBe(positions.atDepth);
    });

    test('maps AN aliases', () => {
        expect(normalizeWorldInfoPosition('an_top', positions)).toBe(positions.ANTop);
        expect(normalizeWorldInfoPosition('author_note_top', positions)).toBe(positions.ANTop);
        expect(normalizeWorldInfoPosition('an_bottom', positions)).toBe(positions.ANBottom);
        expect(normalizeWorldInfoPosition('author_note_bottom', positions)).toBe(positions.ANBottom);
    });

    test('maps EM aliases', () => {
        expect(normalizeWorldInfoPosition('em_top', positions)).toBe(positions.EMTop);
        expect(normalizeWorldInfoPosition('examples_top', positions)).toBe(positions.EMTop);
        expect(normalizeWorldInfoPosition('em_bottom', positions)).toBe(positions.EMBottom);
        expect(normalizeWorldInfoPosition('examples_bottom', positions)).toBe(positions.EMBottom);
    });

    test('maps outlet alias', () => {
        expect(normalizeWorldInfoPosition('outlet', positions)).toBe(positions.outlet);
    });

    test('returns undefined for unknown strings', () => {
        expect(normalizeWorldInfoPosition('garbage', positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition('', positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition('   ', positions)).toBeUndefined();
    });

    test('returns undefined for non-string non-number values', () => {
        expect(normalizeWorldInfoPosition(undefined, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition(null, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition({}, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition(true, positions)).toBeUndefined();
    });
});

describe('normalizeCharacterBookPosition', () => {
    test('normalizes CC/ST before_char extension positions', () => {
        expect(normalizeCharacterBookPosition('before_char', 'after_char', positions)).toBe(positions.before);
    });

    test('normalizes CC/ST after_char entry positions', () => {
        expect(normalizeCharacterBookPosition(undefined, 'after_char', positions)).toBe(positions.after);
    });

    test('preserves numeric World Info positions', () => {
        expect(normalizeCharacterBookPosition(positions.atDepth, 'before_char', positions)).toBe(positions.atDepth);
    });

    test('normalizes numeric string positions from imported metadata', () => {
        expect(normalizeCharacterBookPosition('0', 'after_char', positions)).toBe(positions.before);
    });

    test('falls back to before when no known position exists', () => {
        expect(normalizeCharacterBookPosition('unknown', undefined, positions)).toBe(positions.before);
    });

    test('falls back to before for out-of-enum integer positions', () => {
        expect(normalizeCharacterBookPosition(99, 12, positions)).toBe(positions.before);
    });
});

describe('serializeCharacterBookKeys', () => {
    test('serializes unflagged regexes without delimiters', () => {
        expect(serializeCharacterBookKeys(['/foo/'], ['/bar/'])).toEqual({
            keys: ['foo'],
            secondaryKeys: ['bar'],
            useRegex: true,
        });
    });

    test('preserves delimiters when they carry regex flags', () => {
        expect(serializeCharacterBookKeys(['/foo/i'], [])).toEqual({
            keys: ['/foo/i'],
            secondaryKeys: [],
            useRegex: true,
        });
    });

    test('keeps internal keys unchanged when regex and plaintext keys are mixed', () => {
        expect(serializeCharacterBookKeys(['/foo/i'], ['bar'])).toEqual({
            keys: ['/foo/i'],
            secondaryKeys: ['bar'],
            useRegex: false,
        });
    });

    test('does not classify plaintext with unescaped slashes as regex', () => {
        expect(serializeCharacterBookKeys(['/foo/bar/'], [])).toEqual({
            keys: ['/foo/bar/'],
            secondaryKeys: [],
            useRegex: false,
        });
    });

    test('round-trips delimiter slashes without accumulating backslashes', () => {
        const rawKey = 'foo/bar';
        const internalKey = `/${escapeCharacterBookRegex(rawKey)}/`;
        const serialized = serializeCharacterBookKeys([internalKey], []);

        expect(internalKey).toBe('/foo\\/bar/');
        expect(serialized.keys).toEqual([rawKey]);
        expect(`/${escapeCharacterBookRegex(serialized.keys[0])}/`).toBe(internalKey);
    });

    test('preserves literal backslashes before delimiter slashes', () => {
        const rawKey = String.raw`foo\\/bar`;
        const internalKey = `/${escapeCharacterBookRegex(rawKey)}/`;
        expect(serializeCharacterBookKeys([internalKey], []).keys).toEqual([rawKey]);
    });
});
