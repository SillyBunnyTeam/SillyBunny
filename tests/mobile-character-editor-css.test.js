import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8').replace(/\r\n/g, '\n');
const styleCss = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gs'))];
    const match = matches.at(-1);

    return match?.groups?.body ?? '';
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
});
