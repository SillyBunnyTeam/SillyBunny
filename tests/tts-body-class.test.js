import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ttsSource = (await fs.readFile(fileURLToPath(new URL('../public/scripts/extensions/tts/index.js', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');

describe('TTS body class', () => {
    test('the tts class follows a boolean, because the setting is undefined until the switch is first used', () => {
        const loadSettingsStart = ttsSource.indexOf('function loadSettings()');
        const loadSettingsEnd = ttsSource.indexOf('const defaultSettings = {', loadSettingsStart);
        const loadSettings = ttsSource.slice(loadSettingsStart, loadSettingsEnd);

        expect(loadSettingsStart).toBeGreaterThanOrEqual(0);
        expect(loadSettingsEnd).toBeGreaterThan(loadSettingsStart);
        expect(loadSettings).toContain('$(\'body\').toggleClass(\'tts\', Boolean(extension_settings.tts.enabled));');
        expect(loadSettings).not.toContain('toggleClass(\'tts\', extension_settings.tts.enabled)');
    });

    test('the switch handler sets the setting from the checkbox, so its class state is a boolean', () => {
        const start = ttsSource.indexOf('function onEnableClick()');
        const handler = ttsSource.slice(start, ttsSource.indexOf('\n}\n', start));

        expect(start).toBeGreaterThanOrEqual(0);
        expect(handler).toContain('extension_settings.tts.enabled = $(\'#tts_enabled\').is(');
    });
});
