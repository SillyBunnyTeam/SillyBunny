import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const readJson = (...parts) => JSON.parse(readSource(...parts));

describe('libadwaita default theme motion', () => {
    test('ships motion enabled in the default settings and both libadwaita themes', () => {
        expect(readJson('default', 'content', 'settings.json').power_user.reduced_motion).toBe(false);
        expect(readJson('default', 'content', 'themes', 'Libadwaita.json').reduced_motion).toBe(false);
        expect(readJson('default', 'content', 'themes', 'Libadwaita Light.json').reduced_motion).toBe(false);
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
