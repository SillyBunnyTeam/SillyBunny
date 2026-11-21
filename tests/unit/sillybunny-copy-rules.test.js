/* eslint-disable playwright/no-standalone-expect -- Jest source contract test. */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { COPY_RULE_MODULES } from '../helpers/copy-rule-modules.js';

const TRANSLATED = /\bt`((?:[^`\\]|\\.)*)`|\btranslate\(\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2/g;

function translatedStrings(source) {
    return [...source.matchAll(TRANSLATED)].map(match => match[1] ?? match[3]);
}

describe('UI copy rules', () => {
    test('the matcher finds template and call forms', () => {
        expect(translatedStrings('t`Delete…` translate(\'Export...\') t`Search`')).toEqual(['Delete…', 'Export...', 'Search']);
    });

    for (const file of COPY_RULE_MODULES) {
        test(`${file} uses the U+2026 ellipsis, never three dots, in translatable strings`, () => {
            const source = readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8');
            expect(translatedStrings(source).filter(text => text.includes('...'))).toEqual([]);
        });
    }
});
