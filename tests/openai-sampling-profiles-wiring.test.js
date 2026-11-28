/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static CSS/HTML contracts. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildChatCompletionSamplingProfileKey,
    buildChatCompletionSamplingSettingsSnapshot,
} from '../public/scripts/openai-preset-utils.js';
import { importConnectionManagerModule } from './util/connection-manager-harness.js';
import { importOpenAiModule } from './util/openai-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const toggleDependentCss = readFileSync(path.join(repoRoot, 'public', 'css', 'toggle-dependent.css'), 'utf8');
const jquerySource = readFileSync(path.join(repoRoot, 'public', 'lib', 'jquery-3.5.1.min.js'), 'utf8');

(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

const { openai, mocks } = await importOpenAiModule();
const initialDefaults = structuredClone(openai.oai_settings);

function mountSamplingDom() {
    document.body.innerHTML = `
        <select id="chat_completion_source">
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
        </select>
        <select id="model_openai_select">
            <option value="gpt-5.6">gpt-5.6</option>
        </select>
        <select id="model_claude_select">
            <option value="claude-opus-5">claude-opus-5</option>
        </select>
        <select id="settings_preset_openai">
            <option value="0">Default</option>
            <option value="1">Story</option>
        </select>
        <input id="temp_openai" type="number" value="1" />
        <input id="top_p_openai" type="number" value="1" />
        <input id="claude_disable_temperature" type="checkbox" />
        <input id="claude_disable_top_p" type="checkbox" />
        <input id="model_sampling_profiles_enabled" type="checkbox" />
        <button id="api_button_openai" type="button"></button>
        <div id="model_sampling_profiles_container">
            <button id="model_sampling_profile_save" type="button"></button>
            <button id="model_sampling_profile_clear" type="button"></button>
            <div id="model_sampling_profile_status"></div>
        </div>
    `;
}

describe('OpenAI sampling profile behaviour', () => {
    beforeEach(() => {
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        mocks.script.saveSettingsDebounced.mockClear();
        mocks.script.startStatusLoading.mockClear();
        global.toastr.success.mockClear();
        global.toastr.warning.mockClear();
        mountSamplingDom();
    });

    afterEach(async () => {
        document.body.innerHTML = '';
        await Promise.resolve();
    });

    test('saves sampling snapshots derived from settingsToUpdate and restores checkbox-backed sampling settings as checked state', () => {
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.CLAUDE;
        openai.oai_settings.claude_model = 'claude-opus-5';
        openai.oai_settings.temp_openai = 0.65;
        openai.oai_settings.claude_disable_temperature = true;
        openai.oai_settings.claude_disable_top_p = true;
        openai.oai_settings.model_sampling_profiles_enabled = true;

        openai.initOpenAI();

        // Save snapshot via the real Save button click handler.
        $('#model_sampling_profile_save').trigger('click');

        const profileKey = buildChatCompletionSamplingProfileKey(openai.chat_completion_sources.CLAUDE, 'claude-opus-5');
        const expectedSnapshot = buildChatCompletionSamplingSettingsSnapshot(openai.oai_settings, openai.settingsToUpdate);
        expect(openai.oai_settings.model_sampling_profiles[profileKey]).toEqual(expectedSnapshot);
        expect(openai.oai_settings.model_sampling_profiles[profileKey].claude_disable_temperature).toBe(true);
        expect(openai.oai_settings.model_sampling_profiles[profileKey].temp_openai).toBe(0.65);

        // Mutate live state and DOM checkboxes, then restore via maybeApplyModelSamplingProfile().
        openai.oai_settings.temp_openai = 1.2;
        openai.oai_settings.claude_disable_temperature = false;
        openai.oai_settings.claude_disable_top_p = false;
        $('#temp_openai').val('1.2');
        $('#claude_disable_temperature').prop('checked', false);
        $('#claude_disable_top_p').prop('checked', false);

        const checkboxInputSpy = jest.fn();
        $('#claude_disable_temperature').on('input', checkboxInputSpy);

        openai.maybeApplyModelSamplingProfile();
        expect(openai.oai_settings.temp_openai).toBe(0.65);
        expect(openai.oai_settings.claude_disable_temperature).toBe(true);
        expect($('#claude_disable_temperature').prop('checked')).toBe(true);
        expect($('#claude_disable_top_p').prop('checked')).toBe(true);
        expect(checkboxInputSpy).toHaveBeenCalled();
    });

    test('uses CSS-driven visibility for the model sampling profile controls', () => {
        expect(indexHtml).toContain('id="model_sampling_profiles_container"');
        expect(indexHtml).not.toContain('id="model_sampling_profiles_container" style=');
        expect(toggleDependentCss).toContain('label[for="model_sampling_profiles_enabled"]:has(input:checked)~#model_sampling_profiles_container');

        // Toggling the checkbox does not stamp an inline display style onto the container.
        openai.initOpenAI();
        $('#model_sampling_profiles_enabled').prop('checked', true).trigger('input');
        expect(document.getElementById('model_sampling_profiles_container').getAttribute('style')).toBeNull();
        $('#model_sampling_profiles_enabled').prop('checked', false).trigger('input');
        expect(document.getElementById('model_sampling_profiles_container').getAttribute('style')).toBeNull();
    });

    test('keeps model sampling profile actions as text buttons', () => {
        expect(indexHtml).toContain('id="model_sampling_profile_save" class="menu_button"');
        expect(indexHtml).toContain('id="model_sampling_profile_clear" class="menu_button"');
        expect(indexHtml).not.toContain('id="model_sampling_profile_save" class="menu_button menu_button_icon"');
        expect(indexHtml).not.toContain('id="model_sampling_profile_clear" class="menu_button menu_button_icon"');
        expect(indexHtml).not.toMatch(/id="model_sampling_profile_(?:save|clear)"[^>]*>\s*<i\b/);
    });

    test('applies the saved model sampling profile before saving and reconnecting when the chat completion source changes', async () => {
        const claudeKey = buildChatCompletionSamplingProfileKey(openai.chat_completion_sources.CLAUDE, 'claude-opus-5');
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;
        openai.oai_settings.openai_model = 'gpt-5.6';
        openai.oai_settings.claude_model = 'claude-opus-5';
        openai.oai_settings.temp_openai = 1.0;
        openai.oai_settings.model_sampling_profiles_enabled = true;
        openai.oai_settings.model_sampling_profiles = {
            [claudeKey]: { temp_openai: 0.42, claude_disable_top_p: true },
        };
        mocks.secrets.secret_state[mocks.secrets.SECRET_KEYS.CLAUDE] = true;

        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));

        try {
            openai.initOpenAI();

            const observedAtSave = [];
            const observedAtReconnect = [];
            mocks.script.saveSettingsDebounced.mockImplementation(() => {
                observedAtSave.push({ temp: openai.oai_settings.temp_openai, disableTopP: openai.oai_settings.claude_disable_top_p });
            });
            mocks.script.resultCheckStatus.mockImplementation(() => {
                observedAtReconnect.push({ temp: openai.oai_settings.temp_openai, disableTopP: openai.oai_settings.claude_disable_top_p });
            });

            $('#chat_completion_source').val(openai.chat_completion_sources.CLAUDE).trigger('change');
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(openai.oai_settings.chat_completion_source).toBe(openai.chat_completion_sources.CLAUDE);
            expect(openai.oai_settings.temp_openai).toBe(0.42);
            expect(openai.oai_settings.claude_disable_top_p).toBe(true);
            expect(observedAtSave.at(-1)).toEqual({ temp: 0.42, disableTopP: true });
            expect(observedAtReconnect[0]).toEqual({ temp: 0.42, disableTopP: true });
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('re-applies the final model sampling profile after connection profile backend switches', async () => {
        const events = [];
        const profile = {
            id: 'p-claude',
            name: 'Claude Profile',
            mode: 'cc',
            api: 'claude',
            preset: 'Story',
            model: 'claude-opus-5',
            exclude: [],
        };
        document.body.innerHTML = '<div id="rm_api_block"></div>';
        const { mocks: cmMocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: { selectedProfile: '', profiles: [profile], folders: [], favorites: [] },
            },
            commands: {
                api: async (_a, v) => { events.push(`cmd:api:${v}`); return v; },
                preset: async (_a, v) => { events.push(`cmd:preset:${v}`); return v; },
                model: async (_a, v) => { events.push(`cmd:model:${v}`); return v; },
            },
            openai: {
                maybeApplyModelSamplingProfile: jest.fn(() => {
                    const spinner = document.getElementById('connection_profile_spinner');
                    events.push(`maybeApply:spinnerVisible=${!spinner.classList.contains('hidden')}`);
                }),
            },
            utils: {
                cancelDebounce: jest.fn(() => events.push('cancelDebounce')),
            },
        });

        const select = document.getElementById('connection_profiles');
        select.value = 'p-claude';
        select.dispatchEvent(new Event('change'));
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(typeof openai.maybeApplyModelSamplingProfile).toBe('function');
        expect(cmMocks.openai.maybeApplyModelSamplingProfile).toHaveBeenCalledTimes(1);

        const lastModelIndex = events.lastIndexOf('cmd:model:claude-opus-5');
        const applyIndex = events.indexOf('maybeApply:spinnerVisible=true');
        const cancelAfterApplyIndex = events.indexOf('cancelDebounce', applyIndex + 1);

        expect(lastModelIndex).toBeGreaterThan(-1);
        expect(applyIndex).toBeGreaterThan(lastModelIndex);
        expect(cancelAfterApplyIndex).toBeGreaterThan(applyIndex);
        expect(document.getElementById('connection_profile_spinner').classList.contains('hidden')).toBe(true);
    });
});
