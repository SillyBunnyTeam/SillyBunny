/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildCustomEndpointPresetForSave, CUSTOM_ENDPOINT_PARAMETER_KEYS, fillMissingCustomEndpointParameters, normalizeCustomEndpointPreset, pickCustomEndpointParameters } from '../public/scripts/openai-preset-utils.js';
import { createSettingsSync } from '../public/scripts/sillybunny-settings-sync.js';

const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pollinationsEndpointSource = source.match(/export const POLLINATIONS_ENDPOINT = \{[\s\S]*?\n\};/)[0].replace('export ', '');
const connectSource = source.match(/async function onConnectButtonClick\(e\) \{[\s\S]*?\n\}/)[0];
const keyInputSource = source.match(/function updateCustomEndpointKeyInput\(preset, key\) \{[\s\S]*?\n\}/)[0];
const activateSource = source.match(/async function activateCustomEndpointPresetSecret\([\s\S]*?\n\}/)[0];
const setPresetSource = source.match(/async function setCustomEndpointPreset\([\s\S]*?\n\}/)[0];
const saveSource = source.match(/\$\('#save_custom_endpoint'\)\.on\('click', async function \(\) \{[\s\S]*?\n\}\);/)[0];
const changeSource = source.match(/async function onCustomEndpointPresetChange\([\s\S]*?\n\}/)[0];
const loadSource = source.match(/export async function loadCustomEndpointPresets\(settings\) \{[\s\S]*?\n\}/)[0].replace('export ', '');
const deleteSource = source.match(/\$\('#delete_custom_endpoint'\)\.on\('click', async function \(\) \{[\s\S]*?\n\}\);/)[0];
const slashCommandSource = source.match(/async function runCustomEndpointPresetCallback\([\s\S]*?\n\}/)[0];
const syncSource = source.match(/export function syncCustomEndpointPresetSelectionBySecretId\([\s\S]*?\n\}/)[0].replace('export ', '');
const popupSource = ['writeCustomEndpointParameter', 'bindCustomEndpointParameterFields', 'onCustomizeParametersClick']
    .map(name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join('\n');
const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const saverSource = ['saveSettings', 'saveSettingsInner', 'normalizeSettingsVersion']
    .map(name => scriptSource.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join('\n');
const sources = Object.fromEntries([...source.matchAll(/chat_completion_sources\.([A-Z0-9_]+)/g)].map(([, name]) => [name, name.toLowerCase()]));
const keys = Object.fromEntries(Object.keys(sources).map(name => [name, `api_key_${name.toLowerCase()}`]));
const saveFailures = [
    ['HTTP', context => context.fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })],
    ['network', context => context.fetch.mockRejectedValue(new Error('Network failure'))],
    ['compression', context => context.compressRequest.mockRejectedValue(new Error('Compression failure'))],
    ...[undefined, 0, 1, 'invalid', 1.5].map(version => [
        `version ${version}`, context => context.fetch.mockResolvedValue({ ok: true, json: async () => ({ version }) }),
    ]),
    ['invalid JSON', context => context.fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })],
    ['409', context => context.fetch.mockResolvedValue({ status: 409, json: async () => ({ version: 5 }) })],
    ['existing conflict', context => { context.settingsConflictReloadRequired = true; }],
    ['not ready', context => { context.settingsReady = false; }],
    ['temporary length', context => context.TempResponseLength.isCustomized.mockReturnValue(true)],
];

// A settings sync that never skips a save, so that every save in these tests reaches fetch.
const sendEverySave = () => ({ getFingerprint: json => json, remember() {}, isSynced: () => false });

