import { describe, expect, test } from '@jest/globals';
import { importOpenAiModule } from './util/openai-harness.js';

const { openai, mocks } = await importOpenAiModule();

describe('OpenAI prompt logging wiring', () => {
    test('passes the existing prompt-log preference to backend request metadata', async () => {
        const settings = { ...openai.oai_settings, chat_completion_source: openai.chat_completion_sources.OPENAI };

        mocks.powerUser.console_log_prompts = false;
        const { generate_data: disabledData } = await openai.createGenerationParameters(settings, 'gpt-4o', 'normal', []);
        expect(disabledData.log_prompts).toBe(false);

        mocks.powerUser.console_log_prompts = true;
        const { generate_data: enabledData } = await openai.createGenerationParameters(settings, 'gpt-4o', 'normal', []);
        expect(enabledData.log_prompts).toBe(true);
    });
});
