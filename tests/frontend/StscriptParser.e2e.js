import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { installStscriptHarness } from './stscript-parser-harness.js';

const fixtureDirectory = new URL('../fixtures/stscript/', import.meta.url);
const OPTION_NAMES = ['verify', 'flags', 'configuredFlags', 'experimentalMacroEngine', 'positions', 'debug'];

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

    test('parses every corpus script the same way on a parser that handled other scripts first', async ({ page }) => {
        const cases = loadCases();
        const inputs = cases.map(toInput);

        const forward = await page.evaluate(items => window.stscriptHarness.runOnOneParser(items), inputs);
        const backward = (await page.evaluate(items => window.stscriptHarness.runOnOneParser(items), inputs.toReversed())).toReversed();

        cases.forEach((item, index) => {
            expect.soft(forward[index], label(item)).toEqual(item.expected);
            expect.soft(backward[index], `${label(item)} in reverse order`).toEqual(item.expected);
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
