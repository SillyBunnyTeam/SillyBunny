import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parse } from '@adobe/css-tools';

const sheet = name => readFileSync(new URL(`../public/css/sillybunny-${name}.css`, import.meta.url), 'utf8');
const theme = sheet('theme');
const tabs = sheet('tabs');
const shell = sheet('editor-shell');

/** The declarations of every rule that has `selector` as one of its selectors, in source order, with the at-rules around it. */
function rulesFor(source, selector) {
    const found = [];
    const visit = (rules, context) => {
        for (const entry of rules) {
            if (entry.type === 'rule' && entry.selectors.includes(selector)) {
                found.push({ context, declarations: Object.fromEntries(entry.declarations.filter(item => item.type === 'declaration').map(item => [item.property, item.value])) });
            }
            if (entry.rules) visit(entry.rules, [...context, entry.media ?? entry.type]);
        }
    };
    visit(parse(source).stylesheet.rules, []);
    return found;
}

const declared = (source, selector, property, context = []) => rulesFor(source, selector)
    .filter(rule => rule.context.join('|') === context.join('|'))
    .map(rule => rule.declarations[property])
    .findLast(value => value !== undefined);

const strengthOf = value => Number(/color-mix\(in srgb, var\(--SmartThemeBodyColor\) (\d+)%, transparent\)/.exec(value)?.[1]);
const MORE = '(prefers-contrast: more)';
/** The declarations that a more-contrast block sets on the root for `property`. */
const moreRoot = property => rulesFor(theme, ':root').find(rule => rule.context.join() === MORE && rule.declarations[property] !== undefined).declarations;

describe('toggle group tokens', () => {
    test('the selected toggle is white at 20% on the dark tone and white on the light tone, over two soft shadows', () => {
        expect(declared(theme, ':root', '--sb-toggle-raised-bg')).toBe('rgb(255 255 255 / 20%)');
        expect(declared(theme, ':root[data-sb-surface-tone=\'light\']', '--sb-toggle-raised-bg')).toBe('#fff');
        expect(declared(theme, ':root', '--sb-toggle-raised-shadow')).toBe('0 1px 3px 1px rgb(0 0 6 / 7%), 0 2px 6px 2px rgb(0 0 6 / 3%)');
    });

    test('under more contrast the raised shadow carries a 1px ring at the border strength', () => {
        const more = moreRoot('--sb-toggle-raised-shadow');
        expect(more['--sb-shell-border']).toBe('color-mix(in srgb, var(--SmartThemeBodyColor) 50%, transparent)');
        expect(more['--sb-toggle-raised-shadow']).toMatch(/^inset 0 0 0 1px var\(--sb-shell-border\), 0 1px 3px 1px/);
    });

    test('the tray, the toggles and the selected toggle follow the shared rules and no id-led rule beats them', () => {
        expect(declared(theme, '.sb-boolean-radio-group', 'background')).toBe('var(--sb-raised-bg)');
        expect(declared(theme, '.sb-boolean-radio-group', 'padding')).toBe('3px');
        expect(declared(theme, '.sb-boolean-radio-option > span', 'font-weight')).toBe('700');
        expect(declared(theme, '.sb-boolean-radio-option > span', 'color')).toBe('var(--SmartThemeBodyColor)');
        expect(declared(theme, '.sb-boolean-radio-option > span', 'border-radius')).toBe('calc(var(--sb-radius-control) - 3px)');
        const checked = '.sb-boolean-radio-option > input[type="radio"]:checked + span';
        expect(declared(theme, checked, 'background')).toBe('var(--sb-toggle-raised-bg)');
        expect(declared(theme, checked, 'box-shadow')).toBe('var(--sb-toggle-raised-shadow)');
        const focus = '.sb-boolean-radio-option > input[type="radio"]:focus-visible + span';
        expect(declared(theme, focus, 'outline')).toBe('2px solid var(--sb-focus-ring-color)');
        expect(declared(theme, focus, 'outline-offset')).toBe('0');
        for (const name of ['prompt-editor', 'persona-detail', 'world-info-editor']) {
            expect(sheet(name)).not.toContain('sb-boolean-radio');
        }
    });

    test('a toggle keeps the 32px floor on a fine pointer and 44px on a coarse one', () => {
        expect(declared(theme, '.sb-segmented-control--compact .sb-boolean-radio-option > span', 'min-height')).toBe('32px');
        expect(declared(theme, '.sb-segmented-control--compact .sb-boolean-radio-option > span', 'min-height', ['(pointer: coarse)'])).toBe('var(--sb-mobile-touch-target)');
        expect(declared(tabs, '.ds-toggle-row__group .sb-boolean-radio-option > span', 'min-height', ['(pointer: coarse)'])).toBe('44px');
        expect(Number.parseInt(declared(tabs, '.ds-toggle-row__group--fill .sb-boolean-radio-option > span', 'min-height'), 10)).toBeGreaterThanOrEqual(32);
    });
});

describe('selection check tokens', () => {
    const outline = declared(theme, ':root', '--sb-selection-check-outline');
    const hover = declared(theme, ':root', '--sb-selection-check-outline-hover');
    const strong = moreRoot('--sb-selection-check-outline')['--sb-selection-check-outline'];

    test('the outline is the body colour at 15%, 20% hovered, and the check is a 28px circle with a 2px outline', () => {
        expect(strengthOf(outline)).toBe(15);
        expect(strengthOf(hover)).toBe(20);
        const check = '[data-selection-mode=\'true\'] .sb-selection-check';
        expect(declared(shell, check, '--sb-checkbox-size')).toBe('28px');
        expect(declared(shell, check, 'inline-size')).toBe('28px');
        expect(declared(shell, check, 'block-size')).toBe('28px');
        expect(declared(shell, check, 'border')).toBe('2px solid var(--sb-selection-check-outline)');
        expect(declared(shell, check, 'border-radius')).toBe('50%');
        expect(declared(shell, `${check}:not(:checked):not(:disabled):hover`, 'border-color', ['(hover: hover)'])).toBe('var(--sb-selection-check-outline-hover)');
    });

    test('under more contrast the outline takes the border strength, 50%, and 60% on hover, as libadwaita draws it', () => {
        expect(strengthOf(strong)).toBe(50);
        expect(strengthOf(moreRoot('--sb-selection-check-outline')['--sb-selection-check-outline-hover'])).toBe(60);
    });
});

describe('check at the start of its row', () => {
    test('only a switch row sends its control to the end; a check keeps its place and takes a gap', () => {
        expect(declared(tabs, '.ds-row-switch > input[type=\'checkbox\']', 'order')).toBe('1');
        expect(declared(tabs, '.ds-row-switch > input[type=\'checkbox\']', 'margin-inline-start')).toBe('auto');
        expect(rulesFor(tabs, '.ds-row-check > input[type=\'checkbox\']').every(rule => rule.declarations.order === undefined && rule.declarations['margin-inline-start'] === undefined)).toBe(true);
        expect(declared(tabs, '.ds-row-check > input[type=\'checkbox\']', 'margin-inline-end')).toBe('6px');
        expect(declared(tabs, ':is(.ds-row-switch, .ds-row-check) > input[type=\'checkbox\']', 'order')).toBeUndefined();
    });
});
