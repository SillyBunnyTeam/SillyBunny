import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyClaudeModelParameterConstraints } from '../public/scripts/openai-model-capabilities.js';

const openAiSource = fs.readFileSync(fileURLToPath(new URL('../public/scripts/openai.js', import.meta.url)), 'utf8');

describe('OpenAI-compatible Claude model capabilities', () => {
    test('removes unsupported parameters from provider-prefixed Claude 5 requests', () => {
        for (const model of ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5']) {
            const payload = {
                model,
                temperature: 0.8,
                top_p: 0.9,
                top_k: 40,
                frequency_penalty: 0.2,
                presence_penalty: 0.3,
                reasoning_effort: 'high',
                custom_reasoning_param_name: 'reasoning_effort',
            };

            applyClaudeModelParameterConstraints(payload);

            expect(payload).toEqual({ model });
        }
    });

    test('preserves native Claude 5 reasoning controls while removing sampling parameters', () => {
        for (const model of ['claude-sonnet-5', 'claude-opus-5']) {
            const payload = {
                model,
                temperature: 0.8,
                top_p: 0.9,
                top_k: 40,
                reasoning_effort: 'high',
                custom_reasoning_param_name: 'reasoning_effort',
            };

            applyClaudeModelParameterConstraints(payload, { preserveReasoning: true });

            expect(payload).toEqual({
                model,
                reasoning_effort: 'high',
                custom_reasoning_param_name: 'reasoning_effort',
            });
        }
    });

    test('applies Claude model constraints while building generation parameters', () => {
        expect(openAiSource).toContain('import { applyClaudeModelParameterConstraints } from \'./openai-model-capabilities.js\';');
        expect(openAiSource).toContain('applyClaudeModelParameterConstraints(generate_data, {');
        expect(openAiSource).toContain('preserveReasoning: [chat_completion_sources.CLAUDE, chat_completion_sources.LINKAPI].includes(settings.chat_completion_source)');
    });
});
