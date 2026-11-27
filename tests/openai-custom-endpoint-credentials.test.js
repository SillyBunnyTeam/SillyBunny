/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest table-driven tests are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importOpenAiModule } from './util/openai-harness.js';
import {
    normalizeCustomEndpointPreset,
    pickCustomEndpointParameters,
} from '../public/scripts/openai-preset-utils.js';

const ENDPOINT_DOM = `
    <select id="chat_completion_source">
        <option value="custom" selected>custom</option>
    </select>
    <select id="custom_endpoint_preset"></select>
    <input id="custom_endpoint_preset_name" value="" />
    <input id="custom_api_url_text" value="https://endpoint.example/v1" />
    <input id="custom_model_id" value="test-model" />
    <input id="api_key_custom" value="" />
    <select id="model_custom_select"></select>
    <button id="save_custom_endpoint" type="button"></button>
    <button id="delete_custom_endpoint" type="button"></button>
    <button id="api_button_openai" class="api_button" type="button"></button>
    <button id="customize_additional_parameters" type="button"></button>
`;

const POPUP_TEMPLATE_HTML = `
    <div id="custom_additional_parameters_popup">
        <textarea id="custom_include_body"></textarea>
        <textarea id="custom_exclude_body"></textarea>
        <textarea id="custom_include_headers"></textarea>
        <select id="custom_reasoning_preset">
            <option value="custom">custom</option>
        </select>
        <input id="custom_reasoning_param_name" />
        <select id="custom_reasoning_param_format">
            <option value="openai">openai</option>
            <option value="string">string</option>
            <option value="thinking_object">thinking_object</option>
        </select>
        <input id="custom_reasoning_enabled_value" />
        <input id="custom_reasoning_disabled_value" />
        <div class="sb-custom-reasoning-toggle-values"></div>
    </div>
`;

const originalFetch = globalThis.fetch;

afterEach(() => {
    document.body.innerHTML = '';
    globalThis.fetch = originalFetch;
    if (typeof window !== 'undefined' && window.jQuery) {
        window.jQuery(document).off();
    }
    jest.restoreAllMocks();
});

