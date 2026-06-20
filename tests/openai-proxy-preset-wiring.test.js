import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');

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

    test('loads selected proxy preset credentials without overriding the saved backend', () => {
        const loadProxyPresetsSource = getFunctionSource('loadProxyPresets');
        const setProxyPresetIndex = loadProxyPresetsSource.indexOf('setProxyPreset(selected_proxy.name, selected_proxy.url, selected_proxy.password, selected_proxy.source, { applySource: false, silent: true });');

        expect(setProxyPresetIndex).toBeGreaterThanOrEqual(0);
        expect(loadProxyPresetsSource).not.toContain('{ applySource: true, silent: true }');
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

    test('shows an explicit Custom endpoint profile selector', () => {
        expect(indexHtml).toContain('id="custom_endpoint_preset"');
        expect(indexHtml).toContain('id="save_custom_endpoint"');
        expect(indexHtml).toContain('id="delete_custom_endpoint"');
        expect(indexHtml).toContain('id="custom_endpoint_preset_name"');
        expect(indexHtml).toContain('Saved Custom OpenAI-compatible URLs, API keys, and model IDs.');
    });

    test('saves Custom endpoint profiles with URL, key, and model fields', () => {
        expect(openAiSource).toContain('buildCustomEndpointPresetForSave({');
        expect(openAiSource).toContain('url: $(\'#custom_api_url_text\').val()');
        expect(openAiSource).toContain('key: $(\'#api_key_custom\').val()');
        expect(openAiSource).toContain('model: $(\'#custom_model_id\').val()');
    });

    test('applies Custom endpoint profile values before reconnecting', () => {
        const setCustomEndpointSource = getFunctionSource('setCustomEndpointPreset');
        const urlUpdateIndex = setCustomEndpointSource.indexOf('oai_settings.custom_url = normalizedPreset.url;');
        const modelUpdateIndex = setCustomEndpointSource.indexOf('oai_settings.custom_model = normalizedPreset.model;');
        const secretWriteIndex = setCustomEndpointSource.indexOf('await writeSecret(SECRET_KEYS.CUSTOM, normalizedPreset.key, undefined, { allowEmpty: true });');
        const keyInputIndex = setCustomEndpointSource.indexOf('$(\'#api_key_custom\').val(normalizedPreset.key);');
        const reconnectIndex = setCustomEndpointSource.indexOf('reconnectOpenAi();');

        expect(urlUpdateIndex).toBeGreaterThanOrEqual(0);
        expect(modelUpdateIndex).toBeGreaterThan(urlUpdateIndex);
        expect(secretWriteIndex).toBeGreaterThan(modelUpdateIndex);
        expect(keyInputIndex).toBeGreaterThan(secretWriteIndex);
        expect(reconnectIndex).toBeGreaterThan(keyInputIndex);
    });

    test('loads and persists Custom endpoint profiles with settings', () => {
        expect(scriptSource).toContain('await loadCustomEndpointPresets(settings);');
        expect(scriptSource).toContain('custom_endpoint_presets: custom_endpoint_presets');
        expect(scriptSource).toContain('selected_custom_endpoint_preset: selected_custom_endpoint_preset');
    });

    test('preserves legacy Custom endpoint settings until a profile is selected', () => {
        const loadCustomEndpointSource = getFunctionSource('loadCustomEndpointPresets');
        const selectedAssignmentIndex = loadCustomEndpointSource.indexOf('selected_custom_endpoint_preset = savedSelectedPreset ? normalizeCustomEndpointPreset(savedSelectedPreset) : null;');
        const applyBranchIndex = loadCustomEndpointSource.indexOf('if (selected_custom_endpoint_preset) {');
        const applyPresetIndex = loadCustomEndpointSource.indexOf('await setCustomEndpointPreset(', applyBranchIndex);
        const fallbackNameIndex = loadCustomEndpointSource.indexOf('$(\'#custom_endpoint_preset_name\').val(\'None\');');

        expect(selectedAssignmentIndex).toBeGreaterThanOrEqual(0);
        expect(applyBranchIndex).toBeGreaterThan(selectedAssignmentIndex);
        expect(applyPresetIndex).toBeGreaterThan(applyBranchIndex);
        expect(fallbackNameIndex).toBeGreaterThan(applyPresetIndex);
        expect(loadCustomEndpointSource).not.toContain('savedSelectedPreset ||');
    });

    test('wires Custom endpoint profile selection from initOpenAI', () => {
        const initSource = getFunctionSource('initOpenAI');

        expect(initSource).toContain('$(\'#custom_endpoint_preset\').on(\'change\', onCustomEndpointPresetChange);');
    });
});
