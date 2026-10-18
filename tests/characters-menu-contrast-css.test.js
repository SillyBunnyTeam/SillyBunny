import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parse } from '@adobe/css-tools';

const sheet = name => readFileSync(new URL(`../public/css/sillybunny-${name}.css`, import.meta.url), 'utf8');
const theme = sheet('theme');
const entities = sheet('entity-list');
const editor = sheet('character-editor');

function rule(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

function luminance(channels) {
    return channels.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

const mix = (first, second, weight) => first.map((value, index) => value * weight + second[index] * (1 - weight));
const contrast = (first, second) => (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);

function hoverRules(source) {
    const matches = [];
    const visit = (rules, hover = false) => {
        for (const entry of rules) {
            const guarded = hover || (entry.type === 'media' && /\(hover:\s*hover\)/.test(entry.media));
            for (const selector of entry.selectors ?? []) {
                if (selector.includes(':hover') && /sb-boolean-radio-option|menu_button_primary|popup-button-ok/.test(selector)) matches.push({ selector, guarded });
            }
            if (entry.rules) visit(entry.rules, guarded);
        }
    };
    visit(parse(source).stylesheet.rules);
    return matches;
}

describe('Characters menu contrast and token contracts', () => {
    test('segmented and primary hover fills require hover capability, not press state', () => {
        const matches = hoverRules(theme);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches.every(match => match.guarded)).toBe(true);
        expect(theme).toMatch(/\.menu_button\.menu_button_primary[^{}]*:active/);
    });

    test('keeps dark favorites gold and uses readable gold on light row states', () => {
        const scope = ':is(.sb-character-list, #rm_group_members, #rm_group_add_members)';
        expect(rule(entities, scope)).toContain('--sb-favorite-ink: var(--golden);');
        const light = rule(entities, `:root[data-sb-surface-tone='light'] ${scope}`);
        const weight = Number(light.match(/var\(--golden\)\s+(\d+)%/)?.[1]) / 100;
        const golden = [248, 211, 0];
        const body = [51, 51, 56];
        const ink = mix(golden, body, weight);
        expect(ink[0]).toBeGreaterThan(ink[1]);
        expect(ink[1]).toBeGreaterThan(ink[2]);
        for (const fill of [0, 0.07, 0.1, 0.13, 0.16]) {
            expect(contrast(ink, mix(body, [250, 250, 251], fill))).toBeGreaterThanOrEqual(4.5);
        }
    });

    test('selected compact modes use body ink and retain only an inset focus ring', () => {
        const selector = '.sb-segmented-control--compact .sb-boolean-radio-option > input';
        expect(rule(theme, `${selector}:checked + span`)).toContain('color: var(--SmartThemeBodyColor);');
        expect(rule(theme, `${selector}:focus-visible + span`)).toContain('outline: none;');
        expect(rule(theme, `${selector}:focus-visible + span`)).toContain('box-shadow: var(--sb-focus-ring-inset);');
    });

    test('migrated placeholders override the legacy important color', () => {
        for (const [source, selector] of [
            [editor, '.sb-editor-sheet .text_pole::placeholder'],
            [sheet('character-list'), '.sb-character-list .text_pole::placeholder'],
            [sheet('editor-shell'), '.sb-list-editor .text_pole::placeholder'],
        ]) {
            expect(rule(source, selector)).toContain('color: var(--sb-input-placeholder) !important;');
        }
        expect(rule(sheet('tag-manager'), '#tag_view_list .text_pole::placeholder')).toContain('color: var(--SmartThemeBodyColor) !important;');
        expect(rule(editor, '.ds-field-subtitle')).toContain('opacity: 1;');
    });

    test('tinted small text uses body ink rather than another alpha layer', () => {
        for (const selector of ['.ds-entity-row__badge', '.ds-entity-row:is(.is-selected, .is-selection-selected) .ds-entity-row__subtitle']) {
            expect(rule(entities, selector)).toContain('color: var(--SmartThemeBodyColor);');
        }
        expect(rule(entities, '.ds-entity-row__tags .tag.sb-tag-overflow')).toContain('color: var(--SmartThemeBodyColor) !important;');
        expect(rule(sheet('tag-manager'), '.sb-tag-manager .ds-entity-row__subtitle')).toContain('color: var(--SmartThemeBodyColor);');
    });

    test('editor chrome uses shared motion and prefixed sticky geometry', () => {
        expect(rule(editor, '.sb-editor-header')).toMatch(/position: -webkit-sticky;\s*position: sticky;/);
        expect(editor).toContain('visibility 0s linear var(--sb-duration-fast)');
        expect(editor).not.toContain('max-height 200ms ease');
        expect(theme).toContain('--sb-transition-fast: var(--sb-duration-fast)');
        expect(theme).not.toContain('transition: transform 100ms var(--sb-ease-out)');
        expect(rule(editor, '#right-nav-panel.openDrawer #rm_ch_create_block')).toContain('scrollbar-gutter: auto;');
        expect(rule(theme, '.select2-container--default .select2-results__options')).toContain('background-color: var(--sb-layer-popover);');
    });

    test('migrated cards and overlays use their own radius roles without decorative accent', () => {
        expect(rule(editor, '.sb-editor-sheet .ds-pref-group')).toContain('border-radius: var(--sb-radius-card);');
        expect(rule(sheet('editor-shell'), '.sb-list-editor .ds-pref-group')).toContain('border-radius: var(--sb-radius-card);');
        expect(sheet('character-import')).toContain('border-radius: var(--sb-radius-card);');
        expect(sheet('tag-manager')).not.toContain('--sb-radius-dialog');
        expect(sheet('tag-manager')).toContain('border-radius: var(--sb-radius-overlay) var(--sb-radius-overlay) 0 0;');
        expect(rule(sheet('tabs'), '.sb-character-editor-empty-icon')).toContain('color: var(--sb-muted-fg);');
    });
});
