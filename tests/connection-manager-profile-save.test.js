import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizeSource = source => source.replace(/\r\n/g, '\n');
const connectionManagerSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', 'index.js'), 'utf8'));
const openAiSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8'));
const sharedSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'shared.js'), 'utf8'));

function getFunctionSourceFrom(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = source.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function getFunctionSource(name) {
    return getFunctionSourceFrom(connectionManagerSource, name);
}

function getOpenAiFunctionSource(name) {
    return getFunctionSourceFrom(openAiSource, name);
}

describe('connection manager profile save wiring', () => {
    test('cancels debounced settings saves while applying profile commands', () => {
        const applySource = getFunctionSource('applyConnectionProfile');

        expect(connectionManagerSource).toContain('saveSettingsDebounced } from \'../../../script.js\';');
        expect(connectionManagerSource).toContain('cancelDebounce, collapseSpaces');
        expect(applySource).toContain('const commandPromise = SlashCommandParser.commands[command].callback(args, argument);');
        expect(applySource).toContain('cancelDebounce(saveSettingsDebounced);');
        expect(applySource).toContain('finally {\n                    cancelDebounce(saveSettingsDebounced);\n                }');
    });

    test('clears stale endpoint and secret fields when updating to providers without values', () => {
        const readSource = getFunctionSource('readProfileFromCommands');

        expect(connectionManagerSource).toContain('const CLEAR_ON_EMPTY_RESULT = [\n    \'api-url\',\n    \'secret-id\',\n    \'custom-endpoint-profile\',\n];');
        expect(readSource).toContain('if (cleanUp && CLEAR_ON_EMPTY_RESULT.includes(command)) {');
        expect(readSource).toContain('delete profile[command];');
    });

    test('persists selected Custom endpoint profile secrets instead of active fallback secrets', () => {
        const helperSource = getFunctionSource('getCustomEndpointProfileSecretId');
        const readSource = getFunctionSource('readProfileFromCommands');

        expect(connectionManagerSource).toContain('chat_completion_sources');
        expect(connectionManagerSource).toContain('oai_settings');
        expect(connectionManagerSource).toContain('selected_custom_endpoint_preset');
        expect(connectionManagerSource).toContain('syncCustomEndpointPresetSelectionBySecretId');
        expect(helperSource).toContain('mode !== \'cc\'');
        expect(helperSource).toContain('oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM');
        expect(helperSource).toContain('selected_custom_endpoint_preset?.name === \'None\'');
        expect(helperSource).toContain('return String(selected_custom_endpoint_preset?.secretId ?? \'\').trim();');

        const secretCommandIndex = readSource.indexOf('if (command === \'secret-id\') {');
        const profileSecretIndex = readSource.indexOf('const customEndpointSecretId = getCustomEndpointProfileSecretId(mode);', secretCommandIndex);
        const assignIndex = readSource.indexOf('profile[command] = customEndpointSecretId;', profileSecretIndex);
        const fallbackIndex = readSource.indexOf('const result = await SlashCommandParser.commands[command].callback(args, \'\');');

        expect(secretCommandIndex).toBeGreaterThanOrEqual(0);
        expect(profileSecretIndex).toBeGreaterThan(secretCommandIndex);
        expect(assignIndex).toBeGreaterThan(profileSecretIndex);
        expect(fallbackIndex).toBeGreaterThan(assignIndex);
    });

    test('binds Custom endpoint profile secrets before endpoint and model refreshes', () => {
        const applySource = getFunctionSource('applyConnectionProfile');
        const syncSource = getFunctionSource('syncAppliedCustomEndpointProfileSecret');
        const openAiSyncSource = getOpenAiFunctionSource('syncCustomEndpointPresetSelectionBySecretId');
        const ccCommandsStart = connectionManagerSource.indexOf('const CC_COMMANDS = [');
        const tcCommandsStart = connectionManagerSource.indexOf('const TC_COMMANDS = [');
        const ccCommandsSource = connectionManagerSource.slice(ccCommandsStart, tcCommandsStart);

        expect(syncSource).toContain('oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM');
        expect(syncSource).toContain('syncCustomEndpointPresetSelectionBySecretId(secretId);');
        expect(openAiSyncSource).toContain('preset.name !== \'None\'');
        expect(openAiSyncSource).toContain('selected_custom_endpoint_preset = matchedPreset;');
        expect(openAiSyncSource).toContain('selected_custom_endpoint_preset = custom_endpoint_presets.find(preset => preset.name === \'None\')');

        const secretCommandIndex = ccCommandsSource.indexOf('\'secret-id\'');
        const apiUrlCommandIndex = ccCommandsSource.indexOf('\'api-url\'');
        const modelCommandIndex = ccCommandsSource.indexOf('\'model\'');

        expect(secretCommandIndex).toBeGreaterThanOrEqual(0);
        expect(apiUrlCommandIndex).toBeGreaterThan(secretCommandIndex);
        expect(modelCommandIndex).toBeGreaterThan(secretCommandIndex);

        const commandResultIndex = applySource.indexOf('const result = await commandPromise;');
        const secretGuardIndex = applySource.indexOf('if (command === \'secret-id\') {', commandResultIndex);
        const syncIndex = applySource.indexOf('syncAppliedCustomEndpointProfileSecret(mode, result || argument);', secretGuardIndex);

        expect(commandResultIndex).toBeGreaterThanOrEqual(0);
        expect(secretGuardIndex).toBeGreaterThan(commandResultIndex);
        expect(syncIndex).toBeGreaterThan(secretGuardIndex);
    });

    test('re-selects the Custom endpoint profile by name after the secret and before the URL and model', () => {
        const ccCommandsStart = connectionManagerSource.indexOf('const CC_COMMANDS = [');
        const tcCommandsStart = connectionManagerSource.indexOf('const TC_COMMANDS = [');
        const ccCommandsSource = connectionManagerSource.slice(ccCommandsStart, tcCommandsStart);
        const secretCommandIndex = ccCommandsSource.indexOf('\'secret-id\'');
        const endpointProfileIndex = ccCommandsSource.indexOf('\'custom-endpoint-profile\'');
        const apiUrlCommandIndex = ccCommandsSource.indexOf('\'api-url\'');
        const modelCommandIndex = ccCommandsSource.indexOf('\'model\'');

        expect(endpointProfileIndex).toBeGreaterThan(secretCommandIndex);
        expect(apiUrlCommandIndex).toBeGreaterThan(endpointProfileIndex);
        expect(modelCommandIndex).toBeGreaterThan(endpointProfileIndex);
        expect(connectionManagerSource).toContain('\'custom-endpoint-profile\': \'Custom Endpoint Profile\',');
    });

    test('records Custom endpoint additional parameters, including empty values, in Chat Completion profiles', () => {
        const ccCommandsStart = connectionManagerSource.indexOf('const CC_COMMANDS = [');
        const tcCommandsStart = connectionManagerSource.indexOf('const TC_COMMANDS = [');
        const ccCommandsSource = connectionManagerSource.slice(ccCommandsStart, tcCommandsStart);
        const allowEmptyStart = connectionManagerSource.indexOf('const ALLOW_EMPTY = [');
        const allowEmptySource = connectionManagerSource.slice(allowEmptyStart, connectionManagerSource.indexOf('];', allowEmptyStart));

        for (const command of ['custom-include-body', 'custom-exclude-body', 'custom-include-headers']) {
            expect(ccCommandsSource).toContain(`'${command}',`);
            expect(allowEmptySource).toContain(`'${command}',`);
            expect(sharedSource).toContain(`'${command}': ['${command.replaceAll('-', '_')}', value => String(value ?? '')],`);
        }
        expect(connectionManagerSource).toContain('\'custom-include-body\': \'Custom Include Body Parameters\',');
        expect(connectionManagerSource).toContain('\'custom-exclude-body\': \'Custom Exclude Body Parameters\',');
        expect(connectionManagerSource).toContain('\'custom-include-headers\': \'Custom Include Request Headers\',');
    });
});
