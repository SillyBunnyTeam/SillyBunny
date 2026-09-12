/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildCustomEndpointPresetForSave, normalizeCustomEndpointPreset } from '../public/scripts/openai-preset-utils.js';

const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pollinationsEndpointSource = source.match(/export const POLLINATIONS_ENDPOINT = \{[\s\S]*?\n\};/)[0].replace('export ', '');
const connectSource = source.match(/async function onConnectButtonClick\(e\) \{[\s\S]*?\n\}/)[0];
const keyInputSource = source.match(/function updateCustomEndpointKeyInput\(preset, key\) \{[\s\S]*?\n\}/)[0];
const activateSource = source.match(/async function activateCustomEndpointPresetSecret\([\s\S]*?\n\}/)[0];
const setPresetSource = source.match(/async function setCustomEndpointPreset\([\s\S]*?\n\}/)[0];
const saveSource = source.match(/\$\('#save_custom_endpoint'\)\.on\('click', async function \(\) \{[\s\S]*?\n\}\);/)[0];
const changeSource = source.match(/async function onCustomEndpointPresetChange\([\s\S]*?\n\}/)[0];
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

function createHarness({ profile = normalizeCustomEndpointPreset({ name: 'Saved endpoint', secretId: 'saved-id' }), input = '', writeResult = 'replacement-id' } = {}) {
    const values = new Map([['#api_key_custom', input], ['#custom_endpoint_preset_name', profile.name], ['#custom_endpoint_preset', profile.name]]);
    const attributes = new Map();
    const secretState = { [keys.CUSTOM]: [{ id: 'unrelated-active-id', active: true }] };
    let persistedSettings;
    let saveHandler;
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
        secret_state: secretState,
        console: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        t: strings => strings.join(''),
        toastr: { success: jest.fn(), error: jest.fn() },
        refreshModelIdSearchControlsForSource: jest.fn(),
        reconnectOpenAi: jest.fn(),
        updateCustomEndpointPresetOption: jest.fn(),
        appendCustomEndpointPresetOption: jest.fn(),
        rotateSecret: jest.fn(async () => {}),
        $: selector => ({
            find() {
                return this;
            },
            on(event, handler) {
                saveHandler = handler;
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
        getStatusOpen: jest.fn(async () => context.selected_custom_endpoint_preset?.secretId),
    };
    runInNewContext(`${pollinationsEndpointSource}\n${saverSource}\n${keyInputSource}\n${connectSource}\n${activateSource}\n${setPresetSource}\n${changeSource}\n${saveSource}`, context);
    return {
        context,
        profile,
        values,
        attributes,
        connect: () => context.onConnectButtonClick({ stopPropagation() {} }),
        save: () => saveHandler(),
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
