import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildCustomEndpointPresetForSave, normalizeCustomEndpointPreset } from '../public/scripts/openai-preset-utils.js';

const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const connectSource = source.match(/async function onConnectButtonClick\(e\) \{[\s\S]*?\n\}/)[0];
const keyInputSource = source.match(/function updateCustomEndpointKeyInput\(preset, key\) \{[\s\S]*?\n\}/)[0];
const activateSource = source.match(/async function activateCustomEndpointPresetSecret\([\s\S]*?\n\}/)[0];
const setPresetSource = source.match(/async function setCustomEndpointPreset\([\s\S]*?\n\}/)[0];
const saveSource = source.match(/\$\('#save_custom_endpoint'\)\.on\('click', async function \(\) \{[\s\S]*?\n\}\);/)[0];
const sources = Object.fromEntries([...source.matchAll(/chat_completion_sources\.([A-Z0-9_]+)/g)].map(([, name]) => [name, name.toLowerCase()]));
const keys = Object.fromEntries(Object.keys(sources).map(name => [name, `api_key_${name.toLowerCase()}`]));

function createHarness({ profile = normalizeCustomEndpointPreset({ name: 'Saved endpoint', secretId: 'saved-id' }), input = '', writeResult = 'replacement-id' } = {}) {
    const values = new Map([['#api_key_custom', input]]);
    const attributes = new Map();
    const secretState = { [keys.CUSTOM]: [{ id: 'unrelated-active-id', active: true }] };
    let persistedProfile;
    let saveHandler;
    const persist = () => {
        persistedProfile = JSON.stringify(normalizeCustomEndpointPreset(context.selected_custom_endpoint_preset));
    };
    const context = {
        chat_completion_sources: sources,
        SECRET_KEYS: keys,
        oai_settings: { chat_completion_source: sources.CUSTOM },
        selected_custom_endpoint_preset: profile,
        custom_endpoint_presets: [profile],
        normalizeCustomEndpointPreset,
        buildCustomEndpointPresetForSave,
        secret_state: secretState,
        console,
        t: strings => strings.join(''),
        toastr: { success: jest.fn(), error: jest.fn() },
        refreshModelIdSearchControlsForSource: jest.fn(),
        reconnectOpenAi: jest.fn(),
        updateCustomEndpointPresetOption: jest.fn(),
        $: selector => ({
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
        saveSettings: jest.fn(async () => persist()),
        saveSettingsDebounced: jest.fn(persist),
        getStatusOpen: jest.fn(async () => context.selected_custom_endpoint_preset?.secretId),
    };
    const connect = runInNewContext(`${keyInputSource}\n${connectSource}\nonConnectButtonClick`, context);
    runInNewContext(`${activateSource}\n${setPresetSource}\n${saveSource}`, context);
    return {
        context,
        profile,
        values,
        attributes,
        connect: () => connect({ stopPropagation() {} }),
        save: () => saveHandler(),
        reload: () => createHarness({ profile: JSON.parse(persistedProfile) }),
    };
}

describe('Custom endpoint profile credentials on Connect', () => {
    test('persists the profile binding before reporting a successful Save', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        harness.values.set('#custom_endpoint_preset_name', harness.profile.name);
        harness.values.set('#custom_api_url_text', 'https://endpoint.example/v1');
        harness.values.set('#custom_model_id', 'test-model');
        let finishSave;
        harness.context.saveSettings.mockImplementation(() => new Promise(resolve => {
            finishSave = resolve;
        }));

        const saving = harness.save();
        await new Promise(resolve => setImmediate(resolve));

        expect(harness.context.saveSettings).toHaveBeenCalledTimes(1);
        expect(harness.context.toastr.success).not.toHaveBeenCalled();
        expect(harness.profile.secretId).toBe('replacement-id');
        finishSave();
        await saving;
        expect(harness.context.toastr.success).toHaveBeenCalledTimes(1);
    });

    test('persists a replacement binding before checking the connection', async () => {
        const harness = createHarness({ input: 'replacement-test-key' });
        let finishSave;
        harness.context.saveSettings.mockImplementation(() => new Promise(resolve => {
            finishSave = resolve;
        }));

        const connecting = harness.connect();
        await new Promise(resolve => setImmediate(resolve));

        expect(harness.context.saveSettings).toHaveBeenCalledTimes(1);
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
