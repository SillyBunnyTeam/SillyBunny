import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const openAiSource = readSource('../public/scripts/openai.js').replace(/\r\n/g, '\n');
const toolCallingSource = readSource('../public/scripts/tool-calling.js').replace(/\r\n/g, '\n');
const chatCompletionsSource = readSource('../src/endpoints/backends/chat-completions.js');

function loadGetReasoningEffort() {
    const declarations = ['chat_completion_sources', 'reasoning_effort_types'].map(name =>
        openAiSource.match(new RegExp(`export const ${name} = \\{[\\s\\S]*?\\n\\};`))[0].replace('export ', ''),
    );
    const effortSource = openAiSource.match(/function getReasoningEffort\([\s\S]*?\n\}/)[0];
    const context = { model_list: [] };
    runInNewContext([...declarations, effortSource].join('\n'), context);
    return context.getReasoningEffort;
}

describe('reasoning effort \'none\'', () => {
    test('the client resolves \'none\' to a literal only for OpenAI-style sources on GPT-5.1+ models', () => {
        // GPT-5.1 and newer accept 'none' as a value that pins thinking off. Omitting the field
        // there lets the model pick its own default depth, which defeats picking None. Every
        // other source keeps omitting it, because endpoints that do not list the value reject it.
        const getReasoningEffort = loadGetReasoningEffort();

        const results = ['openai', 'openai_responses', 'azure_openai', 'custom', 'fireworks', 'openrouter'].flatMap(source =>
            ['gpt-5', 'gpt-5.1', 'gpt-5.6', 'gpt-5.10', 'other-model'].map(model => ({
                source,
                model,
                effort: getReasoningEffort({ chat_completion_source: source, reasoning_effort: 'none' }, model),
            })),
        );
        expect(results.filter(result => result.effort === 'none')).toEqual(
            ['openai', 'openai_responses', 'azure_openai', 'custom'].flatMap(source =>
                ['gpt-5.1', 'gpt-5.6', 'gpt-5.10'].map(model => ({ source, model, effort: 'none' })),
            ),
        );
        expect(results.every(result => result.effort === 'none' || result.effort === undefined)).toBe(true);
    });

    test('None pins thinking off on GPT-6 Sol and Luna and stays unsent on Astra', () => {
        const getReasoningEffort = loadGetReasoningEffort();

        for (const source of ['openai', 'openai_responses', 'azure_openai', 'custom']) {
            const settings = { chat_completion_source: source, reasoning_effort: 'none' };
            expect(getReasoningEffort(settings, 'gpt-6-sol')).toBe('none');
            expect(getReasoningEffort(settings, 'gpt-6-luna')).toBe('none');
            expect(getReasoningEffort(settings, 'gpt-6-astra')).toBeUndefined();
        }
    });

    test('GPT-6 Sol and Luna get Chat Completions tools only with None, and Astra never does', () => {
        // SillyTavern opens this gate on Min because it sends Min as 'none'. SillyBunny sends Min as 'minimal', so None opens it here.
        const toolSupport = toolCallingSource.match(/static isToolCallingSupported\([\s\S]*?\n {4}\}/)[0].replace('static ', 'function ');
        const supportsTools = (source, model, reasoningEffort) => runInNewContext(`(${toolSupport})(settings, model)`, {
            main_api: 'openai',
            chat_completion_sources: CHAT_COMPLETION_SOURCES,
            custom_prompt_post_processing_types: { NONE: 0 },
            model_list: [],
            model,
            settings: { chat_completion_source: source, reasoning_effort: reasoningEffort, function_calling: true, custom_prompt_post_processing: 0 },
        });

        for (const source of [CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI]) {
            for (const effort of ['auto', 'min', 'low', 'max']) {
                expect(supportsTools(source, 'gpt-6-sol', effort)).toBe(false);
                expect(supportsTools(source, 'gpt-6-luna', effort)).toBe(false);
                expect(supportsTools(source, 'gpt-6-astra', effort)).toBe(false);
            }
            expect(supportsTools(source, 'gpt-6-sol', 'none')).toBe(true);
            expect(supportsTools(source, 'gpt-6-luna', 'none')).toBe(true);
            expect(supportsTools(source, 'gpt-6-astra', 'none')).toBe(false);
        }
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
