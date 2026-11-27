/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static markup checks. */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildChatCompletionPreset } from '../public/scripts/openai-preset-utils.js';
import { importOpenAiModule } from './util/openai-harness.js';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const scriptSource = readSource('../public/script.js');
const jquerySource = readSource('../public/lib/jquery-3.5.1.min.js');

(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const { openai, mocks } = await importOpenAiModule();
const initialDefaults = structuredClone(openai.oai_settings);

describe('Kimi K3 partial prefill field', () => {
    beforeEach(() => {
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        mocks.script.main_api = 'openai';
        mocks.powerUser.user_prompt_bias = '';
        mocks.script.saveSettingsDebounced.mockClear();
        document.body.innerHTML = '';
    });

    afterEach(async () => {
        document.body.innerHTML = '';
        await Promise.resolve();
    });

    test('is registered in the preset setting map as a plain, non-connection value', () => {
        expect(openai.settingsToUpdate.kimi_partial_prefill).toEqual([
            '#openai_kimi_partial_prefill',
            'kimi_partial_prefill',
            false,
            false,
        ]);
    });

    test('defaults to empty so no existing install starts sending a prefill', () => {
        expect(initialDefaults.kimi_partial_prefill).toBe('');
    });

    test('writes back to settings on input and survives the settings drawer rebuild', () => {
        document.body.innerHTML = `
            <div id="openai_settings">
                <div id="range_block_openai">
                    <div class="range-block" data-source="custom,moonshot,nanogpt,openrouter">
                        <input id="openai_kimi_partial_prefill" type="text" value="" />
                    </div>
                </div>
            </div>
        `;

        openai.initOpenAI();

        // The input must remain mounted inside an accordion drawer rather than orphaned.
        const field = document.getElementById('openai_kimi_partial_prefill');
        expect(field).not.toBeNull();
        expect(field.closest('.inline-drawer-content')).not.toBeNull();

        $(field).val('Understood.').trigger('input');
        expect(openai.oai_settings.kimi_partial_prefill).toBe('Understood.');
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalled();
    });

    test('round-trips through a preset save using the real settingsToUpdate map', () => {
        const settings = { ...openai.oai_settings, kimi_partial_prefill: 'Understood.' };

        expect(buildChatCompletionPreset(settings, openai.settingsToUpdate).kimi_partial_prefill).toBe('Understood.');
        expect(buildChatCompletionPreset(settings, openai.settingsToUpdate, { includeConnection: false, includeSampling: false }).kimi_partial_prefill)
            .toBe('Understood.');
    });

    test('the field is gated to the four K3-capable sources', () => {
        expect(indexSource).toMatch(/<div class="range-block" data-source="custom,moonshot,nanogpt,openrouter">[\s\S]*?id="openai_kimi_partial_prefill"/);
    });
});

describe('effective prompt bias', () => {
    beforeEach(() => {
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        mocks.script.main_api = 'openai';
        mocks.powerUser.user_prompt_bias = 'Global bias';
    });

    test('only diverges from the global value in chat completion mode on a K3 model', () => {
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.MOONSHOT;
        openai.oai_settings.moonshot_model = 'kimi-k3';
        openai.oai_settings.kimi_partial_prefill = 'K3 prefill';
        expect(openai.getEffectivePromptBias()).toBe('K3 prefill');

        // Empty K3 field falls back to the global bias so existing installs stay unchanged.
        openai.oai_settings.kimi_partial_prefill = '';
        expect(openai.getEffectivePromptBias()).toBe('Global bias');

        // Non-K3 models and non-K3 sources always return the global bias.
        openai.oai_settings.kimi_partial_prefill = 'K3 prefill';
        openai.oai_settings.moonshot_model = 'kimi-k2.5';
        expect(openai.getEffectivePromptBias()).toBe('Global bias');

        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;
        openai.oai_settings.openai_model = 'kimi-k3';
        expect(openai.getEffectivePromptBias()).toBe('Global bias');
    });

    test('is the single source for every prefill consumer in script.js', () => {
        expect(scriptSource.match(/getEffectivePromptBias\(\)/g)).toHaveLength(3);

        const getBiasStrings = scriptSource.match(/export function getBiasStrings\(textareaText, type\) \{([\s\S]*?)\n\}/);
        expect(getBiasStrings).not.toBeNull();
        expect(getBiasStrings[1]).toContain('const userPromptBias = getEffectivePromptBias();');
        expect(getBiasStrings[1]).toContain('promptBias = messageBias || promptBias || userPromptBias || \'\';');
        expect(getBiasStrings[1]).toContain('const isUserPromptBias = promptBias === userPromptBias;');

        const cleanUpMessage = scriptSource.match(/export function cleanUpMessage\(\{[\s\S]*?\n\}\n/);
        expect(cleanUpMessage).not.toBeNull();
        expect(cleanUpMessage[0]).toContain('const userPromptBias = getEffectivePromptBias();');
        expect(cleanUpMessage[0]).toContain('getMessage = substituteParams(userPromptBias) + getMessage;');
    });

    test('leaves no direct prefill reads behind', () => {
        expect(scriptSource).not.toContain('substituteParams(power_user.user_prompt_bias)');
        expect(scriptSource).not.toContain('promptBias || power_user.user_prompt_bias');
        expect(scriptSource).not.toContain('promptBias === power_user.user_prompt_bias');
    });
});
