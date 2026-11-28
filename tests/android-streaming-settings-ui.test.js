/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML contracts. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANDROID_STREAMING_SETTING_DEFAULTS } from '../public/scripts/mobile-streaming.js';
import { importPowerUserModule } from './util/power-user-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const settingsContentSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-settings-content.js'), 'utf8');

const androidSettingIds = [
    'android_conservative_streaming',
    'android_reduce_streaming_work',
    'android_disable_smooth_streaming',
    'android_disable_stream_fade_in',
    'android_streaming_basic_markdown',
];

document.body.innerHTML = androidSettingIds.map(id => `<input id="${id}" type="checkbox" />`).join('\n');

const { powerUser, mocks, runReady } = await importPowerUserModule();
await runReady();

describe('Android streaming settings UI', () => {
    test('keeps a persistent Android streaming settings section', () => {
        expect(indexHtml).toContain('name="AndroidStreamingToggles" data-sb-persistent-menu="true"');
        expect(indexHtml).toContain('Applies when the browser is Android, even if the server runs on another machine.');

        for (const settingId of androidSettingIds) {
            expect(indexHtml).toContain(`id="${settingId}"`);
        }
    });

    test('backs Android streaming controls with saved power-user settings and live checkbox handlers', async () => {
        expect(Object.isFrozen(ANDROID_STREAMING_SETTING_DEFAULTS)).toBe(true);
        for (const settingId of androidSettingIds) {
            expect(ANDROID_STREAMING_SETTING_DEFAULTS[settingId]).toBe(settingId !== 'android_streaming_basic_markdown');
        }

        // Loading a fresh settings object initializes defaults and reflects them onto all 5 checkboxes.
        await powerUser.loadPowerUserSettings(
            { power_user: {} },
            { themes: [], context: [], instruct: [], sysprompt: [], reasoning: [] },
        );

        for (const settingId of androidSettingIds) {
            const expectedDefault = settingId !== 'android_streaming_basic_markdown';
            expect(powerUser.power_user[settingId]).toBe(expectedDefault);
            expect($(`#${settingId}`).prop('checked')).toBe(expectedDefault);

            // Toggling the checkbox updates power_user and schedules a save.
            mocks.script.saveSettingsDebounced.mockClear();
            $(`#${settingId}`).prop('checked', !expectedDefault).trigger('input');
            expect(powerUser.power_user[settingId]).toBe(!expectedDefault);
            expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        }
    });

    test('moves Android streaming settings into the Messages tab with the rest of streaming', () => {
        expect(settingsContentSource).toContain('\'[name="AndroidStreamingToggles"]\'');
    });

    test('routes reduced Android stream ticks through the plain-text preview path', () => {
        expect(scriptSource).toContain('shouldUsePlainTextStreamingPreview({');
        expect(scriptSource).toContain('isAndroidPlatform: isAndroidStreamingPreview');
        expect(scriptSource).toContain('formatMobileStreamingPreview(');
        expect(scriptSource).toContain('collapseOocBlocks: !preparedPreview?.isSystem');
        expect(scriptSource).toContain('sanitizeHtml: sanitizeMessageHtml');
    });
});
