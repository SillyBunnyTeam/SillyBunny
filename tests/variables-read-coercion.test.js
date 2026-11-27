import { describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

import {
    booleanOperandToString,
    isNumericZero,
    readVariableValue,
} from '../public/scripts/slash-commands/SlashCommandRuntimeUtils.js';

const resolvePublic = relativePath => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));
const chatMetadata = { variables: {} };
const extensionSettings = { variables: { global: {} } };
const noop = () => {};

await jest.unstable_mockModule(resolvePublic('script.js'), () => ({
    chat_metadata: chatMetadata,
    getCurrentChatId: () => 'test-chat',
    saveSettingsDebounced: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/extensions.js'), () => ({
    extension_settings: extensionSettings,
    saveMetadataDebounced: noop,
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands.js'), () => ({
    executeSlashCommandsWithOptions: async () => ({ pipe: '' }),
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommand.js'), () => ({ SlashCommand: { fromProps: props => props } }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandAbortController.js'), () => ({ SlashCommandAbortController: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandArgument.js'), () => ({
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list', DICTIONARY: 'dictionary', CLOSURE: 'closure', RANGE: 'range', VARIABLE_NAME: 'variable_name' },
    SlashCommandArgument: { fromProps: props => props },
    SlashCommandNamedArgument: { fromProps: props => props },
}));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandBreakController.js'), () => ({ SlashCommandBreakController: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandClosure.js'), () => ({ SlashCommandClosure: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandClosureResult.js'), () => ({ SlashCommandClosureResult: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({ commonEnumProviders: {}, enumIcons: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({ SlashCommandEnumValue: class {}, enumTypes: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandParser.js'), () => ({ SlashCommandParser: { addCommandObject: noop } }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({ slashCommandReturnHelper: {} }));
await jest.unstable_mockModule(resolvePublic('scripts/slash-commands/SlashCommandScope.js'), () => ({ SlashCommandScope: class {} }));
await jest.unstable_mockModule(resolvePublic('scripts/utils.js'), () => ({
    isFalseBoolean: value => ['false', '0', 'off', 'no'].includes(String(value).toLowerCase()),
    isTrueBoolean: value => ['true', '1', 'on', 'yes'].includes(String(value).toLowerCase()),
    convertValueType: value => value,
}));

const { evalBoolean, getGlobalVariable, getLocalVariable, setGlobalVariable, setLocalVariable } = await import('../public/scripts/variables.js');

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

    test('a zero-padded clock minute survives through local and global variable readers', () => {
        setLocalVariable('minute', '00');
        setGlobalVariable('minute', '00');
        expect(getLocalVariable('minute')).toBe('00');
        expect(getGlobalVariable('minute')).toBe('00');
        expect(`7:${getLocalVariable('minute')}`).toBe('7:00');
    });
});

describe('reading a variable that is not numeric', () => {
    test('a whitespace-only value is preserved, not turned into 0', () => {
        expect(readVariableValue('   ')).toBe('   ');
    });

    test('unset and null keep their existing, differing results', () => {
        expect(readVariableValue(undefined)).toBe('');
        expect(readVariableValue(null)).toBe(0);
    });
});

describe('values arriving from the index path', () => {
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
    test('a padded value still adds numerically', () => {
        const current = readVariableValue('00');
        expect(current).toBe('00');
        expect(Number(current) + 5).toBe(5);
    });

    test('a padded counter increments to a plain number', () => {
        expect(Number(readVariableValue('007')) + 1).toBe(8);
    });

    test('the || 0 fallback in addLocalVariable is unaffected', () => {
        expect(Number(readVariableValue('0') || 0)).toBe(0);
        expect(Number(readVariableValue('00') || 0)).toBe(0);
    });
});

describe('boolean callers retain upstream semantics', () => {
    test('alternate numeric spellings of zero stay falsy', () => {
        for (const value of ['00', '-0', '+0', '0.0', '0e0', '0x0']) {
            expect(readVariableValue(value)).toBe(value);
            expect(isNumericZero(readVariableValue(value))).toBe(true);
        }
        expect(isNumericZero('0.01')).toBe(false);
        expect(isNumericZero('off')).toBe(false);
    });

    test('containment uses the numeric spelling upstream readers produced', () => {
        expect(booleanOperandToString(readVariableValue('007'))).toBe('7');
        expect(booleanOperandToString(readVariableValue('1e3'))).toBe('1000');
        expect(booleanOperandToString(readVariableValue('0.50'))).toBe('0.5');
        expect(booleanOperandToString(readVariableValue('+Infinity'))).toBe('null');
        expect(booleanOperandToString('Needle')).toBe('needle');
    });
});

describe('evalBoolean is wired to those helpers', () => {
    test('every numeric spelling of zero is still falsy', () => {
        for (const stored of ['00', '-0', '+0', '0.0', '0e0', '0x0', '-00.0']) {
            expect(evalBoolean(undefined, readVariableValue(stored), undefined)).toBe(false);
            expect(evalBoolean('not', readVariableValue(stored), undefined)).toBe(true);
        }
    });

    test('padded non-zero values stay truthy, so the zero guard does not overreach', () => {
        for (const stored of ['007', '01', '0.50']) {
            expect(evalBoolean(undefined, readVariableValue(stored), undefined)).toBe(true);
            expect(evalBoolean('not', readVariableValue(stored), undefined)).toBe(false);
        }
    });

    test('containment compares the canonical spelling, not the padding', () => {
        expect(evalBoolean('in', readVariableValue('007'), 0)).toBe(false);
        expect(evalBoolean('nin', readVariableValue('007'), 0)).toBe(true);
        expect(evalBoolean('in', readVariableValue('1e3'), 100)).toBe(true);
        expect(evalBoolean('eq', readVariableValue('0.50'), 'half')).toBe(false);
    });

    test('preserved text still takes the numeric branch instead of throwing', () => {
        expect(evalBoolean('gt', readVariableValue('007'), 5)).toBe(true);
        expect(evalBoolean('lte', readVariableValue('0.50'), 0.5)).toBe(true);
        expect(evalBoolean('eq', readVariableValue('0.50'), 0.5)).toBe(true);
        expect(evalBoolean('neq', readVariableValue('00'), 0)).toBe(false);
        expect(() => evalBoolean('gt', readVariableValue('abc'), 5)).toThrow();
    });
});
