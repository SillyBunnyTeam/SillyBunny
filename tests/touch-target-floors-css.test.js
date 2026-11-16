import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, 'public', 'css', file), 'utf8').replace(/\r\n/g, '\n');
const themeCss = read('sillybunny-theme.css');
const tabsCss = read('sillybunny-tabs.css');
const promptEditorCss = read('sillybunny-prompt-editor.css');
const characterEditorCss = read('sillybunny-character-editor.css');

/** The declarations of the first rule whose selector list is exactly `selector`, at any nesting depth. */
function ruleBody(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    return match ? match[1] : null;
}

describe('touch target floors', () => {
    test('a range input is as tall as the target floor and draws a 4px trough in its middle', () => {
        const input = ruleBody(themeCss, 'input[type=\'range\'],\ninput[type=\'range\'].neo-range-slider');
        expect(input).toContain('height: var(--sb-density-floor);');
        expect(input).toMatch(/--sb-range-trough: linear-gradient\(.*\) center \/ 100% 4px no-repeat;/);
        expect(input).toContain('background: var(--sb-range-trough);');

        const neo = ruleBody(themeCss.slice(themeCss.indexOf('style.css pins the .neo-range-slider track')), 'input[type=\'range\'].neo-range-slider');
        expect(neo).toContain('height: var(--sb-density-floor) !important;');
        // style.css offsets the thin slider by 7px; on an element of the floor's height that offset would grow every row.
        expect(neo).toContain('margin: 0 !important;');
        expect(neo).toContain('background: var(--sb-range-trough) !important;');
    });

    test('the double-ended slider keeps its 4px element, whose fill is placed against it', () => {
        expect(ruleBody(themeCss, '.doubleRangeInputContainer > input[type=\'range\']')).toContain('height: 4px;');
        expect(ruleBody(themeCss, '.doubleRangeInputContainer > input[type=\'range\']:focus-visible')).toContain('outline-offset: 4px;');
    });

    test('the sampling and talkativeness sliders no longer carry their own track rules', () => {
        expect(tabsCss).not.toContain('.sb-sampling-panel input[type=\'range\'] {');
        expect(characterEditorCss).not.toContain('#talkativeness_slider');
    });

    test('the help links beside settings titles are the target floor, on the span as well as the anchor', () => {
        const body = ruleBody(themeCss, ':is(a.note-link-span, .notes-link:has(> .note-link-span), a.fa-circle-question, #regex_info_block_flags_hint)');
        expect(body).toContain('min-inline-size: var(--sb-density-floor);');
        expect(body).toContain('min-block-size: var(--sb-density-floor);');
    });

    test('a switch property is one label that is the target floor tall', () => {
        const body = ruleBody(promptEditorCss, 'label.sb-prompt-property');
        expect(body).toContain('min-block-size: var(--sb-density-floor);');
    });

    test('the token warning link and the connections chevron are boxes of the target floor', () => {
        const warning = ruleBody(characterEditorCss, '.sb-editor-tokens__warning');
        expect(warning).toContain('min-inline-size: var(--sb-density-floor);');
        expect(warning).toContain('min-block-size: var(--sb-density-floor);');

        const chevron = ruleBody(tabsCss, '#sb-settings-page .sb-connections-panel .sb-connections-expander .inline-drawer-icon');
        // The shared box of `.inline-drawer-icon` is at least the floor, and this rule does not shrink it.
        expect(chevron).not.toMatch(/(?:^|\s)(?:width|height|min-width|min-height|flex):/);
        expect(chevron).toContain('margin: calc(-1 * var(--sb-density-row-padding-block)) 0;');
        expect(ruleBody(themeCss, '.custom-drawer-icon,\n.inline-drawer-icon')).toContain('min-inline-size: var(--sb-inline-drawer-icon-size);');
    });
});