async function createEndpointHarness({
    profile = normalizeCustomEndpointPreset({ name: 'Saved endpoint', url: 'https://endpoint.example/v1', model: 'test-model', secretId: 'saved-id' }),
    input = '',
    writeResult = 'replacement-id',
} = {}) {
    document.body.innerHTML = ENDPOINT_DOM;
    if (!window.jQuery) {
        await import('../public/lib/jquery-3.5.1.min.js');
    }
    const $ = window.jQuery;
    globalThis.$ = $;
    globalThis.jQuery = $;
    if (!$.fn.select2) $.fn.select2 = function () { return this; };
    if (!$.fn.sortable) $.fn.sortable = function () { return this; };

    const secretState = { api_key_custom: [{ id: 'unrelated-active-id', active: true }] };
    let persistedSettings = null;
    let openaiRef = null;
    let closePopup = null;
    let activePopupEl = null;

    const statusCalls = [];
    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/backends/chat-completions/status') {
            statusCalls.push(openaiRef.selected_custom_endpoint_preset?.secretId ?? '');
            return { ok: true, status: 200, json: async () => ({ data: [{ id: 'test-model' }] }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock;

    const saveSettingsMock = jest.fn(async (_loop = 0, { returnResult = false } = {}) => {
        persistedSettings = {
            custom_endpoint_presets: openaiRef.custom_endpoint_presets.map(p => ({
                ...structuredClone(p),
                key: p.secretId ? '' : p.key,
            })),
            selected_custom_endpoint_preset: openaiRef.selected_custom_endpoint_preset
                ? {
                    ...structuredClone(openaiRef.selected_custom_endpoint_preset),
                    key: openaiRef.selected_custom_endpoint_preset.secretId ? '' : openaiRef.selected_custom_endpoint_preset.key,
                }
                : null,
        };
        return returnResult ? true : undefined;
    });

    const writeSecretMock = jest.fn(async () => {
        if (writeResult) {
            $('#api_key_custom').val('');
            secretState.api_key_custom = [{ id: writeResult, active: true }];
        }
        return writeResult;
    });

    const callGenericPopupMock = jest.fn(async (template) => {
        activePopupEl = template;
        $(document.body).append(template);
        return new Promise(resolve => {
            closePopup = () => {
                template.remove();
                activePopupEl = null;
                resolve(1);
            };
        });
    });

    const { openai, mocks } = await importOpenAiModule({
        resetModules: true,
        script: {
            saveSettings: saveSettingsMock,
            getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
        },
        secrets: {
            secret_state: secretState,
            writeSecret: writeSecretMock,
            rotateSecret: jest.fn(async () => {}),
        },
        templates: {
            renderTemplateAsync: jest.fn(async () => POPUP_TEMPLATE_HTML),
        },
        popup: {
            callGenericPopup: callGenericPopupMock,
        },
    });
    openaiRef = openai;

    openai.oai_settings.chat_completion_source = openai.chat_completion_sources.CUSTOM;
    openai.oai_settings.custom_url = profile.url || 'https://endpoint.example/v1';
    openai.oai_settings.custom_model = profile.model || 'test-model';
    openai.oai_settings.custom_include_body = '';
    openai.oai_settings.custom_exclude_body = '';
    openai.oai_settings.custom_include_headers = '';

    await openai.loadCustomEndpointPresets({
        custom_endpoint_presets: [profile],
        selected_custom_endpoint_preset: { name: profile.name },
    });
    // Keep only the passed profile when None was not originally in the list, unless caller adds it.
    if (profile.name !== 'None') {
        const noneIdx = openai.custom_endpoint_presets.findIndex(p => p.name === 'None');
        if (noneIdx !== -1) {
            openai.custom_endpoint_presets.splice(noneIdx, 1);
            $('#custom_endpoint_preset option[value="None"]').remove();
        }
    }

    const activeProfile = openai.selected_custom_endpoint_preset;
    // Preserve caller's initial Additional Parameters presence (loadCustomEndpointPresets migrates empty live values onto the selected profile).
    for (const key of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) {
        if (!Object.hasOwn(profile, key)) {
            delete activeProfile[key];
        }
    }
    $('#custom_endpoint_preset_name').val(activeProfile.name);
    $('#custom_endpoint_preset').val(activeProfile.name);
    $('#custom_api_url_text').val(activeProfile.url || 'https://endpoint.example/v1');
    $('#custom_model_id').val(activeProfile.model || 'test-model');
    $('#api_key_custom').val(input);

    openai.initOpenAI();

    mocks.script.saveSettingsDebounced.mockClear();
    saveSettingsMock.mockClear();
    writeSecretMock.mockClear();
    globalThis.toastr.success.mockClear();
    globalThis.toastr.error.mockClear();
    globalThis.toastr.warning.mockClear();
    fetchMock.mockClear();
    statusCalls.length = 0;

    const getHandler = (id, event) => $._data(document.getElementById(id), 'events')[event][0].handler;
    const saveHandler = getHandler('save_custom_endpoint', 'click');
    const deleteHandler = getHandler('delete_custom_endpoint', 'click');
    const connectHandler = getHandler('api_button_openai', 'click');
    const changeHandler = getHandler('custom_endpoint_preset', 'change');
    const customizeHandler = getHandler('customize_additional_parameters', 'click');
    const slashCommand = mocks.registeredCommands.get('custom-endpoint-profile').callback;

    const addPresetOption = (preset) => {
        openai.custom_endpoint_presets.push(preset);
        if (!$(`#custom_endpoint_preset option[value="${preset.name}"]`).length) {
            $('#custom_endpoint_preset').append($('<option>').val(preset.name).text(preset.name));
        }
    };

    const selectPresetDropdown = async (name) => {
        if (!$(`#custom_endpoint_preset option[value="${name}"]`).length) {
            $('#custom_endpoint_preset').append($('<option>').val(name).text(name));
        }
        $('#custom_endpoint_preset').val(name);
        await changeHandler();
    };

    const openPopup = async () => {
        const opened = customizeHandler();
        await new Promise(resolve => setTimeout(resolve, 0));
        const popup = {
            text: key => String(activePopupEl.find(`#${key}`).val() ?? ''),
            type: (key, text) => {
                const field = activePopupEl.find(`#${key}`);
                field.val(text);
                field.trigger('input');
            },
            close: async () => {
                closePopup?.();
                await opened;
            },
        };
        popup.append = (key, text) => popup.type(key, `${popup.text(key)}${text}`);
        return popup;
    };

    return {
        $,
        openai,
        mocks,
        profile: activeProfile,
        saveSettingsMock,
        writeSecretMock,
        fetchMock,
        statusCalls,
        slashCommand,
        addPresetOption,
        selectPresetDropdown,
        openPopup,
        connect: () => connectHandler({ stopPropagation() {} }),
        save: () => saveHandler(),
        remove: () => deleteHandler(),
        reload: () => createEndpointHarness({ profile: persistedSettings.selected_custom_endpoint_preset }),
        persisted: () => persistedSettings,
    };
}

describe('Custom endpoint profile credentials on Connect', () => {
    test('does not reselect A when B is selected during the settings response', async () => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        const other = normalizeCustomEndpointPreset({ name: 'B', url: 'https://b.example/v1', model: 'model-b', secretId: 'b-id' });
        harness.addPresetOption(other);

        let finishSave;
        const origSave = harness.saveSettingsMock.getMockImplementation();
        harness.saveSettingsMock.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(origSave(...args));
        }));

        const saving = harness.save();
        await new Promise(resolve => setTimeout(resolve, 0));
        await harness.selectPresetDropdown('B');
        finishSave();
        await saving;

        expect(harness.openai.selected_custom_endpoint_preset).toBe(other);
        expect(harness.openai.oai_settings.custom_model).toBe('model-b');
        expect(harness.$('#custom_endpoint_preset').val()).toBe('B');
    });

    test.each([
        ['save', ['replacement-id']],
        ['connect', []],
    ])('does not report success or continue replacement %s when settings save fails', async (action, expectedStatusCalls) => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        harness.saveSettingsMock.mockResolvedValue(false);

        await harness[action]();

        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(harness.statusCalls).toEqual(expectedStatusCalls);
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.$('#api_key_custom').val()).toBe('');
    });

    test.each(['save', 'connect'])('retains the written binding for Save retry after %s settings failure', async (action) => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        harness.saveSettingsMock.mockResolvedValueOnce(false);

        await harness[action]();
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');

        await harness.save();
        expect(harness.writeSecretMock).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.success).toHaveBeenCalledTimes(1);
        expect((await harness.reload()).profile.secretId).toBe('replacement-id');
        expect(JSON.stringify(harness.persisted())).not.toContain('replacement-test-key');
    });

    test.each(['save', 'connect'])('does not persist a failed secret write and allows %s retry', async (action) => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        harness.writeSecretMock.mockResolvedValueOnce(null);

        await harness[action]();
        expect(harness.saveSettingsMock).not.toHaveBeenCalled();
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(harness.statusCalls).toEqual([]);
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.$('#api_key_custom').val()).toBe('replacement-test-key');

        await harness[action]();
        expect(harness.writeSecretMock).toHaveBeenCalledTimes(2);
        expect((await harness.reload()).profile.secretId).toBe('replacement-id');
    });

    test('persists the profile binding before reporting a successful Save', async () => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        harness.$('#custom_endpoint_preset_name').val(harness.profile.name);
        harness.$('#custom_api_url_text').val('https://endpoint.example/v1');
        harness.$('#custom_model_id').val('test-model');

        let finishSave;
        const origSave = harness.saveSettingsMock.getMockImplementation();
        harness.saveSettingsMock.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(origSave(...args));
        }));

        const saving = harness.save();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(harness.saveSettingsMock).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.openai.selected_custom_endpoint_preset).toBe(harness.profile);
        expect(harness.$('#custom_endpoint_preset').val()).toBe(harness.profile.name);

        finishSave();
        await saving;
        expect(globalThis.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.persisted().custom_endpoint_presets[0].key).toBe('');
        expect(JSON.stringify(harness.persisted())).not.toContain('replacement-test-key');
        expect((await harness.reload()).profile.secretId).toBe('replacement-id');
    });

    test('persists a replacement binding before checking the connection', async () => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        let finishSave;
        const origSave = harness.saveSettingsMock.getMockImplementation();
        harness.saveSettingsMock.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(origSave(...args));
        }));

        const connecting = harness.connect();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(harness.saveSettingsMock).toHaveBeenCalledTimes(1);
        expect(harness.statusCalls).toEqual([]);

        finishSave();
        await connecting;
        expect(harness.statusCalls).toEqual(['replacement-id']);
    });

    test('replaces the saved credential before connecting and keeps it after reload', async () => {
        const harness = await createEndpointHarness({ input: ' replacement-test-key ' });

        await harness.connect();

        expect(harness.writeSecretMock).toHaveBeenCalledWith('api_key_custom', 'replacement-test-key');
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.profile.key).toBe('');
        expect(harness.$('#api_key_custom').val()).toBe('');
        expect(harness.$('#api_key_custom').attr('placeholder')).toBe('(saved secret)');
        expect(harness.statusCalls).toEqual(['replacement-id']);

        const reloaded = await harness.reload();
        await reloaded.connect();
        expect(reloaded.writeSecretMock).not.toHaveBeenCalled();
        expect(reloaded.statusCalls).toEqual(['replacement-id']);
    });

    test('reuses the profile credential when no replacement was entered', async () => {
        const harness = await createEndpointHarness();

        await harness.connect();
        await harness.connect();

        expect(harness.writeSecretMock).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.statusCalls).toEqual(['saved-id', 'saved-id']);
    });

    test('binds a key entered for a legacy profile without a secret id', async () => {
        const harness = await createEndpointHarness({
            profile: normalizeCustomEndpointPreset({ name: 'Legacy endpoint', url: 'https://endpoint.example/v1', key: 'legacy-test-key' }),
            input: 'replacement-test-key',
        });

        await harness.connect();

        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.profile.key).toBe('');
    });

    test('leaves the None profile unbound when connecting a manually entered key', async () => {
        const harness = await createEndpointHarness({
            profile: normalizeCustomEndpointPreset({ name: 'None' }),
            input: 'manual-test-key',
        });

        await harness.connect();

        expect(harness.writeSecretMock).toHaveBeenCalledWith('api_key_custom', 'manual-test-key');
        expect(harness.profile.secretId).toBe('');
    });

    test('does not connect with the old key if saving its replacement fails', async () => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key', writeResult: null });

        await harness.connect();

        expect(harness.writeSecretMock).toHaveBeenCalledTimes(1);
        expect(harness.statusCalls).toEqual([]);
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.$('#api_key_custom').val()).toBe('replacement-test-key');
    });

    test('binds the key to the original profile if selection changes while it is being saved', async () => {
        const harness = await createEndpointHarness({ input: 'replacement-test-key' });
        const otherProfile = normalizeCustomEndpointPreset({ name: 'Other endpoint', url: 'https://other.example/v1', secretId: 'other-id' });
        harness.addPresetOption(otherProfile);
        harness.writeSecretMock.mockImplementation(async () => {
            await harness.selectPresetDropdown('Other endpoint');
            return 'replacement-id';
        });

        await harness.connect();

        expect(harness.profile.secretId).toBe('replacement-id');
        expect(otherProfile.secretId).toBe('other-id');
    });
});

