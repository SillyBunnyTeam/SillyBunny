import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'quick-image-gen', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const paramsStart = source.indexOf('(', start);
    let parenDepth = 0;
    let bodyStart = -1;
    for (let index = paramsStart; index < source.length; index++) {
        if (source[index] === '(') parenDepth++;
        if (source[index] === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                bodyStart = source.indexOf('{', index);
                break;
            }
        }
    }
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

describe('Quick Image Gen artifact persistence', () => {
    test('explicit artifact saves flush server-backed backups immediately', () => {
        expect(source).toContain('let extension_settings, getContext, saveSettingsDebounced, saveSettings');
        expect(source).toContain('saveSettings = scriptModule.saveSettings;');

        for (const name of ['saveBackupToSettings', 'saveLocalStoreBackupNow']) {
            const backupSource = getFunctionSource(name);
            expect(backupSource).toContain('await persistSynchronizedStore({');
            expect(backupSource).toContain('save: saveSettings,');
            expect(backupSource).toContain('acknowledge: confirmSettingsSaveEvent,');
        }
        expect(getFunctionSource('flushSettingsBackup')).toContain('await saveSettingsWithConfirmation({');
        expect(getFunctionSource('commitConfigurationStore')).toContain('await saveLocalStoreBackupNow("qig_configurations", nextStore, errorMessage, { lastLoadedPresetId: activeId })');
        expect(getFunctionSource('saveConfigurationAsNow')).toContain('await commitConfigurationStore(nextStore, { activeId: record.id })');
        expect(getFunctionSource('updateSelectedConfigurationNow')).toContain('await commitConfigurationStore(configurations.map(');
        expect(getFunctionSource('deleteSelectedConfigurationNow')).toContain('await commitConfigurationStore(configurations.filter(');
        expect(getFunctionSource('importSettings')).toContain('await commitSettingsImport(data);');
        expect(getFunctionSource('commitSettingsImportNow')).toContain('await flushSettingsBackup();');
    });
});
