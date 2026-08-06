import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBodies(selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...tabsCss.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];

    return matches.map(match => match.groups?.body ?? '');
}

function getRuleBody(selector) {
    return getRuleBodies(selector).at(-1) ?? '';
}

describe('mobile shell icon alignment css', () => {
    test('uses Font Awesome display variable for shell tab icon centering', () => {
        const tabIconRule = getRuleBodies('.sb-shell-tab i').find(rule => rule.includes('--fa-display: inline-flex;')) ?? '';

        expect(tabIconRule).toContain('--fa-display: inline-flex;');
        expect(tabIconRule).toContain('height: 18px;');
        expect(tabIconRule).toContain('align-items: center;');
        expect(tabIconRule).toContain('justify-content: center;');
    });

    test('keeps character import action icons centered inside their tiles', () => {
        const importIconRule = getRuleBody('.sb-character-import-action > i');

        expect(importIconRule).toContain('--fa-display: inline-flex;');
        expect(importIconRule).toContain('width: 48px;');
        expect(importIconRule).toContain('height: 48px;');
        expect(importIconRule).toContain('align-items: center;');
        expect(importIconRule).toContain('justify-content: center;');
    });
});
