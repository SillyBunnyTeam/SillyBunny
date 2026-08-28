import { jest } from '@jest/globals';
import * as chevrotain from 'chevrotain';

await jest.unstable_mockModule('../public/lib.js', () => ({ chevrotain }));

const { MacroLexer } = await import('../public/scripts/macros/engine/MacroLexer.js');
const { MacroParser } = await import('../public/scripts/macros/engine/MacroParser.js');

/**
 * @param {string} input
 * @returns {string[]} Flat list of error messages from lexing and parsing
 */
function parseErrors(input) {
    const result = MacroParser.parseDocument(input);
    return result.errors.map(x => String(x.message).split('\n')[0]);
}

/**
 * @param {string} input
 * @returns {string[]} Names of the tokens the lexer produced
 */
function tokenNames(input) {
    return MacroLexer.test(input).tokens.map(x => x.type);
}

const commentsWithPipes = {
    'bare pipe': '{{// a | b}}',
    'pipe inside brackets': '{{// see [CENSUS:RESIDENT|Name] for recurring characters}}',
    'escaped pipe': '{{// a \\| b}}',
    'consecutive pipes': '{{// a||b}}',
    'pipe at the very end': '{{// trailing pipe |}}',
    'multiline body with pipes': '{{// README\n\n- [CENSUS:LODGER|Name]\n- [CENSUS:PASSERBY|Name]\n}}\n{{trim}}',
};

const commentsWithoutPipes = {
    'plain comment': '{{// just a comment}}',
    'nested macro': '{{// text {{user}} more}}',
    'colon separated args': '{{// a::b:c}}',
    'empty comment': '{{//}}',
};

describe('comment macros containing pipes', () => {
    for (const [name, input] of Object.entries(commentsWithPipes)) {
        test(`parses without errors: ${name}`, () => {
            expect(parseErrors(input)).toEqual([]);
        });
    }

    test('does not lex pipes inside a comment as filter tokens', () => {
        expect(tokenNames('{{// a|b}}')).not.toContain('Filter.Pipe');
    });

    test('still lexes pipes outside a comment as filter tokens', () => {
        expect(tokenNames('{{foo a|b}}')).toContain('Filter.Pipe');
    });
});

describe('comment macros without pipes', () => {
    for (const [name, input] of Object.entries(commentsWithoutPipes)) {
        test(`keeps parsing without errors: ${name}`, () => {
            expect(parseErrors(input)).toEqual([]);
        });
    }
});
