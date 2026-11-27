/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

import { importConnectionManagerModule } from './util/connection-manager-harness.js';
import { importOpenAiModule } from './util/openai-harness.js';

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));
// Capture the real OpenAI and shared.js modules before connection-manager tests mock them.
const { openai: realOpenAi } = await importOpenAiModule();

jest.resetModules();
await jest.unstable_mockModule(pub('script.js'), () => ({
    CONNECT_API_MAP: {},
    createModelIcon: jest.fn(),
    getRequestHeaders: jest.fn(() => ({})),
    substituteParams: v => v,
}));
await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
    extension_settings: {},
    openThirdPartyExtensionMenu: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: s => s.join('') }));
await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
    chat_completion_sources: { CUSTOM: 'custom' },
    custom_endpoint_presets: [],
    oai_settings: {},
    proxies: [],
    ZAI_ENDPOINT: {},
    POLLINATIONS_ENDPOINT: {},
}));
await jest.unstable_mockModule(pub('scripts/preset-manager.js'), () => ({ getPresetManager: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({ SECRET_KEYS: {}, secret_state: {} }));
await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
await jest.unstable_mockModule(pub('scripts/tokenizers.js'), () => ({ getTokenCountAsync: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
    createThumbnail: jest.fn(),
    isTrueBoolean: v => v === true || v === 'true',
    isValidUrl: () => true,
}));
const realShared = await import('../public/scripts/extensions/shared.js');

async function settle() {
    await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('connection manager profile save behaviour', () => {
    test('cancels debounced settings saves while applying profile commands and even on command error', async () => {
        const events = [];
        const profile = {
            id: 'p1',
            name: 'Custom Profile',
            mode: 'cc',
            api: 'openai',
            preset: 'Default',
            model: 'gpt-4o',
            exclude: [],
        };
        const { mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: {
                    selectedProfile: '',
                    profiles: [profile],
                    folders: [],
                    favorites: [],
                },
            },
            commands: {
                api: async (_args, value) => { events.push(`cmd:api:${value}`); return value; },
                preset: async (_args, value) => { events.push(`cmd:preset:${value}`); return value; },
                model: async () => {
                    events.push('cmd:model:throw');
                    throw new Error('Model switch failed');
                },
            },
            utils: {
                cancelDebounce: jest.fn((fn) => {
                    events.push(fn === mocks?.script?.saveSettingsDebounced ? 'cancelDebounce:saveSettingsDebounced' : 'cancelDebounce');
                }),
            },
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const select = document.getElementById('connection_profiles');
            select.value = 'p1';
            select.dispatchEvent(new Event('change'));
            await settle();

            // Each command cancels debounced saves both immediately after dispatch and in finally (including on failure).
            expect(mocks.utils.cancelDebounce).toHaveBeenCalledWith(mocks.script.saveSettingsDebounced);
            expect(events.filter(entry => entry.startsWith('cancelDebounce')).length).toBeGreaterThanOrEqual(6);
            expect(events.indexOf('cmd:model:throw')).toBeGreaterThan(-1);
            expect(events.slice(events.indexOf('cmd:model:throw') + 1)).toContain('cancelDebounce:saveSettingsDebounced');
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('clears stale api-url, secret-id and custom-endpoint-profile when updating to a provider without values', async () => {
        const profile = {
            id: 'p1',
            name: 'Previously Custom',
            mode: 'cc',
            api: 'custom',
            'api-url': 'https://old.example/v1',
            'secret-id': 'old-secret',
            'custom-endpoint-profile': 'Old Preset',
            model: 'old-model',
            exclude: [],
        };
        const { state } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: {
                    selectedProfile: 'p1',
                    profiles: [profile],
                    folders: [],
                    favorites: [],
                },
            },
            oai_settings: { chat_completion_source: 'openai' },
            commandValues: {
                api: 'openai',
                'api-url': '',
                'secret-id': '',
                'custom-endpoint-profile': '',
                model: 'gpt-4o',
            },
        });

        document.getElementById('update_connection_profile').click();
        await settle();

        const updated = state.extension_settings.connectionManager.profiles[0];
        expect(updated.api).toBe('openai');
        expect(updated.model).toBe('gpt-4o');
        expect(updated).not.toHaveProperty('api-url');
        expect(updated).not.toHaveProperty('secret-id');
        expect(updated).not.toHaveProperty('custom-endpoint-profile');
    });

    test('persists selected Custom endpoint profile secretId instead of active fallback secret when updating', async () => {
        const profile = {
            id: 'p1',
            name: 'Custom Preset Profile',
            mode: 'cc',
            api: 'custom',
            exclude: [],
        };
        const secretCommandSpy = jest.fn(async () => 'fallback-active-secret');
        const { state } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: {
                    selectedProfile: 'p1',
                    profiles: [profile],
                    folders: [],
                    favorites: [],
                },
            },
            oai_settings: { chat_completion_source: 'custom' },
            selected_custom_endpoint_preset: { name: 'My Endpoint', secretId: '  preset-secret-42  ' },
            commands: {
                'secret-id': secretCommandSpy,
            },
            commandValues: {
                api: 'custom',
                'custom-endpoint-profile': 'My Endpoint',
                'api-url': 'https://custom.example/v1',
                model: 'custom-model',
            },
        });

        document.getElementById('update_connection_profile').click();
        await settle();

        expect(state.extension_settings.connectionManager.profiles[0]['secret-id']).toBe('preset-secret-42');
        expect(secretCommandSpy).not.toHaveBeenCalled();

        // When preset is "None", fallback to the /secret-id command.
        state.selected_custom_endpoint_preset.name = 'None';
        state.selected_custom_endpoint_preset.secretId = 'ignored';
        document.getElementById('update_connection_profile').click();
        await settle();

        expect(secretCommandSpy).toHaveBeenCalledTimes(1);
        expect(state.extension_settings.connectionManager.profiles[0]['secret-id']).toBe('fallback-active-secret');
    });

    test('binds Custom endpoint profile secret before custom-endpoint-profile, api-url and model, and syncs OpenAI preset selection', async () => {
        const callOrder = [];
        const profile = {
            id: 'p1',
            name: 'Custom Full',
            mode: 'cc',
            api: 'custom',
            'secret-id': 'sec-99',
            'custom-endpoint-profile': 'Endpoint A',
            'api-url': 'https://custom.example/v1',
            model: 'custom-model',
            'custom-include-body': 'temperature: 0.4',
            'custom-exclude-body': 'top_k',
            'custom-include-headers': 'X-Test: 1',
            exclude: [],
        };

        const { mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: {
                    selectedProfile: '',
                    profiles: [profile],
                    folders: [],
                    favorites: [],
                },
            },
            oai_settings: { chat_completion_source: 'custom' },
            openai: {
                syncCustomEndpointPresetSelectionBySecretId: jest.fn(secretId => {
                    callOrder.push(`sync:${secretId}`);
                }),
            },
            commands: {
                api: async (_a, v) => { callOrder.push(`api:${v}`); return v; },
                'secret-id': async (_a, v) => { callOrder.push(`secret-id:${v}`); return v; },
                'custom-endpoint-profile': async (_a, v) => { callOrder.push(`custom-endpoint-profile:${v}`); return v; },
                'api-url': async (_a, v) => { callOrder.push(`api-url:${v}`); return v; },
                model: async (_a, v) => { callOrder.push(`model:${v}`); return v; },
                'custom-include-body': async (_a, v) => { callOrder.push(`custom-include-body:${v}`); return v; },
                'custom-exclude-body': async (_a, v) => { callOrder.push(`custom-exclude-body:${v}`); return v; },
                'custom-include-headers': async (_a, v) => { callOrder.push(`custom-include-headers:${v}`); return v; },
            },
        });

        const select = document.getElementById('connection_profiles');
        select.value = 'p1';
        select.dispatchEvent(new Event('change'));
        await settle();

        expect(mocks.openai.syncCustomEndpointPresetSelectionBySecretId).toHaveBeenCalledWith('sec-99');
        const secretIdx = callOrder.indexOf('secret-id:sec-99');
        const syncIdx = callOrder.indexOf('sync:sec-99');
        const epIdx = callOrder.indexOf('custom-endpoint-profile:Endpoint A');
        const urlIdx = callOrder.indexOf('api-url:https://custom.example/v1');
        const modelIdx = callOrder.indexOf('model:custom-model');
        const includeBodyIdx = callOrder.indexOf('custom-include-body:temperature: 0.4');
        const excludeBodyIdx = callOrder.indexOf('custom-exclude-body:top_k');
        const includeHeadersIdx = callOrder.indexOf('custom-include-headers:X-Test: 1');

        expect(secretIdx).toBeGreaterThan(-1);
        expect(syncIdx).toBeGreaterThan(secretIdx);
        expect(epIdx).toBeGreaterThan(syncIdx);
        expect(urlIdx).toBeGreaterThan(epIdx);
        expect(modelIdx).toBeGreaterThan(epIdx);
        // Connection profile's own additional parameters apply after endpoint profile so they win.
        expect(includeBodyIdx).toBeGreaterThan(epIdx);
        expect(excludeBodyIdx).toBeGreaterThan(epIdx);
        expect(includeHeadersIdx).toBeGreaterThan(epIdx);

        // Verify the real OpenAI helper selects the matching non-None preset or falls back to None.
        realOpenAi.custom_endpoint_presets.length = 0;
        const nonePreset = { name: 'None', secretId: '' };
        const matchedPreset = { name: 'Endpoint A', secretId: 'sec-99' };
        realOpenAi.custom_endpoint_presets.push(nonePreset, matchedPreset);

        realOpenAi.syncCustomEndpointPresetSelectionBySecretId('sec-99');
        expect(realOpenAi.selected_custom_endpoint_preset).toBe(matchedPreset);

        realOpenAi.syncCustomEndpointPresetSelectionBySecretId('unknown-secret');
        expect(realOpenAi.selected_custom_endpoint_preset).toBe(nonePreset);
    });

    test('records and applies empty values for Custom endpoint additional parameters and maps them in shared.js', async () => {
        const profile = {
            id: 'p1',
            name: 'Empty Params Profile',
            mode: 'cc',
            api: 'custom',
            'custom-include-body': 'old: 1',
            'custom-exclude-body': 'old',
            'custom-include-headers': 'X-Old: 1',
            exclude: [],
        };
        const appliedEmpty = [];
        const { state, mocks } = await importConnectionManagerModule({
            extension_settings: {
                connectionManager: {
                    selectedProfile: 'p1',
                    profiles: [profile],
                    folders: [],
                    favorites: [],
                },
            },
            commandValues: {
                api: 'custom',
                'custom-include-body': '',
                'custom-exclude-body': '',
                'custom-include-headers': '',
            },
            commands: {
                'custom-include-body': async (args, val) => {
                    if (args?.force === 'true') appliedEmpty.push(['custom-include-body', val]);
                    return '';
                },
                'custom-exclude-body': async (args, val) => {
                    if (args?.force === 'true') appliedEmpty.push(['custom-exclude-body', val]);
                    return '';
                },
                'custom-include-headers': async (args, val) => {
                    if (args?.force === 'true') appliedEmpty.push(['custom-include-headers', val]);
                    return '';
                },
            },
        });

        // Verify FANCY_NAMES passed to initProfileChangeNotice carry the expected labels.
        const { fancyNames } = mocks.notice.initProfileChangeNotice.mock.calls[0][0];
        expect(fancyNames['custom-endpoint-profile']).toBe('Custom Endpoint Profile');
        expect(fancyNames['custom-include-body']).toBe('Custom Include Body Parameters');
        expect(fancyNames['custom-exclude-body']).toBe('Custom Exclude Body Parameters');
        expect(fancyNames['custom-include-headers']).toBe('Custom Include Request Headers');

        // Updating preserves empty strings for ALLOW_EMPTY additional parameter commands.
        document.getElementById('update_connection_profile').click();
        await settle();

        const updated = state.extension_settings.connectionManager.profiles[0];
        expect(updated['custom-include-body']).toBe('');
        expect(updated['custom-exclude-body']).toBe('');
        expect(updated['custom-include-headers']).toBe('');

        // Reloading applies those empty strings with force=true.
        document.getElementById('reload_connection_profile').click();
        await settle();
        expect(appliedEmpty).toEqual([
            ['custom-include-body', ''],
            ['custom-exclude-body', ''],
            ['custom-include-headers', ''],
        ]);

        // Verify real shared.js maps profile keys to request payload keys (including empty strings).
        const { overrides } = realShared.getChatCompletionProfileRequestOverrides({
            api: 'custom',
            'custom-include-body': 'foo: 1',
            'custom-exclude-body': '',
            'custom-include-headers': 'X-H: 2',
        }, {});
        expect(overrides).toMatchObject({
            custom_include_body: 'foo: 1',
            custom_exclude_body: '',
            custom_include_headers: 'X-H: 2',
        });
    });
});