function createHarness({ profile = normalizeCustomEndpointPreset({ name: 'Saved endpoint', secretId: 'saved-id' }), input = '', writeResult = 'replacement-id', settingsSync = sendEverySave() } = {}) {
    const values = new Map([['#api_key_custom', input], ['#custom_endpoint_preset_name', profile.name], ['#custom_endpoint_preset', profile.name]]);
    const attributes = new Map();
    const secretState = { [keys.CUSTOM]: [{ id: 'unrelated-active-id', active: true }] };
    let persistedSettings;
    const clickHandlers = new Map();
    // The Additional Parameters dialog exists only while it is open, so its fields are kept apart from the page's `$` selectors.
    const popupValues = new Map();
    const popupHandlers = new Map();
    const popupFields = new Map();
    const popupTemplate = {
        find(selector) {
            if (!popupFields.has(selector)) {
                popupFields.set(selector, {
                    val(...args) {
                        if (args.length === 0) return popupValues.get(selector) ?? '';
                        popupValues.set(selector, args[0] ?? '');
                        return this;
                    },
                    on(event, handler) {
                        popupHandlers.set(`${selector}:${event}`, handler);
                        return this;
                    },
                    toggle() {
                        return this;
                    },
                });
            }
            return popupFields.get(selector);
        },
    };
    let closePopup;
    let popupOpen = false;
    const context = {
        ...Object.fromEntries([
            'firstRun', 'currentVersion', 'name1', 'active_character', 'active_group', 'user_avatar',
            'amount_gen', 'max_context', 'main_api', 'textgen_settings', 'swipes', 'horde_settings',
            'power_user', 'extension_settings', 'tags', 'tag_map', 'nai_settings', 'kai_settings',
            'background_settings', 'proxies', 'selected_proxy',
        ].map(name => [name, null])),
        settingsSaveQueue: Promise.resolve(),
        settingsReady: true,
        settingsConflictReloadRequired: false,
        settingsConflictPromptDismissed: false,
        settingsSync,
        lastServerSettingsVersion: 1,
        settings: {},
        accountStorage: { getState: () => ({}) },
        getWorldInfoSettings: () => ({}),
        getRequestHeaders: () => ({}),
        TempResponseLength: { isCustomized: jest.fn(() => false), restore: jest.fn() },
        promptSettingsConflictReload: jest.fn(async () => {}),
        compressRequest: jest.fn(async request => request),
        fetch: jest.fn(async (_, request) => {
            persistedSettings = JSON.parse(request.body);
            return { ok: true, json: async () => ({ version: persistedSettings._version + 1 }) };
        }),
        eventSource: { emit: jest.fn(async () => {}) },
        event_types: { SETTINGS_UPDATED: 'settings_updated' },
        chat_completion_sources: sources,
        SECRET_KEYS: keys,
        oai_settings: { chat_completion_source: sources.CUSTOM },
        selected_custom_endpoint_preset: profile,
        custom_endpoint_presets: [profile],
        normalizeCustomEndpointPreset,
        buildCustomEndpointPresetForSave,
        pickCustomEndpointParameters,
        CUSTOM_ENDPOINT_PARAMETER_KEYS,
        fillMissingCustomEndpointParameters,
        secret_state: secretState,
        console: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        t: strings => strings.join(''),
        toastr: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
        refreshModelIdSearchControlsForSource: jest.fn(),
        reconnectOpenAi: jest.fn(),
        updateCustomEndpointPresetOption: jest.fn(),
        appendCustomEndpointPresetOption: jest.fn(),
        getCustomEndpointPresetOption: () => ({ remove() {} }),
        rotateSecret: jest.fn(async () => {}),
        renderTemplateAsync: async () => popupTemplate,
        callGenericPopup: () => new Promise(resolve => { closePopup = resolve; }),
        POPUP_TYPE: { TEXT: 1 },
        customEndpointParametersOptions: () => ({}),
        custom_reasoning_param_formats: { OPENAI: 'openai', STRING: 'string', THINKING_OBJECT: 'thinking_object' },
        custom_reasoning_preset_types: { CUSTOM: 'custom' },
        setCustomReasoningPreset: jest.fn(),
        // A selector reaches a dialog field while the dialog is in the page, as `document` lookups do.
        $: selector => typeof selector === 'object' ? selector : popupOpen && popupFields.has(selector) ? popupFields.get(selector) : ({
            find() {
                return this;
            },
            empty() {
                return this;
            },
            on(event, handler) {
                clickHandlers.set(selector, handler);
            },
            val(value) {
                if (value === undefined) return values.get(selector) ?? '';
                values.set(selector, value);
                return this;
            },
            attr(name, value) {
                attributes.set(`${selector}:${name}`, value);
                return this;
            },
            removeAttr(name) {
                attributes.delete(`${selector}:${name}`);
                return this;
            },
        }),
        writeSecret: jest.fn(async () => {
            if (writeResult) {
                values.set('#api_key_custom', '');
                secretState[keys.CUSTOM] = [{ id: writeResult, active: true }];
            }
            return writeResult;
        }),
        startStatusLoading: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        isTemporaryChat: () => false,
        getStatusOpen: jest.fn(async () => context.selected_custom_endpoint_preset?.secretId),
    };
    runInNewContext(`${pollinationsEndpointSource}\n${saverSource}\n${keyInputSource}\n${connectSource}\n${activateSource}\n${setPresetSource}\n${changeSource}\n${loadSource}\n${slashCommandSource}\n${saveSource}\n${deleteSource}\n${syncSource}\n${popupSource}`, context);
    return {
        context,
        profile,
        values,
        attributes,
        // Opens the dialog and returns its fields. Typing runs the field's `input` handler on the text that the field holds.
        openPopup: async () => {
            popupOpen = true;
            const opened = context.onCustomizeParametersClick();
            await new Promise(resolve => setImmediate(resolve));
            const popup = {
                text: parameterKey => popupValues.get(`#${parameterKey}`),
                type: (parameterKey, text) => {
                    popupValues.set(`#${parameterKey}`, text);
                    popupHandlers.get(`#${parameterKey}:input`).call(popupFields.get(`#${parameterKey}`));
                },
                close: async () => {
                    closePopup();
                    await opened;
                    popupOpen = false;
                },
            };
            popup.append = (parameterKey, text) => popup.type(parameterKey, `${popup.text(parameterKey)}${text}`);
            return popup;
        },
        connect: () => context.onConnectButtonClick({ stopPropagation() {} }),
        save: () => clickHandlers.get('#save_custom_endpoint')(),
        remove: () => clickHandlers.get('#delete_custom_endpoint')(),
        reload: () => createHarness({ profile: persistedSettings.selected_custom_endpoint_preset }),
        persisted: () => persistedSettings,
    };
}

