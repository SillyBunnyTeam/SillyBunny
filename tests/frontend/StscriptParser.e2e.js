import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { installStscriptHarness } from './stscript-parser-harness.js';

const fixtureDirectory = new URL('../fixtures/stscript/', import.meta.url);
const OPTION_NAMES = ['verify', 'flags', 'configuredFlags', 'experimentalMacroEngine', 'positions', 'debug'];

const HINT_CASES = [
    { script: '/stp-plain a | /nosuch', lines: ['/stp-plain a | /nosuch'] },
    { script: '/stp-plain a |\n/stp-plain b |\n/nosuch', lines: ['/stp-plain a |', '/stp-plain b |', '/nosuch'] },
    { script: '/stp-plain a |\n\n/nosuch', lines: ['/stp-plain a |', '', '/nosuch'] },
    { script: '\t/nosuch', lines: ['    /nosuch'] },
    {
        script: Array.from({ length: 12 }, (_, line) => `/stp-plain line${line} |`).join('\n') + '\n/nosuch',
        lines: ['/stp-plain line10 |', '/stp-plain line11 |', '/nosuch'],
    },
];

function loadCases() {
    return fs.readdirSync(fixtureDirectory)
        .filter(file => file.endsWith('.json'))
        .sort()
        .flatMap(file => JSON.parse(fs.readFileSync(new URL(file, fixtureDirectory), 'utf8')).map(item => ({ ...item, file })));
}

function toInput(item) {
    return Object.fromEntries(['script', ...OPTION_NAMES].filter(key => key in item).map(key => [key, item[key]]));
}

function label(item) {
    return `${item.file} / ${item.name}: ${JSON.stringify(item.script)}`;
}

function withoutHint(result) {
    if (!result.error) return result;
    const error = { ...result.error };
    delete error.hint;
    return { error };
}

function expectedResult(item) {
    if (!item.expected.error) return item.expected;
    return { error: { type: 'SlashCommandParserError', hasText: true, ...item.expected.error } };
}

function indexIsInside(result, script) {
    const index = result.error?.index;
    return Number.isInteger(index) && index >= 0 && index <= script.length;
}

function splitHint(hint) {
    const lines = hint.split('\n');
    return {
        sourceLines: lines.slice(0, -1).map(line => line.replace(/^\s*\d+: {2}/, '')),
        marker: lines.at(-1),
    };
}

test.describe('STscript parser', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await page.evaluate(installStscriptHarness);
    });

    test('parses the corpus into the committed trees', async ({ page }) => {
        const cases = loadCases().filter(item => item.expected.tree);
        expect(cases.length).toBeGreaterThan(0);

        const results = await page.evaluate(inputs => inputs.map(input => window.stscriptHarness.run(input)), cases.map(toInput));

        cases.forEach((item, index) => {
            expect.soft(results[index], label(item)).toEqual(item.expected);
        });
    });

    test('reports malformed scripts as parser errors that point into the text', async ({ page }) => {
        const cases = loadCases().filter(item => item.expected.error);
        expect(cases.length).toBeGreaterThan(0);

        const results = await page.evaluate(inputs => inputs.map(input => window.stscriptHarness.run(input)), cases.map(toInput));

        cases.forEach((item, index) => {
            expect.soft(withoutHint(results[index]), label(item)).toEqual(expectedResult(item));
            expect.soft(indexIsInside(results[index], item.script), `${label(item)} has an index inside the text`).toBe(true);
        });
    });

    test('shows the offending source lines in the error hint', async ({ page }) => {
        const hints = await page.evaluate(
            scripts => scripts.map(script => window.stscriptHarness.run({ script }).error.hint),
            HINT_CASES.map(item => item.script),
        );

        HINT_CASES.forEach((item, index) => {
            const { sourceLines, marker } = splitHint(hints[index]);
            expect.soft(sourceLines, JSON.stringify(item.script)).toEqual(item.lines);
            expect.soft(marker, JSON.stringify(item.script)).toMatch(/^ +\^{5}$/);
        });
    });

    test('parses every corpus script the same way on a parser that handled other scripts first', async ({ page }) => {
        const cases = loadCases();
        const inputs = cases.map(toInput);

        const forward = await page.evaluate(items => window.stscriptHarness.runOnOneParser(items), inputs);
        const backward = (await page.evaluate(items => window.stscriptHarness.runOnOneParser(items), inputs.toReversed())).toReversed();

        cases.forEach((item, index) => {
            expect.soft(withoutHint(forward[index]), label(item)).toEqual(expectedResult(item));
            expect.soft(withoutHint(backward[index]), `${label(item)} in reverse order`).toEqual(expectedResult(item));
        });
    });

    test('hands the abort and debug controllers to every nested closure', async ({ page }) => {
        const shared = await page.evaluate(() => window.stscriptHarness.controllers());

        expect(shared).toEqual([
            { abort: true, debug: true },
            { abort: true, debug: true },
            { abort: true, debug: true },
        ]);
    });
});
