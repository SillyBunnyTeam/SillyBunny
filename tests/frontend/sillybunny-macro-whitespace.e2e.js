import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

const MARKER_PATTERN = /[﷐﷑]/;

test.describe('SillyBunny macro whitespace', () => {
    test.beforeEach(testSetup.awaitST);

    test.describe('explicit whitespace macros survive trims', () => {
        test('{{noop}} prevents newline trimming around {{trim}}', async ({ page }) => {
            const output = await evaluateWithEngine(page, 'foo\n{{noop}}{{trim}}\nbar');
            expect(output).toBe('foo\nbar');
        });

        test('{{noop}} preserves the space in variable shorthand assignment values', async ({ page }) => {
            const output = await evaluateWithEngine(page, '{{.myvar = foo}}{{.myvar += {{noop}} bar}}{{.myvar}}');
            expect(output).toBe('foo bar');
        });

        test('{{newline}} works inside {{if}} branches', async ({ page }) => {
            const output = await evaluateWithEngine(page, 'foo{{if 1}}{{newline}}{{/if}}bar');
            expect(output).toBe('foo\nbar');
        });

        test('{{space}} works inside {{if}} branches', async ({ page }) => {
            const output = await evaluateWithEngine(page, 'a{{if 1}}{{space}}{{/if}}b');
            expect(output).toBe('a b');
        });

        test('{{newline}} works inside nested {{if}} branches', async ({ page }) => {
            const output = await evaluateWithEngine(page, '{{if 1}}{{if 1}}{{newline}}x{{/if}}{{/if}}');
            expect(output).toBe('\nx');
        });

        test('the # (preserveWhitespace) flag keeps working', async ({ page }) => {
            const output = await evaluateWithEngine(page, 'foo{{#if 1}}{{newline}}{{/if}}bar');
            expect(output).toBe('foo\nbar');
        });
    });

    test.describe('other whitespace behaves as before', () => {
        test('literal author whitespace is still trimmed in assignment values', async ({ page }) => {
            const output = await evaluateWithEngine(page, '{{.myvar = x }}{{.myvar}}');
            expect(output).toBe('x');
        });

        test('literal author whitespace is still trimmed in {{if}} branches', async ({ page }) => {
            const output = await evaluateWithEngine(page, 'foo{{if 1}} hi {{/if}}bar');
            expect(output).toBe('foohibar');
        });

        test('{{trim}} without {{noop}} still eats surrounding newlines', async ({ page }) => {
            const output = await evaluateWithEngine(page, 'foo\n{{trim}}\nbar');
            expect(output).toBe('foobar');
        });

        test('{{trim}} still eats {{newline}} output next to it', async ({ page }) => {
            expect(await evaluateWithEngine(page, 'a{{newline}}{{trim}}b')).toBe('ab');
            expect(await evaluateWithEngine(page, 'a{{trim}}{{newline}}b')).toBe('ab');
        });

        test('comparison operands are unaffected', async ({ page }) => {
            const output = await evaluateWithEngine(page, '{{setvar::a:: 5 }}{{.a == 5}}');
            expect(output).toBe('true');
        });

        test('comparison result is usable in {{if}}', async ({ page }) => {
            const output = await evaluateWithEngine(page, '{{setvar::c:: 5 }}{{if {{.c == 5}} }}Y{{else}}N{{/if}}');
            expect(output).toBe('Y');
        });

        test('object variable values are still JSON', async ({ page }) => {
            await page.evaluate(() => SillyTavern.getContext().variables.local.set('vobj', { a: 1 }));
            const output = await evaluateWithEngine(page, '[{{getvar::vobj}}]');
            expect(output).toBe('[{"a":1}]');
        });
    });

    test.describe('no markers leave the engine', () => {
        test('stored variables contain no markers via named macros', async ({ page }) => {
            await evaluateWithEngine(page, '{{setvar::x::{{newline}}}}');
            expect(await evaluateWithEngine(page, '{{getvar::x}}')).toBe('\n');
            await evaluateWithEngine(page, '{{setvar::y::a{{noop}}b}}');
            expect(await evaluateWithEngine(page, '{{getvar::y}}')).toBe('ab');
        });

        test('macro results stored in variables contain no markers', async ({ page }) => {
            const output = await evaluateWithEngine(page, '{{.myvar = a{{newline}}b}}{{.myvar}}');
            expect(output).toBe('a\nb');
        });

        test('output of common macros contains no markers', async ({ page }) => {
            for (const name of ['newline', 'space', 'noop', 'char', 'user', 'model', 'time', 'date']) {
                expect(await evaluateWithEngine(page, `x{{${name}}}y`)).not.toMatch(MARKER_PATTERN);
            }
        });

        test('a failed macro inside an {{if}} branch leaves no markers', async ({ page }) => {
            expect(await evaluateWithEngine(page, '{{if 1}}{{nonexistentmacrowithargs::x::y::z}}{{newline}}{{/if}}')).not.toMatch(MARKER_PATTERN);
            expect(await evaluateWithEngine(page, 'a {{newline}} b')).toBe('a \n b');
        });

        for (const priority of [5, 50.5, 100]) {
            test(`a post-processor at priority ${priority} runs on each evaluation and gets no markers`, async ({ page }) => {
                const result = await page.evaluate(async ({ priority }) => {
                    const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
                    const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');

                    const input = 'a{{newline}}b{{if 1}}{{newline}}{{/if}}c';
                    const seen = [];
                    const handler = text => {
                        seen.push(text);
                        return text;
                    };
                    MacroEngine.addPostProcessor(handler, { priority, source: 'e2e' });
                    try {
                        const env = MacroEnvBuilder.buildFromRawEnv({ content: input, name1Override: 'User', name2Override: 'Character' });
                        return { output: MacroEngine.evaluate(input, env), seen };
                    } finally {
                        MacroEngine.removePostProcessor(handler);
                    }
                }, { priority });

                expect(result.output).toBe('a\nb\nc');
                expect(result.seen).toEqual(['1', '\n', 'a\nb\nc']);
            });
        }
    });
});

/**
 * Evaluates the given input string using the MacroEngine inside the browser
 * context, ensuring that the core macros are registered.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} input
 * @returns {Promise<string>}
 */
async function evaluateWithEngine(page, input) {
    return await page.evaluate(async (input) => {
        /** @type {import('../../public/scripts/macros/engine/MacroEngine.js')} */
        const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
        /** @type {import('../../public/scripts/macros/engine/MacroEnvBuilder.js')} */
        const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');

        /** @type {import('../../public/scripts/macros/engine/MacroEnvBuilder.js').MacroEnvRawContext} */
        const rawEnv = {
            content: input,
            name1Override: 'User',
            name2Override: 'Character',
        };
        const env = MacroEnvBuilder.buildFromRawEnv(rawEnv);

        return MacroEngine.evaluate(input, env);
    }, input);
}
