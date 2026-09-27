import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const personaCss = readFileSync(path.join(repoRoot, 'public', 'css', 'personas.css'), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const tabsJs = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBodies(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gms'))];

    return matches.map(match => match.groups?.body ?? '');
}

describe('Persona Management mobile layout', () => {
    test('keeps the persona list vertical-only', () => {
        const rules = getRuleBodies(personaCss, '#persona_management_list_scroller').join('\n');

        expect(rules).toContain('overflow-y: auto;');
        expect(rules).toContain('overflow-x: hidden;');
        expect(rules).toContain('touch-action: pan-y;');
    });

    test('shrinks persona card content and wraps mobile actions', () => {
        const contentRules = getRuleBodies(personaCss, '#user_avatar_block:not(.gridView) .avatar-container .character_select_container').join('\n');
        const stateRules = getRuleBodies(personaCss, '#user_avatar_block:not(.gridView) .avatar-container .avatar_container_states').join('\n');

        expect(contentRules).toContain('grid-template-columns: minmax(0, 1fr);');
        expect(stateRules).toContain('min-width: 0;');
        expect(stateRules).toContain('flex-wrap: wrap;');
    });
});

describe('Scenario Notes disclosure', () => {
    test('starts collapsed with a plain final-prompt preview', () => {
        expect(indexHtml).toMatch(/<details class="persona-appendices-block"[^>]*>\s*<summary id="persona_appendices_heading"/);
        expect(indexHtml).not.toContain('<details open class="persona-appendices-block"');
        expect(indexHtml).not.toContain('<details class="persona-effective-preview">');
        expect(indexHtml).toContain('class="persona-effective-preview-title"');
    });

    test('the Scenario Notes shortcut opens the disclosure before focusing Add', () => {
        expect(tabsJs).toContain('const appendicesBlock = appendicesHeading?.closest(\'details\');');
        expect(tabsJs).toContain('appendicesBlock.open = true;');
        expect(tabsJs).toContain('addButton?.focus({ preventScroll: true });');
    });
});
