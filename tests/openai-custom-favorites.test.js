import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8').replace(/\r\n/g, '\n');

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

describe('OpenAI custom favorites wiring', () => {
    test('imports the Custom endpoint favorites key helper', () => {
        expect(openAiSource).toContain('getCustomEndpointFavoritesKey,');
        expect(openAiSource).toContain('} from \'./openai-preset-utils.js\';');
    });

    test('reads model favorites from URL-scoped Custom buckets', () => {
        const getterSource = getFunctionSource('getModelFavoritesForSource');

        expect(getterSource).toContain('const favoritesKey = getCustomEndpointFavoritesKey(source, settings.custom_url);');
        expect(getterSource).toContain('source === chat_completion_sources.CUSTOM && favoritesKey !== source && !Object.hasOwn(favoritesStore, favoritesKey)');
        expect(getterSource).toContain('favoritesStore[favoritesKey] = Array.isArray(favoritesStore[source]) ? [...favoritesStore[source]] : [];');
        expect(getterSource).toContain('favoritesStore[favoritesKey] = [...new Set(');
        expect(getterSource).toContain('return favoritesStore[favoritesKey];');
    });

    test('writes model favorites back to the resolved storage bucket', () => {
        const setterSource = getFunctionSource('setModelFavoritesForSource');

        expect(setterSource).toContain('const favoritesKey = getCustomEndpointFavoritesKey(source, settings.custom_url);');
        expect(setterSource).toContain('favoritesStore[favoritesKey] = [...new Set(');
    });

    test('renders DOM model ID favorites alphabetically without mutating the store', () => {
        const rebuildSource = getFunctionSource('rebuildModelIdSearchControl');

        expect(rebuildSource).toContain('const favorites = [...getModelFavoritesForSource(control.source)].sort((left, right) => left.localeCompare(right));');
    });

    test('refreshes Custom model ID favorites after endpoint profile changes', () => {
        const setCustomEndpointSource = getFunctionSource('setCustomEndpointPreset');
        const urlUpdateIndex = setCustomEndpointSource.indexOf('oai_settings.custom_url = normalizedPreset.url;');
        const modelSelectIndex = setCustomEndpointSource.indexOf('$(\'#model_custom_select\').val(oai_settings.custom_model);');
        const refreshIndex = setCustomEndpointSource.indexOf('refreshModelIdSearchControlsForSource(chat_completion_sources.CUSTOM);');
        const reconnectIndex = setCustomEndpointSource.indexOf('reconnectOpenAi();');

        expect(urlUpdateIndex).toBeGreaterThanOrEqual(0);
        expect(modelSelectIndex).toBeGreaterThan(urlUpdateIndex);
        expect(refreshIndex).toBeGreaterThan(modelSelectIndex);
        expect(reconnectIndex).toBeGreaterThan(refreshIndex);
    });

    test('refreshes Custom model ID favorites when manually changing the endpoint URL', () => {
        expect(openAiSource).toContain('$(\'#custom_api_url_text\').on(\'change\', function () {');
        expect(openAiSource).toContain('if (oai_settings.chat_completion_source === chat_completion_sources.CUSTOM) {\n            refreshModelIdSearchControlsForSource(chat_completion_sources.CUSTOM);\n        }');
    });
});
