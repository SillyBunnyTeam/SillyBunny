/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML/CSS contracts. */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importPowerUserModule } from './util/power-user-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const { powerUser, mocks } = await importPowerUserModule();

describe('SillyBunny accent profile compatibility', () => {
    const indexSource = readSource('public', 'index.html');
    const themeCssSource = readSource('public', 'css', 'sillybunny-theme.css');

    test('removes the unused Accent Profiles UI', () => {
        expect(indexSource).not.toContain('sb-accent-profiles-panel');
        expect(indexSource).not.toContain('Accent Profiles');
        expect(indexSource).not.toContain('sb-accent-profile-save');
        expect(powerUser.renderAccentProfiles).toBeUndefined();
        expect(powerUser.applyAccentProfile).toBeUndefined();
        expect(powerUser.saveAccentProfile).toBeUndefined();
        expect(powerUser.deleteAccentProfile).toBeUndefined();
        expect(themeCssSource).not.toContain('sb-accent-profiles-');
        expect(themeCssSource).not.toContain('sb-accent-profile-');
    });

    test('retains profile data, normalization on load, and persisted drawer key for legacy compatibility', async () => {
        expect(powerUser.SB_ACCENT_PROFILES_DRAWER_KEY).toBe('SBAccentProfilesDrawerExpanded');
        expect(Array.isArray(powerUser.power_user.sb_accent_profiles)).toBe(true);
        expect(powerUser.power_user.sb_accent_profiles.length).toBeGreaterThan(0);
        expect(typeof powerUser.power_user.sb_accent_profiles_seed_version).toBe('number');

        mocks.script.saveSettingsDebounced.mockClear();

        // Loading malformed/stale accent profile data normalizes it back to valid profiles and persists the repair.
        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    sb_accent_profiles: [{ id: 'broken' }, null],
                    sb_accent_profiles_seed_version: 0,
                },
            },
            { themes: [], context: [], instruct: [], sysprompt: [], reasoning: [] },
        );

        expect(Array.isArray(powerUser.power_user.sb_accent_profiles)).toBe(true);
        expect(powerUser.power_user.sb_accent_profiles.length).toBeGreaterThan(0);
        expect(powerUser.power_user.sb_accent_profiles.every(profile => typeof profile.name === 'string' && typeof profile.quote_text_color === 'string' && typeof profile.underline_text_color === 'string')).toBe(true);
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalled();
    });
});
