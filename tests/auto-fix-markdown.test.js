import { describe, expect, test } from '@jest/globals';

import { autoFixMarkdown } from '../public/scripts/auto-fix-markdown.js';

const HORIZONTAL_WHITESPACE = /[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const ALL_HORIZONTAL_WHITESPACE = new RegExp(HORIZONTAL_WHITESPACE.source, 'g');

// fixMarkdown() as upstream SillyTavern ships it in public/scripts/power-user.js, with its utils.js helpers inlined.
function upstreamFixMarkdown(text, forDisplay) {
    function countOccurrences(string, character) {
        let count = 0;

        for (let i = 0; i < string.length; i++) {
            if (string.substring(i, i + character.length) === character) {
                count++;
            }
        }

        return count;
    }

    function isOdd(number) {
        return number % 2 !== 0;
    }

    // Find pairs of formatting characters and capture the text in between them
    const format = /([*_]{1,2})([\s\S]*?)\1/gm;
    let matches = [];
    let match;
    while ((match = format.exec(text)) !== null) {
        matches.push(match);
    }

    // Iterate through the matches and replace adjacent spaces immediately beside formatting characters
    let newText = text;
    for (let i = matches.length - 1; i >= 0; i--) {
        let matchText = matches[i][0];
        let replacementText = matchText.replace(/(\*|_)([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)|([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)(\*|_)/g, '$1$4');
        newText = newText.slice(0, matches[i].index) + replacementText + newText.slice(matches[i].index + matchText.length);
    }

    // Don't auto-fix asterisks if this is a message clean-up procedure.
    // It botches the continue function. Apply this to display only.
    if (!forDisplay) {
        return newText;
    }

    const splitText = newText.split('\n');

    // Fix asterisks, and quotes that are not paired
    for (let index = 0; index < splitText.length; index++) {
        const line = splitText[index];
        const charsToCheck = ['*', '"'];
        for (const char of charsToCheck) {
            if (line.includes(char) && isOdd(countOccurrences(line, char))) {
                splitText[index] = line.trimEnd() + char;
            }
        }
    }

    newText = splitText.join('\n');

    return newText;
}

const keptTexts = [
    '*italic **bold and italic** italic*',
    '*She said **no** and left.*',
    '**bold *italic* bold**',
    '**Warning:** *this is **very** important*',
    '*italic **bold***',
    '*one **two *three* two** one*',
    '* **Name:** the first item\n* **Other:** the second item',
    '*   **Name:** Gemini-style bullet\n*   **Other:** second',
    '* plain item one\n* plain item two',
    'Before\n\n* * *\n\nAfter',
    'Scene one.\n\n***\n\nScene two.',
    'An empty pair * * stays.',
    '```c\nint *p = &x;\nint y = a * b * c;\n```',
    '```sql\nSELECT * FROM users;\n```',
    '~~~\nSELECT * FROM users;\n~~~',
    'Use `a * b * c` here.',
    'Run `ls *.md` or `echo "hi` now.',
    'snake_case_file and other_one',
    '\\* not emphasis \\*',
];

const fixedTexts = [
    ['* text *', '*text*'],
    ['*text * and * more*', '*text* and *more*'],
    ['** bold **', '**bold**'],
    ['_ under _ and __ line __', '_under_ and __line__'],
    ['"Hi," *she says * softly.', '"Hi," *she says* softly.'],
    ['*a ** b ** c*', '*a **b** c*'],
    ['\\\\*a *', '\\\\*a*'],
    ['file_name and _ spaced _', 'file_name and _spaced_'],
];

const ordinaryTexts = [
    'Plain prose with no marks at all.',
    '*She smiles.*',
    '**Bold** words, *italic* words, _under_ words and __strong__ words.',
    '*She smiles',
    'She smiles*',
    '*She smiles   ',
    '"Hello there',
    'He said "hi" and "bye.',
    '*She looks up. "Hello?',
    '*She said "yes*',
    'She said * hello * to me.',
    '*text * and * more*',
    '** Bold claim ** and *  spaced  *',
    '_ under _ and __ line __',
    '"Hi," *she says * softly.',
    'She looks *\tcrooked\u00a0* today.',
    '*a* *b* *c',
    '_She smiles_ and _waves',
    '2 * 3 = 6',
    'First line.\n*Second line\nThird "line',
    'Line one.\r\n*Line two\r\nLine three.',
    '*She waves.*\n\n"Hi!" she says.\n*He nods*',
    '*The rain had not stopped for hours.* She pulled her coat tighter. "We should go," *she whispered, glancing at the door.*',
];

function generateTexts(count, seed) {
    const tokens = ['*', '**', '***', '_', '__', ' ', '  ', '\t', '\u00a0', '\u3000', 'a', 'word', 'snake_case', '`', '```', '~~~', '\\', '"', '-', '\n', '\r\n', '.'];
    let state = seed;
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    const texts = [];
    for (let i = 0; i < count; i++) {
        let text = '';
        const length = 1 + Math.floor(next() * 24);
        for (let j = 0; j < length; j++) {
            text += tokens[Math.floor(next() * tokens.length)];
        }
        texts.push(text);
    }
    return texts;
}

function deletesOnlyHorizontalWhitespace(text, fixed) {
    let fixedIndex = 0;
    for (let index = 0; index < text.length; index++) {
        if (text[index] === fixed[fixedIndex]) {
            fixedIndex++;
        } else if (!HORIZONTAL_WHITESPACE.test(text[index])) {
            return false;
        }
    }
    return fixedIndex === fixed.length;
}

describe('autoFixMarkdown', () => {
    test.each(keptTexts)('leaves %j unchanged when stored and when displayed', (text) => {
        expect(autoFixMarkdown(text, false)).toBe(text);
        expect(autoFixMarkdown(text, true)).toBe(text);
    });

    test.each(fixedTexts)('removes the spaces inside a broken pair in %j', (text, fixed) => {
        expect(autoFixMarkdown(text, false)).toBe(fixed);
        expect(autoFixMarkdown(text, true)).toBe(fixed);
    });

    test('closes an unpaired * or " only for display', () => {
        expect(autoFixMarkdown('*She smiles', true)).toBe('*She smiles*');
        expect(autoFixMarkdown('*She smiles', false)).toBe('*She smiles');
        expect(autoFixMarkdown('"Hello there', true)).toBe('"Hello there"');
        expect(autoFixMarkdown('"Hello there', false)).toBe('"Hello there');
    });

    test('does not count a bullet marker as an unpaired *', () => {
        expect(autoFixMarkdown('She waved.\n* She smiles', true)).toBe('She waved.\n* She smiles');
        expect(autoFixMarkdown('She waved.\n* She smiles', false)).toBe('She waved.\n* She smiles');
    });

    test('does not pair an escaped mark', () => {
        expect(autoFixMarkdown('Say * one \\* two * now', false)).toBe('Say *one \\* two* now');
    });

    test('treats the rest of the text as code after a fence that does not close', () => {
        const streaming = 'Here:\n```js\nconst total = price * count;';

        expect(autoFixMarkdown(streaming, true)).toBe(streaming);
    });

    test('reads three backticks with more backticks on the line as inline code, not a fence', () => {
        const text = '```inline``` and * this *\n*next line';

        expect(autoFixMarkdown(text, false)).toBe('```inline``` and *this*\n*next line');
        expect(autoFixMarkdown(text, true)).toBe('```inline``` and *this*\n*next line*');
    });

    test.each(ordinaryTexts)('gives the upstream result for ordinary text %j', (text) => {
        expect(autoFixMarkdown(text, false)).toBe(upstreamFixMarkdown(text, false));
        expect(autoFixMarkdown(text, true)).toBe(upstreamFixMarkdown(text, true));
    });

    test('only deletes horizontal whitespace from stored text', () => {
        const corpus = [
            ...keptTexts,
            ...fixedTexts.map(([text]) => text),
            ...ordinaryTexts,
            ...generateTexts(3000, 955),
        ];
        const broken = corpus.filter((text) => {
            const fixed = autoFixMarkdown(text, false);
            return fixed.replace(ALL_HORIZONTAL_WHITESPACE, '') !== text.replace(ALL_HORIZONTAL_WHITESPACE, '')
                || !deletesOnlyHorizontalWhitespace(text, fixed);
        });

        expect(broken).toEqual([]);
    });

    test('stays linear on long lines', () => {
        const runs = 50000;
        const unpaired = '_a '.repeat(runs) + 'a* '.repeat(runs);
        const broken = '* a * '.repeat(runs) + 'end';
        const startedAt = performance.now();

        expect(autoFixMarkdown(unpaired, true)).toBe(unpaired);
        expect(autoFixMarkdown(broken, true)).toBe('*a* '.repeat(runs) + 'end');
        // A search of the whole opener stack for each run would take far longer than this budget.
        expect(performance.now() - startedAt).toBeLessThan(5000);
    });
});
