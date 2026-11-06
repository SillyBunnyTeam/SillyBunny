import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8').replace(/\r\n/g, '\n');
const importCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-character-import.css'), 'utf8');

function getRuleBodies(selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...tabsCss.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];

    return matches.map(match => match.groups?.body ?? '');
}

describe('mobile shell icon alignment css', () => {
    test('uses Font Awesome display variable for shell tab icon centering', () => {
        const tabIconRule = getRuleBodies('.sb-shell-tab i').find(rule => rule.includes('--fa-display: inline-flex;')) ?? '';

        expect(tabIconRule).toContain('--fa-display: inline-flex;');
        expect(tabIconRule).toContain('height: 18px;');
        expect(tabIconRule).toContain('align-items: center;');
        expect(tabIconRule).toContain('justify-content: center;');
    });

    test('centers the rebuilt Import drop-zone contents in its deferred stylesheet, not retired tiles', () => {
        const zone = importCss.match(/\.sb-import-drop\s*\{([^}]+)\}/)[1];
        expect(zone).toContain('display: flex;');
        expect(zone).toContain('align-items: center;');
        expect(zone).toContain('justify-content: center;');
        expect(tabsCss).not.toContain('.sb-character-import-action');
    });
});
