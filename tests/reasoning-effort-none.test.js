import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const openAiSource = readSource('../public/scripts/openai.js');
const chatCompletionsSource = readSource('../src/endpoints/backends/chat-completions.js');

describe('reasoning effort \'none\'', () => {
    test('the client resolves \'none\' to a literal only for OpenAI-style sources on GPT-5.1+ models', () => {
        // GPT-5.1 and newer accept 'none' as a value that pins thinking off. Omitting the field
        // there lets the model pick its own default depth, which defeats picking None. Every
        // other source keeps omitting it, because endpoints that do not list the value reject it.
        const noneCase = openAiSource.match(/case reasoning_effort_types\.none:[\s\S]*?(?=case reasoning_effort_types\.min:)/);

        expect(noneCase).not.toBeNull();
        expect(noneCase[0]).toContain('return [chat_completion_sources.OPENAI, chat_completion_sources.OPENAI_RESPONSES, chat_completion_sources.AZURE_OPENAI, chat_completion_sources.CUSTOM].includes(settings.chat_completion_source) && /^gpt-5\\.([1-9]|\\d{2,})/.test(model)');
        expect(noneCase[0]).toContain('? reasoning_effort_types.none');
        expect(noneCase[0]).toContain(': undefined;');
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
