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
        expect(immediateLocalStoreSource).toContain('await persistSynchronizedStore({');
        expect(immediateLocalStoreSource).toContain('save: flushSettingsBackup,');
        expect(getFunctionSource('saveConnectionProfileNow')).toContain('await saveLocalStoreBackupNow("qig_profiles", nextProfiles');
        expect(getFunctionSource('deleteConnectionProfileNow')).toContain('await saveLocalStoreBackupNow("qig_profiles", nextProfiles');
        expect(getFunctionSource('commitComfyWorkflowStore')).toContain('await saveLocalStoreBackupNow("qig_comfy_workflows", nextStore, errorMessage)');
        expect(getFunctionSource('saveComfyWorkflowPresetAsNow')).toContain('await commitComfyWorkflowStore(nextStore)');
        expect(getFunctionSource('updateSelectedComfyWorkflowPresetNow')).toContain('await commitComfyWorkflowStore(nextStore)');
        expect(getFunctionSource('deleteSelectedComfyWorkflowPresetNow')).toContain('await commitComfyWorkflowStore(nextStore)');
        expect(getFunctionSource('commitGenerationPresetStore')).toContain('await saveLocalStoreBackupNow("qig_gen_presets", nextStore, errorMessage)');
        expect(getFunctionSource('savePresetNow')).toContain('await commitGenerationPresetStore([...generationPresets, preset])');
        expect(getFunctionSource('deletePresetNow')).toContain('await commitGenerationPresetStore(nextStore, "Failed to delete preset from your SillyTavern account.")');
        expect(getFunctionSource('clearPresetsNow')).toContain('await commitGenerationPresetStore([], "Failed to clear presets from your SillyTavern account.")');
        expect(getFunctionSource('importSettings')).toContain('await commitSettingsImport(data);');
        expect(getFunctionSource('commitSettingsImportNow')).toContain('await flushSettingsBackup();');
    });
});
