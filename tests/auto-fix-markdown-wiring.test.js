import { describe, expect, test } from '@jest/globals';
import vm from 'node:vm';

import { autoFixMarkdown } from '../public/scripts/auto-fix-markdown.js';
import { loadDeclarations, readClientModule } from './util/load-declarations.js';

const { source, ast } = readClientModule('scripts/power-user.js');

function getFixMarkdownSource() {
    const node = ast.body.find(item => item.declaration?.id?.name === 'fixMarkdown');

    expect(node).toBeDefined();

    return source.slice(node.start, node.end);
}

describe('auto-fix markdown wiring', () => {
    test('power-user.js imports the auto-fix module', () => {
        expect(source).toContain('import { autoFixMarkdown } from \'./auto-fix-markdown.js\';');
    });

    test('fixMarkdown keeps its export and signature and delegates to the module', () => {
        const fixMarkdownSource = getFixMarkdownSource();

        expect(fixMarkdownSource).toMatch(/^export function fixMarkdown\(text, forDisplay\) \{/);
        expect(fixMarkdownSource).toContain('// SillyBunny:');
        expect(fixMarkdownSource).toContain('return autoFixMarkdown(text, forDisplay);');
        expect(fixMarkdownSource).not.toContain('[*_]{1,2}');
    });

    test('fixMarkdown passes the text and the display flag to the module', () => {
        const context = vm.createContext({ autoFixMarkdown });
        loadDeclarations(context, 'scripts/power-user.js', ['fixMarkdown']);
        const fixMarkdown = vm.runInContext('fixMarkdown', context);

        expect(fixMarkdown('*italic **bold and italic** italic*', true)).toBe('*italic **bold and italic** italic*');
        expect(fixMarkdown('*She smiles', true)).toBe('*She smiles*');
        expect(fixMarkdown('*She smiles', false)).toBe('*She smiles');
    });
});
