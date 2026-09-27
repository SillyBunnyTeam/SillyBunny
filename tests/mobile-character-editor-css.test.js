import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8').replace(/\r\n/g, '\n');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8').replace(/\r\n/g, '\n');
const styleCss = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];
    const match = matches.at(-1);

    return match?.groups?.body ?? '';
}

function getLastRuleIndex(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];
    const match = matches.at(-1);

    return match?.index ?? -1;
}

describe('mobile character editor css', () => {
    test('keeps the favorite control in the name column on mobile', () => {
        expect(mobileShellCss).toContain(`grid-template-areas:
            'avatar name'
            'avatar side-actions'
            'icon-actions icon-actions'
            'tags tags';`);
    });

    test('stretches the mobile editor action rows before wrapping', () => {
        const avatarControlsRule = getRuleBody(styleCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls');
        const formButtonsRule = getRuleBody(styleCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls > .form_create_bottom_buttons_block,\n    #right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls .char-button-toolbar');
        const sideActionsRule = getRuleBody(styleCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) .sb-character-editor-side-actions');
        const iconActionsRule = getRuleBody(styleCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls .char-button-group-icons');

        expect(avatarControlsRule).toContain('grid-column: 1 / -1;');
        expect(avatarControlsRule).toContain('align-items: stretch;');
        expect(formButtonsRule).toContain('flex: 0 0 auto;');
        expect(sideActionsRule).toContain('max-width: 100%;');
        expect(sideActionsRule).toContain('justify-self: stretch;');
        expect(iconActionsRule).toContain('width: 100%;');
        expect(iconActionsRule).toContain('flex-wrap: wrap;');
        expect(iconActionsRule).toContain('overflow-x: visible;');
    });

    test('keeps the mobile editor action wrappers flattened in the late mobile shell', () => {
        const flattenedActionWrappersRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #character-editor-pinned-actions,\n    #right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls,\n    #right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls > .form_create_bottom_buttons_block,\n    #right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls .char-button-toolbar');

        expect(flattenedActionWrappersRule).toContain('display: contents !important;');
    });

    test('gives the tag input the full first row on mobile', () => {
        const tagControlsRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls > #tags_div .tag_controls');
        const tagDropdownRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls > #tags_div .tag_controls > label[for="char-management-dropdown"]');
        const tagDropdownSelectRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #avatar_controls #char-management-dropdown');

        expect(tagControlsRule).toContain('grid-template-columns: minmax(0, 1fr) auto;');
        expect(tagDropdownRule).toContain('grid-column: 1 / -1;');
        expect(tagDropdownRule).toContain('justify-self: stretch;');
        expect(tagDropdownRule).toContain('width: 100%;');
        expect(tagDropdownRule).toContain('max-width: 100%;');
        expect(tagDropdownSelectRule).toContain('width: 100%;');
        expect(tagDropdownSelectRule).toContain('max-width: 100%;');
    });

    test('keeps the parked mode toggle and close button clear of the editor sub-tabs on mobile', () => {
        const editorBandRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) > #CharListButtonAndHotSwaps');

        // The generic band rule is `min-height: 34px !important`; the toggle sits at top 8px with a 44px touch target.
        expect(editorBandRule).toContain('min-height: 54px !important;');
    });

    test('dims the spoiler-hidden editor sub-tabs without making them untappable', () => {
        const hiddenTabRule = getRuleBody(tabsCss, '#right-nav-panel .sb-character-editor-subtab.is-spoiler-hidden');

        expect(hiddenTabRule).toContain('opacity: 0.45;');
        // A tap on a dimmed tab reveals the fields, so nothing here may swallow the click or advertise a dead button.
        expect(hiddenTabRule).not.toContain('pointer-events');
        expect(hiddenTabRule).not.toContain('not-allowed');
        expect(tabsCss).not.toContain('.sb-character-editor-subtab[aria-disabled');
    });

    test('keeps the desktop editor shell from reintroducing refactor padding and wrapper collapse', () => {
        const desktopActionWrappersRule = getRuleBody(tabsCss, '#right-nav-panel .sb-character-editor-controls-row #character-editor-pinned-actions,\n#right-nav-panel .sb-character-editor-controls-row #avatar_controls,\n#right-nav-panel .sb-character-editor-controls-row #avatar_controls > .form_create_bottom_buttons_block,\n#right-nav-panel .sb-character-editor-controls-row #avatar_controls .char-button-toolbar');
        const desktopNavPaddingRule = getRuleBody(tabsCss, ':root:not([data-sb-desktop-nav-layout=\'vertical\']) #right-nav-panel.openDrawer .sb-character-shell-nav');
        const desktopCreateButtonSelector = '#right-nav-panel .sb-character-create-bar #rm_button_create,\n#right-nav-panel .sb-character-create-bar #rm_button_group_chats';
        const desktopCreateButtonRule = getRuleBody(tabsCss, desktopCreateButtonSelector);
        const unlayeredGuardIndex = tabsCss.indexOf('/* Unlayered fork cascade guards');
        const desktopCreateButtonIndex = getLastRuleIndex(tabsCss, desktopCreateButtonSelector);

        expect(tabsCss).toContain(`#right-nav-panel.openDrawer > .sb-character-shell-header {
    gap: 4px;
    padding: 8px calc(var(--sb-shell-panel-padding-inline) + 52px) 10px var(--sb-shell-panel-padding-inline);
}`);
        expect(desktopActionWrappersRule).toContain('display: contents !important;');
        expect(desktopNavPaddingRule).toContain('padding-inline: var(--sb-shell-panel-padding-inline) !important;');
        expect(desktopNavPaddingRule).not.toContain('60px');
        expect(desktopCreateButtonIndex).toBeGreaterThan(unlayeredGuardIndex);
        expect(desktopCreateButtonRule).toContain('inline-size: auto;');
        expect(desktopCreateButtonRule).toContain('min-inline-size: max-content;');
        expect(desktopCreateButtonRule).toContain('max-inline-size: none;');
        expect(desktopCreateButtonRule).toContain('padding: 0 var(--sb-shell-space-lg) !important;');
        expect(desktopCreateButtonRule).toContain('aspect-ratio: auto;');
    });
});
