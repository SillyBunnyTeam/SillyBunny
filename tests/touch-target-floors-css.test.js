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
const readExtension = (name) => readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', name, 'style.css'), 'utf8').replace(/\r\n/g, '\n');

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

describe('touch target floors of the Quick Reply editor, the composer buttons, the pickers and the manager', () => {
    test('a select row\'s trigger is a box of the floor in both directions, with no coarse rule of its own', () => {
        const trigger = ruleBody(tabsCss, '.ds-select-row__trigger');
        expect(trigger).toContain('min-width: var(--sb-density-floor);');
        expect(trigger).toContain('min-height: var(--sb-density-floor);');
        expect(tabsCss).not.toMatch(/@media \(pointer: coarse\) \{\n {4}\.ds-select-row__trigger/);
    });

    test('the side panel\'s counters and the grips of the entity lists reach the floor', () => {
        const sidePanelCss = read('sillybunny-side-panel.css');
        expect(ruleBody(sidePanelCss, '.sb-side-panel input[type=\'number\']')).toContain('min-block-size: var(--sb-density-floor);');
        const grip = ruleBody(read('sillybunny-entity-list.css'), '.ds-entity-row__grip');
        expect(grip).toContain('flex: 0 0 var(--sb-density-floor);');
        expect(grip).toContain('min-height: var(--sb-density-floor);');
    });

    test('the extension manager\'s switch reaches the floor through its own ::before, inside its column and row', () => {
        const panelCss = read('extensions-panel.css');
        const reach = ruleBody(panelCss, '.extensions_info .extension_toggle input[type="checkbox"]::before');
        expect(reach).toContain('position: absolute;');
        // style.css draws the checkbox tick in this pseudo-element; the target must not show it.
        expect(reach).toContain('background: none;');
        expect(reach).toContain('clip-path: none;');
        // Never outside the column on the inline axis: `min(0px, ...)` only grows the box where the floor is larger than the switch.
        expect(reach).toContain('inset-inline: min(0px, calc((var(--sb-switch-width) - var(--sb-density-floor)) / 2));');
        expect(reach).toContain('inset-block: min(0px, calc((var(--sb-switch-height) - var(--sb-density-floor)) / 2));');
    });

    test('the Quick Reply editor\'s narrow-window actions, grips and option labels take the floor', () => {
        const css = readExtension('quick-reply');
        expect(ruleBody(css, '#qr--settings')).toContain('--qr--target: max(38px, var(--sb-density-floor, 38px));');
        const narrow = css.slice(css.indexOf('@media screen and (max-width: 600px) {\n  #qr--settings {'));
        expect(narrow.slice(0, narrow.indexOf('\n}\n'))).not.toContain('38px;');
        expect(css).toContain('grid-template-columns: var(--qr--target) minmax(0, 1fr) var(--qr--target);');
        const grip = ruleBody(css, '#qr--settings :is(.qr--setList > .qr--item, .qr--set-qrListContents > .qr--set-item .qr--content) > .drag-handle');
        expect(grip).toContain('min-inline-size: var(--sb-density-floor, 0px);');
        expect(grip).toContain('min-block-size: var(--sb-density-floor, 0px);');
        expect(ruleBody(css, '#qr--settings #qr--set-settings label')).toContain('min-block-size: var(--sb-density-floor, 0px);');
    });

    test('the Guided Generations and input history buttons never go under the floor, wide or narrow', () => {
        const gg = readExtension('guided-generations');
        const history = readExtension('input-history');
        expect(ruleBody(gg, '.gg-action-button')).toContain('--gg-action-size: max(var(--bottomFormBlockSize), var(--sb-density-floor, 0px));');
        expect(gg).toContain('--gg-mobile-action-size: max(var(--sb-density-floor, 28px), clamp(28px, calc(var(--bottomFormBlockSize) * 0.5), 34px));');
        expect(ruleBody(history, '.stih--buttons .stih--button')).toContain('--stih-action-size: max(var(--bottomFormBlockSize), var(--sb-density-floor, 0px));');
        expect(history).toContain('--stih-mobile-action-size: max(var(--sb-density-floor, 28px), clamp(28px, calc(var(--bottomFormBlockSize) * 0.5), 34px));');
    });

    test('the regex editor\'s checkbox rows take the floor', () => {
        const css = readExtension('regex');
        expect(ruleBody(css, '.regex_editor label.checkbox')).toContain('min-block-size: var(--sb-density-floor, 0px);');
    });
});
