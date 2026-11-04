import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { installStscriptHarness } from './stscript-parser-harness.js';

function parse(page, inputs) {
    return page.evaluate(items => items.map(item => window.stscriptHarness.run(item)), inputs);
}

function summarizeError(result) {
    return { type: result.error?.type, message: result.error?.message, index: result.error?.index };
}

function executeWithErrorToasts(page, script) {
    return page.evaluate(async script => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        const errorTitles = [];
        const showError = window.toastr.error;
        window.toastr.error = (message, title) => {
            errorTitles.push(title);
        };
        try {
            const result = await executeSlashCommandsWithOptions(script);
            return { pipe: result.pipe ?? null, errorTitles };
        } catch (error) {
            return { thrown: `${error.name}: ${error.message}`, errorTitles };
        } finally {
            window.toastr.error = showError;
        }
    }, script);
}

test.describe('STscript parser fixes', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await page.evaluate(installStscriptHarness);
    });

    test('a nested block comment ends at its own closing mark', async ({ page }) => {
        const results = await parse(page, [
            { script: '/* a /* b *|*| /stp-plain ok' },
            { script: '/stp-plain {: /* a /* b *|*| /stp-plain c :}' },
            { script: '/*/**|' },
            { script: '/* a /* b *|' },
        ]);

        expect.soft(results[0]).toEqual({ tree: { executors: [{ name: 'stp-plain', unnamed: ['ok'] }] } });
        expect.soft(results[1]).toEqual({
            tree: {
                executors: [{
                    name: 'stp-plain',
                    unnamed: [{ closure: { rawText: ' /* a /* b *|*| /stp-plain c ', executors: [{ name: 'stp-plain', unnamed: ['c'] }] } }],
                }],
            },
        });
        expect.soft(summarizeError(results[2])).toEqual({ type: 'SlashCommandParserError', message: 'Unclosed block comment at position 6', index: 6 });
        expect.soft(summarizeError(results[3])).toEqual({ type: 'SlashCommandParserError', message: 'Unclosed block comment at position 12', index: 12 });
    });

    test('an empty key= on /let parses like an empty value on any other command', async ({ page }) => {
        const results = await parse(page, [
            { script: '/let key= x' },
            { script: '/let key= x', verify: false },
        ]);

        for (const result of results) {
            expect.soft(result).toEqual({ tree: { executors: [{ name: 'let', named: [{ name: 'key', value: null }], unnamed: ['x'] }] } });
        }
    });

    test('a split argument that starts with extra whitespace raises a parser error with its position', async ({ page }) => {
        const [result] = await parse(page, [{ script: '/parser-flag  STRICT_ESCAPING' }]);

        expect.soft(summarizeError(result)).toEqual({ type: 'SlashCommandParserError', message: 'Unexpected end of unnamed argument at index 13.', index: 13 });
        expect.soft(await executeWithErrorToasts(page, '/parser-flag  STRICT_ESCAPING')).toEqual({ pipe: null, errorTitles: ['SlashCommandParserError'] });
    });

    test('an escaped first character stays at the start of the first split value', async ({ page }) => {
        const results = await parse(page, [
            { script: '/stp-split \\|1 2' },
            { script: '/stp-split \\| 2' },
            { script: '/let \\|x 1' },
            { script: '/stp-plain {: /stp-split \\:} x :}' },
            { script: '/stp-split \\| a', flags: { STRICT_ESCAPING: true } },
        ]);

        expect.soft(results[0]).toEqual({ tree: { executors: [{ name: 'stp-split', unnamed: ['|1', '2'] }] } });
        expect.soft(results[1]).toEqual({ tree: { executors: [{ name: 'stp-split', unnamed: ['|', '2'] }] } });
        expect.soft(results[2]).toEqual({ tree: { variables: ['|x'], executors: [{ name: 'let', unnamed: ['|x', '1'] }] } });
        expect.soft(results[3]).toEqual({
            tree: {
                executors: [{
                    name: 'stp-plain',
                    unnamed: [{ closure: { rawText: ' /stp-split \\:} x ', executors: [{ name: 'stp-split', unnamed: [':}', 'x'] }] } }],
                }],
            },
        });
        expect.soft(results[4]).toEqual({ tree: { executors: [{ name: 'stp-split', unnamed: ['|', 'a'], flags: ['STRICT_ESCAPING'] }] } });
    });

    test('/parser-flag without a flag name raises a parser error', async ({ page }) => {
        const results = await parse(page, [
            { script: '/parser-flag ' },
            { script: '/parser-flag ', verify: false },
            { script: '/parser-flag | /stp-plain ok' },
            { script: '/stp-plain {: /parser-flag :}' },
        ]);

        expect.soft(results.map(summarizeError)).toEqual([
            { type: 'SlashCommandParserError', message: 'Unexpected end of unnamed argument at index 13.', index: 13 },
            { type: 'SlashCommandParserError', message: 'Unexpected end of unnamed argument at index 13.', index: 13 },
            { type: 'SlashCommandParserError', message: 'Unexpected end of unnamed argument at index 13.', index: 13 },
            { type: 'SlashCommandParserError', message: 'Unexpected end of unnamed argument at index 27.', index: 27 },
        ]);
    });

    test('a closure among split values keeps the quotes in the rest', async ({ page }) => {
        const results = await parse(page, [
            { script: '/stp-split2 a {: /stp-plain y :} "b c" d' },
            { script: '/stp-split1 {: :} "b c" d' },
        ]);

        expect.soft(results[0]).toEqual({
            tree: {
                executors: [{
                    name: 'stp-split2',
                    unnamed: ['a', { closure: { rawText: ' /stp-plain y ', executors: [{ name: 'stp-plain', unnamed: ['y'] }] } }, '"b c" d'],
                }],
            },
        });
        expect.soft(results[1]).toEqual({ tree: { executors: [{ name: 'stp-split1', unnamed: [{ closure: { rawText: ' ', executors: [] } }, '"b c" d'] }] } });
    });
});
