import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');
const themeCss = read('public/css/sillybunny-theme.css');
const conversationCss = read('public/css/sillybunny-conversation.css');
const editorCss = read('public/css/sillybunny-character-editor.css');
const importCss = read('public/css/sillybunny-character-import.css');
const styleCss = read('public/style.css');

/**
 * Returns the declarations of every rule whose selector list is exactly `selector`, joined.
 * @param {string} css Stylesheet text
 * @param {string} selector Full selector text, as written before the opening brace
 * @returns {string} The rule bodies
 */
function bodies(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
    const found = [...css.matchAll(pattern)].map(match => match[1]);
    expect(found.length).toBeGreaterThan(0);
    return found.join('\n');
}

const SWITCH = 'input[type="checkbox"]:is(.sb-switch, .checkbox_label > *)';

describe('switch size', () => {
    test('one set of variables gives the 46x26 pill with a 20px thumb and 3px of padding', () => {
        expect(themeCss).toMatch(/--sb-switch-width:\s*46px;/);
        expect(themeCss).toMatch(/--sb-switch-height:\s*26px;/);
        expect(themeCss).toMatch(/--sb-switch-thumb:\s*20px;/);
        expect(themeCss).toMatch(/--sb-switch-padding:\s*3px;/);
    });

    test('compact mode is 38x22 with a 16px thumb, which leaves a 16px travel', () => {
        expect(bodies(themeCss, ':root[data-sb-compact-mode=\'true\']')).toMatch(/--sb-switch-width:\s*38px;[^]*--sb-switch-height:\s*22px;[^]*--sb-switch-thumb:\s*16px;/);
    });

    test('the row switch takes its size from the variables and its off trough is 15% of the body colour', () => {
        const body = bodies(themeCss, SWITCH);
        expect(body).toMatch(/width:\s*var\(--sb-switch-width\);/);
        expect(body).toMatch(/height:\s*var\(--sb-switch-height\);/);
        expect(body).toMatch(/min-width:\s*var\(--sb-switch-width\);/);
        expect(body).toMatch(/min-height:\s*var\(--sb-switch-height\);/);
        expect(body).toMatch(/background:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor\) 15%, transparent\);/);
        expect(body).toMatch(/-webkit-appearance:\s*none;/);
        expect(body).toMatch(/appearance:\s*none;/);
        expect(body).not.toMatch(/\b(?:42|24)px/);
    });

    test('the row switch thumb is 20px and travels with inset-inline-start so RTL mirrors', () => {
        const thumb = bodies(themeCss, `${SWITCH}::after`);
        expect(thumb).toMatch(/inline-size:\s*var\(--sb-switch-thumb\);/);
        expect(thumb).toMatch(/block-size:\s*var\(--sb-switch-thumb\);/);
        expect(thumb).toMatch(/inset-inline-start:\s*var\(--sb-switch-inset\);/);
        expect(thumb).toMatch(/transition:\s*inset-inline-start /);
        expect(bodies(themeCss, `${SWITCH}:checked::after`)).toMatch(/inset-inline-start:\s*var\(--sb-switch-inset-on\);/);
        expect(themeCss).not.toMatch(/translateX\((?:16|18)px\)/);
    });

    test('the settings suffix and the Prompt Editor slot share the variables, and the Conversation pane has no switch of its own', () => {
        // The pane's boolean rows are the shared .sb-switch rows (createSwitchRow), so no local switch is left to drift.
        expect(conversationCss).not.toContain('.sb-conversation-switch');

        const tabsCss = read('public/css/sillybunny-tabs.css');
        expect(bodies(tabsCss, '#sb-settings-page .ds-row-switch > .ds-row-suffix')).toMatch(/width:\s*var\(--sb-switch-width\);/);

        const promptCss = read('public/css/sillybunny-prompt-editor.css');
        expect(bodies(promptCss, '.sb-prompt-editor')).toMatch(/--sb-prompt-switch-width:\s*var\(--sb-switch-width\);/);
    });
});

