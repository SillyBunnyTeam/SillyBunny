import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('SillyBunny accent color profiles', () => {
    const indexSource = readSource('public', 'index.html');
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');
    const themeCssSource = readSource('public', 'css', 'sillybunny-theme.css');
    const seedBlock = powerUserSource.match(/const SILLYBUNNY_ACCENT_PROFILE_SEEDS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] ?? '';

    test('ships a generous seeded profile set by default', () => {
        const seedNames = [...seedBlock.matchAll(/name: '([^']+)'/g)].map(match => match[1]);

        expect(powerUserSource).toContain('const SB_ACCENT_PROFILE_SEED_VERSION = 2;');
        expect(powerUserSource).toContain('sb_accent_profiles: SILLYBUNNY_ACCENT_PROFILE_SEEDS.map(profile => ({ ...profile }))');
        expect(powerUserSource).toContain('sb_accent_profiles_seed_version: SB_ACCENT_PROFILE_SEED_VERSION');
        expect(powerUserSource).toContain('function normalizeAccentProfiles()');
        expect(seedNames).toHaveLength(30);
        expect(seedNames).toEqual(expect.arrayContaining([
            'Warm Signal',
            'Story Moss',
            'Rose Glow',
            'Tidepool',
            'Graphite Glow',
            'Aurora Veil',
            'Solar Flare',
            'Neptune',
        ]));
    });

    test('persists profiles in power_user and migrates seeds during settings load', () => {
        expect(powerUserSource).toContain('Object.hasOwn(settings.power_user, \'sb_accent_profiles_seed_version\')');
        expect(powerUserSource).toContain('power_user.sb_accent_profiles_seed_version = 0;');
        expect(powerUserSource).toContain('if (normalizeAccentProfiles()) {\n        saveSettingsDebounced();\n    }');
        expect(powerUserSource).toContain('power_user.sb_accent_profiles = normalizedProfiles;');
    });

    test('applies exactly the primary and secondary accent colors', () => {
        expect(powerUserSource).toContain('function applyAccentColors(quoteColor, underlineColor)');
        expect(powerUserSource).toContain('power_user.quote_text_color = quoteColor;');
        expect(powerUserSource).toContain('power_user.underline_text_color = underlineColor;');
        expect(powerUserSource).toContain('applyThemeColor(\'quote\');');
        expect(powerUserSource).toContain('applyThemeColor(\'underline\');');
        expect(powerUserSource).toContain('applyAccentColors(profile.quote_text_color, profile.underline_text_color);');
        expect(powerUserSource).toContain('syncCustomAccentPickersFromState();');
    });

    test('wires the appearance UI and responsive profile controls', () => {
        expect(indexSource).toContain('id="sb-accent-profile-save"');
        expect(indexSource).toContain('id="sb-accent-profiles-panel"');
        expect(indexSource).toContain('data-settings-tab="appearance"');
        expect(indexSource).toContain('id="sb-accent-profiles-list"');
        expect(indexSource).toContain('id="sb-accent-profiles-empty"');
        expect(indexSource).toContain('class="inline-drawer-toggle sb-accent-profiles-toggle"');
        expect(indexSource).toContain('class="inline-drawer-content sb-accent-profiles-content"');
        expect(indexSource).toContain('css/sillybunny-theme.css?v=');
        expect(powerUserSource).toContain('const SB_ACCENT_PROFILES_DRAWER_KEY = \'SBAccentProfilesDrawerExpanded\';');
        expect(powerUserSource).toContain('function bindSbAccentProfilesDrawerPersistence()');
        expect(powerUserSource).toContain('accountStorage.getItem(SB_ACCENT_PROFILES_DRAWER_KEY)');
        expect(powerUserSource).toContain('accountStorage.setItem(SB_ACCENT_PROFILES_DRAWER_KEY, String(Boolean(expanded)))');
        expect(powerUserSource).toContain('toggleDrawer(drawer, storedExpanded ?? false);');
        expect(powerUserSource).toContain('$(document).on(\'click\', \'#sb-accent-profile-save\'');
        expect(powerUserSource).toContain('$(document).on(\'click\', \'.sb-accent-profile-apply\'');
        expect(powerUserSource).toContain('$(document).on(\'click\', \'.sb-accent-profile-delete\'');
        expect(themeCssSource).toContain('.sb-accent-profiles-panel');
        expect(themeCssSource).toContain('.sb-accent-profiles-toggle');
        expect(themeCssSource).toContain('.sb-accent-profiles-content');
        expect(themeCssSource).toContain('grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));');
        expect(themeCssSource).toContain('@media screen and (max-width: 768px)');
        expect(themeCssSource).toContain('.sb-accent-profiles-list {\n        grid-template-columns: 1fr;\n    }');
    });
});
