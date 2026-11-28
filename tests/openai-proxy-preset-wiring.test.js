/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML contracts. */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importOpenAiModule } from './util/openai-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const jquerySource = readFileSync(path.join(repoRoot, 'public', 'lib', 'jquery-3.5.1.min.js'), 'utf8');

(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

// Mount top-level click targets (#save_proxy, #save_custom_endpoint) before importing openai.js because it binds them at module evaluation time.
function createProxyAndCustomDom() {
    document.body.innerHTML = `
        <select id="chat_completion_source">
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
            <option value="makersuite">AI Studio</option>
            <option value="custom">Custom</option>
        </select>
        <select id="settings_preset_openai">
            <option value="0">Default</option>
            <option value="1">StoryPreset</option>
        </select>
        <select id="openai_proxy_preset"></select>
        <input id="openai_reverse_proxy_name" type="text" value="" />
        <input id="openai_reverse_proxy" type="text" value="" />
        <input id="openai_proxy_access_key" type="text" value="" />
        <select id="openai_proxy_source">
            <option value="">None (Don't switch)</option>
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
            <option value="makersuite">AI Studio</option>
        </select>
        <button id="save_proxy" type="button"></button>
        <select id="custom_endpoint_preset"></select>
        <input id="custom_endpoint_preset_name" type="text" value="" />
        <input id="custom_api_url_text" type="text" value="" />
        <input id="api_key_custom" type="text" value="" />
        <input id="custom_model_id" type="text" value="" />
        <select id="model_custom_select" class="model_custom_select"></select>
        <textarea id="custom_include_body"></textarea>
        <textarea id="custom_exclude_body"></textarea>
        <textarea id="custom_include_headers"></textarea>
        <button id="save_custom_endpoint" type="button"></button>
        <button id="api_button_openai" type="button"></button>
    `;
}

createProxyAndCustomDom();
const { openai, mocks } = await importOpenAiModule();
const initialDefaults = structuredClone(openai.oai_settings);
openai.initOpenAI();

function resetDomValues() {
    $('#chat_completion_source').val('openai');
    $('#settings_preset_openai').val('0');
    $('#openai_proxy_preset').empty();
    $('#openai_reverse_proxy_name').val('');
    $('#openai_reverse_proxy').val('');
    $('#openai_proxy_access_key').val('');
    $('#openai_proxy_source').val('');
    $('#custom_endpoint_preset').empty();
    $('#custom_endpoint_preset_name').val('');
    $('#custom_api_url_text').val('');
    $('#api_key_custom').val('').removeAttr('placeholder');
    $('#custom_model_id').val('');
    $('#model_custom_select').empty();
    $('#custom_include_body').val('');
    $('#custom_exclude_body').val('');
    $('#custom_include_headers').val('');
}

describe('OpenAI proxy and Custom endpoint preset behaviour', () => {
    let originalFetch;

    beforeEach(async () => {
        originalFetch = globalThis.fetch;
        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'fetched-model' }] }),
        }));
        Object.assign(openai.oai_settings, structuredClone(initialDefaults));
        Object.keys(mocks.secrets.secret_state).forEach(key => delete mocks.secrets.secret_state[key]);
        mocks.secrets.writeSecret.mockReset().mockResolvedValue('written-secret-id');
        mocks.secrets.rotateSecret.mockReset().mockResolvedValue('rotated-secret-id');
        mocks.script.saveSettings.mockReset().mockResolvedValue(true);
        mocks.script.saveSettingsDebounced.mockReset();
        mocks.script.setOnlineStatus.mockReset();
        mocks.script.resultCheckStatus.mockReset();
        mocks.script.startStatusLoading.mockReset();
        mocks.fetchResumable.mockReset();
        global.toastr.success.mockReset();
        global.toastr.warning.mockReset();
        global.toastr.error.mockReset();
        resetDomValues();
        await openai.loadCustomEndpointPresets({ custom_endpoint_presets: [], selected_custom_endpoint_preset: null });
        openai.loadProxyPresets({ proxies: [{ name: 'None', url: '', password: '', source: '' }], selected_proxy: { name: 'None', url: '', password: '', source: '' } });
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await Promise.resolve();
    });

    afterAll(async () => {
        document.body.innerHTML = '';
        await Promise.resolve();
    });

    test('shows explicit reverse proxy and Custom endpoint selectors in index.html', () => {
        expect(indexHtml).toContain('id="openai_proxy_source"');
        expect(indexHtml).toContain('None (Don\'t switch)');
        expect(indexHtml).toContain('value="makersuite"');
        expect(indexHtml).toContain('id="custom_endpoint_preset"');
        expect(indexHtml).toContain('id="save_custom_endpoint"');
        expect(indexHtml).toContain('id="delete_custom_endpoint"');
        expect(indexHtml).toContain('id="custom_endpoint_preset_name"');
        expect(indexHtml).toMatch(/<span data-i18n="Saved Custom OpenAI-compatible URLs, API keys, model IDs, and Additional Parameters">\s*Saved Custom OpenAI-compatible URLs, API keys, model IDs, and Additional Parameters\s*<\/span>/);
    });

    test('saves reverse proxy presets with their selected backend binding and renders clean source indicators', () => {
        $('#openai_reverse_proxy_name').val('Gemini Proxy');
        $('#openai_reverse_proxy').val('https://proxy.example/gemini');
        $('#openai_proxy_access_key').val('secret-pw');
        $('#openai_proxy_source').val(openai.chat_completion_sources.MAKERSUITE);

        $('#save_proxy').trigger('click');

        const saved = openai.proxies.find(preset => preset.name === 'Gemini Proxy');
        expect(saved).toMatchObject({
            name: 'Gemini Proxy',
            url: 'https://proxy.example/gemini',
            password: 'secret-pw',
            source: openai.chat_completion_sources.MAKERSUITE,
        });
        const option = document.querySelector('#openai_proxy_preset option[value="Gemini Proxy"]');
        expect(option?.innerText || option?.textContent).toBe('Gemini Proxy [AI Studio]');
    });

    test('applies proxy credentials before switching Chat Completion source and keeps two-way source sync without redundant reconnects', () => {
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;
        openai.loadProxyPresets({
            proxies: [
                { name: 'None', url: '', password: '', source: '' },
                { name: 'Claude Proxy', url: 'https://claude.proxy/v1', password: 'cpw', source: 'claude' },
            ],
            selected_proxy: { name: 'None', url: '', password: '', source: '' },
        });

        // Selecting a bound proxy preset updates proxy credentials BEFORE #chat_completion_source fires change.
        const credentialsDuringSourceChange = [];
        const spyHandler = () => {
            credentialsDuringSourceChange.push({
                url: openai.oai_settings.reverse_proxy,
                password: openai.oai_settings.proxy_password,
            });
        };
        $('#chat_completion_source').on('change.testSpy', spyHandler);

        try {
            $('#openai_proxy_preset').val('Claude Proxy').trigger('change');
            expect(credentialsDuringSourceChange[0]).toEqual({ url: 'https://claude.proxy/v1', password: 'cpw' });
            expect(openai.oai_settings.chat_completion_source).toBe(openai.chat_completion_sources.CLAUDE);
            expect(mocks.script.resultCheckStatus).toHaveBeenCalled();
        } finally {
            $('#chat_completion_source').off('change.testSpy');
        }

        // Reverse direction: switching source to Claude syncs the bound proxy preset BEFORE reconnecting,
        // without causing recursive source-change loops.
        openai.oai_settings.reverse_proxy = '';
        openai.oai_settings.proxy_password = '';
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;
        openai.loadProxyPresets({
            proxies: [
                { name: 'None', url: '', password: '', source: '' },
                { name: 'Claude Proxy', url: 'https://claude.proxy/v1', password: 'cpw', source: 'claude' },
            ],
            selected_proxy: { name: 'None', url: '', password: '', source: '' },
        });
        mocks.script.resultCheckStatus.mockClear();

        const proxyAtReconnect = [];
        mocks.script.resultCheckStatus.mockImplementation(() => {
            proxyAtReconnect.push(openai.oai_settings.reverse_proxy);
        });

        $('#chat_completion_source').val(openai.chat_completion_sources.CLAUDE).trigger('change');
        expect(proxyAtReconnect).toEqual(['https://claude.proxy/v1']);
        expect(openai.selected_proxy.name).toBe('Claude Proxy');
    });

    test('loads selected proxy preset credentials silently without overriding the saved backend or triggering a reconnect', () => {
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;

        openai.loadProxyPresets({
            proxies: [
                { name: 'None', url: '', password: '', source: '' },
                { name: 'Bound Claude', url: 'https://bound.example/v1', password: 'pw', source: 'claude' },
            ],
            selected_proxy: { name: 'Bound Claude', url: 'https://bound.example/v1', password: 'pw', source: 'claude' },
        });

        // Credentials load, saved backend stays OpenAI, and no reconnect runs on startup.
        expect(openai.oai_settings.reverse_proxy).toBe('https://bound.example/v1');
        expect(openai.oai_settings.proxy_password).toBe('pw');
        expect(openai.oai_settings.chat_completion_source).toBe(openai.chat_completion_sources.OPENAI);
        expect(mocks.script.resultCheckStatus).not.toHaveBeenCalled();
    });

    test('preserves the selected settings preset when switching Chat Completion sources', () => {
        openai.loadOpenAISettings(
            {
                openai_settings: [JSON.stringify({ temp_openai: 1 }), JSON.stringify({ temp_openai: 0.7 })],
                openai_setting_names: ['Default', 'StoryPreset'],
            },
            { ...openai.oai_settings, preset_settings_openai: 'StoryPreset', chat_completion_source: 'openai' },
        );
        $('#settings_preset_openai').val('1');

        $('#chat_completion_source').val(openai.chat_completion_sources.CLAUDE).trigger('change');

        expect(openai.oai_settings.preset_settings_openai).toBe('StoryPreset');
        expect($('#settings_preset_openai').val()).toBe('1');
    });

    test('saves Custom endpoint profiles with URL, key, model, and secret id while allowing keyless profiles and rejecting empty names', async () => {
        // Empty name is rejected before writing secrets.
        $('#custom_endpoint_preset_name').val('');
        $('#save_custom_endpoint').trigger('click');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(mocks.secrets.writeSecret).not.toHaveBeenCalled();
        expect(global.toastr.error).toHaveBeenCalled();

        // Keyless profile saves cleanly with allowEmpty: true.
        $('#custom_endpoint_preset_name').val('Local Ollama');
        $('#custom_api_url_text').val('http://127.0.0.1:11434/v1');
        $('#api_key_custom').val('');
        $('#custom_model_id').val('llama3');
        mocks.secrets.writeSecret.mockResolvedValueOnce('empty-secret-id');

        $('#save_custom_endpoint').trigger('click');
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(mocks.secrets.writeSecret).toHaveBeenCalledWith(
            mocks.secrets.SECRET_KEYS.CUSTOM,
            '',
            undefined,
            { allowEmpty: true },
        );
        const saved = openai.custom_endpoint_presets.find(p => p.name === 'Local Ollama');
        expect(saved).toMatchObject({
            name: 'Local Ollama',
            url: 'http://127.0.0.1:11434/v1',
            model: 'llama3',
            secretId: 'empty-secret-id',
        });
        // Bound secret clears the key input and sets the saved-secret placeholder.
        expect($('#api_key_custom').val()).toBe('');
        expect($('#api_key_custom').attr('placeholder')).toBe('(saved secret)');
    });

    test('activates Custom endpoint secrets by rotation (skipping already-active secrets) and applies values before reconnecting', async () => {
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [
                { name: 'Profile A', url: 'https://a.example/v1', model: 'model-a', key: '', secretId: 'sec-a' },
                { name: 'Profile B', url: 'https://b.example/v1', model: 'model-b', key: '', secretId: 'sec-b' },
            ],
            selected_custom_endpoint_preset: { name: 'Profile A', url: 'https://a.example/v1', model: 'model-a', key: '', secretId: 'sec-a' },
        });
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.CUSTOM;

        const events = [];
        mocks.secrets.rotateSecret.mockImplementation(async (key, id) => {
            events.push(`rotate:${id}`);
            return id;
        });
        mocks.script.resultCheckStatus.mockImplementation(() => {
            events.push(`reconnect:${openai.oai_settings.custom_url}:${openai.oai_settings.custom_model}`);
        });

        // Switch to Profile B when sec-b is NOT yet active -> rotates sec-b before reconnecting, never writes a duplicate key.
        $('#custom_endpoint_preset').val('Profile B').trigger('change');
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(events[0]).toBe('rotate:sec-b');
        expect(events[1]).toBe('reconnect:https://b.example/v1:model-b');
        expect(mocks.secrets.writeSecret).not.toHaveBeenCalled();

        // Switch to Profile A when sec-a IS already active -> skips rotateSecret.
        mocks.secrets.rotateSecret.mockClear();
        mocks.secrets.secret_state[mocks.secrets.SECRET_KEYS.CUSTOM] = [{ id: 'sec-a', active: true }];
        $('#custom_endpoint_preset').val('Profile A').trigger('change');
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(mocks.secrets.rotateSecret).not.toHaveBeenCalled();
    });

    test('sends selected Custom endpoint secret_id with both chat completion requests and status checks', async () => {
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [
                { name: 'MyCustom', url: 'https://my.custom/v1', model: 'm-1', key: '', secretId: 'custom-sec-99' },
            ],
            selected_custom_endpoint_preset: { name: 'MyCustom', url: 'https://my.custom/v1', model: 'm-1', key: '', secretId: 'custom-sec-99' },
        });
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.CUSTOM;
        openai.oai_settings.custom_url = 'https://my.custom/v1';
        openai.oai_settings.custom_include_headers = 'X-Test: 1';
        openai.oai_settings.stream_openai = false;

        // Status check forwards custom_url, custom_include_headers, and secret_id.
        await openai.getStatusOpen();
        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/api/backends/chat-completions/status',
            expect.objectContaining({ method: 'POST' }),
        );
        const statusBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
        expect(statusBody).toMatchObject({
            chat_completion_source: 'custom',
            custom_url: 'https://my.custom/v1',
            custom_include_headers: 'X-Test: 1',
            secret_id: 'custom-sec-99',
        });

        // Chat generation forwards secret_id after CHAT_COMPLETION_SETTINGS_READY.
        mocks.fetchResumable.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
        });
        await openai.sendOpenAIRequest('normal', [{ role: 'user', content: 'hi' }], new AbortController().signal);
        const generateBody = JSON.parse(mocks.fetchResumable.mock.calls[0][1].body);
        expect(generateBody.secret_id).toBe('custom-sec-99');
    });

    test('preserves legacy Custom endpoint settings and skips load-time apply when None or no profile is saved, and shares array identity when loaded', async () => {
        // Legacy install with no saved selected profile keeps typed URL/model and leaves preset name empty.
        openai.oai_settings.custom_url = 'https://legacy.example/v1';
        openai.oai_settings.custom_model = 'legacy-model';
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [{ name: 'Saved', url: 'https://saved.example/v1', model: 'saved-model', secretId: 's1' }],
            selected_custom_endpoint_preset: null,
        });
        expect(openai.oai_settings.custom_url).toBe('https://legacy.example/v1');
        expect(openai.oai_settings.custom_model).toBe('legacy-model');
        expect($('#custom_endpoint_preset_name').val()).toBe('');

        // Selecting None on reload also preserves typed URL and model.
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [{ name: 'Saved', url: 'https://saved.example/v1', model: 'saved-model', secretId: 's1' }],
            selected_custom_endpoint_preset: { name: 'None' },
        });
        expect(openai.oai_settings.custom_url).toBe('https://legacy.example/v1');
        expect(openai.oai_settings.custom_model).toBe('legacy-model');

        // Loading a saved profile applies URL/model without rotating/writing secrets or overwriting live Additional Parameters,
        // and selected_custom_endpoint_preset points to the exact entry in custom_endpoint_presets.
        openai.oai_settings.custom_include_body = 'live_override: true';
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [
                { name: 'Saved', url: 'https://saved.example/v1', model: 'saved-model', secretId: 's1', custom_include_body: 'profile_default: true' },
            ],
            selected_custom_endpoint_preset: { name: 'Saved' },
        });
        const arrayEntry = openai.custom_endpoint_presets.find(p => p.name === 'Saved');
        expect(openai.selected_custom_endpoint_preset).toBe(arrayEntry);
        expect(openai.oai_settings.custom_url).toBe('https://saved.example/v1');
        expect(openai.oai_settings.custom_include_body).toBe('live_override: true');
        expect(mocks.secrets.writeSecret).not.toHaveBeenCalled();
        expect(mocks.secrets.rotateSecret).not.toHaveBeenCalled();
        expect(mocks.script.resultCheckStatus).not.toHaveBeenCalled();
    });

    test('exposes /custom-endpoint-profile with exact-name lookup and stores additional parameters verbatim via slash commands', async () => {
        await openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [
                { name: 'Alpha', url: 'https://alpha.example/v1', model: 'alpha-m', key: '', secretId: 'sec-alpha', custom_include_body: 'a: 1' },
                { name: 'Alpha-2', url: 'https://alpha2.example/v1', model: 'alpha2-m', key: '', secretId: 'sec-alpha2' },
            ],
            selected_custom_endpoint_preset: null,
        });
        openai.oai_settings.chat_completion_source = openai.chat_completion_sources.CUSTOM;

        // /custom-endpoint-profile matches exact name (no fuzzy fallback for typos).
        const profileCommand = mocks.registeredCommands.get('custom-endpoint-profile');
        expect(profileCommand).toBeDefined();
        await profileCommand.callback({}, 'Alph');
        expect(openai.oai_settings.custom_url).not.toBe('https://alpha.example/v1');

        await profileCommand.callback({}, 'Alpha');
        expect(openai.oai_settings.custom_url).toBe('https://alpha.example/v1');
        expect(openai.oai_settings.custom_model).toBe('alpha-m');
        expect(openai.oai_settings.custom_include_body).toBe('a: 1');
        expect($('#custom_endpoint_preset').val()).toBe('Alpha');

        // Additional parameter slash commands preserve leading/trailing whitespace verbatim.
        for (const [cmdName, settingKey] of [
            ['custom-include-body', 'custom_include_body'],
            ['custom-exclude-body', 'custom_exclude_body'],
            ['custom-include-headers', 'custom_include_headers'],
        ]) {
            const cmd = mocks.registeredCommands.get(cmdName);
            expect(cmd).toBeDefined();
            const rawValue = '  indented: true  \n';
            cmd.callback({}, rawValue);
            expect(openai.oai_settings[settingKey]).toBe(rawValue);
        }
    });

    test('loads and persists Custom endpoint profiles with settings in script.js', () => {
        expect(scriptSource).toContain('await loadCustomEndpointPresets(settings);');
        expect(scriptSource).toContain('custom_endpoint_presets: custom_endpoint_presets');
        expect(scriptSource).toContain('selected_custom_endpoint_preset: selected_custom_endpoint_preset');

        const getSettingsSource = scriptSource.match(/export async function getSettings\(\) \{[\s\S]*?\n\}/)?.[0];
        expect(getSettingsSource).toBeDefined();
        const liveSettingsIndex = getSettingsSource.indexOf('\n        loadOpenAISettings(');
        const profilesIndex = getSettingsSource.indexOf('await loadCustomEndpointPresets(settings);');
        expect(getSettingsSource).not.toContain('await loadOpenAISettings(');
        expect(liveSettingsIndex).toBeGreaterThanOrEqual(0);
        expect(profilesIndex).toBeGreaterThan(liveSettingsIndex);
    });
});
