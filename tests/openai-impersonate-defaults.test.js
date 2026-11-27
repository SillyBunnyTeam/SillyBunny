import { describe, expect, jest, test } from '@jest/globals';
import { importOpenAiModule } from './util/openai-harness.js';

const { openai } = await importOpenAiModule();

function configurePromptManager({ impersonateDisabled = false } = {}) {
    openai.oai_settings.prompts = [
        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Main', system_prompt: true, enabled: true },
        { identifier: 'chatHistory', name: 'Chat History', marker: true, system_prompt: true },
        { identifier: 'impersonate', name: 'Impersonate', role: 'system', content: '', system_prompt: true },
    ];
    openai.oai_settings.prompt_order = [
        {
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'chatHistory', enabled: true },
            ],
        },
    ];
    openai.setupChatCompletionPromptManager(openai.oai_settings);
    openai.promptManager.activeCharacter = { id: 1 };
    openai.promptManager.getPromptCollection = () => {
        const prompts = [];
        return {
            collection: prompts,
            overriddenPrompts: [],
            set(prompt, index) {
                prompts[index] = prompt;
            },
            get(id) {
                return prompts.find(item => item?.identifier === id) ?? null;
            },
            has(id) {
                return prompts.some(item => item?.identifier === id);
            },
            index(id) {
                return prompts.findIndex(item => item?.identifier === id);
            },
            add(prompt) {
                prompts.push(prompt);
            },
            forEach(fn) {
                prompts.forEach(fn);
            },
        };
    };
    openai.promptManager.isPromptDisabledForActiveCharacter = jest.fn(id => id === 'impersonate' && impersonateDisabled);
    openai.promptManager.tokenHandler = {
        getCounts: () => ({}),
        counts: {},
        resetCounts: () => {},
        updateCount: () => {},
    };
}

describe('OpenAI impersonate defaults', () => {
    test('falls back to first-person impersonation prompts when user fields are empty', async () => {
        expect(openai.oai_settings.assistant_impersonation).toBe('{{user}}:');

        // Empty assistant_impersonation falls back to '{{user}}:' on Claude impersonate requests.
        const { generate_data: fallbackClaude } = await openai.createGenerationParameters(
            { ...openai.oai_settings, chat_completion_source: openai.chat_completion_sources.CLAUDE, assistant_impersonation: '   ' },
            'claude-opus-5',
            'impersonate',
            [{ role: 'user', content: 'Hello' }],
        );
        expect(fallbackClaude.assistant_prefill).toBe('{{user}}:');

        // Custom non-empty assistant_impersonation is respected.
        const { generate_data: customClaude } = await openai.createGenerationParameters(
            { ...openai.oai_settings, chat_completion_source: openai.chat_completion_sources.CLAUDE, assistant_impersonation: 'Alice:' },
            'claude-opus-5',
            'impersonate',
            [{ role: 'user', content: 'Hello' }],
        );
        expect(customClaude.assistant_prefill).toBe('Alice:');

        // Empty impersonation_prompt falls back to the built-in first-person impersonation prompt.
        configurePromptManager({ impersonateDisabled: false });
        openai.oai_settings.impersonation_prompt = '   ';
        openai.oai_settings.openai_max_context = 4096;
        openai.oai_settings.openai_max_tokens = 256;
        const [messages] = await openai.prepareOpenAIMessages({
            name2: 'Assistant',
            charDescription: '',
            charPersonality: '',
            scenario: '',
            worldInfoBefore: '',
            worldInfoAfter: '',
            bias: '',
            type: 'impersonate',
            quietPrompt: '',
            quietImage: null,
            extensionPrompts: {},
            cyclePrompt: '',
            systemPromptOverride: '',
            jailbreakPromptOverride: '',
            messages: [],
            messageExamples: [],
        }, true);
        expect(messages.some(msg => msg.content.includes('Write your next reply from the point of view of {{user}}'))).toBe(true);
    });

    test('does not add the impersonate control prompt when prompt manager disables it', async () => {
        configurePromptManager({ impersonateDisabled: true });
        openai.oai_settings.impersonation_prompt = 'Custom impersonate instructions';
        openai.oai_settings.openai_max_context = 4096;
        openai.oai_settings.openai_max_tokens = 256;

        const [messages] = await openai.prepareOpenAIMessages({
            name2: 'Assistant',
            charDescription: '',
            charPersonality: '',
            scenario: '',
            worldInfoBefore: '',
            worldInfoAfter: '',
            bias: '',
            type: 'impersonate',
            quietPrompt: '',
            quietImage: null,
            extensionPrompts: {},
            cyclePrompt: '',
            systemPromptOverride: '',
            jailbreakPromptOverride: '',
            messages: [],
            messageExamples: [],
        }, true);

        expect(openai.promptManager.isPromptDisabledForActiveCharacter).toHaveBeenCalledWith('impersonate');
        expect(messages.some(msg => msg.content.includes('Custom impersonate instructions'))).toBe(false);
    });
});
