/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { loadQigModule } from './util/qig-module-harness.js';

let activeHarness = null;

async function drainAsync(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
    jest.restoreAllMocks();
});

describe('Quick Image Gen artifact persistence', () => {
    test('configuration save, update, and delete flush server-backed backups immediately via saveSettings', async () => {
        activeHarness = await loadQigModule({
            qigSettings: {
                provider: 'pollinations',
                pollinationsModel: 'flux',
                prompt: 'sunset portrait',
                starterPresetsSeeded: true,
            },
        });
        activeHarness.saveSettings.mockClear();
        activeHarness.saveSettingsDebounced.mockClear();

        // Save new configuration via the real UI button.
        activeHarness.callGenericPopup.mockResolvedValueOnce('Sunset Config');
        document.getElementById('qig-config-save').click();
        await drainAsync();

        expect(activeHarness.saveSettings).toHaveBeenCalledTimes(1);
        const savedBackup = activeHarness.extension_settings['quick-image-gen']._backupConfigurations;
        expect(savedBackup).toEqual([
            expect.objectContaining({
                name: 'Sunset Config',
                provider: 'pollinations',
                prompt: 'sunset portrait',
            }),
        ]);
        const savedId = savedBackup[0].id;
        expect(activeHarness.extension_settings['quick-image-gen'].lastLoadedPresetId).toBe(savedId);

        // Update the selected configuration via the real UI button.
        activeHarness.saveSettings.mockClear();
        const modelInput = document.getElementById('qig-pollinations-model');
        modelInput.value = 'turbo';
        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
        modelInput.dispatchEvent(new Event('change', { bubbles: true }));
        activeHarness.callGenericPopup.mockResolvedValueOnce(1);
        document.getElementById('qig-config-update').click();
        await drainAsync();

        expect(activeHarness.saveSettings).toHaveBeenCalledTimes(1);
        expect(activeHarness.extension_settings['quick-image-gen']._backupConfigurations).toEqual([
            expect.objectContaining({
                id: savedId,
                name: 'Sunset Config',
                pollinationsModel: 'turbo',
            }),
        ]);

        // Delete the selected configuration via the real UI button.
        activeHarness.saveSettings.mockClear();
        activeHarness.callGenericPopup.mockResolvedValueOnce(1);
        document.getElementById('qig-config-del').click();
        await drainAsync();

        expect(activeHarness.saveSettings).toHaveBeenCalledTimes(1);
        expect(activeHarness.extension_settings['quick-image-gen']._backupConfigurations).toEqual([]);
        expect(activeHarness.extension_settings['quick-image-gen'].lastLoadedPresetId).toBe('');
    });

    test('settings import commits synchronized stores and flushes server backup immediately', async () => {
        activeHarness = await loadQigModule({
            qigSettings: {
                provider: 'pollinations',
                pollinationsModel: 'flux',
                starterPresetsSeeded: true,
            },
        });
        activeHarness.saveSettings.mockClear();
        activeHarness.callGenericPopup.mockResolvedValueOnce(1);

        const importPayload = JSON.stringify({
            exportDate: '2026-01-02T00:00:00.000Z',
            version: 7,
            activeSettings: {
                provider: 'pollinations',
                pollinationsModel: 'turbo',
                width: 768,
                height: 768,
            },
            generationPresets: [
                { id: 'imported-cfg-1', name: 'Imported Preset', provider: 'pollinations', pollinationsModel: 'turbo' },
            ],
        });

        // Intercept the transient file input created by importSettings().
        const originalCreateElement = document.createElement.bind(document);
        let fileInput = null;
        jest.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
            const el = originalCreateElement(tagName, options);
            if (String(tagName).toLowerCase() === 'input') {
                el.click = () => { fileInput = el; };
            }
            return el;
        });

        document.getElementById('qig-import-btn').click();
        expect(fileInput).not.toBeNull();
        expect(typeof fileInput.onchange).toBe('function');

        await fileInput.onchange({
            target: {
                files: [{
                    size: importPayload.length,
                    text: async () => importPayload,
                }],
            },
        });
        await drainAsync();

        expect(activeHarness.saveSettings).toHaveBeenCalled();
        expect(activeHarness.qigModule.getSettings().pollinationsModel).toBe('turbo');
        expect(activeHarness.extension_settings['quick-image-gen']._backupConfigurations).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'imported-cfg-1', name: 'Imported Preset' })]),
        );
        expect(activeHarness.toastr.success).toHaveBeenCalledWith('Settings imported successfully', '', { escapeHtml: true });
    });
});
