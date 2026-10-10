import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe('prompt manager source token counts', () => {
    test.beforeEach(testSetup.awaitST);

    test('reuses the runtime substitution and re-evaluates edited prompts', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const context = window.SillyTavern.getContext();
            const pm = context.promptManager;
            const prompts = [
                { identifier: 'sbtest_setter', name: 'Setter', role: 'system', content: '{{setvar::sbtest_880::on}}' },
                { identifier: 'sbtest_comment', name: 'Readme', role: 'system', content: '{{// only a note}}' },
                { identifier: 'sbtest_injection', name: 'Injection', role: 'system', content: 'Hi {{getvar::sbtest_880}}' },
                { identifier: 'sbtest_text', name: 'Text', role: 'system', content: 'Mode is {{getvar::sbtest_880}}' },
            ];
            const saved = {
                activeCharacter: pm.activeCharacter,
                tokenHandler: pm.tokenHandler,
                promptTokenCounts: pm.promptTokenCounts,
                runtimePreparedPromptContent: pm.runtimePreparedPromptContent,
            };
            const prepared = [];
            const preparePrompt = pm.preparePrompt.bind(pm);

            pm.activeCharacter = saved.activeCharacter ?? { id: 'sbtest' };
            pm.tokenHandler = { countUntrackedAsync: async message => message.content.length };
            pm.getPromptsForCharacter = () => prompts;
            pm.getPromptOrderForCharacter = () => prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true }));
            pm.getPromptById = identifier => prompts.find(prompt => prompt.identifier === identifier);
            pm.shouldTrigger = () => true;
            pm.preparePrompt = (prompt, original) => {
                prepared.push(prompt.identifier);
                return preparePrompt(prompt, original);
            };

            const pass = async () => {
                prepared.length = 0;
                await pm.populateSourcePromptTokenCounts();
                return { prepared: [...prepared], counts: { ...pm.sourcePromptTokenCounts }, usage: pm.sourcePromptTokenUsage };
            };

            try {
                pm.promptTokenCounts = {};
                pm.runtimePreparedPromptContent = new Map();
                const withoutRuntime = await pass();

                pm.getPromptCollection('normal');
                pm.promptTokenCounts = { sbtest_text: 10 };
                const reused = await pass();

                const savedRuntime = pm.runtimePreparedPromptContent;
                pm.runtimePreparedPromptContent = new Map();
                const evaluated = await pass();
                pm.runtimePreparedPromptContent = savedRuntime;

                prompts[0].content = '{{setvar::sbtest_880::off}}';
                const edited = await pass();

                return { withoutRuntime, reused, evaluated, edited };
            } finally {
                for (const name of ['getPromptsForCharacter', 'getPromptOrderForCharacter', 'getPromptById', 'shouldTrigger', 'preparePrompt']) {
                    delete pm[name];
                }
                Object.assign(pm, saved);
                delete context.chatMetadata?.variables?.sbtest_880;
            }
        });

        expect(result.withoutRuntime.prepared).toEqual(['sbtest_setter', 'sbtest_comment', 'sbtest_injection', 'sbtest_text']);
        expect(result.withoutRuntime.counts).toEqual({ sbtest_setter: 26, sbtest_injection: 5, sbtest_text: 10 });
        expect(result.withoutRuntime.usage).toBe(15);

        expect(result.reused.prepared).toEqual([]);
        expect(result.reused.counts).toEqual({ sbtest_setter: 26, sbtest_injection: 5 });
        expect(result.reused).toEqual({ ...result.evaluated, prepared: [] });
        expect(result.evaluated.prepared).toEqual(['sbtest_setter', 'sbtest_comment', 'sbtest_injection']);

        expect(result.edited.prepared).toEqual(['sbtest_setter']);
        expect(result.edited.counts.sbtest_setter).toBe(27);
    });
});
