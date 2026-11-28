/** @jest-environment jsdom */
import { afterEach, describe, expect, test } from '@jest/globals';
import { loadTtsModule } from './util/tts-module-harness.js';

let activeHarness = null;

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
});

describe('TTS body class', () => {
    test('the tts class stays off on first load when enabled is undefined, and clears a stale tts class', async () => {
        activeHarness = await loadTtsModule({
            ttsSettings: {},
            initialBodyClass: 'tts',
        });

        await activeHarness.ttsModule.init();

        expect(activeHarness.extension_settings.tts.enabled).toBeUndefined();
        expect(document.body.classList.contains('tts')).toBe(false);
        expect(document.getElementById('tts_enabled').checked).toBe(false);

        activeHarness.cleanup();

        activeHarness = await loadTtsModule({
            ttsSettings: {},
            initialBodyClass: '',
        });

        await activeHarness.ttsModule.init();

        expect(document.body.classList.contains('tts')).toBe(false);
    });

    test('the switch handler writes a boolean setting from the checkbox and toggles the body class', async () => {
        activeHarness = await loadTtsModule({
            ttsSettings: {},
        });

        await activeHarness.ttsModule.init();

        const checkbox = document.getElementById('tts_enabled');
        checkbox.click();

        expect(activeHarness.extension_settings.tts.enabled).toBe(true);
        expect(document.body.classList.contains('tts')).toBe(true);

        checkbox.click();

        expect(activeHarness.extension_settings.tts.enabled).toBe(false);
        expect(document.body.classList.contains('tts')).toBe(false);
    });
});
