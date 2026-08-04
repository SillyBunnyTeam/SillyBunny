import { describe, expect, test } from '@jest/globals';

import { readVariableValue } from '../public/scripts/slash-commands/SlashCommandRuntimeUtils.js';

// readVariableValue backs all three variable readers: getLocalVariable and
// getGlobalVariable in public/scripts/variables.js, and SlashCommandScope.getVariable
// for scoped (/let, /var) variables. Those modules pull in browser-only code and cannot
// be imported here, so the shared helper is what gets covered.

/** The expression this replaced, verbatim, for parity checks. */
const upstream = (value) =>
    ((value?.trim?.() === '' || isNaN(Number(value))) ? (value || '') : Number(value));

/** Values upstream rewrites on read; the whole point of the change. */
const LOSSY = ['00', '007', '0.50', '1.10', '+5', '.5', '1e3', '0x10', '-0'];

/** Values that must keep behaving exactly as they always have. */
const UNCHANGED = [
    ['5', 5],
    ['12.5', 12.5],
    ['-3', -3],
    ['0', 0],
    ['1000', 1000],
    ['-0.25', -0.25],
    ['  5  ', 5],
    ['abc', 'abc'],
    ['5 apples', '5 apples'],
    ['true', 'true'],
    ['', ''],
];

describe('reading a variable that is plainly numeric', () => {
    test('numeric text still reads back as a number', () => {
        for (const [stored, expected] of UNCHANGED) {
            expect(readVariableValue(stored)).toBe(expected);
        }
    });

    test('surrounding whitespace is still tolerated', () => {
        expect(readVariableValue('  5  ')).toBe(5);
    });
});

describe('reading a variable whose text a number would change', () => {
    test('the stored text is returned unchanged', () => {
        for (const stored of LOSSY) {
            expect(readVariableValue(stored)).toBe(stored);
        }
    });

    test('a zero-padded clock minute survives, which is the reported symptom', () => {
        expect(readVariableValue('00')).toBe('00');
        expect(`7:${readVariableValue('00')}`).toBe('7:00');
    });
});

describe('reading a variable that is not numeric', () => {
    test('a whitespace-only value is preserved, not turned into 0', () => {
        // Guarded upstream since 4336253b2; Number('   ') is 0, which is what that
        // commit was fixing. Kept exactly as it was.
        expect(readVariableValue('   ')).toBe('   ');
    });

    test('unset and null keep their existing, differing results', () => {
        // Not a distinction worth changing here: both are upstream behaviour and
        // altering either would be a separate change with its own blast radius.
        expect(readVariableValue(undefined)).toBe('');
        expect(readVariableValue(null)).toBe(0);
    });
});

describe('values arriving from the index path', () => {
    // getLocalVariable/getGlobalVariable JSON.parse the value when args.index is set,
    // so the helper can be handed a number or a boolean rather than a string. Those
    // must keep their old behaviour: Number(false) is 0, but Number('false') is NaN.
    test('numbers pass straight through', () => {
        expect(readVariableValue(5)).toBe(5);
        expect(readVariableValue(0)).toBe(0);
        expect(readVariableValue(-2.5)).toBe(-2.5);
    });

    test('booleans still read as 1 and 0, as they did before', () => {
        expect(readVariableValue(true)).toBe(1);
        expect(readVariableValue(false)).toBe(0);
    });
});

describe('parity with the upstream expression', () => {
    test('every value except the lossy ones matches upstream exactly', () => {
        const sameAsBefore = [
            ...UNCHANGED.map(([stored]) => stored),
            '   ', undefined, null, 5, 0, true, false,
        ];
        for (const value of sameAsBefore) {
            expect(readVariableValue(value)).toBe(upstream(value));
        }
    });

    test('the only differences are values upstream would rewrite', () => {
        for (const value of LOSSY) {
            expect(readVariableValue(value)).toBe(value);
            expect(upstream(value)).not.toBe(value);
        }
    });
});

describe('arithmetic callers still work', () => {
    // addLocalVariable/addGlobalVariable re-read through the helper and then apply
    // Number() themselves, so a preserved string must still add up correctly.
    test('a padded value still adds numerically', () => {
        const current = readVariableValue('00');
        expect(current).toBe('00');
        expect(Number(current) + 5).toBe(5);
    });

    test('a padded counter increments to a plain number', () => {
        expect(Number(readVariableValue('007')) + 1).toBe(8);
    });

    test('the || 0 fallback in addLocalVariable is unaffected', () => {
        // '0' stays the number 0 (falsy), and '00' becomes a truthy string, but both
        // yield 0 once Number() is applied, which is all the caller does with it.
        expect(Number(readVariableValue('0') || 0)).toBe(0);
        expect(Number(readVariableValue('00') || 0)).toBe(0);
    });
});
