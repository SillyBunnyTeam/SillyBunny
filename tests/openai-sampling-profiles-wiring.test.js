import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
const connectionManagerSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', 'index.js'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const toggleDependentCss = readFileSync(path.join(repoRoot, 'public', 'css', 'toggle-dependent.css'), 'utf8');

function getFunctionSourceFrom(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = source.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function getFunctionSource(name) {
    return getFunctionSourceFrom(openAiSource, name);
}

describe('OpenAI sampling profile wiring', () => {
    test('restores checkbox-backed sampling settings as checked state', () => {
        const applySamplingSettingsSource = getFunctionSource('applySamplingSettings');

        expect(applySamplingSettingsSource).toContain('for (const [selector, setting, isCheckbox, , isSampling] of Object.values(settingsToUpdate))');
        expect(applySamplingSettingsSource).toContain('$(selector).prop(\'checked\', value).trigger(\'input\')');
        expect(applySamplingSettingsSource).not.toContain('$(`#${key}`)');
    });

    test('keeps sampling snapshots derived from settingsToUpdate', () => {
        const getSamplingSettingsSnapshotSource = getFunctionSource('getSamplingSettingsSnapshot');

        expect(getSamplingSettingsSnapshotSource).toContain('buildChatCompletionSamplingSettingsSnapshot(oai_settings, settingsToUpdate)');
        expect(getSamplingSettingsSnapshotSource).not.toContain('temp_openai: oai_settings.temp_openai');
    });

    test('uses CSS-driven visibility for the model sampling profile controls', () => {
        expect(indexHtml).toContain('id="model_sampling_profiles_container"');
        expect(indexHtml).not.toContain('id="model_sampling_profiles_container" style=');
        expect(toggleDependentCss).toContain('label[for="model_sampling_profiles_enabled"]:has(input:checked)~#model_sampling_profiles_container');
        expect(openAiSource).toContain('function syncModelSamplingProfilesUI()');
        expect(openAiSource).not.toContain('function updateModelSamplingProfilesHelp()');
    });

    test('keeps model sampling profile actions as text buttons', () => {
        expect(indexHtml).toContain('id="model_sampling_profile_save" class="menu_button"');
        expect(indexHtml).toContain('id="model_sampling_profile_clear" class="menu_button"');
        expect(indexHtml).not.toContain('id="model_sampling_profile_save" class="menu_button menu_button_icon"');
        expect(indexHtml).not.toContain('id="model_sampling_profile_clear" class="menu_button menu_button_icon"');
    });

    test('applies the selected model sampling profile when the chat completion source changes', () => {
        const initOpenAISource = getFunctionSource('initOpenAI');
        const sourceChangeStart = initOpenAISource.indexOf('$(\'#chat_completion_source\').on(\'change\', function () {');
        const nextHandlerStart = initOpenAISource.indexOf('$(\'#oai_max_context_unlocked\')', sourceChangeStart);

        expect(sourceChangeStart).toBeGreaterThanOrEqual(0);
        expect(nextHandlerStart).toBeGreaterThan(sourceChangeStart);

        const sourceChangeHandler = initOpenAISource.slice(sourceChangeStart, nextHandlerStart);
        const toggleFormsIndex = sourceChangeHandler.indexOf('toggleChatCompletionForms();');
        const restorePresetIndex = sourceChangeHandler.indexOf('restoreOpenAIPresetSelection(presetName);');
        const applyProfileIndex = sourceChangeHandler.indexOf('maybeApplyModelSamplingProfile();');
        const saveSettingsIndex = sourceChangeHandler.indexOf('saveSettingsDebounced();');
        const reconnectIndex = sourceChangeHandler.indexOf('reconnectOpenAi();');

        expect(toggleFormsIndex).toBeGreaterThanOrEqual(0);
        expect(restorePresetIndex).toBeGreaterThan(toggleFormsIndex);
        expect(applyProfileIndex).toBeGreaterThan(restorePresetIndex);
        expect(saveSettingsIndex).toBeGreaterThan(applyProfileIndex);
        expect(reconnectIndex).toBeGreaterThan(applyProfileIndex);
    });

    test('re-applies the final model sampling profile after connection profile backend switches', () => {
        const applyConnectionProfileSource = getFunctionSourceFrom(connectionManagerSource, 'applyConnectionProfile');
        const commandLoopIndex = applyConnectionProfileSource.indexOf('for (const command of commands) {');
        const applyProfileIndex = applyConnectionProfileSource.indexOf('maybeApplyModelSamplingProfile();');
        const cancelSaveIndex = applyConnectionProfileSource.indexOf('cancelDebounce(saveSettingsDebounced);', applyProfileIndex);
        const stopSpinnerIndex = applyConnectionProfileSource.indexOf('spinner.stop();');

        expect(openAiSource).toContain('export function maybeApplyModelSamplingProfile()');
        expect(connectionManagerSource).toContain('maybeApplyModelSamplingProfile');
        expect(commandLoopIndex).toBeGreaterThanOrEqual(0);
        expect(applyProfileIndex).toBeGreaterThan(commandLoopIndex);
        expect(cancelSaveIndex).toBeGreaterThan(applyProfileIndex);
        expect(stopSpinnerIndex).toBeGreaterThan(applyProfileIndex);
    });
});
