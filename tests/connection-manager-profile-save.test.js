import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizeSource = source => source.replace(/\r\n/g, '\n');
const connectionManagerSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'connection-manager', 'index.js'), 'utf8'));

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = connectionManagerSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = connectionManagerSource.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < connectionManagerSource.length; index++) {
        const char = connectionManagerSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return connectionManagerSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
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

        expect(connectionManagerSource).toContain('const CLEAR_ON_EMPTY_RESULT = [\n    \'api-url\',\n    \'secret-id\',\n];');
        expect(readSource).toContain('if (cleanUp && CLEAR_ON_EMPTY_RESULT.includes(command)) {');
        expect(readSource).toContain('delete profile[command];');
    });

    test('persists selected Custom endpoint profile secrets instead of active fallback secrets', () => {
        const helperSource = getFunctionSource('getCustomEndpointProfileSecretId');
        const readSource = getFunctionSource('readProfileFromCommands');

        expect(connectionManagerSource).toContain('import { chat_completion_sources, oai_settings, selected_custom_endpoint_preset } from \'../../openai.js\';');
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
});
