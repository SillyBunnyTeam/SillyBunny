/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { LOGPROBS_CHAT_SOURCES, getOptionsApplicability, syncOptionsMenu } from '../../public/scripts/sillybunny-options-menu.js';
import { importOpenAiModule } from '../util/openai-harness.js';

const CFG_TYPES = ['ooba', 'tabby'];

describe('getOptionsApplicability', () => {
    test('CFG Scale applies to a text completion server with a guidance scale only', () => {
        const cfg = (mainApi, textgenType) => getOptionsApplicability({ mainApi, textgenType, cfgTypes: CFG_TYPES }).cfg;
        expect(cfg('textgenerationwebui', 'ooba')).toBe(true);
        expect(cfg('textgenerationwebui', 'tabby')).toBe(true);
        expect(cfg('textgenerationwebui', 'llamacpp')).toBe(false);
        expect(cfg('openai', 'ooba')).toBe(false);
        expect(cfg('novel', '')).toBe(false);
        expect(cfg('koboldhorde', '')).toBe(false);
    });

    test('Token Probabilities applies to text completion, NovelAI and the chat sources that request logprobs', () => {
        const probabilities = (mainApi, chatSource = '') => getOptionsApplicability({ mainApi, chatSource }).tokenProbabilities;
        expect(probabilities('textgenerationwebui')).toBe(true);
        expect(probabilities('novel')).toBe(true);
        expect(probabilities('openai', 'openrouter')).toBe(true);
        expect(probabilities('openai', 'claude')).toBe(false);
        expect(probabilities('kobold')).toBe(false);
        expect(probabilities('koboldhorde')).toBe(false);
    });

    test('the chat source list is the one that openai.js sends logprobs for', async () => {
        const { openai } = await importOpenAiModule({ powerUser: { request_token_probabilities: true } });
        const sourcesWithLogprobs = [];

        for (const source of Object.values(openai.chat_completion_sources)) {
            const settings = {
                ...openai.oai_settings,
                chat_completion_source: source,
                reverse_proxy: '',
                stream_openai: false,
            };
            const { generate_data } = await openai.createGenerationParameters(settings, 'gpt-4o', 'normal', []);
            if (generate_data.logprobs !== undefined) {
                sourcesWithLogprobs.push(source);
            }
        }

        expect([...LOGPROBS_CHAT_SOURCES].sort()).toEqual(sourcesWithLogprobs.sort());
    });
});

describe('syncOptionsMenu', () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="cfg_block_ooba" data-tg-type="ooba, tabby"></div>
            <div id="options"><a id="option_toggle_CFG"></a><a id="option_toggle_logprobs"></a><a id="option_toggle_AN"></a></div>`;
    });
    const hidden = id => document.getElementById(id).style.display === 'none';

    test('hides what does not apply, shows it again, and leaves every other item alone', () => {
        syncOptionsMenu(document, { mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'claude' }, textCompletionSettings: { type: 'ooba' } });
        expect([hidden('option_toggle_CFG'), hidden('option_toggle_logprobs'), hidden('option_toggle_AN')]).toEqual([true, true, false]);
        syncOptionsMenu(document, { mainApi: 'textgenerationwebui', chatCompletionSettings: {}, textCompletionSettings: { type: 'tabby' } });
        expect([hidden('option_toggle_CFG'), hidden('option_toggle_logprobs'), hidden('option_toggle_AN')]).toEqual([false, false, false]);
    });

    test('does nothing before the app has a context', () => {
        syncOptionsMenu(document, null);
        expect(hidden('option_toggle_CFG')).toBe(false);
    });
});