describe('Custom endpoint profile Additional Parameters', () => {
    const storedParameters = {
        custom_include_body: '  top_k: 20\n  min_p: 0.05\n',
        custom_exclude_body: '',
        custom_include_headers: 'X-Title: Story',
    };

    test('Save stores the current Additional Parameters with the profile and keeps them after a reload', async () => {
        const harness = await createEndpointHarness();
        Object.assign(harness.openai.oai_settings, storedParameters);

        await harness.save();

        expect(globalThis.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.profile).toMatchObject(storedParameters);
        expect(harness.persisted().custom_endpoint_presets[0]).toMatchObject(storedParameters);

        const reloaded = await createEndpointHarness();
        await reloaded.openai.loadCustomEndpointPresets(harness.persisted());
        expect(reloaded.openai.selected_custom_endpoint_preset.name).toBe(harness.profile.name);
        expect(reloaded.openai.selected_custom_endpoint_preset).toMatchObject(storedParameters);
    });

    test('Save stores the Additional Parameters with a new profile', async () => {
        const harness = await createEndpointHarness();
        Object.assign(harness.openai.oai_settings, storedParameters);
        harness.$('#custom_endpoint_preset_name').val('New endpoint');

        await harness.save();

        const created = harness.openai.custom_endpoint_presets.find(preset => preset.name === 'New endpoint');
        expect(created).toMatchObject({ secretId: 'unrelated-active-id', ...storedParameters });
        expect(harness.openai.selected_custom_endpoint_preset).toBe(created);
        expect(harness.profile).not.toHaveProperty('custom_include_body');
    });

    test('Delete and /custom-endpoint-profile apply the Additional Parameters of the profile they select', async () => {
        const harness = await createEndpointHarness();
        const stored = normalizeCustomEndpointPreset({ name: 'Stored', model: 'model-b', secretId: 'b-id', ...storedParameters });
        const doomed = normalizeCustomEndpointPreset({ name: 'Doomed', secretId: 'd-id', custom_include_body: 'doomed: 1', custom_exclude_body: '', custom_include_headers: '' });
        harness.addPresetOption(stored);
        harness.addPresetOption(doomed);

        harness.$('#custom_endpoint_preset_name').val('Doomed');
        await harness.remove();
        expect(harness.openai.custom_endpoint_presets).not.toContain(doomed);
        expect(harness.openai.selected_custom_endpoint_preset).toBe(stored);
        expect(harness.openai.oai_settings).toMatchObject(storedParameters);

        Object.assign(harness.openai.oai_settings, { custom_include_body: 'changed: 1' });
        expect(await harness.slashCommand(null, 'Stored')).toBe('Stored');
        expect(harness.openai.oai_settings).toMatchObject(storedParameters);
    });

    test.each([
        ['the profile after None', harness => {
            harness.openai.custom_endpoint_presets.unshift(normalizeCustomEndpointPreset({ name: 'None' }));
            harness.$('#custom_endpoint_preset').prepend('<option value="None">None</option>');
        }],
        ['the only profile', () => {}],
    ])('Delete of %s falls back to None, which clears the Additional Parameters in effect', async (_, arrange) => {
        const harness = await createEndpointHarness();
        arrange(harness);
        Object.assign(harness.profile, storedParameters);
        Object.assign(harness.openai.oai_settings, storedParameters);

        await harness.remove();

        expect(harness.openai.custom_endpoint_presets).not.toContain(harness.profile);
        expect(harness.openai.selected_custom_endpoint_preset.name).toBe('None');
        expect(harness.openai.oai_settings).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
    });

    test('selecting a profile applies its Additional Parameters, a profile without them keeps the current ones, and None clears them', async () => {
        const harness = await createEndpointHarness();
        const stored = normalizeCustomEndpointPreset({ name: 'Stored', model: 'model-b', secretId: 'b-id', ...storedParameters });
        const legacy = normalizeCustomEndpointPreset({ name: 'Legacy', model: 'model-c', secretId: 'c-id' });
        harness.addPresetOption(normalizeCustomEndpointPreset({ name: 'None' }));
        harness.addPresetOption(stored);
        harness.addPresetOption(legacy);
        Object.assign(harness.openai.oai_settings, { custom_include_body: 'current: 1', custom_exclude_body: '- seed', custom_include_headers: '' });

        await harness.selectPresetDropdown('Stored');
        expect(harness.openai.oai_settings).toMatchObject(storedParameters);

        await harness.selectPresetDropdown('Legacy');
        expect(harness.openai.oai_settings.custom_model).toBe('model-c');
        expect(harness.openai.oai_settings).toMatchObject(storedParameters);
        expect(legacy).not.toHaveProperty('custom_include_body');

        await harness.selectPresetDropdown('None');
        expect(harness.openai.oai_settings).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
    });

    test('loading the settings keeps the Additional Parameters that were in effect', async () => {
        const harness = await createEndpointHarness();
        Object.assign(harness.openai.oai_settings, { custom_include_body: 'set-by-connection-profile: 1' });

        await harness.openai.loadCustomEndpointPresets({
            custom_endpoint_presets: [
                { name: 'None' },
                { name: 'Saved endpoint', url: 'https://endpoint.example/v1', model: 'test-model', secretId: 'saved-id', ...storedParameters },
            ],
            selected_custom_endpoint_preset: { name: 'Saved endpoint' },
        });

        expect(harness.openai.oai_settings.custom_url).toBe('https://endpoint.example/v1');
        expect(harness.openai.oai_settings.custom_include_body).toBe('set-by-connection-profile: 1');
        expect(harness.openai.selected_custom_endpoint_preset).toMatchObject(storedParameters);
        expect(harness.mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    describe('editing in the Additional Parameters dialog', () => {
        const makeOther = () => normalizeCustomEndpointPreset({
            name: 'Other',
            model: 'model-b',
            secretId: 'b-id',
            custom_include_body: 'other: 1',
            custom_exclude_body: '',
            custom_include_headers: 'X-Other: 1',
        });

        test('an edit is stored with the selected profile, comes back when the profile is selected again, and is in the saved settings', async () => {
            const harness = await createEndpointHarness();
            const otherProfile = makeOther();
            harness.addPresetOption(otherProfile);
            Object.assign(harness.profile, storedParameters);
            Object.assign(harness.openai.oai_settings, storedParameters);

            const popup = await harness.openPopup();
            expect(popup.text('custom_include_body')).toBe(storedParameters.custom_include_body);
            popup.type('custom_include_body', 'edited_in_popup: 1');

            expect(harness.openai.oai_settings.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.profile.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.profile).toMatchObject({ custom_exclude_body: storedParameters.custom_exclude_body, custom_include_headers: storedParameters.custom_include_headers });
            expect(harness.mocks.script.saveSettingsDebounced).toHaveBeenCalled();
            await popup.close();

            await harness.selectPresetDropdown('Other');
            expect(harness.openai.oai_settings.custom_include_body).toBe('other: 1');

            await harness.selectPresetDropdown(harness.profile.name);
            expect(harness.openai.oai_settings).toMatchObject({ ...storedParameters, custom_include_body: 'edited_in_popup: 1' });

            await harness.saveSettingsMock(0, { returnResult: true });
            const saved = harness.persisted().custom_endpoint_presets.find(preset => preset.name === harness.profile.name);
            expect(saved.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.persisted().selected_custom_endpoint_preset.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.persisted().custom_endpoint_presets.find(preset => preset.name === 'Other').custom_include_body).toBe('other: 1');
        });

        test('each of the three fields is stored with the selected profile, including an empty value', async () => {
            const harness = await createEndpointHarness();
            Object.assign(harness.profile, storedParameters);
            Object.assign(harness.openai.oai_settings, storedParameters);

            const popup = await harness.openPopup();
            popup.type('custom_exclude_body', '- seed');
            popup.type('custom_include_headers', '');

            expect(harness.profile).toMatchObject({ custom_exclude_body: '- seed', custom_include_headers: '' });
            expect(harness.openai.oai_settings).toMatchObject({ custom_exclude_body: '- seed', custom_include_headers: '' });
            await popup.close();
        });

        test('an edit stores only the field that changed with a profile that stores none', async () => {
            const harness = await createEndpointHarness();
            Object.assign(harness.openai.oai_settings, storedParameters);

            const popup = await harness.openPopup();
            popup.type('custom_include_body', 'edited_in_popup: 1');

            expect(harness.profile.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.profile).not.toHaveProperty('custom_exclude_body');
            expect(harness.profile).not.toHaveProperty('custom_include_headers');
            await popup.close();
        });

        test.each([
            ['the dropdown', harness => harness.selectPresetDropdown('Other')],
            ['/custom-endpoint-profile', harness => harness.slashCommand(null, 'Other')],
            ['a connection profile that names its secret', harness => harness.openai.syncCustomEndpointPresetSelectionBySecretId('b-id')],
        ])('a selection by %s while the dialog is open does not let the text of the previous profile reach the new one', async (_, select) => {
            const harness = await createEndpointHarness();
            const otherProfile = makeOther();
            harness.addPresetOption(otherProfile);
            Object.assign(harness.profile, { custom_include_body: 'a: 1', custom_exclude_body: '', custom_include_headers: 'Authorization: Bearer KEY-A' });
            Object.assign(harness.openai.oai_settings, pickCustomEndpointParameters(harness.profile));
            const popup = await harness.openPopup();

            await select(harness);
            popup.append('custom_include_headers', '\n');

            const live = harness.openai.oai_settings;
            expect(harness.openai.selected_custom_endpoint_preset).toBe(otherProfile);
            expect(JSON.stringify([live, otherProfile])).not.toContain('KEY-A');
            expect(harness.profile.custom_include_headers).toBe('Authorization: Bearer KEY-A');
            for (const parameterKey of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) {
                expect(popup.text(parameterKey)).toBe(live[parameterKey]);
                expect(otherProfile[parameterKey]).toBe(live[parameterKey]);
            }
            await popup.close();
        });

        test('an edit after the dialog caught up with a new selection is stored with that profile', async () => {
            const harness = await createEndpointHarness();
            const otherProfile = makeOther();
            harness.addPresetOption(otherProfile);
            Object.assign(harness.openai.oai_settings, pickCustomEndpointParameters(harness.profile));
            const popup = await harness.openPopup();
            harness.openai.syncCustomEndpointPresetSelectionBySecretId('b-id');
            popup.append('custom_include_body', ' ');
            expect(otherProfile.custom_include_body).toBe('other: 1');

            popup.append('custom_include_body', '# kept');

            expect(otherProfile.custom_include_body).toBe('other: 1# kept');
            expect(harness.openai.oai_settings.custom_include_body).toBe('other: 1# kept');
            await popup.close();
        });

        test('with None selected the live settings are the only store', async () => {
            const harness = await createEndpointHarness({ profile: normalizeCustomEndpointPreset({ name: 'None' }) });
            const popup = await harness.openPopup();

            popup.type('custom_include_headers', 'X-Typed: 1');

            expect(harness.openai.oai_settings.custom_include_headers).toBe('X-Typed: 1');
            expect(harness.profile).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
            await harness.saveSettingsMock(0, { returnResult: true });
            expect(harness.persisted().custom_endpoint_presets[0]).toMatchObject({ name: 'None', custom_include_headers: '' });
            await popup.close();
        });
    });

    describe('applying a connection profile that selects an endpoint profile by its secret', () => {
        const parametersA = { custom_include_body: 'a: 1', custom_exclude_body: '', custom_include_headers: 'Authorization: Bearer KEY-A' };
        const parametersB = { custom_include_body: 'b: 1', custom_exclude_body: '- seed', custom_include_headers: 'Authorization: Bearer KEY-B' };

        const applyConnectionProfile = async (harness, { secretId, endpointProfile, parameters = {} }) => {
            harness.openai.syncCustomEndpointPresetSelectionBySecretId(secretId);
            if (endpointProfile) await harness.slashCommand(null, endpointProfile);
            Object.assign(harness.openai.oai_settings, parameters);
        };

        const createProviders = async ({ providerB = parametersB } = {}) => {
            const harness = await createEndpointHarness({
                profile: normalizeCustomEndpointPreset({ name: 'Provider A', url: 'http://a.example/v1', model: 'model-a', secretId: 'secret-a', ...parametersA }),
            });
            const none = normalizeCustomEndpointPreset({ name: 'None' });
            const b = normalizeCustomEndpointPreset({ name: 'Provider B', url: 'http://b.example/v1', model: 'model-b', secretId: 'secret-b', ...providerB });
            harness.openai.custom_endpoint_presets.unshift(none);
            harness.$('#custom_endpoint_preset').prepend('<option value="None">None</option>');
            harness.addPresetOption(b);
            Object.assign(harness.openai.oai_settings, parametersA);
            return { harness, none, b };
        };

        test.each([
            ['has no endpoint profile name', undefined],
            ['names an endpoint profile that was deleted', 'Deleted Profile'],
        ])('a connection profile that %s brings the parameters of the profile that its secret selects', async (_, endpointProfile) => {
            const { harness, b } = await createProviders();

            await applyConnectionProfile(harness, { secretId: 'secret-b', endpointProfile });

            expect(harness.openai.selected_custom_endpoint_preset).toBe(b);
            expect(harness.openai.oai_settings).toMatchObject(parametersB);
            expect(harness.openai.oai_settings.custom_include_headers).not.toContain('KEY-A');
        });

        test('the parameters that the connection profile records itself win over the ones the secret selects', async () => {
            const { harness } = await createProviders();

            await applyConnectionProfile(harness, { secretId: 'secret-b', parameters: { custom_include_body: 'own: 1' } });

            expect(harness.openai.oai_settings).toMatchObject({ ...parametersB, custom_include_body: 'own: 1' });
        });

        test('a selected profile that stores none leaves the current parameters', async () => {
            const { harness, b } = await createProviders({ providerB: {} });

            await applyConnectionProfile(harness, { secretId: 'secret-b' });

            expect(harness.openai.selected_custom_endpoint_preset).toBe(b);
            expect(harness.openai.oai_settings).toMatchObject(parametersA);
        });

        test('a secret that no endpoint profile holds selects None, which clears the parameters', async () => {
            const { harness, none } = await createProviders();

            await applyConnectionProfile(harness, { secretId: 'secret-unknown' });

            expect(harness.openai.selected_custom_endpoint_preset).toBe(none);
            expect(harness.openai.oai_settings).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
        });

        test('a secret of the profile that is already selected keeps the parameters in effect', async () => {
            const { harness } = await createProviders();
            harness.openai.oai_settings.custom_include_body = 'set-by-an-earlier-connection-profile: 1';

            await applyConnectionProfile(harness, { secretId: 'secret-a' });

            expect(harness.openai.selected_custom_endpoint_preset).toBe(harness.profile);
            expect(harness.openai.oai_settings.custom_include_body).toBe('set-by-an-earlier-connection-profile: 1');
        });

        test('no secret changes nothing', async () => {
            const { harness } = await createProviders();

            await applyConnectionProfile(harness, { secretId: '' });

            expect(harness.openai.selected_custom_endpoint_preset).toBe(harness.profile);
            expect(harness.openai.oai_settings).toMatchObject(parametersA);
        });
    });

    describe('loading profiles that store no Additional Parameters', () => {
        const liveParameters = { custom_include_body: 'top_k: 40', custom_exclude_body: '- seed', custom_include_headers: 'Authorization: Bearer LIVE-A' };
        const noParameters = Object.keys(liveParameters);
        const savedProfiles = () => [
            { name: 'None', url: '', key: '', model: '', secretId: '' },
            { name: 'Provider A', url: 'https://a.example/v1', model: 'model-a', secretId: 'a-id' },
            { name: 'Provider B', url: 'https://b.example/v1', model: 'model-b', secretId: 'b-id' },
        ];

        test('gives the selected profile the live ones once and saves them, and gives no other profile a copy', async () => {
            const harness = await createEndpointHarness();
            Object.assign(harness.openai.oai_settings, liveParameters);

            await harness.openai.loadCustomEndpointPresets({ custom_endpoint_presets: savedProfiles(), selected_custom_endpoint_preset: { name: 'Provider A' } });

            const [none, providerA, providerB] = harness.openai.custom_endpoint_presets;
            expect(harness.openai.selected_custom_endpoint_preset).toBe(providerA);
            expect(providerA).toMatchObject(liveParameters);
            for (const parameterKey of noParameters) {
                expect(providerB).not.toHaveProperty(parameterKey);
            }
            expect(none).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
            expect(harness.openai.oai_settings).toMatchObject(liveParameters);
            expect(harness.mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);

            await harness.saveSettingsMock(0, { returnResult: true });
            const savedB = harness.persisted().custom_endpoint_presets.find(preset => preset.name === 'Provider B');
            expect(Object.keys(savedB).sort()).toEqual(['key', 'model', 'name', 'secretId', 'url']);
            expect(harness.persisted().selected_custom_endpoint_preset).toMatchObject(liveParameters);
            expect(JSON.stringify(savedB)).not.toContain('LIVE-A');
        });

        test('keeps the live header when a profile that stores none is selected afterwards', async () => {
            const harness = await createEndpointHarness();
            Object.assign(harness.openai.oai_settings, liveParameters);
            await harness.openai.loadCustomEndpointPresets({ custom_endpoint_presets: savedProfiles(), selected_custom_endpoint_preset: { name: 'Provider A' } });
            const providerB = harness.openai.custom_endpoint_presets.find(preset => preset.name === 'Provider B');

            await harness.selectPresetDropdown('Provider B');

            expect(harness.openai.selected_custom_endpoint_preset).toBe(providerB);
            expect(harness.openai.oai_settings.custom_url).toBe('https://b.example/v1');
            expect(harness.openai.oai_settings).toMatchObject(liveParameters);
            for (const parameterKey of noParameters) {
                expect(providerB).not.toHaveProperty(parameterKey);
            }
        });

        test('changes nothing when None is selected', async () => {
            const harness = await createEndpointHarness();
            Object.assign(harness.openai.oai_settings, liveParameters);

            await harness.openai.loadCustomEndpointPresets({ custom_endpoint_presets: savedProfiles(), selected_custom_endpoint_preset: { name: 'None' } });

            for (const profile of harness.openai.custom_endpoint_presets.filter(preset => preset.name !== 'None')) {
                for (const parameterKey of noParameters) {
                    expect(profile).not.toHaveProperty(parameterKey);
                }
            }
            expect(harness.openai.oai_settings).toMatchObject(liveParameters);
            expect(harness.mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();
        });
    });
});
