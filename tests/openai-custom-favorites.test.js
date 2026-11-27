/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getCustomEndpointFavoritesKey } from '../public/scripts/openai-preset-utils.js';
import { importOpenAiModule } from './util/openai-harness.js';

const jquerySource = readFileSync(fileURLToPath(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url)), 'utf8');
(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const { openai, mocks } = await importOpenAiModule();
const initialDefaults = structuredClone(openai.oai_settings);

function mountCustomModelDom() {
    document.body.innerHTML = `
        <select id="chat_completion_source">
            <option value="custom">Custom</option>
            <option value="openai">OpenAI</option>
        </select>
        <input id="custom_api_url_text" type="text" value="" />
        <div class="custom-model-row"><input id="custom_model_id" type="text" value="" /></div>
        <select id="model_custom_select" class="model_custom_select"></select>
        <datalist id="model_custom_select_fill"></datalist>
        <select id="custom_endpoint_preset"></select>
        <input id="custom_endpoint_preset_name" type="text" value="" />
        <input id="api_key_custom" type="text" value="" />
        <button id="api_button_openai" type="button"></button>
    `;
}

function getFavoriteOptionValues() {
    return Array.from(document.querySelectorAll('#model_custom_select option[data-favorite="true"]'))
        .map(option => option.value);
}

describe('OpenAI custom favorites behaviour', () => {
    beforeEach(() => {
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.CUSTOM;
        openai.model_list.splice(0, openai.model_list.length);
        mocks.script.saveSettingsDebounced.mockClear();
        mocks.script.startStatusLoading.mockClear();
        mountCustomModelDom();
    });

    afterEach(async () => {
        document.body.innerHTML = '';
        await Promise.resolve();
    });

    test('migrates legacy custom favorites into a URL-scoped bucket and isolates buckets per URL', () => {
        const urlA = 'https://alpha.example/v1';
        const urlB = 'https://beta.example/v1';
        const keyA = getCustomEndpointFavoritesKey(openai.chat_completion_sources.CUSTOM, urlA);
        const keyB = getCustomEndpointFavoritesKey(openai.chat_completion_sources.CUSTOM, urlB);

        openai.oai_settings.custom_url = urlA;
        openai.oai_settings.model_favorites = {
            custom: ['zeta-model', '  alpha-model  ', 'zeta-model', ''],
            [keyB]: ['beta-only'],
        };
        openai.model_list.push({ id: 'zeta-model' }, { id: 'alpha-model' }, { id: 'beta-only' });

        openai.initOpenAI();

        // Legacy custom favorites migrate once to URL A's bucket and deduplicate.
        expect(openai.oai_settings.model_favorites[keyA]).toEqual(['zeta-model', 'alpha-model']);
        // DOM displays favorites alphabetically without mutating the stored order.
        expect(getFavoriteOptionValues()).toEqual(['alpha-model', 'zeta-model']);
        expect(openai.oai_settings.model_favorites[keyA]).toEqual(['zeta-model', 'alpha-model']);

        // Switching the manual URL swaps the displayed favorites to URL B's isolated bucket.
        $('#custom_api_url_text').val(urlB).trigger('input').trigger('change');
        expect(openai.oai_settings.custom_url).toBe(urlB);
        expect(getFavoriteOptionValues()).toEqual(['beta-only']);
    });

    test('writes toggled favorites back to the active URL-scoped Custom bucket', () => {
        const urlA = 'https://alpha.example/v1';
        const keyA = getCustomEndpointFavoritesKey(openai.chat_completion_sources.CUSTOM, urlA);

        openai.oai_settings.custom_url = urlA;
        openai.oai_settings.custom_model = 'custom-fav';
        openai.oai_settings.model_favorites = { [keyA]: [] };
        openai.model_list.push({ id: 'custom-fav' }, { id: 'other-model' });

        openai.initOpenAI();

        const toggleButton = document.querySelector('[data-sb-model-id-favorite-source="custom"]');
        expect(toggleButton).not.toBeNull();

        toggleButton.click();
        expect(openai.oai_settings.model_favorites[keyA]).toEqual(['custom-fav']);
        expect(getFavoriteOptionValues()).toEqual(['custom-fav']);

        toggleButton.click();
        expect(openai.oai_settings.model_favorites[keyA]).toEqual([]);
        expect(getFavoriteOptionValues()).toEqual([]);
    });

    test('refreshes Custom model favorites and reconnects after selecting a Custom endpoint profile', async () => {
        const urlA = 'https://alpha.example/v1';
        const urlB = 'https://beta.example/v1';
        const keyA = getCustomEndpointFavoritesKey(openai.chat_completion_sources.CUSTOM, urlA);
        const keyB = getCustomEndpointFavoritesKey(openai.chat_completion_sources.CUSTOM, urlB);

        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ data: [{ id: 'beta-model' }, { id: 'alpha-model' }] }),
        }));

        try {
            openai.oai_settings.custom_url = urlA;
            openai.oai_settings.custom_model = 'alpha-model';
            openai.oai_settings.model_favorites = {
                [keyA]: ['alpha-model'],
                [keyB]: ['beta-model'],
            };
            openai.model_list.push({ id: 'alpha-model' }, { id: 'beta-model' });

            await openai.loadCustomEndpointPresets({
                custom_endpoint_presets: [
                    { name: 'Alpha', url: urlA, model: 'alpha-model', key: '', secretId: 'sec-a' },
                    { name: 'Beta', url: urlB, model: 'beta-model', key: '', secretId: 'sec-b' },
                ],
                selected_custom_endpoint_preset: { name: 'Alpha', url: urlA, model: 'alpha-model', key: '', secretId: 'sec-a' },
            });
            openai.initOpenAI();

            expect(getFavoriteOptionValues()).toEqual(['alpha-model']);

            // Switch to Beta profile via the dropdown and confirm favorites update before reconnect.
            const favoritesAtReconnect = [];
            mocks.script.startStatusLoading.mockImplementation(() => {
                favoritesAtReconnect.push(getFavoriteOptionValues());
            });

            $('#custom_endpoint_preset').val('Beta').trigger('change');
            await new Promise(resolve => setTimeout(resolve, 20));

            expect(openai.oai_settings.custom_url).toBe(urlB);
            expect(openai.oai_settings.custom_model).toBe('beta-model');
            expect(getFavoriteOptionValues()).toEqual(['beta-model']);
            expect(favoritesAtReconnect[0]).toEqual(['beta-model']);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
