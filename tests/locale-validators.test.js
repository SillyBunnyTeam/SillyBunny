import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from 'html-entities';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDirectory, '..');
const localesDirectory = path.join(repoRoot, 'public', 'locales');
const baselineFile = 'tests/fixtures/locale-validation-baseline.json';
const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, baselineFile), 'utf8'));

const jsonFileNames = fs.readdirSync(localesDirectory).filter(name => name.endsWith('.json')).sort();
const localeFileNames = jsonFileNames.filter(name => name !== 'lang.json');

const placeholderPattern = /\$\{\d+\}/g;
const attributeTokenPattern = /\[(\S+)\](.+)/;
const attributeNamePattern = /^[A-Za-z_:][-\w:.]*$/;

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function readLocaleText(file) {
    const text = fs.readFileSync(path.join(localesDirectory, file), 'utf8');
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function readLocale(file) {
    return JSON.parse(readLocaleText(file));
}

function findStringEnd(text, start) {
    for (let index = start + 1; index < text.length; index++) {
        if (text[index] === '\\') {
            index++;
        } else if (text[index] === '"') {
            return index;
        }
    }
    throw new Error(`Unterminated string at offset ${start}`);
}

// JSON.parse keeps only the last copy of a repeated key, so the keys come from the source text.
function readTopLevelKeys(text) {
    const keys = [];
    const colonFollows = /\s*:/y;
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            const end = findStringEnd(text, index);
            colonFollows.lastIndex = end + 1;
            if (depth === 1 && colonFollows.test(text)) {
                keys.push(JSON.parse(text.slice(index, end + 1)));
            }
            index = end;
        } else if (char === '{' || char === '[') {
            depth++;
        } else if (char === '}' || char === ']') {
            depth--;
        }
    }
    return keys;
}

function findRepeatedKeys(text) {
    const counts = new Map();
    for (const key of readTopLevelKeys(text)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].filter(([, count]) => count > 1);
}

function findDroppedPlaceholders(key, value) {
    if (typeof value !== 'string' || value === '') {
        return [];
    }
    const wanted = new Set(key.match(placeholderPattern) ?? []);
    return [...wanted].filter(placeholder => !value.includes(placeholder)).sort();
}

