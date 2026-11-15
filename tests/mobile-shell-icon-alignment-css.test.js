import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8').replace(/\r\n/g, '\n');
const importCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-character-import.css'), 'utf8');
const editorShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-editor-shell.css'), 'utf8');

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

    test('the rebuilt Import drop area is a button row, so its contents are centred by the shared row and not by a rule of its own', () => {
        expect(importCss).not.toMatch(/\.sb-import-drop\s*\{/);
        const buttonRow = [...editorShellCss.matchAll(/\.ds-row\.ds-button-row\s*\{([^}]*)\}/g)].map(match => match[1]).join('\n');
        expect(buttonRow).toContain('justify-content: center;');
        expect(tabsCss).not.toContain('.sb-character-import-action');
    });
});
