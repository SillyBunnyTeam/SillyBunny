import { describe, expect, test } from '@jest/globals';

import { STORED_RENAME_EXCLUDES, parseArguments, pathPatternOf } from '../scripts/rename-conversation-identifiers.mjs';

const isExcluded = file => STORED_RENAME_EXCLUDES.some(entry => pathPatternOf(entry).test(file));

describe('the exclusions of the stored-name rename', () => {
    test('name the files that keep the old shape of the store', () => {
        expect(STORED_RENAME_EXCLUDES).toEqual([
            'public/scripts/sillybunny-conversation/legacy-import.js',
            'tests/conversation-legacy*',
            'tests/util/conversation-legacy-fixture.js',
            'tests/sillybunny-conversation-key-compatibility.test.js',
        ]);
    });

    test.each([
        'public/scripts/sillybunny-conversation/legacy-import.js',
        'tests/conversation-legacy.test.js',
        'tests/conversation-legacy-extras.test.js',
        'tests/util/conversation-legacy-fixture.js',
        'tests/sillybunny-conversation-key-compatibility.test.js',
    ])('match %s', (file) => {
        expect(isExcluded(file)).toBe(true);
    });

    test.each([
        'public/scripts/sillybunny-conversation/context.js',
        'tests/sillybunny-conversation-context-migration.test.js',
        'tests/conversation-migration.test.js',
        'tests/conversation-legacy/nested/file.js',
        'xtests/conversation-legacy.test.js',
        'public/scripts/sillybunny-conversation/legacy-import.jsx',
    ])('leave %s in the rename', (file) => {
        expect(isExcluded(file)).toBe(false);
    });

    test('a dot in a path is a dot and not any character', () => {
        expect(pathPatternOf('a/b.js').test('a/bxjs')).toBe(false);
        expect(pathPatternOf('a/b.js').test('a/b.js')).toBe(true);
    });
});

describe('the arguments of the rename script', () => {
    test('--exclude can be given more than once and keeps the order', () => {
        const options = parseArguments(['--include-stored', '--exclude', 'one.js', '--exclude', 'two/*.js']);

        expect(options.includeStored).toBe(true);
        expect(options.excludes).toEqual(['one.js', 'two/*.js']);
    });

    test('--exclude without a path is refused', () => {
        expect(() => parseArguments(['--exclude'])).toThrow('--exclude needs a path');
    });

    test('no exclusions by default', () => {
        expect(parseArguments([]).excludes).toEqual([]);
    });
});