describe('Custom endpoint profile credentials on Connect', () => {
    test('does not reselect A when B is selected during the settings response', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        const other = normalizeCustomEndpointPreset({ name: 'B', model: 'model-b', secretId: 'b-id' });
        harness.context.custom_endpoint_presets.push(other);
        let finishSave;
        const fetch = harness.context.fetch.getMockImplementation();
        harness.context.fetch.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(fetch(...args));
        }));

        const saving = harness.save();
        await new Promise(resolve => setImmediate(resolve));
        harness.values.set('#custom_endpoint_preset', 'B');
        await harness.context.onCustomEndpointPresetChange();
        finishSave();
        await saving;

        expect(harness.context.selected_custom_endpoint_preset).toBe(other);
        expect(harness.context.oai_settings.custom_model).toBe('model-b');
        expect(harness.values.get('#custom_endpoint_preset')).toBe('B');
    });

    test.each(saveFailures)('does not report success or continue replacement Connect on %s', async (_, fail) => {
        for (const action of ['save', 'connect']) {
            const harness = createHarness({ input: 'replacement-test-key' });
            fail(harness.context);
            await harness[action]();

            expect(harness.context.toastr.success).not.toHaveBeenCalled();
            expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
            expect(harness.profile.secretId).toBe('replacement-id');
            expect(harness.values.get('#api_key_custom')).toBe('');
        }
    });

    test.each(['save', 'connect'])('retains the written binding for Save retry after %s settings failure', async action => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.context.fetch.mockRejectedValueOnce(new Error('Network failure'));
        await harness[action]();
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');

        await harness.save();
        expect(harness.context.writeSecret).toHaveBeenCalledTimes(1);
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.reload().profile.secretId).toBe('replacement-id');
        expect(JSON.stringify(harness.persisted())).not.toContain('replacement-test-key');
    });

    test.each(['save', 'connect'])('does not persist a failed secret write and allows %s retry', async action => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.context.writeSecret.mockResolvedValueOnce(null);
        await harness[action]();
        expect(harness.context.fetch).not.toHaveBeenCalled();
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.values.get('#api_key_custom')).toBe('replacement-test-key');

        await harness[action]();
        expect(harness.context.writeSecret).toHaveBeenCalledTimes(2);
        expect(harness.reload().profile.secretId).toBe('replacement-id');
    });

    test('persists the profile binding before reporting a successful Save', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.values.set('#custom_endpoint_preset_name', harness.profile.name);
        harness.values.set('#custom_api_url_text', 'https://endpoint.example/v1');
        harness.values.set('#custom_model_id', 'test-model');
        let finishSave;
        const fetch = harness.context.fetch.getMockImplementation();
        harness.context.fetch.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(fetch(...args));
        }));

        const saving = harness.save();
        await new Promise(resolve => setImmediate(resolve));

        expect(harness.context.fetch).toHaveBeenCalledTimes(1);
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.context.selected_custom_endpoint_preset).toBe(harness.profile);
        expect(harness.values.get('#custom_endpoint_preset')).toBe(harness.profile.name);
        finishSave();
        await saving;
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.persisted().custom_endpoint_presets[0].key).toBe('');
        expect(JSON.stringify(harness.persisted())).not.toContain('replacement-test-key');
        expect(harness.reload().profile.secretId).toBe('replacement-id');
    });

    test('persists a replacement binding before checking the connection', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        let finishSave;
        const fetch = harness.context.fetch.getMockImplementation();
        harness.context.fetch.mockImplementation((...args) => new Promise(resolve => {
            finishSave = () => resolve(fetch(...args));
        }));

        const connecting = harness.connect();
        await new Promise(resolve => setImmediate(resolve));

        expect(harness.context.fetch).toHaveBeenCalledTimes(1);
        expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
        finishSave();
        await connecting;
        expect(harness.context.getStatusOpen).toHaveBeenCalledTimes(1);
    });

    test('replaces the saved credential before connecting and keeps it after reload', async () => {
        const harness = createHarness({ input: ' replacement-test-key ' });

        await harness.connect();

        expect(harness.context.writeSecret).toHaveBeenCalledWith(keys.CUSTOM, 'replacement-test-key');
        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.profile.key).toBe('');
        expect(harness.values.get('#api_key_custom')).toBe('');
        expect(harness.attributes.get('#api_key_custom:placeholder')).toBe('(saved secret)');
        expect(await harness.context.getStatusOpen.mock.results[0].value).toBe('replacement-id');

        const reloaded = harness.reload();
        await reloaded.connect();
        expect(reloaded.context.writeSecret).not.toHaveBeenCalled();
        expect(await reloaded.context.getStatusOpen.mock.results[0].value).toBe('replacement-id');
    });

    test('reuses the profile credential when no replacement was entered', async () => {
        const harness = createHarness();

        await harness.connect();
        await harness.connect();

        expect(harness.context.writeSecret).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(await harness.context.getStatusOpen.mock.results[0].value).toBe('saved-id');
    });

    test('binds a key entered for a legacy profile without a secret id', async () => {
        const harness = createHarness({
            profile: normalizeCustomEndpointPreset({ name: 'Legacy endpoint', key: 'legacy-test-key' }),
            input: 'replacement-test-key',
        });

        await harness.connect();

        expect(harness.profile.secretId).toBe('replacement-id');
        expect(harness.profile.key).toBe('');
    });

    test('leaves the None profile unbound when connecting a manually entered key', async () => {
        const harness = createHarness({
            profile: normalizeCustomEndpointPreset({ name: 'None' }),
            input: 'manual-test-key',
        });

        await harness.connect();

        expect(harness.context.writeSecret).toHaveBeenCalledWith(keys.CUSTOM, 'manual-test-key');
        expect(harness.profile.secretId).toBe('');
    });

    test('does not connect with the old key if saving its replacement fails', async () => {
        const harness = createHarness({ input: 'replacement-test-key', writeResult: null });

        await harness.connect();

        expect(harness.context.writeSecret).toHaveBeenCalledTimes(1);
        expect(harness.context.getStatusOpen).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('saved-id');
        expect(harness.values.get('#api_key_custom')).toBe('replacement-test-key');
    });

    test('binds the key to the original profile if selection changes while it is being saved', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        const otherProfile = { ...harness.profile, name: 'Other endpoint' };
        harness.context.writeSecret.mockImplementation(async () => {
            harness.context.selected_custom_endpoint_preset = otherProfile;
            return 'replacement-id';
        });

        await harness.connect();

        expect(harness.profile.secretId).toBe('replacement-id');
        expect(otherProfile.secretId).toBe('saved-id');
        expect(harness.attributes.has('#api_key_custom:placeholder')).toBe(false);
    });
});

