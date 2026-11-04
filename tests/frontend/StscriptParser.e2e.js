import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { installStscriptHarness } from './stscript-parser-harness.js';

const fixtureDirectory = new URL('../fixtures/stscript/', import.meta.url);
const OPTION_NAMES = ['verify', 'flags', 'configuredFlags', 'experimentalMacroEngine', 'positions', 'debug'];

const FUZZ_FIRST_SEED = 1;
const FUZZ_ITERATIONS = 10000;
const BATCH_SIZE = 100;
const BATCH_TIME_LIMIT_MS = 10000;
const FUZZ_FLAG_CHOICES = [
    null,
    { STRICT_ESCAPING: true },
    { REPLACE_GETVAR: true },
    { STRICT_ESCAPING: true, REPLACE_GETVAR: true },
];
const FUZZ_FRAGMENTS = [
    '{:', ':}', '|', '||', '"', '\\', '[', ']', '=', ' ', '\n', '\t', '/*', '*|', '//', '/#', '/:', '()', '{{', '}}',
    '::', 'key=', '/stp-plain ', '/stp-split ', '/stp-split1 ', '/stp-raw ', '/break', '/breakpoint |', '/let x ',
    '/parser-flag ', '/parser-flag STRICT_ESCAPING', '{{pipe}}', '\\|', '\\"', '\\{:', '\\:}', '{{getvar::v}}',
    '/import from=a ', '/', ':', '*', '#', '\u{1F600}', '\u0000',
];

const HINT_CASES = [
    { script: '/stp-plain a | /nosuch', lines: ['/stp-plain a | /nosuch'] },
    { script: '/stp-plain a |\n/stp-plain b |\n/nosuch', lines: ['/stp-plain a |', '/stp-plain b |', '/nosuch'] },
    { script: '/stp-plain a |\n\n/nosuch', lines: ['/stp-plain a |', '', '/nosuch'] },
    { script: '\t/nosuch', lines: ['    /nosuch'] },
    {
        script: Array.from({ length: 12 }, (_, line) => `/stp-plain line${line} |`).join('\n') + '\n/nosuch',
        lines: ['/stp-plain line10 |', '/stp-plain line11 |', '/nosuch'],
    },
    { script: '/nosuch|\n/stp-plain x', lines: ['/nosuch|'] },
    { script: '/stp-plain a |\n/nosuch x\n/stp-plain b', lines: ['/stp-plain a |', '/nosuch x'] },
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

function mulberry32(seed) {
    let state = seed | 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(random, list) {
    return list[Math.floor(random() * list.length)];
}

function mutate(random, text, corpus) {
    const at = Math.floor(random() * (text.length + 1));
    const fragment = pick(random, FUZZ_FRAGMENTS);
    switch (Math.floor(random() * 7)) {
        case 0: return text.slice(0, at) + text.slice(at + 1 + Math.floor(random() * 3));
        case 1: return text.slice(0, at) + fragment + text.slice(at);
        case 2: return text.slice(0, at);
        case 3: return text.slice(0, at) + text.slice(at, at + 1 + Math.floor(random() * 8)) + text.slice(at);
        case 4: return at + 1 < text.length ? text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2) : text;
        case 5: return text.slice(0, at) + fragment + text.slice(at + 1);
        default: {
            const other = pick(random, corpus).script;
            const from = Math.floor(random() * other.length);
            return text.slice(0, at) + other.slice(from, from + 1 + Math.floor(random() * 20)) + text.slice(at);
        }
    }
}

/** Every field derives from the seed, so one seed reproduces one input. */
function generateInput(seed, corpus) {
    const random = mulberry32(seed);
    let script = pick(random, corpus).script;
    for (let edits = 1 + Math.floor(random() * 4); edits > 0; edits--) {
        script = mutate(random, script, corpus);
    }
    return {
        seed,
        script,
        verify: random() < 0.7,
        flags: pick(random, FUZZ_FLAG_CHOICES),
        experimentalMacroEngine: random() < 0.1,
        debug: random() < 0.2,
    };
}

function prefixInputs(corpus) {
    const seen = new Set();
    const inputs = [];
    for (const item of corpus) {
        for (const verify of [true, false]) {
            for (let length = 0; length <= item.script.length; length++) {
                const input = { ...toInput(item), script: item.script.slice(0, length), verify };
                const key = JSON.stringify(input);
                if (!seen.has(key)) {
                    seen.add(key);
                    inputs.push({ ...input, source: `${item.file} / ${item.name}` });
                }
            }
        }
    }
    return inputs;
}

function withTimeLimit(promise, milliseconds, describeHang) {
    let timer;
    const hang = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(describeHang())), milliseconds);
    });
    return Promise.race([promise, hang]).finally(() => clearTimeout(timer));
}

/** Parses the inputs in small batches so a hang can be traced to the inputs that were in flight. */
async function parseInBatches(page, inputs, title) {
    const counts = { tree: 0, error: 0 };
    const failures = [];
    for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
        const batch = inputs.slice(start, start + BATCH_SIZE);
        const outcomes = await withTimeLimit(
            page.evaluate(items => window.stscriptHarness.outcomes(items), batch.map(toInput)),
            BATCH_TIME_LIMIT_MS,
            () => `${title}: parsing did not finish for the inputs ${start} to ${start + batch.length - 1}: ${JSON.stringify(batch)}`,
        );
        outcomes.forEach((outcome, offset) => {
            const input = batch[offset];
            if (outcome === 'tree' || outcome === 'error') {
                counts[outcome]++;
            } else {
                failures.push({ input, outcome });
            }
        });
    }
    return { counts, failures };
}

function describeFailures(title, failures) {
    if (!failures.length) return '';
    return `${title}: ${failures.length} inputs neither parsed nor raised a well formed parser error. First: ${JSON.stringify(failures.slice(0, 3))}`;
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

    test('mutated corpus scripts either parse or raise a well formed parser error', async ({ page }) => {
        const corpus = loadCases();
        const inputs = Array.from({ length: FUZZ_ITERATIONS }, (_, offset) => generateInput(FUZZ_FIRST_SEED + offset, corpus));

        const { counts, failures } = await parseInBatches(page, inputs, 'fuzz');

        expect(failures, describeFailures('fuzz', failures)).toEqual([]);
        expect(counts.tree + counts.error).toBe(FUZZ_ITERATIONS);
        expect(counts.tree).toBeGreaterThan(FUZZ_ITERATIONS * 0.1);
        expect(counts.error).toBeGreaterThan(FUZZ_ITERATIONS * 0.1);
    });

    test('every prefix of every corpus script either parses or raises a well formed parser error', async ({ page }) => {
        const inputs = prefixInputs(loadCases());

        const { counts, failures } = await parseInBatches(page, inputs, 'prefix sweep');

        expect(failures, describeFailures('prefix sweep', failures)).toEqual([]);
        expect(counts.tree + counts.error).toBe(inputs.length);
        expect(counts.tree).toBeGreaterThan(inputs.length * 0.1);
        expect(counts.error).toBeGreaterThan(inputs.length * 0.1);
    });
});
