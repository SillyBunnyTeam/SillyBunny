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
});
