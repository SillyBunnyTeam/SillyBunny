import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('SillyBunny settings legacy CSS cleanup', () => {
    test('does not retain the retired admin-card presentation path', () => {
        const sources = [
            readSource('public', 'css', 'sillybunny-tabs.css'),
            readSource('public', 'css', 'sillybunny-mobile-shell.css'),
            readSource('public', 'css', 'mobile-styles.css'),
            readSource('public', 'scripts', 'sillybunny-settings-presentation.js'),
        ];

        expect(sources.join('\n')).not.toContain('sb-admin-card');
    });

    test('does not retain the retired server-tools card presentation path', () => {
        const sources = [
            readSource('public', 'scripts', 'sillybunny-server-tools.js'),
            readSource('public', 'scripts', 'sillybunny-data-security.js'),
            readSource('public', 'css', 'sillybunny-tabs.css'),
        ];

        expect(sources.join('\n')).not.toMatch(/sb-server-(?:card|grid|stat(?![-\w])|stat-label|actions)|sb-thumbnail-(?:card|controls|field)/);
    });
});
