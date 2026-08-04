import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const openAiSource = readSource('../public/scripts/openai.js');
const chatCompletionsSource = readSource('../src/endpoints/backends/chat-completions.js');

describe('DeepSeek reasoning effort', () => {
    test('exposes the reasoning effort control and a DeepSeek-specific hint', () => {
        const wrapper = indexSource.match(/<div class="flex-container flexFlowColumn wide100p textAlignCenter marginTop10" data-source="([^"]*)">\s*<div class="flex-container oneline-dropdown"[^>]*>\s*<label for="openai_reasoning_effort">/);

        expect(wrapper).not.toBeNull();
        expect(wrapper[1].split(',')).toContain('deepseek');
        expect(indexSource).toMatch(/data-source="deepseek"[^>]*>\s*DeepSeek only accepts low, high, and max reasoning efforts\./);

        // The generic OpenAI-style caption describes tiers DeepSeek does not have, so it must not claim DeepSeek.
        const genericCaption = indexSource.match(/data-source="([^"]*)"[^>]*>\s*OpenAI-style options: low, medium, high, xhigh\./);
        expect(genericCaption).not.toBeNull();
        expect(genericCaption[1].split(',')).not.toContain('deepseek');
    });

    test('keeps DeepSeek out of the string-effort resolver so max is not collapsed to high', () => {
        const sources = openAiSource.match(/const reasoningEffortSources = \[([\s\S]*?)\];/);

        expect(sources).not.toBeNull();
        expect(sources[1]).not.toContain('DEEPSEEK');
    });

    test('forwards the effort to DeepSeek for thinking models only, mapping min to low', () => {
        const handler = chatCompletionsSource.match(/async function sendDeepSeekRequest\(request, response\) \{([\s\S]*?)\n\}/);

        expect(handler).not.toBeNull();
        expect(handler[1]).toContain('const isThinkingModel = /(?:^|-)reasoner$|deepseek-v4/i.test(String(request.body.model || \'\'));');
        expect(handler[1]).toContain('if (isThinkingModel && request.body.reasoning_effort && ![\'auto\', \'none\'].includes(request.body.reasoning_effort)) {');
        expect(handler[1]).toContain('bodyParams[\'reasoning_effort\'] = request.body.reasoning_effort === \'min\' ? \'low\' : request.body.reasoning_effort;');
    });

    test('offers the current V4 model ids, both of which the server treats as thinking models', () => {
        const picker = indexSource.match(/<select id="model_deepseek_select">([\s\S]*?)<\/select>/);

        expect(picker).not.toBeNull();
        const modelIds = [...picker[1].matchAll(/value="([^"]*)"/g)].map(m => m[1]);
        expect(modelIds).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
        expect(openAiSource).toContain('deepseek_model: \'deepseek-v4-flash\',');

        // Every shipped default must satisfy the handler's isThinkingModel test, or the dropdown silently does nothing.
        for (const model of modelIds) {
            expect(/(?:^|-)reasoner$|deepseek-v4/i.test(model)).toBe(true);
        }
    });
});
