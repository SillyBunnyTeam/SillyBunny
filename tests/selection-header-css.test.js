import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8');
const shell = read('public/css/sillybunny-editor-shell.css');
const LIST_SHEETS = [
    'public/css/sillybunny-character-list.css',
    'public/css/sillybunny-world-info-editor.css',
    'public/css/sillybunny-prompt-editor.css',
    'public/css/sillybunny-persona-editor.css',
    'public/scripts/extensions/in-chat-agents/style.css',
];
const ruleBody = (css, selector) => css.match(new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{(?<body>[^}]*)\\}`, 's'))?.groups?.body ?? '';

describe('the standalone selection header', () => {
    test('has one rule for every list, on the spacing scale', () => {
        const host = ruleBody(shell, '.sb-selection-header-host');
        expect(host).toContain('min-height: 60px;');
        expect(host).toContain('padding: 6px 9px;');
        const inner = ruleBody(shell, '.sb-selection-header-host .sb-selection-header');
        expect(inner).toContain('min-height: 48px;');
        expect(inner).toContain('gap: 3px;');
        expect(ruleBody(shell, '.sb-selection-header-host .sb-selection-title')).toContain('text-align: center;');
    });

    test.each(LIST_SHEETS)('%s does not restate it', file => {
        expect(read(file)).not.toMatch(/(?:sb-wi|sb-persona|sb-prompt|ica-agents)-selection-header|sb-character-list__selection-header/);
    });
});
