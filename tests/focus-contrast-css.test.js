import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8');
const themeCss = read('public', 'css', 'sillybunny-theme.css');

/** Returns the text between the braces of the at-rule that starts at `start`. */
function blockAt(css, start) {
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < css.length; index++) {
        if (css[index] === '{') depth++;
        else if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index);
    }
    throw new Error('Unbalanced block');
}

const forcedColorsBlocks = [...themeCss.matchAll(/@media \(forced-colors: active\)/g)].map(match => blockAt(themeCss, match.index));
const contrastMatches = [...themeCss.matchAll(/@media \(prefers-contrast: more\)/g)];
// Component rules have their own contrast blocks; the strengths of the Layer Ladder are the one block that sets tokens.
const tokenContrastMatches = contrastMatches.filter(match => blockAt(themeCss, match.index).includes('--sb-muted-fg:'));
const contrastBlocks = tokenContrastMatches.map(match => blockAt(themeCss, match.index));

/** Returns the declarations of the last rule whose selector line is exactly `selector`, as the cascade reads it. */
function declarationsOf(css, selector) {
    const starts = [...css.matchAll(new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`, 'gm'))];
    if (starts.length === 0) throw new Error(`No rule for ${selector}`);
    return blockAt(css, starts.at(-1).index).replace(/\s+/g, ' ').trim();
}

describe('forced colours', () => {
    const forced = forcedColorsBlocks.join('\n');

    test('every invalid field keeps a system-colour border that the id rules of Persona and the Tag Manager cannot override', () => {
        expect(declarationsOf(forced, ':is(input, textarea, select, .text_pole)[aria-invalid=\'true\']')).toBe('border: 3px double Mark !important;');
        expect(read('public', 'css', 'sillybunny-persona-detail.css')).toContain('.sb-persona-entry-name[aria-invalid=\'true\']');
        expect(read('public', 'css', 'sillybunny-tag-manager.css')).toContain('.sb-tag-manager__name[aria-invalid="true"]');
    });

    test('one shared rule draws a Highlight outline on every focus, because forced colours remove the box-shadow ring', () => {
        expect(declarationsOf(forced, ':focus-visible')).toBe('outline: 2px solid Highlight !important; outline-offset: -2px !important;');
    });
});

describe('prefers-contrast: more', () => {
    test('the theme sheet has one token block, and it holds the stronger strengths of the Layer Ladder', () => {
        expect(contrastBlocks).toHaveLength(1);
        const [block] = contrastBlocks;
        expect(block).toContain(':root[data-sb-theme=\'clean-minimal\']');
        expect(block).toContain(':root[data-sb-surface-tone=\'light\']');
        expect(block).toContain('--sb-muted-fg: color-mix(in srgb, var(--SmartThemeBodyColor) 90%, transparent);');
        expect(block).toContain('--sb-shell-border: color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent);');
        expect(block).toContain('--sb-input-border: color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent);');
        expect(block).toContain('--sb-shadow-dialog-highlight: inset 0 0 0 1px color-mix(in srgb, var(--SmartThemeBodyColor) 30%, transparent);');
        expect(block).toContain('--sb-shadow-card:');
    });

    test('the block comes after the definitions it overrides, so it wins at equal specificity', () => {
        const blockStart = tokenContrastMatches[0].index;
        for (const definition of [
            '--sb-shell-border: color-mix(in srgb, var(--SmartThemeBorderColor) 70%, transparent);',
            '--sb-muted-fg: color-mix(in srgb, var(--SmartThemeBodyColor) 74%, transparent);',
            '--sb-input-border: color-mix(in srgb, var(--SmartThemeBorderColor) 92%, transparent);',
            '--sb-shadow-dialog-highlight: inset 0 0 0 1px color-mix(in srgb, var(--SmartThemeBodyColor) 7%, transparent);',
        ]) {
            expect(themeCss.lastIndexOf(definition)).toBeLessThan(blockStart);
        }
    });
});

describe('focus outlines', () => {
    const sheet = name => read('public', 'css', name);
    const ring = 'outline: none; box-shadow: var(--sb-focus-ring-inset);';

    test.each([
        ['sillybunny-message-actions.css', '#chat .mes :is(.mes_buttons .mes_button, .extraMesButtons > div):focus-visible', 'opacity: 1; ' + ring],
        ['sillybunny-side-panel.css', '.sb-side-panel__menu-item:focus-visible', ring],
        ['sillybunny-tabs.css', '.sb-mode-menu-item:focus-visible', ring],
        ['sillybunny-tabs.css', '.sb-persona-option:focus-visible', ring],
        ['sillybunny-tabs.css', '.sb-subpage-row:focus-visible', ring],
        ['sillybunny-tabs.css', '.sb-subpage-back:focus-visible', ring],
        ['sillybunny-tabs.css', '#sb-settings-page .sb-sampling-panel .sb-sampling-help-toggle:focus-visible', ring],
    ])('%s: %s draws the inset ring and no outline', (name, selector, expected) => {
        expect(declarationsOf(sheet(name), selector)).toBe(expected);
    });

    test.each([
        ['sillybunny-color-picker.css', '.sb-color-picker-menu input[type=\'range\']:focus-visible'],
        ['sillybunny-conversation.css', '.sb-conversation-switch:focus-visible'],
        ['sillybunny-conversation.css', '.sb-conversation-participant-avatar.is-interactive:focus-visible'],
        ['sillybunny-conversation.css', '.sb-conversation-message-avatar:focus-visible'],
        ['sillybunny-home.css', '.sbHomeToastAction:focus-visible'],
    ])('%s: %s keeps its outline and removes the inset ring that would stack with it', (name, selector) => {
        const declarations = declarationsOf(sheet(name), selector);
        expect(declarations).toMatch(/outline: 2px solid /);
        expect(declarations).toContain('box-shadow: none;');
    });

    test('the range outline of the theme sheet also removes the inset ring', () => {
        const start = themeCss.indexOf('input[type=\'range\'].neo-range-slider:focus-visible {');
        expect(blockAt(themeCss, start)).toContain('box-shadow: none;');
    });
});