function readDataI18nValues() {
    const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    const values = [];
    for (const match of html.matchAll(/\sdata-i18n\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        // The browser decodes entities before the page code splits a value on ';'.
        values.push(decode(match[1] ?? match[2], { scope: 'attribute' }));
    }
    return values;
}

function findTokenProblems(value) {
    const problems = [];
    let textTokens = 0;
    for (const token of value.split(';')) {
        if (token === '') {
            problems.push({ problem: 'empty token', locator: value });
            continue;
        }
        const match = token.match(attributeTokenPattern);
        if (!match) {
            textTokens++;
            continue;
        }
        if (match.index > 0) {
            problems.push({ problem: 'text before the [attribute] part', locator: match[0] });
        }
        if (!attributeNamePattern.test(match[1])) {
            problems.push({ problem: 'invalid attribute name', locator: token });
        }
    }
    if (textTokens > 1) {
        problems.push({ problem: 'more than one text token', locator: value });
    }
    return problems;
}

function record(found, scope, subject, detail) {
    found[scope] ??= Object.create(null);
    found[scope][subject] = detail;
}

function flattenEntries(sections) {
    const entries = new Map();
    for (const [scope, subjects] of Object.entries(sections)) {
        for (const [subject, detail] of Object.entries(subjects)) {
            entries.set(JSON.stringify([scope, subject]), { scope, subject, detail });
        }
    }
    return entries;
}

function compareWithBaseline(section, found, describeEntry) {
    const known = flattenEntries(baseline[section] ?? {});
    const current = flattenEntries(found);
    const added = [];
    const stale = [];
    for (const [id, entry] of current) {
        if (JSON.stringify(known.get(id)?.detail) !== JSON.stringify(entry.detail)) {
            added.push(describeEntry(entry));
        }
    }
    for (const [id, entry] of known) {
        if (JSON.stringify(current.get(id)?.detail) !== JSON.stringify(entry.detail)) {
            stale.push(`Remove from ${baselineFile}, it no longer occurs: ${describeEntry(entry)}`);
        }
    }
    return { added, stale };
}

const describeRepeatedKey = ({ scope, subject, detail }) => `${scope} repeats the key ${JSON.stringify(subject)} ${detail} times`;
const describeDroppedPlaceholders = ({ scope, subject, detail }) => `${scope} drops ${detail.join(', ')} from the value of ${JSON.stringify(subject)}`;
const describeTokenProblem = ({ scope, subject, detail }) => `data-i18n ${scope}: ${JSON.stringify(subject)} (${detail} time${detail === 1 ? '' : 's'})`;

describe('locale files', () => {
    test.each(jsonFileNames)('%s parses as JSON', file => {
        let parseError = null;
        try {
            JSON.parse(readLocaleText(file));
        } catch (error) {
            parseError = error.message;
        }
        expect(parseError).toBeNull();
    });

    test.each(localeFileNames)('%s maps every key to a string or null', file => {
        const data = readLocale(file);
        expect(isPlainObject(data)).toBe(true);
        const badValues = Object.entries(data)
            .filter(([, value]) => value !== null && typeof value !== 'string')
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
        expect(badValues).toEqual([]);
    });

    test('tokenizing keys finds repeats that JSON.parse hides', () => {
        const text = '{"a": "first", "b\\"c": "{[", "a": "second"}';
        expect(Object.keys(JSON.parse(text))).toEqual(['a', 'b"c']);
        expect(readTopLevelKeys(text)).toEqual(['a', 'b"c', 'a']);
        expect(findRepeatedKeys(text)).toEqual([['a', 2]]);
    });

    test('repeats no key beyond the baseline', () => {
        const found = Object.create(null);
        for (const file of localeFileNames) {
            for (const [key, count] of findRepeatedKeys(readLocaleText(file))) {
                record(found, file, key, count);
            }
        }
        expect(compareWithBaseline('repeatedKeys', found, describeRepeatedKey)).toEqual({ added: [], stale: [] });
    });

    test('keeps every ${n} placeholder of a key in its translation beyond the baseline', () => {
        const found = Object.create(null);
        for (const file of localeFileNames) {
            for (const [key, value] of Object.entries(readLocale(file))) {
                const dropped = findDroppedPlaceholders(key, value);
                if (dropped.length > 0) {
                    record(found, file, key, dropped);
                }
            }
        }
        expect(compareWithBaseline('droppedPlaceholders', found, describeDroppedPlaceholders)).toEqual({ added: [], stale: [] });
    });

    test('lang.json lists exactly the non-English locale files', () => {
        const entries = readLocale('lang.json');
        expect(Array.isArray(entries)).toBe(true);
        const malformed = entries.filter(entry => !(typeof entry?.lang === 'string' && entry.lang !== '' && typeof entry.display === 'string' && entry.display !== ''));
        expect(malformed).toEqual([]);
        const expected = localeFileNames.filter(name => name !== 'en.json').map(name => name.replace(/\.json$/, '')).sort();
        expect(entries.map(entry => entry.lang).sort()).toEqual(expected);
    });

    test('en.json stays empty because the English text is the key', () => {
        expect(readLocale('en.json')).toEqual({});
    });

    test('reports null and empty values without failing on them', () => {
        const kinds = [
            ['null, the English text stays', value => value === null],
            ['empty, data-i18n elements show no text and translate() uses the English text', value => value === ''],
            ['whitespace only, the text renders blank', value => typeof value === 'string' && value !== '' && value.trim() === ''],
        ];
        const scanned = [];
        const lines = [];
        for (const file of localeFileNames) {
            scanned.push(file);
            const entries = Object.entries(readLocale(file));
            for (const [label, matches] of kinds) {
                const keys = entries.filter(([, value]) => matches(value)).map(([key]) => key);
                if (keys.length > 0) {
                    lines.push(`${file}, ${label}: ${keys.join(', ')}`);
                }
            }
        }
        console.info(`Locale values without a translation (reported only, never a failure):\n${lines.join('\n')}`);
        expect(scanned).toEqual(localeFileNames);
    });

    test('the baseline holds only known sections', () => {
        expect(Object.keys(baseline).sort()).toEqual(['dataI18n', 'droppedPlaceholders', 'repeatedKeys']);
    });
});

describe('data-i18n attributes in index.html', () => {
    test('are present in the markup', () => {
        expect(readDataI18nValues().length).toBeGreaterThan(0);
    });

    test('hold only text keys and [attribute]key pairs beyond the baseline', () => {
        const found = Object.create(null);
        for (const value of readDataI18nValues()) {
            for (const { problem, locator } of findTokenProblems(value)) {
                found[problem] ??= Object.create(null);
                found[problem][locator] = (found[problem][locator] ?? 0) + 1;
            }
        }
        expect(compareWithBaseline('dataI18n', found, describeTokenProblem)).toEqual({ added: [], stale: [] });
    });

    test.each([
        ['a text key', 'Save'],
        ['a text key with an attribute pair', 'Authorize;[title]Get a token'],
        ['several attribute pairs', '[title]Hint;[aria-label]Hint'],
        ['a text key with brackets that hold spaces', '[Currently loaded] model'],
    ])('accepts %s', (_name, value) => {
        expect(findTokenProblems(value)).toEqual([]);
    });

    test.each([
        ['an empty value', '', 'empty token', ''],
        ['a trailing semicolon', 'Save;', 'empty token', 'Save;'],
        ['text before the bracketed attribute', 'Save [title]Hint', 'text before the [attribute] part', '[title]Hint'],
        ['an attribute name that setAttribute rejects', '[a<b]Hint', 'invalid attribute name', '[a<b]Hint'],
        ['two text keys that overwrite each other', 'One; two', 'more than one text token', 'One; two'],
    ])('rejects %s', (_name, value, problem, locator) => {
        expect(findTokenProblems(value)).toEqual([{ problem, locator }]);
    });
});
