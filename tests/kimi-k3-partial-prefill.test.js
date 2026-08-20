import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildChatCompletionPreset } from '../public/scripts/openai-preset-utils.js';

const readSource = (relativePath) => fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const indexSource = readSource('../public/index.html');
const openAiSource = readSource('../public/scripts/openai.js');
const scriptSource = readSource('../public/script.js');

const SETTING_ENTRY = "kimi_partial_prefill: ['#openai_kimi_partial_prefill', 'kimi_partial_prefill', false, false],";

describe('Kimi K3 partial prefill field', () => {
    test('is registered in the preset setting map as a plain, non-connection value', () => {
        const map = openAiSource.match(/export const settingsToUpdate = \{([\s\S]*?)\n\};/);

        expect(map).not.toBeNull();
        expect(map[1]).toContain(SETTING_ENTRY);
    });

    test('defaults to empty so no existing install starts sending a prefill', () => {
        const defaults = openAiSource.match(/const default_settings = \{([\s\S]*?)\n\};/);

        expect(defaults).not.toBeNull();
        expect(defaults[1]).toContain("kimi_partial_prefill: '',");
    });

    test('writes back to settings on input', () => {
        expect(openAiSource).toMatch(/\$\('#openai_kimi_partial_prefill'\)\.on\('input', function \(\) \{\s*oai_settings\.kimi_partial_prefill = String\(\$\(this\)\.val\(\)\);\s*saveSettingsDebounced\(\);/);
    });

    test('is claimed by a settings drawer group, or it is orphaned when the panel is rebuilt', () => {
        expect(openAiSource).toContain("'#openai_settings > div > .range-block:has(#openai_kimi_partial_prefill)',");
    });

    test('round-trips through a preset save', () => {
        // The map entry is what makes a setting persist; a plain value is neither a connection
        // nor a sampling field, so it survives both linked-preset modes.
        const settingsMap = { kimi_partial_prefill: ['#openai_kimi_partial_prefill', 'kimi_partial_prefill', false, false] };
        const settings = { kimi_partial_prefill: 'Understood.' };

        expect(buildChatCompletionPreset(settings, settingsMap)).toEqual({ kimi_partial_prefill: 'Understood.' });
        expect(buildChatCompletionPreset(settings, settingsMap, { includeConnection: false, includeSampling: false }))
            .toEqual({ kimi_partial_prefill: 'Understood.' });
    });

    test('the field is gated to the four K3-capable sources', () => {
        expect(indexSource).toMatch(/<div class="range-block" data-source="custom,moonshot,nanogpt,openrouter">[\s\S]*?id="openai_kimi_partial_prefill"/);
    });
});

describe('effective prompt bias', () => {
    test('only diverges from the global value in chat completion mode on a K3 model', () => {
        const helper = openAiSource.match(/export function getEffectivePromptBias\(\) \{([\s\S]*?)\n\}/);

        expect(helper).not.toBeNull();
        expect(helper[1]).toContain("if (main_api === 'openai' && isKimiK3PartialPrefillActive()) {");
        // The fallback is what keeps installs that predate the field working untouched.
        expect(helper[1]).toContain('return oai_settings.kimi_partial_prefill || power_user.user_prompt_bias;');
        expect(helper[1]).toContain('return power_user.user_prompt_bias;');
    });

    // Outbound and inbound must agree: a partial-mode model returns only the continuation, so
    // whatever was sent has to be prepended back. Reading the global value in one place and the
    // K3 field in the other would paste a prefill onto a reply that never contained it.
    test('is the single source for every prefill consumer in script.js', () => {
        expect(scriptSource.match(/getEffectivePromptBias\(\)/g)).toHaveLength(3);

        const getBiasStrings = scriptSource.match(/export function getBiasStrings\(textareaText, type\) \{([\s\S]*?)\n\}/);
        expect(getBiasStrings).not.toBeNull();
        expect(getBiasStrings[1]).toContain('const userPromptBias = getEffectivePromptBias();');
        expect(getBiasStrings[1]).toContain("promptBias = messageBias || promptBias || userPromptBias || '';");
        expect(getBiasStrings[1]).toContain('const isUserPromptBias = promptBias === userPromptBias;');

        const cleanUpMessage = scriptSource.match(/export function cleanUpMessage\(\{[\s\S]*?\n\}\n/);
        expect(cleanUpMessage).not.toBeNull();
        expect(cleanUpMessage[0]).toContain('const userPromptBias = getEffectivePromptBias();');
        expect(cleanUpMessage[0]).toContain('getMessage = substituteParams(userPromptBias) + getMessage;');
    });

    test('leaves no direct prefill reads behind', () => {
        // show_user_prompt_bias and its own assignment still read power_user directly; the three
        // prefill reads that decide what is sent and displayed must not.
        expect(scriptSource).not.toContain('substituteParams(power_user.user_prompt_bias)');
        expect(scriptSource).not.toContain("promptBias || power_user.user_prompt_bias");
        expect(scriptSource).not.toContain('promptBias === power_user.user_prompt_bias');
    });
});
