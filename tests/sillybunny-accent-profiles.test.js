import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('SillyBunny accent profile compatibility', () => {
    const indexSource = readSource('public', 'index.html');
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');
    const themeCssSource = readSource('public', 'css', 'sillybunny-theme.css');

    test('removes the unused Accent Profiles UI', () => {
        expect(indexSource).not.toContain('sb-accent-profiles-panel');
        expect(indexSource).not.toContain('Accent Profiles');
        expect(indexSource).not.toContain('sb-accent-profile-save');
        expect(powerUserSource).not.toMatch(/renderAccentProfiles|applyAccentProfile|saveAccentProfile|deleteAccentProfile|sb-accent-profile-/);
        expect(themeCssSource).not.toContain('sb-accent-profiles-');
        expect(themeCssSource).not.toContain('sb-accent-profile-');
    });

    test('retains profile data and persisted drawer state for legacy compatibility', () => {
        expect(powerUserSource).toContain('sb_accent_profiles: SILLYBUNNY_ACCENT_PROFILE_SEEDS.map(profile => ({ ...profile }))');
        expect(powerUserSource).toContain('sb_accent_profiles_seed_version: SB_ACCENT_PROFILE_SEED_VERSION');
        expect(powerUserSource).toContain('function normalizeAccentProfiles()');
        expect(powerUserSource).toContain('power_user.sb_accent_profiles = normalizedProfiles;');
        expect(powerUserSource).toContain('export const SB_ACCENT_PROFILES_DRAWER_KEY = \'SBAccentProfilesDrawerExpanded\';');
        expect(powerUserSource).toContain('if (normalizeAccentProfiles()) {\n        saveSettingsDebounced();\n    }');
    });
});
