import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8').replace(/\r\n/g, '\n');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8').replace(/\r\n/g, '\n');
const styleCss = readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const characterEditorCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-character-editor.css'), 'utf8').replace(/\r\n/g, '\n');
const listCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-character-list.css'), 'utf8').replace(/\r\n/g, '\n');

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

    test('leaves the removed character editor action block out of the base stylesheet', () => {
        // The editor rebuild removed #avatar_controls and the button groups inside it; no markup builds them.
        for (const name of ['#avatar_controls', '.char-button-group', '.char-button-toolbar', '.sb-character-editor-side-actions', '.alternate_greeting_actions']) {
            expect(mobileShellCss).not.toContain(name);
        }
        // A SillyBunny marker comment names the removed selectors, so compare the rules only.
        const styleRules = styleCss.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const name of ['#avatar_controls', '.char-button-group', '.char-button-toolbar', '.sb-character-editor-side-actions']) {
            expect(styleRules).not.toContain(name);
        }
    });

    test('keeps the mobile editor action wrapper flattened in the late mobile shell', () => {
        const flattenedActionWrapperRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"]) #character-editor-pinned-actions');

        expect(flattenedActionWrapperRule).toContain('display: contents !important;');
    });

    test('keeps the retired hotswap band hidden instead of reserving editor space', () => {
        expect(getRuleBody(tabsCss, '#right-nav-panel > #CharListButtonAndHotSwaps')).toContain('display: none !important;');
        expect(mobileShellCss).not.toContain('#CharListButtonAndHotSwaps');
    });

    test('drops the retired editor sub-tab and spoiler-panel rules', () => {
        // The editor is one scrolling sheet; stale sub-tab rules would only fight the new layout.
        for (const source of [tabsCss, mobileShellCss]) {
            expect(source).not.toContain('sb-character-editor-subtab');
            expect(source).not.toContain('data-sb-character-editor-panel');
            expect(source).not.toContain('is-spoiler-hidden');
        }
    });

    test('keeps the desktop editor shell from reintroducing refactor padding and wrapper collapse', () => {
        expect(tabsCss).not.toContain('.sb-character-editor-controls-row');
        expect(tabsCss).not.toContain('.sb-character-create-bar');
        expect(listCss).toContain('.sb-character-list .sb-list-header__button');
        expect(characterEditorCss).toMatch(/\.sb-editor-toolbar\s*\{[^}]*display:\s*flex;/);
    });
});
