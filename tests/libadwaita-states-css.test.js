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

    test('the disabled strength is one token: 50%, and 40% under prefers-contrast: more', () => {
        expect(themeCss).toMatch(/\n\s*--sb-disabled-opacity:\s*0\.5;/);
        expect(themeCss).toMatch(/@media \(prefers-contrast: more\) \{\n\s*:root,[^{]*\{\n\s*--sb-disabled-opacity:\s*0\.4;/);
    });

    test('a shared suggested button is the accent at the disabled strength', () => {
        const rest = bodies(themeCss, SHARED);
        expect(rest).toMatch(/background:\s*var\(--color-primary, var\(--sb-accent\)\);/);
        expect(rest).toMatch(/color:\s*var\(--sb-on-solid-accent\);/);
        expect(rest).toMatch(/opacity:\s*var\(--sb-disabled-opacity\);/);
    });

    test('the roleplay send button stays the accent when disabled or offline', () => {
        const SEND = '#rightSendForm > #send_but:is(:disabled, .disabled, [aria-disabled=\'true\']),\n#send_form.no-connection #rightSendForm > #send_but';
        const body = bodies(themeCss, SEND);
        expect(body).toMatch(/background:\s*var\(--sb-accent\) !important;/);
        expect(body).toMatch(/opacity:\s*var\(--sb-disabled-opacity\) !important;/);
        expect(body).not.toMatch(/--sb-raised-bg|--sb-muted-fg/);
    });

    test('the Conversation send button keeps its accent fill when disabled', () => {
        const SEND = '#sheld[data-sb-conversation-mode=\'on\'] #sb_conversation_send:disabled';
        const body = bodies(conversationCss, SEND);
        expect(body).toMatch(/opacity:\s*var\(--sb-disabled-opacity\);/);
        expect(body).not.toMatch(/background|--sb-raised-bg|--sb-muted-fg/);
    });

    test('the editor header actions fade to the disabled strength', () => {
        expect(bodies(editorCss, '.sb-editor-action.sb-editor-action:disabled')).toMatch(/opacity:\s*var\(--sb-disabled-opacity\);/);
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

describe('shell tokens: row fills, one disabled strength, the switch thumb', () => {
    const cssFiles = ['theme', 'tabs', 'editor-shell', 'entity-list', 'character-list', 'prompt-editor', 'world-info-editor', 'character-editor', 'persona-detail', 'conversation'];

    test('a row that activates hovers at 3% and presses at 8% of the body colour; flat buttons keep 7% and 16%', () => {
        expect(themeCss).toMatch(/--sb-row-hover-bg:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor\) 3%, transparent\);/);
        expect(themeCss).toMatch(/--sb-row-active-bg:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor\) 8%, transparent\);/);
        expect(themeCss).toMatch(/--sb-flat-hover-bg:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor\) 7%, transparent\);/);
        const shell = read('public/css/sillybunny-editor-shell.css');
        const selectors = '.ds-row--activatable:not(:disabled)';
        expect(bodies(shell, `${selectors}:active,\n.ds-row.ds-button-row:not(:disabled):active,\n.sb-status-page__action:not(:disabled):not(.is-suggested):active`)).toMatch(/background:\s*var\(--sb-row-active-bg\);/);
        expect(shell).toMatch(/\.ds-row--activatable:not\(:disabled\):hover,\n\s*\.ds-row\.ds-button-row:not\(:disabled\):hover,\n\s*\.sb-status-page__action:not\(:disabled\):not\(\.is-suggested\):hover \{\n\s*background: var\(--sb-row-hover-bg\);/);
        const entity = read('public/css/sillybunny-entity-list.css');
        expect(bodies(entity, '.ds-entity-row--activatable:active')).toMatch(/background:\s*var\(--sb-row-active-bg\);/);
        const characters = read('public/css/sillybunny-character-list.css');
        expect(characters).toMatch(/\.sb-character-list \.ds-entity-row--activatable:hover,\n\s*body\.charListGrid \.sb-character-list #rm_print_characters_block > \.ds-entity-row--activatable:hover \{\n\s*background: var\(--sb-row-hover-bg\);/);
    });

    test('no sheet draws a disabled control at 0.55, 0.58 or 0.6', () => {
        for (const name of cssFiles) {
            const css = read(`public/css/sillybunny-${name}.css`);
            // The pencil of a disabled entry row fades again to 30% on top of the row's own fade, so its 0.6 is not a disabled strength.
            // A prompt or World Info entry that is switched off is a state of the item, and its title needs the 0.6 to stay over 4.5:1.
            const stray = css.split(/\n(?=[^\s}@/][^{]*\{)/).filter(rule => /(?:disabled|insensitive|is-disabled)/.test(rule.split('{')[0]) && !rule.includes('__edit') && !/^\.sb-(?:wi|prompt)-row\.is-disabled/.test(rule) && /opacity:\s*0\.(?:55|58|6)\b/.test(rule));
            expect({ name, stray }).toEqual({ name, stray: [] });
        }
        expect(styleCss).not.toMatch(/input\[type="checkbox"\]:disabled \{[^}]*opacity:\s*0\.55/);
    });

    test('the off thumb of a switch is light on both tones', () => {
        expect(themeCss).toMatch(/--sb-switch-thumb-bg:\s*#fff;/);
        expect(bodies(themeCss, `${SWITCH}::after`)).toMatch(/background:\s*var\(--sb-switch-thumb-bg\);/);
        expect(bodies(themeCss, `${SWITCH}:checked::after`)).toMatch(/background:\s*var\(--sb-on-solid-accent/);
    });
});

describe('spacing scale for buttons, tabs and cards', () => {
    test('buttons and shell tabs pad 9px 12px', () => {
        expect(bodies(read('public/css/sillybunny-tabs.css'), '.sb-shell-tab')).toMatch(/padding:\s*9px 12px;/);
        expect(bodies(themeCss, '.sb-dialog .sb-dialog__response')).toMatch(/padding:\s*9px 12px;/);
        expect(bodies(read('public/css/sillybunny-windows.css'), '.sbGettingStartedHide')).toMatch(/padding:\s*9px 12px;/);
    });

    test('a settings card pads the container padding', () => {
        expect(themeCss).toMatch(/--sb-settings-card-padding:\s*var\(--sb-density-container-padding\);/);
    });
});

describe('header bars share one metric', () => {
    const tabsCss = read('public/css/sillybunny-tabs.css');
    const shellCss = read('public/css/sillybunny-editor-shell.css');

    test('every list header is the shared 60px bar with a 6px inset and gap', () => {
        const body = bodies(shellCss, '.sb-list-header');
        expect(body).toMatch(/height:\s*60px;/);
        expect(body).toMatch(/gap:\s*6px;/);
        expect(body).toMatch(/padding:\s*6px;/);
        expect(read('public/css/sillybunny-prompt-editor.css')).not.toMatch(/\.sb-prompt-list-header \{/);
        expect(read('public/css/sillybunny-world-info-editor.css')).not.toMatch(/\.sb-wi-list-header \{/);
    });

    test('settings bars, the subpage bar and the editor bar take the decided heights and the 6px inset', () => {
        expect(bodies(tabsCss, '#sb-settings-sidebar-header')).toMatch(/padding:\s*0 6px;[^]*min-height:\s*60px;[^]*gap:\s*6px;/);
        expect(bodies(tabsCss, '#sb-settings-content-header')).toMatch(/padding:\s*8px 6px;[^]*min-height:\s*60px;[^]*gap:\s*6px;/);
        expect(bodies(tabsCss, '.sb-subpage-detail-bar')).toMatch(/gap:\s*6px;[^]*min-height:\s*56px;[^]*padding:\s*0 6px;/);
        expect(bodies(read('public/css/sillybunny-character-editor.css'), '.sb-editor-header')).toMatch(/min-height:\s*60px;/);
    });

    test('the top bar insets 6px, gaps 6px and centres its row', () => {
        expect(tabsCss).toMatch(/--sb-topbar-padding-x:\s*6px;/);
        expect(tabsCss).toMatch(/#top-bar \{[^}]*align-items:\s*center;[^}]*gap:\s*6px;/);
        expect(bodies(tabsCss, '#sb-topbar-stack')).toMatch(/align-self:\s*flex-start;/);
    });

    test('a menu sheet handle is the shared 80px grab area with the cover strip behind it', () => {
        const handle = bodies(themeCss, ':is(#options, #extensionsMenu, #sd_dropdown, .actionButtonsModal)[data-sb-menu-sheet] > .sb-dialog__handle');
        expect(handle).toMatch(/inline-size:\s*80px;/);
        expect(handle).toMatch(/margin:\s*-6px auto 0;/);
        expect(bodies(themeCss, ':is(#options, #extensionsMenu, #sd_dropdown, .actionButtonsModal)[data-sb-menu-sheet] > .sb-dialog__handle::after')).toMatch(/background:\s*var\(--sb-layer-drawer\);/);
    });
});
