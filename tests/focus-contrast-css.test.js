import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
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

describe('forced colours: the edge of a surface that draws it as a shadow ring', () => {
    const publicRoot = path.join(repoRoot, 'public');
    const sheets = [];
    const collect = directory => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!['lib', 'third-party', 'quick-image-gen'].includes(entry.name)) collect(entryPath);
            } else if (entry.name.endsWith('.css')) {
                sheets.push(entryPath);
            }
        }
    };
    collect(publicRoot);

    const splitSelectors = list => {
        const parts = [];
        let depth = 0;
        let current = '';
        for (const char of list) {
            if (char === '(' || char === '[') depth++;
            else if (char === ')' || char === ']') depth--;
            if (char === ',' && depth === 0) {
                parts.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        parts.push(current);
        return parts.map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    };

    const edgeMatch = forcedColorsBlocks.map(block => block.match(/:is\(\s*(\.sb-action-popover,[^{}]*?)\s*\) \{\s*outline: 1px solid CanvasText;\s*outline-offset: -1px;\s*\}/)).find(Boolean);
    const edgeRule = edgeMatch?.[0];
    const edgeSelectors = edgeMatch ? splitSelectors(edgeMatch[1]).sort() : [];

    // Flat rules only: a stylesheet nests no rule inside a style rule, and the at-rules around them are skipped by the pattern.
    const ringRules = sheets.flatMap(sheet => {
        const css = readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
            .filter(([, , body]) => /box-shadow:\s*var\(--sb-(shadow-popover|typeahead-shadow)\b/.test(body))
            .map(([, selector, body]) => ({ sheet: path.relative(repoRoot, sheet), selectors: splitSelectors(selector), body }));
    });

    // A drag helper is a copy of a row that is on the page already. A menu sheet is the same element as its popover.
    // The card of an in-app notification draws the popover ring too, and the rule for toasts above (`:is(#toast-container, #sb-toast-overlay) > div`) gives it its edge.
    const notSurfaces = new Set(['.ui-sortable-helper.ica--tpanel-agent', '#rm_group_members .group_member.ui-sortable-helper', ':is(#options, #extensionsMenu, #sd_dropdown, .actionButtonsModal)[data-sb-menu-sheet]', 'body #toast-container[class] > .sb-form-notification']);

    test('one rule in the theme sheet, inside forced-colors, draws a 1px inset outline in a system colour', () => {
        expect(edgeRule).toBeDefined();
        expect(edgeRule).toMatch(/\)\s*\{\s*outline: 1px solid CanvasText;\s*outline-offset: -1px;\s*\}/);
        expect(edgeSelectors.length).toBeGreaterThan(15);
    });

    test('every selector that uses the popover ring or the type-ahead ring is in that rule, unless it draws a border', () => {
        expect(ringRules.length).toBeGreaterThan(15);
        const missing = [];
        for (const { sheet, selectors, body } of ringRules) {
            const drawsBorder = /(^|[\s;])border(-width)?:\s*[1-9]/.test(body);
            for (const selector of selectors) {
                if (drawsBorder || notSurfaces.has(selector) || edgeSelectors.includes(selector)) continue;
                missing.push(`${sheet}: ${selector}`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('the toast rule gives the card of a notification its edge, so the card is not repeated in the popover rule', () => {
        expect(edgeSelectors).not.toContain('body #toast-container[class] > .sb-form-notification');
        const toastEdge = forcedColorsBlocks.join('\n').match(/:is\(#toast-container, #sb-toast-overlay\) > div \{\s*outline: 1px solid CanvasText;\s*outline-offset: -1px;\s*\}/);
        expect(toastEdge).not.toBeNull();
    });

    test('the action menu sheet and popover, which edge their frames with a ring, are in the rule', () => {
        expect(edgeSelectors).toEqual(expect.arrayContaining(['.sb-action-sheet', '.sb-action-popover']));
    });

    test('the rule lists no selector that no stylesheet gives the ring', () => {
        const ringSelectors = new Set(ringRules.flatMap(rule => rule.selectors));
        const sheetRing = sheets.map(sheet => readFileSync(sheet, 'utf8')).join('\n');
        const unknown = edgeSelectors.filter(selector => !ringSelectors.has(selector) && !sheetRing.includes(selector));
        expect(unknown).toEqual([]);
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
        ['sillybunny-tabs.css', '.sb-subpage-back:focus-visible', ring],
        ['sillybunny-tabs.css', '#sb-settings-page .sb-sampling-panel .sb-sampling-help-toggle:focus-visible', ring],
    ])('%s: %s draws the inset ring and no outline', (name, selector, expected) => {
        expect(declarationsOf(sheet(name), selector)).toBe(expected);
    });

    // Keyboard selection in a menu is a fill. Forced colours remove fills, so each row keeps a transparent outline that they repaint.
    test.each([
        ['sillybunny-message-actions.css', '.sb-action-menu-item:focus-visible'],
        ['sillybunny-editor-shell.css', '.sb-picker__option:focus-visible'],
        ['sillybunny-tabs.css', '.sb-mode-menu-item:focus-visible'],
        ['sillybunny-tabs.css', '.sb-persona-option:focus-visible'],
    ])('%s: %s selects with a fill, not the inset ring', (name, selector) => {
        const declarations = declarationsOf(sheet(name), selector);
        expect(declarations).toContain('background: var(--sb-flat-selected-bg);');
        expect(declarations).toContain('outline: 2px solid transparent;');
        expect(declarations).not.toContain('--sb-focus-ring-inset');
    });

    test('the composer menus (#options, #extensionsMenu, the Data Bank Add menu) select with the same fill', () => {
        const start = themeCss.indexOf('.actionButtonsModal > .actionButton):focus-visible {');
        expect(start).toBeGreaterThan(0);
        const declarations = blockAt(themeCss, start).replace(/\s+/g, ' ').trim();
        expect(declarations).toContain('background: var(--sb-flat-selected-bg) !important;');
        expect(declarations).toContain('outline: 2px solid transparent !important;');
        expect(declarations).not.toContain('--sb-focus-ring-inset');
    });

    test('the activatable rows of the editor shell, which the Extensions list rows are, draw the inset ring and no outline', () => {
        const css = sheet('sillybunny-editor-shell.css');
        expect(blockAt(css, css.indexOf('.ds-row--activatable:focus-visible,')).replace(/\s+/g, ' ').trim()).toBe(ring);
    });

    test.each([
        ['sillybunny-color-picker.css', '.sb-color-picker-menu input[type=\'range\']:focus-visible'],
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

describe('the focus ring colour', () => {
    test('one token holds the colour, and the inset ring is written with it', () => {
        expect(themeCss).toContain('--sb-focus-ring-color: color-mix(in srgb, var(--sb-focus-ring) 78%, transparent);');
        expect(themeCss).toContain('--sb-focus-ring-inset: inset 0 0 0 2px var(--sb-focus-ring-color);');
        expect(themeCss).toContain('--sb-entry-focus-border: var(--sb-focus-ring-color);');
        expect(themeCss).toContain('--sb-entry-focus-ring: inset 0 0 0 1px var(--sb-focus-ring-color);');
    });
});

describe('the outer ring on solid fills and pictures', () => {
    const sheet = name => read('public', 'css', name);
    const outerOutline = 'outline: 2px solid var(--sb-focus-ring-color); outline-offset: 1px;';
    const outer = `${outerOutline} box-shadow: none;`;
    const buttonFamily = '.menu_button:is(.menu_button_primary, .popup-button-ok, .suggested-action, .is-suggested, .red_button, .redWarningBG, .is-destructive:is(.popup-button-ok, .popup-button-custom, .sb-dialog__response)):not(.disabled):not(.is-disabled):not([disabled]):not([aria-disabled=\'true\']):focus-visible';

    test.each([
        ['one rule: suggested, primary, popup OK, status-page, Connections Connect and destructive buttons', 'sillybunny-theme.css', buttonFamily],
        ['the roleplay send button and the stop button that takes its place', 'sillybunny-theme.css', '#send_form.sb-generating-controls #mes_stop:focus-visible'],
        ['the legacy confirm popup\'s destructive OK', 'sillybunny-theme.css', '#dialogue_popup_controls > #dialogue_popup_ok:focus-visible'],
        ['the Conversation send button', 'sillybunny-conversation.css', '#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_send:focus-visible'],
        ['the Conversation edit Save button', 'sillybunny-conversation.css', '.sb-conversation-message-edit-save:focus-visible'],
        ['the primary editor action', 'sillybunny-character-editor.css', '.sb-editor-action.sb-editor-action.sb-editor-action--primary.sb-editor-action--primary:not(#sb-specificity):focus-visible'],
        ['the participant avatar', 'sillybunny-conversation.css', '.sb-conversation-participant-avatar.is-interactive:focus-visible'],
        ['the message avatar', 'sillybunny-conversation.css', '.sb-conversation-message-avatar:focus-visible'],
    ])('%s draws a 2px outline one pixel off the edge and no inset ring', (_label, name, selector) => {
        const declarations = declarationsOf(sheet(name), selector);
        expect(declarations).toContain(outerOutline);
        expect(declarations).toContain('box-shadow: none;');
        expect(declarations).not.toContain('--sb-focus-ring-inset');
        expect(declarations).not.toContain('!important');
    });

    test('the roleplay send rule lists #send_but with the stop button', () => {
        expect(sheet('sillybunny-theme.css')).toContain(`#send_but:focus-visible,\n#send_form.sb-generating-controls #mes_stop:focus-visible {\n    ${outer.replace(/; /g, ';\n    ')}\n}`);
    });

    test('the send button rule is the whole focus state: the stopgap fill change is gone', () => {
        const conversation = declarationsOf(sheet('sillybunny-conversation.css'), '#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_send:focus-visible');
        expect(conversation).toBe(outer);
        expect(conversation).not.toContain('background');
    });

    test('the Conversation day pill draws the same colour and offset on its checked accent fill', () => {
        const pill = declarationsOf(sheet('sillybunny-conversation.css'), '.sb-conversation-day-pill:focus-within');
        expect(pill).toBe('outline: 2px solid var(--sb-focus-ring-color); outline-offset: 1px;');
    });

    test('no outer ring rule outranks the forced-colours outline, which is important', () => {
        for (const [name, selector] of [
            ['sillybunny-theme.css', buttonFamily],
            ['sillybunny-conversation.css', '.sb-conversation-message-avatar:focus-visible'],
        ]) {
            expect(declarationsOf(sheet(name), selector)).not.toMatch(/outline[^;]*!important/);
        }
        expect(declarationsOf(forcedColorsBlocks.join('\n'), ':focus-visible')).toContain('outline: 2px solid Highlight !important;');
    });
});

describe('the focus ring inside the toast layer', () => {
    const fallbackStart = themeCss.indexOf('body #sb-toast-overlay {\n    --sb-focus-ring: currentColor;');
    const supportsStart = themeCss.indexOf('@supports (color: oklab(from red l a b))');

    test('the toast takes its own ink as the ring, and declares the two tokens that read it again', () => {
        expect(fallbackStart).toBeGreaterThan(-1);
        expect(blockAt(themeCss, fallbackStart).replace(/\s+/g, ' ').trim()).toBe('--sb-focus-ring: currentColor; --sb-focus-ring-color: color-mix(in srgb, var(--sb-focus-ring) 78%, transparent); --sb-focus-ring-inset: inset 0 0 0 2px var(--sb-focus-ring-color);');
    });

    test('where relative colours work, the ring is the light form of the accent, as libadwaita draws it', () => {
        expect(supportsStart).toBeGreaterThan(fallbackStart);
        const supports = blockAt(themeCss, supportsStart);
        expect(supports.replace(/\s+/g, ' ').trim()).toBe('body #sb-toast-overlay { --sb-focus-ring: oklab(from var(--sb-accent) max(l, 0.85) a b); }');
    });

    test('the Home toast action uses the ordinary inset ring', () => {
        expect(declarationsOf(read('public', 'css', 'sillybunny-home.css'), '.sbHomeToastAction:focus-visible')).toBe('outline: none; box-shadow: var(--sb-focus-ring-inset);');
    });
});

describe('popover edges', () => {
    // --sb-shadow-popover draws the edge as a ring, so a popover that also keeps a border draws it twice.
    test.each([
        ['sillybunny-persona-detail.css', '.sb-persona-property-popover'],
        ['sillybunny-world-info-editor.css', '.sb-wi-property-popover'],
        ['sillybunny-conversation.css', '#sheld[data-sb-conversation-mode=\'on\'] .sb-conversation-picker:not([hidden])'],
        ['sillybunny-tabs.css', '.sb-search-results'],
        ['sillybunny-tabs.css', '.sb-inline-select-picker-menu'],
        ['sillybunny-color-picker.css', '.sb-color-picker-menu'],
    ])('%s: %s has no border under the ring', (file, selector) => {
        const css = read('public', 'css', file);
        const rule = blockAt(css, css.indexOf(`\n${selector} {`));
        expect(rule).toContain('box-shadow: var(--sb-shadow-popover)');
        expect(rule).toMatch(/\n\s*border:\s*0;/);
    });
});
