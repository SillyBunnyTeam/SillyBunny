import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { installStscriptHarness } from './stscript-parser-harness.js';

function parse(page, inputs) {
    return page.evaluate(items => items.map(item => window.stscriptHarness.run(item)), inputs);
}

function summarizeError(result) {
    return { type: result.error?.type, message: result.error?.message, index: result.error?.index };
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
});
