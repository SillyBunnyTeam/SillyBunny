import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const powerUserSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'power-user.js'), 'utf8');
const settingsTabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-settings-tabs.js'), 'utf8');

const androidSettingIds = [
    'android_conservative_streaming',
    'android_reduce_streaming_work',
    'android_disable_smooth_streaming',
    'android_disable_stream_fade_in',
];

describe('Android streaming settings UI', () => {
    test('keeps a persistent Android streaming settings section', () => {
        expect(indexHtml).toContain('name="AndroidStreamingToggles" data-sb-persistent-menu="true"');
        expect(indexHtml).toContain('Applies when the browser is Android, even if the server runs on another machine.');

        for (const settingId of androidSettingIds) {
            expect(indexHtml).toContain(`id="${settingId}"`);
        }
    });

    test('backs Android streaming controls with saved power-user settings', () => {
        expect(powerUserSource).toContain('const ANDROID_STREAMING_SETTING_DEFAULTS = Object.freeze({');
        expect(powerUserSource).toContain('shouldInitializeAndroidStreamingSettings');

        for (const settingId of androidSettingIds) {
            expect(powerUserSource).toContain(`${settingId}: true`);
            expect(powerUserSource).toContain(`$('#${settingId}').prop('checked', power_user.${settingId});`);
            expect(powerUserSource).toContain(`power_user.${settingId} = !!$(this).prop('checked');`);
        }
    });

    test('promotes Android streaming settings into System & Device', () => {
        expect(settingsTabsSource).toContain('const androidBlock = document.querySelector(\'[name="AndroidStreamingToggles"]\');');
        expect(settingsTabsSource).toContain('androidDrawer.id = \'sb-android-streaming-drawer\';');
        expect(settingsTabsSource).toContain('\'sb-android-streaming-drawer\': \'system-device\'');
    });
});
