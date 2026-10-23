import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileStylesCss = readFileSync(path.join(repoRoot, 'public', 'css', 'mobile-styles.css'), 'utf8').replace(/\r\n/g, '\n');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-shell.css'), 'utf8').replace(/\r\n/g, '\n');
const listCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-character-list.css'), 'utf8').replace(/\r\n/g, '\n');
const navigationCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-mobile-navigation.css'), 'utf8').replace(/\r\n/g, '\n');
const entityCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-entity-list.css'), 'utf8').replace(/\r\n/g, '\n');
const tabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-tabs.css'), 'utf8').replace(/\r\n/g, '\n');
const themeCss = readFileSync(path.join(repoRoot, 'public', 'css', 'sillybunny-theme.css'), 'utf8').replace(/\r\n/g, '\n');
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

describe('mobile character list header css', () => {
    test('retires the favorites strip while keeping the per-view favorite filter visible', () => {
        const strip = getRuleBody(tabsCss, '#right-nav-panel > #CharListButtonAndHotSwaps');
        expect(strip).toContain('display: none !important;');
        expect(getRuleBody(listCss, '#rm_characters_block > .sb-character-list .rm_tag_controls')).toContain('overflow: auto hidden;');
        expect(listCss).not.toMatch(/\.filterByFavorites\s*\{[^}]*display:\s*none/);
        expect(navigationCss).not.toContain('.sb-character-list-more-popover');
    });

    test('uses full touch targets and preserves hidden overflow actions', () => {
        expect(getRuleBodies(listCss, '.sb-character-list .sb-list-header__button').join('\n')).toContain('min-height: 44px;');
        expect(getRuleBody(listCss, '.sb-character-list [hidden]')).toContain('display: none !important;');
    });
});

describe('mobile character drawer entity row css', () => {
    test('lets tag-heavy rows grow instead of shrinking inside the scroller', () => {
        expect(getRuleBody(listCss, '.sb-character-list .ds-entity-row')).toContain('flex: 0 0 auto;');
        expect(getRuleBody(entityCss, '.ds-entity-row')).toContain('min-height: 52px;');
        expect(getRuleBodies(listCss, '.sb-character-list__box').join('\n')).toContain('overflow: auto;');
        expect(mobileShellCss).not.toContain('#rm_print_characters_block:not(.sb-character-list__rows)');
    });

    test('keeps shared-selection rows from shrinking inside the scroller', () => {
        expect(getRuleBody(listCss, '.sb-character-list .ds-entity-row')).toContain('flex: 0 0 auto;');
        expect(getRuleBody(listCss, '.sb-character-list .ds-entity-row.is-selection-selected')).toContain('background: var(--sb-flat-selected-bg);');
        expect(mobileStylesCss).not.toContain('#rm_print_characters_block:not(.sb-character-list__rows).bulk_select');
    });

    test('keeps retired list and toolbar presentation out of blocking and mobile CSS', () => {
        for (const source of [tabsCss, themeCss, mobileStylesCss, mobileShellCss, navigationCss]) {
            for (const selector of [':not(.sb-character-list__rows)', '.sb-character-create-bar', '.sb-character-list-bulk', '.sb-character-list-more-trigger', '.sb-character-favorites-label']) {
                expect(source).not.toContain(selector);
            }
            expect(source).not.toContain('#HotSwapWrapper');
        }
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
