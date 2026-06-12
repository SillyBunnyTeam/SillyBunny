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

describe('Quick Image Gen artifact persistence', () => {
    test('explicit artifact saves flush server-backed backups immediately', () => {
        expect(source).toContain('let extension_settings, getContext, saveSettingsDebounced, saveSettings');
        expect(source).toContain('saveSettings = scriptModule.saveSettings;');

        const durableBackupSource = getFunctionSource('saveBackupToSettings');
        expect(durableBackupSource).toContain('await flushSettingsBackup();');

        const immediateLocalStoreSource = getFunctionSource('saveLocalStoreBackupNow');
        expect(immediateLocalStoreSource).toContain('return saveBackupToSettings(localKey, data);');
        expect(getFunctionSource('clearPresets')).toContain('if (!await saveBackupToSettings("qig_gen_presets", generationPresets)) return;');
        expect(getFunctionSource('saveConnectionProfile')).toContain('if (!await saveBackupToSettings("qig_profiles", connectionProfiles)) return;');
        expect(getFunctionSource('deleteConnectionProfile')).toContain('if (!await saveBackupToSettings("qig_profiles", connectionProfiles)) return;');
        expect(getFunctionSource('saveComfyWorkflowPresetAs')).toContain('await saveComfyWorkflowStoreNow()');
        expect(getFunctionSource('updateSelectedComfyWorkflowPreset')).toContain('await saveComfyWorkflowStoreNow()');
        expect(getFunctionSource('deleteSelectedComfyWorkflowPreset')).toContain('await saveComfyWorkflowStoreNow()');
        expect(getFunctionSource('savePreset')).toContain('await saveGenerationPresetStoreNow()');
        expect(getFunctionSource('deletePreset')).toContain('await saveGenerationPresetStoreNow("Failed to delete preset. Browser storage may be full.")');
        expect(getFunctionSource('importSettings')).toContain('await flushSettingsBackup();');
    });
});
