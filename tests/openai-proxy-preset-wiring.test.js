import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

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

describe('OpenAI proxy preset wiring', () => {
    test('saves reverse proxy presets with the selected backend binding', () => {
        expect(openAiSource).toContain('buildReverseProxyPresetForSave({');
        expect(openAiSource).toContain('source: $(\'#openai_proxy_source\').val() || \'\'');
        expect(openAiSource).toContain('supportedSources: REVERSE_PROXY_SUPPORTED_SOURCES');
    });

    test('shows an explicit reverse proxy backend selector', () => {
        expect(indexHtml).toContain('id="openai_proxy_source"');
        expect(indexHtml).toContain('None (Don\'t switch)');
        expect(indexHtml).toContain('value="makersuite"');
    });

    test('renders clean source indicators in proxy preset options', () => {
        const optionTextSource = getFunctionSource('getReverseProxyPresetOptionText');

        expect(openAiSource).toContain('function getReverseProxySourceLabel(source)');
        expect(openAiSource).toContain('[chat_completion_sources.MAKERSUITE]: \'AI Studio\'');
        expect(optionTextSource).toContain('`${normalizedPreset.name} [${sourceLabel}]`');
    });

    test('applies proxy credentials before switching Chat Completion source', () => {
        const setProxyPresetSource = getFunctionSource('setProxyPreset');
        const proxyUpdateIndex = setProxyPresetSource.indexOf('oai_settings.reverse_proxy = normalizedPreset.url;');
        const passwordUpdateIndex = setProxyPresetSource.indexOf('oai_settings.proxy_password = normalizedPreset.password;');
        const sourceChangeIndex = setProxyPresetSource.indexOf('$(\'#chat_completion_source\').val(normalizedPreset.source).trigger(\'change\');');

        expect(proxyUpdateIndex).toBeGreaterThanOrEqual(0);
        expect(passwordUpdateIndex).toBeGreaterThan(proxyUpdateIndex);
        expect(sourceChangeIndex).toBeGreaterThan(passwordUpdateIndex);
        expect(setProxyPresetSource).toContain('reconnectOpenAi();');
    });

    test('applies selected proxy backend binding when loading presets', () => {
        const loadProxyPresetsSource = getFunctionSource('loadProxyPresets');
        const applySourceFlagIndex = loadProxyPresetsSource.indexOf('const shouldApplySource = Boolean(selected_proxy.source);');
        const setProxyPresetIndex = loadProxyPresetsSource.indexOf('setProxyPreset(selected_proxy.name, selected_proxy.url, selected_proxy.password, selected_proxy.source, { applySource: shouldApplySource, silent: true });');

        expect(applySourceFlagIndex).toBeGreaterThanOrEqual(0);
        expect(setProxyPresetIndex).toBeGreaterThan(applySourceFlagIndex);
        expect(loadProxyPresetsSource).not.toContain('{ applySource: false }');
    });

    test('switches backend on silent load without triggering a reconnect', () => {
        const setProxyPresetSource = getFunctionSource('setProxyPreset');
        const silentBranchIndex = setProxyPresetSource.indexOf('if (silent) {');
        const silentSourceAssignIndex = setProxyPresetSource.indexOf('oai_settings.chat_completion_source = normalizedPreset.source;');
        const silentValIndex = setProxyPresetSource.indexOf('$(\'#chat_completion_source\').val(normalizedPreset.source);');
        const silentRefreshIndex = setProxyPresetSource.indexOf('toggleChatCompletionForms();');
        const silentReturnIndex = setProxyPresetSource.indexOf('return;', silentBranchIndex);
        const reconnectIndex = setProxyPresetSource.indexOf('reconnectOpenAi();');

        // Silent branch applies the source and refreshes UI before returning early.
        expect(silentBranchIndex).toBeGreaterThanOrEqual(0);
        expect(silentSourceAssignIndex).toBeGreaterThan(silentBranchIndex);
        expect(silentValIndex).toBeGreaterThan(silentSourceAssignIndex);
        expect(silentRefreshIndex).toBeGreaterThan(silentValIndex);
        expect(silentReturnIndex).toBeGreaterThan(silentRefreshIndex);

        // Silent branch must short-circuit before the reconnect path.
        expect(reconnectIndex).toBeGreaterThan(silentReturnIndex);
    });

    test('keeps the backend binding two-way by syncing the proxy preset on source change', () => {
        const syncSource = getFunctionSource('syncProxyPresetToBoundSource');

        // Re-entrancy guard prevents feeding back into the source change handler.
        expect(openAiSource).toContain('let isSyncingProxyBinding = false;');
        expect(syncSource).toContain('if (isSyncingProxyBinding) {');
        expect(syncSource).toContain('isSyncingProxyBinding = true;');
        expect(syncSource).toContain('isSyncingProxyBinding = false;');

        // Only acts on supported sources and finds a preset bound to that source.
        expect(syncSource).toContain('REVERSE_PROXY_SUPPORTED_SOURCES.includes(source)');
        expect(syncSource).toContain('proxies.find(preset => preset.name !== \'None\' && preset.source === source)');

        // Applies the bound preset without re-triggering the source change or a redundant reconnect.
        expect(syncSource).toContain('{ applySource: false, silent: true }');
    });

    test('invokes the reverse binding sync from the chat completion source change handler', () => {
        const initSource = getFunctionSource('initOpenAI');
        const sourceChangeIndex = initSource.indexOf('$(\'#chat_completion_source\').on(\'change\'');
        const syncCallIndex = initSource.indexOf('syncProxyPresetToBoundSource(oai_settings.chat_completion_source);');
        const reconnectIndex = initSource.indexOf('reconnectOpenAi();', sourceChangeIndex);

        expect(sourceChangeIndex).toBeGreaterThanOrEqual(0);
        expect(syncCallIndex).toBeGreaterThan(sourceChangeIndex);
        // Proxy preset must be applied before reconnecting so the reconnect uses the bound proxy.
        expect(reconnectIndex).toBeGreaterThan(syncCallIndex);
    });

    test('preserves the selected settings preset when switching backends', () => {
        const restoreSource = getFunctionSource('restoreOpenAIPresetSelection');
        const initSource = getFunctionSource('initOpenAI');
        const sourceChangeIndex = initSource.indexOf('$(\'#chat_completion_source\').on(\'change\'');
        const capturePresetIndex = initSource.indexOf('const presetName = oai_settings.preset_settings_openai;', sourceChangeIndex);
        const sourceUpdateIndex = initSource.indexOf('oai_settings.chat_completion_source = String($(this).find(\':selected\').val());', sourceChangeIndex);
        const syncCallIndex = initSource.indexOf('syncProxyPresetToBoundSource(oai_settings.chat_completion_source);', sourceChangeIndex);
        const restoreCallIndex = initSource.indexOf('restoreOpenAIPresetSelection(presetName);', sourceChangeIndex);
        const saveIndex = initSource.indexOf('saveSettingsDebounced();', sourceChangeIndex);

        expect(restoreSource).toContain('const presetValue = openai_setting_names?.[presetName];');
        expect(restoreSource).toContain('oai_settings.preset_settings_openai = presetName;');
        expect(restoreSource).toContain('$(\'#settings_preset_openai\').val(String(presetValue));');

        expect(capturePresetIndex).toBeGreaterThan(sourceChangeIndex);
        expect(sourceUpdateIndex).toBeGreaterThan(capturePresetIndex);
        expect(restoreCallIndex).toBeGreaterThan(syncCallIndex);
        expect(saveIndex).toBeGreaterThan(restoreCallIndex);
    });
});
