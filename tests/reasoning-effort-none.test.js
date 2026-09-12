import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const openAiSource = readSource('../public/scripts/openai.js').replace(/\r\n/g, '\n');
const chatCompletionsSource = readSource('../src/endpoints/backends/chat-completions.js');

describe('reasoning effort \'none\'', () => {
    test('the client resolves \'none\' to a literal only for OpenAI-style sources on GPT-5.1+ models', () => {
        // GPT-5.1 and newer accept 'none' as a value that pins thinking off. Omitting the field
        // there lets the model pick its own default depth, which defeats picking None. Every
        // other source keeps omitting it, because endpoints that do not list the value reject it.
        const declarations = ['chat_completion_sources', 'reasoning_effort_types'].map(name =>
            openAiSource.match(new RegExp(`export const ${name} = \\{[\\s\\S]*?\\n\\};`))[0].replace('export ', ''),
        );
        const effortSource = openAiSource.match(/function getReasoningEffort\([\s\S]*?\n\}/)[0];
        const context = { model_list: [] };
        runInNewContext([...declarations, effortSource].join('\n'), context);

        const results = ['openai', 'openai_responses', 'azure_openai', 'custom', 'fireworks', 'openrouter'].flatMap(source =>
            ['gpt-5', 'gpt-5.1', 'gpt-5.6', 'gpt-5.10', 'other-model'].map(model => ({
                source,
                model,
                effort: context.getReasoningEffort({ chat_completion_source: source, reasoning_effort: 'none' }, model),
            })),
        );
        expect(results.filter(result => result.effort === 'none')).toEqual(
            ['openai', 'openai_responses', 'azure_openai', 'custom'].flatMap(source =>
                ['gpt-5.1', 'gpt-5.6', 'gpt-5.10'].map(model => ({ source, model, effort: 'none' })),
            ),
        );
        expect(results.every(result => result.effort === 'none' || result.effort === undefined)).toBe(true);
    });

    test('the NanoGPT handler forwards \'none\' untouched', () => {
        // NanoGPT's documented ladder starts at none. Gating on a translation table made the
        // caller omit the reasoning key entirely, letting the model default to thinking.
        expect(chatCompletionsSource).toContain('if (request.body.reasoning_effort && request.body.reasoning_effort !== \'auto\') {');
        expect(chatCompletionsSource).toContain('bodyParams[\'reasoning\'] = { effort: toWireReasoningEffort(request.body.reasoning_effort) };');
    });

    test('the UI no longer promises that None is never sent', () => {
        expect(indexSource).not.toContain('None (don\'t send)');
        expect(indexSource).not.toContain('None does not send an effort level.');
        expect(indexSource).toContain('None is sent verbatim to GPT-5.1 and newer; other models get no effort level.');
    });
});
