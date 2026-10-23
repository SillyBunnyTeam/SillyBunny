/* eslint-disable playwright/no-standalone-expect -- Jest source contract test. */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

// UI modules written for the Connections and Agents rework. Add each new module here (plan §5.4, Q32).
const MODULES = [
    'public/scripts/sillybunny-editor/rows.js',
    'public/scripts/sillybunny-editor/select-row.js',
    'public/scripts/sillybunny-editor/toggle-row.js',
    'public/scripts/sillybunny-connections-panel.js',
    'public/scripts/sillybunny-connections-form.js',
    'public/scripts/sillybunny-connections-groups.js',
];

const TRANSLATED = /\bt`((?:[^`\\]|\\.)*)`|\btranslate\(\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2/g;

function translatedStrings(source) {
    return [...source.matchAll(TRANSLATED)].map(match => match[1] ?? match[3]);
}

describe('UI copy rules', () => {
    test('the matcher finds template and call forms', () => {
        expect(translatedStrings('t`Delete…` translate(\'Export...\') t`Search`')).toEqual(['Delete…', 'Export...', 'Search']);
    });

    for (const file of MODULES) {
        test(`${file} uses the U+2026 ellipsis, never three dots, in translatable strings`, () => {
            const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
            expect(translatedStrings(source).filter(text => text.includes('...'))).toEqual([]);
        });
    }
});
