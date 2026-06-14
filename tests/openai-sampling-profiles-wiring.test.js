import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const toggleDependentCss = readFileSync(path.join(repoRoot, 'public', 'css', 'toggle-dependent.css'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = openAiSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = openAiSource.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < openAiSource.length; index++) {
        const char = openAiSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return openAiSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
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
});