describe('Custom endpoint profile Additional Parameters', () => {
    const storedParameters = {
        custom_include_body: '  top_k: 20\n  min_p: 0.05\n',
        custom_exclude_body: '',
        custom_include_headers: 'X-Title: Story',
    };

    test('Save stores the current Additional Parameters with the profile and keeps them after a reload', async () => {
        const harness = createHarness();
        Object.assign(harness.context.oai_settings, storedParameters);

        await harness.save();

        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
        expect(harness.profile).toMatchObject(storedParameters);
        expect(harness.persisted().custom_endpoint_presets[0]).toMatchObject(storedParameters);

        const reloaded = createHarness();
        await reloaded.context.loadCustomEndpointPresets(harness.persisted());
        expect(reloaded.context.selected_custom_endpoint_preset.name).toBe(harness.profile.name);
        expect(reloaded.context.selected_custom_endpoint_preset).toMatchObject(storedParameters);
    });

    test('Save stores the Additional Parameters with a new profile', async () => {
        const harness = createHarness();
        Object.assign(harness.context.oai_settings, storedParameters);
        harness.values.set('#custom_endpoint_preset_name', 'New endpoint');

        await harness.save();

        const created = harness.context.custom_endpoint_presets.find(preset => preset.name === 'New endpoint');
        expect(created).toMatchObject({ secretId: 'unrelated-active-id', ...storedParameters });
        expect(harness.context.selected_custom_endpoint_preset).toBe(created);
        expect(harness.profile).not.toHaveProperty('custom_include_body');
    });

    test('Delete and /custom-endpoint-profile apply the Additional Parameters of the profile they select', async () => {
        const harness = createHarness();
        const stored = normalizeCustomEndpointPreset({ name: 'Stored', model: 'model-b', secretId: 'b-id', ...storedParameters });
        const doomed = normalizeCustomEndpointPreset({ name: 'Doomed', secretId: 'd-id', custom_include_body: 'doomed: 1', custom_exclude_body: '', custom_include_headers: '' });
        harness.context.custom_endpoint_presets.push(stored, doomed);

        harness.values.set('#custom_endpoint_preset_name', 'Doomed');
        await harness.remove();
        expect(harness.context.custom_endpoint_presets).not.toContain(doomed);
        expect(harness.context.selected_custom_endpoint_preset).toBe(stored);
        expect(harness.context.oai_settings).toMatchObject(storedParameters);

        Object.assign(harness.context.oai_settings, { custom_include_body: 'changed: 1' });
        expect(await harness.context.runCustomEndpointPresetCallback(null, 'Stored')).toBe('Stored');
        expect(harness.context.oai_settings).toMatchObject(storedParameters);
    });

    test.each([
        ['the profile after None', harness => harness.context.custom_endpoint_presets.unshift(normalizeCustomEndpointPreset({ name: 'None' }))],
        ['the only profile', () => {}],
    ])('Delete of %s falls back to None, which clears the Additional Parameters in effect', async (_, arrange) => {
        const harness = createHarness();
        arrange(harness);
        Object.assign(harness.profile, storedParameters);
        Object.assign(harness.context.oai_settings, storedParameters);

        await harness.remove();

        expect(harness.context.custom_endpoint_presets).not.toContain(harness.profile);
        expect(harness.context.selected_custom_endpoint_preset.name).toBe('None');
        expect(harness.context.oai_settings).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
    });

    test('selecting a profile applies its Additional Parameters, a profile without them keeps the current ones, and None clears them', async () => {
        const harness = createHarness();
        const stored = normalizeCustomEndpointPreset({ name: 'Stored', model: 'model-b', secretId: 'b-id', ...storedParameters });
        const legacy = normalizeCustomEndpointPreset({ name: 'Legacy', model: 'model-c', secretId: 'c-id' });
        harness.context.custom_endpoint_presets.push(normalizeCustomEndpointPreset({ name: 'None' }), stored, legacy);
        Object.assign(harness.context.oai_settings, { custom_include_body: 'current: 1', custom_exclude_body: '- seed', custom_include_headers: '' });

        harness.values.set('#custom_endpoint_preset', 'Stored');
        await harness.context.onCustomEndpointPresetChange();
        expect(harness.context.oai_settings).toMatchObject(storedParameters);

        harness.values.set('#custom_endpoint_preset', 'Legacy');
        await harness.context.onCustomEndpointPresetChange();
        expect(harness.context.oai_settings.custom_model).toBe('model-c');
        expect(harness.context.oai_settings).toMatchObject(storedParameters);
        expect(legacy).not.toHaveProperty('custom_include_body');

        harness.values.set('#custom_endpoint_preset', 'None');
        await harness.context.onCustomEndpointPresetChange();
        expect(harness.context.oai_settings).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
    });

    test('loading the settings keeps the Additional Parameters that were in effect', async () => {
        const harness = createHarness();
        Object.assign(harness.context.oai_settings, { custom_include_body: 'set-by-connection-profile: 1' });

        await harness.context.loadCustomEndpointPresets({
            custom_endpoint_presets: [
                { name: 'None' },
                { name: 'Saved endpoint', url: 'https://endpoint.example/v1', model: 'test-model', secretId: 'saved-id', ...storedParameters },
            ],
            selected_custom_endpoint_preset: { name: 'Saved endpoint' },
        });

        expect(harness.context.oai_settings.custom_url).toBe('https://endpoint.example/v1');
        expect(harness.context.oai_settings.custom_include_body).toBe('set-by-connection-profile: 1');
        expect(harness.context.selected_custom_endpoint_preset).toMatchObject(storedParameters);
        expect(harness.context.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    describe('editing in the Additional Parameters dialog', () => {
        const other = () => normalizeCustomEndpointPreset({ name: 'Other', model: 'model-b', secretId: 'b-id', custom_include_body: 'other: 1', custom_exclude_body: '', custom_include_headers: 'X-Other: 1' });

        test('an edit is stored with the selected profile, comes back when the profile is selected again, and is in the saved settings', async () => {
            const harness = createHarness();
            const otherProfile = other();
            harness.context.custom_endpoint_presets.push(otherProfile);
            Object.assign(harness.profile, storedParameters);
            Object.assign(harness.context.oai_settings, storedParameters);

            const popup = await harness.openPopup();
            expect(popup.text('custom_include_body')).toBe(storedParameters.custom_include_body);
            popup.type('custom_include_body', 'edited_in_popup: 1');

            expect(harness.context.oai_settings.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.profile.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.profile).toMatchObject({ custom_exclude_body: storedParameters.custom_exclude_body, custom_include_headers: storedParameters.custom_include_headers });
            expect(harness.context.saveSettingsDebounced).toHaveBeenCalled();
            await popup.close();

            harness.values.set('#custom_endpoint_preset', 'Other');
            await harness.context.onCustomEndpointPresetChange();
            expect(harness.context.oai_settings.custom_include_body).toBe('other: 1');

            harness.values.set('#custom_endpoint_preset', harness.profile.name);
            await harness.context.onCustomEndpointPresetChange();
            expect(harness.context.oai_settings).toMatchObject({ ...storedParameters, custom_include_body: 'edited_in_popup: 1' });

            await harness.context.saveSettings(0, { returnResult: true });
            const saved = harness.persisted().custom_endpoint_presets.find(preset => preset.name === harness.profile.name);
            expect(saved.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.persisted().selected_custom_endpoint_preset.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.persisted().custom_endpoint_presets.find(preset => preset.name === 'Other').custom_include_body).toBe('other: 1');
        });

        test('each of the three fields is stored with the selected profile, including an empty value', async () => {
            const harness = createHarness();
            Object.assign(harness.profile, storedParameters);
            Object.assign(harness.context.oai_settings, storedParameters);

            const popup = await harness.openPopup();
            popup.type('custom_exclude_body', '- seed');
            popup.type('custom_include_headers', '');

            expect(harness.profile).toMatchObject({ custom_exclude_body: '- seed', custom_include_headers: '' });
            expect(harness.context.oai_settings).toMatchObject({ custom_exclude_body: '- seed', custom_include_headers: '' });
        });

        test('an edit stores only the field that changed with a profile that stores none', async () => {
            const harness = createHarness();
            Object.assign(harness.context.oai_settings, storedParameters);

            const popup = await harness.openPopup();
            popup.type('custom_include_body', 'edited_in_popup: 1');

            expect(harness.profile.custom_include_body).toBe('edited_in_popup: 1');
            expect(harness.profile).not.toHaveProperty('custom_exclude_body');
            expect(harness.profile).not.toHaveProperty('custom_include_headers');
        });

        test.each([
            ['the dropdown', harness => {
                harness.values.set('#custom_endpoint_preset', 'Other');
                return harness.context.onCustomEndpointPresetChange();
            }],
            ['/custom-endpoint-profile', harness => harness.context.runCustomEndpointPresetCallback(null, 'Other')],
            ['a connection profile that names its secret', harness => harness.context.syncCustomEndpointPresetSelectionBySecretId('b-id')],
        ])('a selection by %s while the dialog is open does not let the text of the previous profile reach the new one', async (_, select) => {
            const harness = createHarness();
            const otherProfile = other();
            harness.context.custom_endpoint_presets.push(otherProfile);
            Object.assign(harness.profile, { custom_include_body: 'a: 1', custom_exclude_body: '', custom_include_headers: 'Authorization: Bearer KEY-A' });
            Object.assign(harness.context.oai_settings, pickCustomEndpointParameters(harness.profile));
            const popup = await harness.openPopup();

            await select(harness);
            popup.append('custom_include_headers', '\n');

            const live = harness.context.oai_settings;
            expect(harness.context.selected_custom_endpoint_preset).toBe(otherProfile);
            expect(JSON.stringify([live, otherProfile])).not.toContain('KEY-A');
            expect(harness.profile.custom_include_headers).toBe('Authorization: Bearer KEY-A');
            for (const parameterKey of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) {
                expect(popup.text(parameterKey)).toBe(live[parameterKey]);
                expect(otherProfile[parameterKey]).toBe(live[parameterKey]);
            }
        });

        test('an edit after the dialog caught up with a new selection is stored with that profile', async () => {
            const harness = createHarness();
            const otherProfile = other();
            harness.context.custom_endpoint_presets.push(otherProfile);
            Object.assign(harness.context.oai_settings, pickCustomEndpointParameters(harness.profile));
            const popup = await harness.openPopup();
            harness.context.syncCustomEndpointPresetSelectionBySecretId('b-id');
            popup.append('custom_include_body', ' ');
            expect(otherProfile.custom_include_body).toBe('other: 1');

            popup.append('custom_include_body', '# kept');

            expect(otherProfile.custom_include_body).toBe('other: 1# kept');
            expect(harness.context.oai_settings.custom_include_body).toBe('other: 1# kept');
        });

        test('with None selected the live settings are the only store', async () => {
            const harness = createHarness({ profile: normalizeCustomEndpointPreset({ name: 'None' }) });
            const popup = await harness.openPopup();

            popup.type('custom_include_headers', 'X-Typed: 1');

            expect(harness.context.oai_settings.custom_include_headers).toBe('X-Typed: 1');
            expect(harness.profile).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
            await harness.context.saveSettings(0, { returnResult: true });
            expect(harness.persisted().custom_endpoint_presets[0]).toMatchObject({ name: 'None', custom_include_headers: '' });
        });
    });

    describe('applying a connection profile that selects an endpoint profile by its secret', () => {
        const parametersA = { custom_include_body: 'a: 1', custom_exclude_body: '', custom_include_headers: 'Authorization: Bearer KEY-A' };
        const parametersB = { custom_include_body: 'b: 1', custom_exclude_body: '- seed', custom_include_headers: 'Authorization: Bearer KEY-B' };

        // The secret, the endpoint profile by name, then the parameters the connection profile records itself, which is the order of its commands.
        const applyConnectionProfile = async (harness, { secretId, endpointProfile, parameters = {} }) => {
            harness.context.syncCustomEndpointPresetSelectionBySecretId(secretId);
            if (endpointProfile) await harness.context.runCustomEndpointPresetCallback(null, endpointProfile);
            Object.assign(harness.context.oai_settings, parameters);
        };

        const createProviders = ({ providerB = parametersB } = {}) => {
            const harness = createHarness({ profile: normalizeCustomEndpointPreset({ name: 'Provider A', url: 'http://a.example/v1', model: 'model-a', secretId: 'secret-a', ...parametersA }) });
            const none = normalizeCustomEndpointPreset({ name: 'None' });
            const b = normalizeCustomEndpointPreset({ name: 'Provider B', url: 'http://b.example/v1', model: 'model-b', secretId: 'secret-b', ...providerB });
            harness.context.custom_endpoint_presets.unshift(none);
            harness.context.custom_endpoint_presets.push(b);
            Object.assign(harness.context.oai_settings, parametersA);
            return { harness, none, b };
        };

        test.each([
            ['has no endpoint profile name', undefined],
            ['names an endpoint profile that was deleted', 'Deleted Profile'],
        ])('a connection profile that %s brings the parameters of the profile that its secret selects', async (_, endpointProfile) => {
            const { harness, b } = createProviders();

            await applyConnectionProfile(harness, { secretId: 'secret-b', endpointProfile });

            expect(harness.context.selected_custom_endpoint_preset).toBe(b);
            expect(harness.context.oai_settings).toMatchObject(parametersB);
            expect(harness.context.oai_settings.custom_include_headers).not.toContain('KEY-A');
        });

        test('the parameters that the connection profile records itself win over the ones the secret selects', async () => {
            const { harness } = createProviders();

            await applyConnectionProfile(harness, { secretId: 'secret-b', parameters: { custom_include_body: 'own: 1' } });

            expect(harness.context.oai_settings).toMatchObject({ ...parametersB, custom_include_body: 'own: 1' });
        });

        test('a selected profile that stores none leaves the current parameters', async () => {
            const { harness, b } = createProviders({ providerB: {} });

            await applyConnectionProfile(harness, { secretId: 'secret-b' });

            expect(harness.context.selected_custom_endpoint_preset).toBe(b);
            expect(harness.context.oai_settings).toMatchObject(parametersA);
        });

        test('a secret that no endpoint profile holds selects None, which clears the parameters', async () => {
            const { harness, none } = createProviders();

            await applyConnectionProfile(harness, { secretId: 'secret-unknown' });

            expect(harness.context.selected_custom_endpoint_preset).toBe(none);
            expect(harness.context.oai_settings).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
        });

        test('a secret of the profile that is already selected keeps the parameters in effect', async () => {
            const { harness } = createProviders();
            harness.context.oai_settings.custom_include_body = 'set-by-an-earlier-connection-profile: 1';

            await applyConnectionProfile(harness, { secretId: 'secret-a' });

            expect(harness.context.selected_custom_endpoint_preset).toBe(harness.profile);
            expect(harness.context.oai_settings.custom_include_body).toBe('set-by-an-earlier-connection-profile: 1');
        });

        test('no secret changes nothing', async () => {
            const { harness } = createProviders();

            await applyConnectionProfile(harness, { secretId: '' });

            expect(harness.context.selected_custom_endpoint_preset).toBe(harness.profile);
            expect(harness.context.oai_settings).toMatchObject(parametersA);
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
            const harness = createHarness();
            Object.assign(harness.context.oai_settings, liveParameters);

            await harness.context.loadCustomEndpointPresets({ custom_endpoint_presets: savedProfiles(), selected_custom_endpoint_preset: { name: 'Provider A' } });

            const [none, providerA, providerB] = harness.context.custom_endpoint_presets;
            expect(harness.context.selected_custom_endpoint_preset).toBe(providerA);
            expect(providerA).toMatchObject(liveParameters);
            for (const parameterKey of noParameters) {
                expect(providerB).not.toHaveProperty(parameterKey);
            }
            expect(none).toMatchObject({ custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
            expect(harness.context.oai_settings).toMatchObject(liveParameters);
            expect(harness.context.saveSettingsDebounced).toHaveBeenCalledTimes(1);

            await harness.context.saveSettings(0, { returnResult: true });
            const savedB = harness.persisted().custom_endpoint_presets.find(preset => preset.name === 'Provider B');
            expect(Object.keys(savedB).sort()).toEqual(['key', 'model', 'name', 'secretId', 'url']);
            expect(harness.persisted().selected_custom_endpoint_preset).toMatchObject(liveParameters);
            expect(JSON.stringify(savedB)).not.toContain('LIVE-A');
        });

        test('keeps the live header when a profile that stores none is selected afterwards', async () => {
            const harness = createHarness();
            Object.assign(harness.context.oai_settings, liveParameters);
            await harness.context.loadCustomEndpointPresets({ custom_endpoint_presets: savedProfiles(), selected_custom_endpoint_preset: { name: 'Provider A' } });
            const providerB = harness.context.custom_endpoint_presets.find(preset => preset.name === 'Provider B');

            harness.values.set('#custom_endpoint_preset', 'Provider B');
            await harness.context.onCustomEndpointPresetChange();

            expect(harness.context.selected_custom_endpoint_preset).toBe(providerB);
            expect(harness.context.oai_settings.custom_url).toBe('https://b.example/v1');
            expect(harness.context.oai_settings).toMatchObject(liveParameters);
            for (const parameterKey of noParameters) {
                expect(providerB).not.toHaveProperty(parameterKey);
            }
        });

        test('changes nothing when None is selected', async () => {
            const harness = createHarness();
            Object.assign(harness.context.oai_settings, liveParameters);

            await harness.context.loadCustomEndpointPresets({ custom_endpoint_presets: savedProfiles(), selected_custom_endpoint_preset: { name: 'None' } });

            for (const profile of harness.context.custom_endpoint_presets.filter(preset => preset.name !== 'None')) {
                for (const parameterKey of noParameters) {
                    expect(profile).not.toHaveProperty(parameterKey);
                }
            }
            expect(harness.context.oai_settings).toMatchObject(liveParameters);
            expect(harness.context.saveSettingsDebounced).not.toHaveBeenCalled();
        });
    });
});

describe('Queued settings save acknowledgement', () => {
    test.each([false, true])('preserves the default result and optionally confirms success: %s', async returnResult => {
        const { context } = createHarness();
        expect(await context.saveSettings(0, { returnResult })).toBe(returnResult ? true : undefined);
        expect(context.lastServerSettingsVersion).toBe(2);
        expect(context.settings._version).toBe(2);
        expect(context.eventSource.emit).toHaveBeenCalledWith('settings_updated');
        expect(await context.saveSettings()).toBeUndefined();
    });

    test.each(saveFailures)('returns false only when opted in on %s', async (_, fail) => {
        for (const returnResult of [false, true]) {
            const { context } = createHarness();
            fail(context);
            expect(await context.saveSettings(0, { returnResult })).toBe(returnResult ? false : undefined);
            expect(context.eventSource.emit).not.toHaveBeenCalled();
        }
    });

    test('waits for the completed settings update before confirming success', async () => {
        const { context } = createHarness();
        let finishUpdate;
        context.eventSource.emit.mockImplementation(() => new Promise(resolve => { finishUpdate = resolve; }));
        const completed = jest.fn();
        const saving = context.saveSettings(0, { returnResult: true }).then(completed);
        await new Promise(resolve => setImmediate(resolve));
        expect(completed).not.toHaveBeenCalled();
        finishUpdate();
        await saving;
        expect(completed).toHaveBeenCalledWith(true);
    });

    test('does not confirm success when the settings update event fails', async () => {
        const { context } = createHarness();
        context.eventSource.emit.mockRejectedValueOnce(new Error('Update failed'));
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
    });

    test('keeps the queue usable after a failed attempt and advances subsequent request versions', async () => {
        const { context } = createHarness();
        let failSave;
        context.fetch.mockImplementationOnce(() => new Promise((_, reject) => { failSave = reject; }));
        const first = context.saveSettings(0, { returnResult: true });
        const second = context.saveSettings(0, { returnResult: true });
        const third = context.saveSettings(0, { returnResult: true });
        await new Promise(resolve => setImmediate(resolve));
        expect(context.fetch).toHaveBeenCalledTimes(1);
        failSave(new Error('Network failure'));
        expect(await Promise.all([first, second, third])).toEqual([false, true, true]);
        expect(context.fetch.mock.calls.map(([, request]) => JSON.parse(request.body)._version)).toEqual([1, 1, 2]);
        expect(context.lastServerSettingsVersion).toBe(3);
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
    });

    test('accepts a save without a change, which keeps the version that the page sent', async () => {
        const { context } = createHarness();
        context.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version: 1, unchanged: true }) });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
        expect(context.lastServerSettingsVersion).toBe(1);
        expect(context.eventSource.emit).toHaveBeenCalledWith('settings_updated');
    });

    test('takes the newer stored version from a save without a change', async () => {
        const { context } = createHarness();
        context.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version: 4, unchanged: true }) });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
        expect(context.lastServerSettingsVersion).toBe(4);
    });

    test('refuses an older version from a save without a change', async () => {
        const { context } = createHarness();
        context.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version: 0, unchanged: true }) });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.eventSource.emit).not.toHaveBeenCalled();
    });

    test('sends no request when nothing changed since the last save, and still reports a saved update', async () => {
        const { context } = createHarness({ settingsSync: createSettingsSync() });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.eventSource.emit).toHaveBeenCalledTimes(2);
        expect(context.lastServerSettingsVersion).toBe(2);
    });

    test('sends a save after each change, and none for a repeat of the last saved settings', async () => {
        const { context } = createHarness({ settingsSync: createSettingsSync() });
        await context.saveSettings();
        context.name1 = 'Another User';
        await context.saveSettings();
        expect(context.fetch).toHaveBeenCalledTimes(2);
        context.name1 = null;
        await context.saveSettings();
        expect(context.fetch).toHaveBeenCalledTimes(3);
        context.name1 = null;
        await context.saveSettings();
        expect(context.fetch).toHaveBeenCalledTimes(3);
    });

    test('remembers no settings from a failed save', async () => {
        const { context } = createHarness({ settingsSync: createSettingsSync() });
        context.fetch.mockRejectedValueOnce(new Error('Network failure'));
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
        expect(context.fetch).toHaveBeenCalledTimes(2);
    });

    test('remembers no settings from a refused save', async () => {
        const sync = createSettingsSync();
        const { context } = createHarness({ settingsSync: sync });
        context.fetch.mockResolvedValueOnce({ status: 409, json: async () => ({ version: 5 }) });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(sync.isSynced(sync.getFingerprint(JSON.stringify(JSON.parse(context.fetch.mock.calls[0][1].body))))).toBe(false);
    });

    test('preserves conflict state and blocks subsequent writes with the existing prompt', async () => {
        const { context } = createHarness();
        context.fetch.mockResolvedValueOnce({ status: 409, json: async () => ({ version: 5 }) });
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.lastServerSettingsVersion).toBe(5);
        expect(context.settingsConflictReloadRequired).toBe(true);
        expect(context.settingsConflictPromptDismissed).toBe(false);
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.promptSettingsConflictReload).toHaveBeenCalledTimes(2);
        expect(context.toastr.error).not.toHaveBeenCalled();
    });

    test('defers until ready without waiting for its scheduled retry', async () => {
        const { context } = createHarness();
        context.settingsReady = false;
        expect(await context.saveSettings(0, { returnResult: true })).toBe(false);
        expect(context.saveSettingsDebounced).toHaveBeenCalledWith();
        expect(context.fetch).not.toHaveBeenCalled();
        context.settingsReady = true;
        expect(await context.saveSettings(0, { returnResult: true })).toBe(true);
    });

    test('preserves temporary-length retry counters and restores at the retry limit', async () => {
        const { context } = createHarness();
        context.TempResponseLength.isCustomized.mockReturnValue(true);
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(await context.saveSettings(attempt, { returnResult: true })).toBe(false);
            expect(context.saveSettingsDebounced).toHaveBeenLastCalledWith(attempt + 1);
        }
        expect(context.fetch).not.toHaveBeenCalled();
        expect(context.TempResponseLength.restore).not.toHaveBeenCalled();
        expect(await context.saveSettings(3, { returnResult: true })).toBe(true);
        expect(context.TempResponseLength.restore).toHaveBeenCalledWith(null);
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(3);
    });
});
