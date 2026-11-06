import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME_TEXT_REVISION } from '../public/scripts/sillybunny-theme-revisions.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const readJson = (...parts) => JSON.parse(readSource(...parts));

describe('libadwaita default theme motion', () => {
    test('ships motion enabled in the default settings and both libadwaita themes', () => {
        expect(readJson('default', 'content', 'settings.json').power_user.reduced_motion).toBe(false);
        expect(readJson('default', 'content', 'themes', 'Libadwaita.json').reduced_motion).toBe(false);
        expect(readJson('default', 'content', 'themes', 'Libadwaita Light.json').reduced_motion).toBe(false);
    });

    test('ships the bundled Libadwaita text colours in the default settings', () => {
        const defaults = readJson('default', 'content', 'settings.json').power_user;
        const theme = readJson('default', 'content', 'themes', 'Libadwaita.json');

        for (const key of ['main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color']) {
            expect(defaults[key]).toBe(theme[key]);
        }
    });

    test('seeds the text revision marker, because the default palette is already the revised one', () => {
        const defaults = readJson('default', 'content', 'settings.json').power_user;

        expect(defaults.sb_theme_text_revision).toBe(THEME_TEXT_REVISION);
    });

    test('enables motion when migrating the legacy Dark V 1.0 default to Libadwaita', () => {
        const source = readSource('public', 'scripts', 'power-user.js');
        const start = source.indexOf('if (power_user.theme === \'Dark V 1.0\') {');
        expect(start).toBeGreaterThan(-1);
        const block = source.slice(start, source.indexOf('saveSettingsDebounced();', start));

        expect(block).toContain('power_user.theme = \'Libadwaita\';');
        expect(block).toContain('power_user.reduced_motion = false;');
    });

    test('still lets the OS reduced-motion preference override the setting', () => {
        const source = readSource('public', 'scripts', 'power-user.js');
        expect(source).toMatch(/if \(osReduced\) \{\s*power_user\.reduced_motion = true;/);
    });
});