describe('disabled suggested button', () => {
    const SHARED = '.menu_button:is(.menu_button_primary, .popup-button-ok, .suggested-action, .is-suggested):not(.is-destructive):is(.disabled, .is-disabled, [disabled], [aria-disabled=\'true\']):not(.is-busy):not([aria-busy=\'true\'])';

    test('a shared suggested button is the accent at 50% opacity, 40% under prefers-contrast: more', () => {
        const rest = bodies(themeCss, SHARED);
        expect(rest).toMatch(/background:\s*var\(--color-primary, var\(--sb-accent\)\);/);
        expect(rest).toMatch(/color:\s*var\(--sb-on-solid-accent\);/);
        expect(rest).toMatch(/opacity:\s*0\.5;/);
        expect(themeCss).toMatch(new RegExp(`@media \\(prefers-contrast: more\\) \\{\\n\\s*${SHARED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{\\s*opacity:\\s*0\\.4;`));
    });

    test('the roleplay send button stays the accent when disabled or offline', () => {
        const SEND = '#rightSendForm > #send_but:is(:disabled, .disabled, [aria-disabled=\'true\']),\n#send_form.no-connection #rightSendForm > #send_but';
        const body = bodies(themeCss, SEND);
        expect(body).toMatch(/background:\s*var\(--sb-accent\) !important;/);
        expect(body).toMatch(/opacity:\s*0\.5 !important;/);
        expect(body).not.toMatch(/--sb-raised-bg|--sb-muted-fg/);
        expect(themeCss).toMatch(/@media \(prefers-contrast: more\) \{\n\s*#rightSendForm > #send_but:is\(:disabled, \.disabled, \[aria-disabled='true'\]\),\n\s*#send_form\.no-connection #rightSendForm > #send_but \{\n\s*opacity:\s*0\.4 !important;/);
    });

    test('the Conversation send button keeps its accent fill when disabled', () => {
        const SEND = '#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_send:disabled';
        const body = bodies(conversationCss, SEND);
        expect(body).toMatch(/opacity:\s*0\.5;/);
        expect(body).not.toMatch(/background|--sb-raised-bg|--sb-muted-fg/);
        expect(conversationCss).toMatch(/@media \(prefers-contrast: more\) \{\n\s*#sheld\[data-sb-conversation-mode='on'\] #sb_conversation_send:disabled \{\n\s*opacity:\s*0\.4;/);
    });

    test('the editor header actions fade to 40% under prefers-contrast: more', () => {
        expect(editorCss).toMatch(/@media \(prefers-contrast: more\) \{\n\s*\.sb-editor-action\.sb-editor-action:disabled \{\n\s*opacity:\s*0\.4;/);
    });
});

describe('secondary and flat buttons', () => {
    const ENABLED = ':not(.disabled):not(.is-disabled):not([disabled]):not([aria-disabled=\'true\'])';

    test('a secondary button is raised: 10% at rest, 15% on hover, 30% pressed', () => {
        expect(bodies(themeCss, `.menu_button:not(.sb-status-page__action)${ENABLED},\n.menu_button_icon:not(.sb-status-page__action)${ENABLED}`)).toMatch(/background:\s*var\(--sb-raised-bg\);/);
        expect(bodies(themeCss, `.menu_button:not(.sb-status-page__action)${ENABLED}:hover,\n    .menu_button_icon:not(.sb-status-page__action)${ENABLED}:hover`)).toMatch(/background:\s*var\(--sb-raised-hover-bg\);/);
        expect(bodies(themeCss, `.menu_button:not(.sb-status-page__action)${ENABLED}:active,\n.menu_button_icon:not(.sb-status-page__action)${ENABLED}:active`)).toMatch(/background:\s*var\(--sb-raised-active-bg\);/);
    });

    test('a flat button is transparent at rest and takes the flat fills', () => {
        expect(bodies(themeCss, `.right_menu_button${ENABLED}:hover,\n    .drawer-icon.closedIcon${ENABLED}:hover`)).toMatch(/background:\s*var\(--sb-flat-hover-bg\);/);
        expect(bodies(themeCss, `.right_menu_button${ENABLED}:active,\n.drawer-icon.closedIcon${ENABLED}:active`)).toMatch(/background:\s*var\(--sb-flat-active-bg\);/);
    });
});

describe('tooltips', () => {
    test('a tooltip has 6px 10px padding and no shadow', () => {
        const body = bodies(themeCss, '.tooltip-inner');
        expect(body).toMatch(/padding:\s*6px 10px;/);
        expect(body).toMatch(/box-shadow:\s*none;/);
        expect(body).toMatch(/border:\s*1px solid color-mix\(in srgb, var\(--SmartThemeBodyColor\) 10%, transparent\);/);
    });
});

describe('links and text selection', () => {
    const LINK = 'a[href]:not([class], [role], [href^=\'#\'], [href^=\'javascript:\'])';

    test('a link is Accent and underlined, visited is Accent mixed 80% with the body colour', () => {
        const body = bodies(themeCss, LINK);
        expect(body).toMatch(/color:\s*var\(--sb-accent\);/);
        expect(body).toMatch(/text-decoration:\s*underline;/);
        expect(bodies(themeCss, `${LINK}:visited`)).toMatch(/color:\s*color-mix\(in srgb, var\(--sb-accent\) 80%, var\(--SmartThemeBodyColor\)\);/);
    });

    test('a link is brighter by 1.1 on hover under hover-capable pointers and returns to Accent when pressed', () => {
        expect(themeCss).toMatch(/@supports \(color: hsl\(from red h s l\)\) \{\n\s*@media \(hover: hover\) \{\n\s*a\[href\][^{]*:hover \{\n\s*color: hsl\(from var\(--sb-accent\) h calc\(s \* 1\.1\) calc\(l \* 1\.1\)\);/);
        expect(bodies(themeCss, `${LINK}:active`)).toMatch(/color:\s*var\(--sb-accent\);/);
    });

    test('selected text is the body colour at 10%, and Accent at 30% in the focused field', () => {
        expect(bodies(themeCss, '::selection')).toMatch(/background-color:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor\) 10%, transparent\);/);
        expect(themeCss).toMatch(/:is\(input, textarea\):focus::selection,[^{]*\{\s*background-color:\s*color-mix\(in srgb, var\(--sb-accent\) 30%, transparent\);/);
    });
});

describe('drop targets', () => {
    test('a dragged-over area has a 2px inset ring at 40% Accent and a 10% fill, with no dashed outline or pulse', () => {
        const body = bodies(styleCss, '.dragover');
        expect(body).toMatch(/outline:\s*2px solid color-mix\(in srgb, var\(--sb-accent, var\(--SmartThemeQuoteColor\)\) 40%, transparent\);/);
        expect(body).toMatch(/outline-offset:\s*-2px;/);
        expect(body).toMatch(/box-shadow:\s*inset 0 0 0 100vmax color-mix\(in srgb, var\(--sb-accent, var\(--SmartThemeQuoteColor\)\) 10%, transparent\);/);
        expect(body).not.toMatch(/dashed|animation|filter/);
        expect(styleCss).not.toMatch(/\.dragover\.no_animation/);
    });

    test('the import drop zone takes the same ring and fill when dragged over', () => {
        const body = bodies(importCss, '#sb-settings-page #sb_character_import_panel .sb-import-drop.is-dragover');
        expect(body).toMatch(/outline:\s*2px solid color-mix\(in srgb, var\(--sb-accent\) 40%, transparent\);/);
        expect(body).toMatch(/outline-offset:\s*-2px;/);
        expect(body).toMatch(/background:\s*color-mix\(in srgb, var\(--sb-accent\) 10%, var\(--sb-layer-view\)\);/);
        expect(body).not.toMatch(/border-color:\s*var\(--sb-accent\)/);
    });
});
