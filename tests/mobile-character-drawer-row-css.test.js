import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileStylesCss = readFileSync(path.join(repoRoot, 'public', 'css', 'mobile-styles.css'), 'utf8').replace(/\r\n/g, '\n');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8').replace(/\r\n/g, '\n');
const worldInfoCss = readFileSync(path.join(repoRoot, 'public', 'css', 'world-info.css'), 'utf8').replace(/\r\n/g, '\n');
const worldInfoEditorCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-world-info-editor.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBodies(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gms'))];

    return matches.map(match => match.groups?.body ?? '');
}

function getRuleBody(cssSource, selector) {
    return getRuleBodies(cssSource, selector).at(-1) ?? '';
}

describe('mobile character drawer top row css', () => {
    test('keeps the favorites strip wide before the close control', () => {
        const rowRule = getRuleBody(mobileStylesCss, '#right-nav-panel #CharListButtonAndHotSwaps');
        const wrapperRule = getRuleBody(mobileStylesCss, '#right-nav-panel:not(:is([data-menu-type="character_edit"], [data-menu-type="create"], [data-menu-type="group_edit"], [data-menu-type="group_create"])) #CharListButtonAndHotSwaps > .flexFlowColumn.flex-container');
        const hotswapRule = getRuleBody(mobileStylesCss, '#right-nav-panel #HotSwapWrapper');
        const closeRule = getRuleBody(mobileStylesCss, '#right-nav-panel #sb-character-mobile-close');

        expect(rowRule).toContain('grid-template-columns: minmax(0, 1fr) var(--sb-mobile-touch-target, 44px);');
        expect(rowRule).toContain('padding: 6px var(--sb-character-mobile-edge, var(--sb-shell-panel-padding-inline, 12px));');
        expect(wrapperRule).toContain('display: none;');
        expect(hotswapRule).toContain('grid-column: 1;');
        expect(closeRule).toContain('grid-column: 2;');
    });

    test('uses full touch target controls in editor mode', () => {
        const editorRowRule = getRuleBody(mobileStylesCss, '#right-nav-panel:is([data-menu-type="character_edit"], [data-menu-type="create"], [data-menu-type="group_edit"], [data-menu-type="group_create"]) #CharListButtonAndHotSwaps');
        const editorWrapperRule = getRuleBody(mobileStylesCss, '#right-nav-panel:is([data-menu-type="character_edit"], [data-menu-type="create"], [data-menu-type="group_edit"], [data-menu-type="group_create"]) #CharListButtonAndHotSwaps > .flexFlowColumn.flex-container');
        const editorHotswapRule = getRuleBody(mobileShellCss, '#right-nav-panel.openDrawer:is([data-menu-type="character_edit"], [data-menu-type="create"], [data-menu-type="group_edit"], [data-menu-type="group_create"]) #HotSwapWrapper');
        const backRule = getRuleBody(mobileStylesCss, '#right-nav-panel:is([data-menu-type="character_edit"], [data-menu-type="create"], [data-menu-type="group_edit"], [data-menu-type="group_create"]) #sb-character-back-to-list');
        const closeRule = getRuleBody(mobileStylesCss, '#right-nav-panel:is([data-menu-type="character_edit"], [data-menu-type="create"], [data-menu-type="group_edit"], [data-menu-type="group_create"]) #sb-character-mobile-close');

        expect(editorRowRule).toContain('grid-template-columns: var(--sb-mobile-touch-target, 44px) minmax(0, 1fr) var(--sb-mobile-touch-target, 44px) var(--sb-mobile-touch-target, 44px);');
        expect(editorWrapperRule).toContain('grid-column: 1;');
        expect(editorHotswapRule).toContain('display: none !important;');
        expect(backRule).toContain('grid-column: 3;');
        expect(closeRule).toContain('grid-column: 4;');
    });
});

describe('mobile character drawer entity row css', () => {
    test('lets tag-heavy rows grow instead of shrinking inside the scroller', () => {
        const entityRowRules = getRuleBodies(
            mobileShellCss,
            '#right-nav-panel.openDrawer #rm_print_characters_block:not(.group_overlay_mode_select) > :is(.character_select, .group_select, .bogus_folder_select):not(.inline_avatar)',
        ).join('\n');

        expect(entityRowRules).toContain('flex: 0 0 auto;');
        expect(entityRowRules).toContain('overflow: hidden;');
    });

    test('keeps bulk-edit rows from shrinking inside the scroller', () => {
        const bulkEntityRowRule = getRuleBody(mobileStylesCss, '#rm_print_characters_block.bulk_select > :is(.character_select, .group_select)');

        expect(bulkEntityRowRule).toContain('flex: 0 0 auto;');
    });
});

describe('mobile embedded lorebook css', () => {
    test('lets the rebuilt editor own scrolling without legacy container or mobile overrides', () => {
        expect(worldInfoCss).not.toContain('@container sb-world-info');
        expect(worldInfoCss).not.toContain('#WorldInfo.sb-shell-embedded-content');
        expect(worldInfoCss).not.toContain('max-height: clamp(');
        expect(getRuleBody(worldInfoEditorCss, '.sb-wi-list-body')).toContain('overflow: auto;');
        expect(getRuleBody(worldInfoEditorCss, '#sb_character_world_info_panel:has(.sb-wi-editor-mounted)')).toContain('overflow: hidden;');
    });
});
