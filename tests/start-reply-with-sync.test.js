/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML contract. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { importPowerUserModule } from './util/power-user-harness.js';

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));
const indexSource = readFileSync(pub('index.html'), 'utf8');

document.body.innerHTML = `
    <select id="settings_preset_openai" data-preset-manager-for="openai"></select>
    <input id="start_reply_with" class="start-reply-with-input" type="text" value="" />
    <input id="chat-show-reply-prefix-checkbox" type="checkbox" />
`;

const { powerUser, mocks, runReady } = await importPowerUserModule();
await runReady();

await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({ kai_settings: {} }));
await jest.unstable_mockModule(pub('scripts/nai-settings.js'), () => ({ convertNovelPreset: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
    getChatCompletionPreset: jest.fn(),
    getPresetApplicationPromise: jest.fn(),
    oai_settings: {},
    openai_setting_names: {},
    openai_settings: [],
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/preset-lorebook-dialogs.js'), () => ({
    presetChoicesOptions: jest.fn(() => ({})),
}));
await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
    getTextCompletionPresetSettings: jest.fn(),
    textgenerationwebui_settings: {},
    textgenerationwebui_preset_names: [],
    textgenerationwebui_presets: [],
}));

const { getPresetManager, initPresetManager } = await import('../public/scripts/preset-manager.js');

describe('Start Reply With input synchronization', () => {
    test('keeps the single Advanced Formatting input synced between power-user.js and preset-manager.js', async () => {
        expect(indexSource.match(/class="start-reply-with-input [^"]*"/g)).toHaveLength(1);
        expect(indexSource).toContain('id="start_reply_with"');

        // Typing into .start-reply-with-input writes power_user.user_prompt_bias and schedules save.
        mocks.script.saveSettingsDebounced.mockClear();
        $('#start_reply_with').val('Typed bias').trigger('input');
        expect(powerUser.power_user.user_prompt_bias).toBe('Typed bias');
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);

        // Applying a master preset updates both power_user.user_prompt_bias and the .start-reply-with-input DOM value.
        await initPresetManager();
        const PresetManagerClass = getPresetManager('openai').constructor;
        PresetManagerClass.masterSections.srw.setData({ value: 'Master preset bias', show: true });
        expect(powerUser.power_user.user_prompt_bias).toBe('Master preset bias');
        expect($('#start_reply_with').val()).toBe('Master preset bias');
        expect($('#chat-show-reply-prefix-checkbox').prop('checked')).toBe(true);
    });
});
