import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const name = 'sillybunny-conversation.css';
const sheet = parse(readFileSync(fileURLToPath(new URL(`../public/css/${name}`, import.meta.url)), 'utf8'), { source: name });
const top = sheet.stylesheet.rules;

function rulesFor(rules, selector) {
    return rules.filter(rule => rule.type === 'rule' && rule.selectors.includes(selector));
}

function declarationsOf(rules, selector) {
    const found = rulesFor(rules, selector);
    if (!found.length) {
        throw new Error(`no rule for ${selector}`);
    }
    return Object.fromEntries(found.flatMap(rule => rule.declarations.filter(item => item.type === 'declaration').map(item => [item.property, item.value])));
}

const allRules = rules => rules.flatMap(rule => (rule.type === 'media' ? allRules(rule.rules) : [rule]));
const selectorsMentioning = text => allRules(top).filter(rule => rule.type === 'rule' && rule.selectors.some(selector => selector.includes(text)));

describe('the Pinned mark', () => {
    test('is a pill under the bubble with the words in the body colour, the text size of the name row, and an outline in place of a tint, which no theme can put under the body colour', () => {
        const mark = declarationsOf(top, '.sb-conversation-message-pinned');

        expect(mark.display).toBe('inline-flex');
        expect(mark['border-radius']).toBe('var(--sb-radius-pill)');
        expect(mark.padding).toBe('3px 9px');
        expect(mark.border).toContain('var(--SmartThemeBodyColor) 26%');
        expect(mark.color).toBe('var(--SmartThemeBodyColor)');
        expect(mark['font-size']).toBe('var(--sb-type-meta)');
        expect(mark).not.toHaveProperty('background');
    });

    test('is never hidden by a rule of its own or by the rule that hides the name row of a message that continues a group', () => {
        const rules = selectorsMentioning('.sb-conversation-message-pinned');

        expect(rules.length).toBeGreaterThan(0);
        for (const rule of rules) {
            expect(rule.selectors.join(',')).not.toContain('show-header');
            for (const item of rule.declarations.filter(declaration => declaration.type === 'declaration')) {
                expect(`${item.property}:${item.value}`).not.toBe('display:none');
                expect(`${item.property}:${item.value}`).not.toBe('visibility:hidden');
            }
        }
    });

    test('replaces the thumbtack of the name row, which a message without a header never showed', () => {
        const thumbtack = /\.sb-conversation-message-pin(?![\w-])/;

        expect(allRules(top).some(rule => rule.type === 'rule' && rule.selectors.some(selector => thumbtack.test(selector)))).toBe(false);
    });
});

describe('the line that says a message was pinned', () => {
    test('is a centred row in the column of the timeline, like a day divider, that wraps its buttons under its text on a narrow screen', () => {
        const row = declarationsOf(top, '.sb-conversation-event');

        expect(row['align-self']).toBe('center');
        expect(row['inline-size']).toBe('min(100%, var(--sb-conv-column-width))');
        expect(row.display).toBe('flex');
        expect(row['flex-wrap']).toBe('wrap');
        expect(row['justify-content']).toBe('center');
        expect(row['font-size']).toBe('var(--sb-type-meta)');
    });

    test('holds its buttons in a group that wraps as one, centred, with the gap between the buttons on the scale', () => {
        const group = declarationsOf(top, '.sb-conversation-event-actions');

        expect(group.display).toBe('flex');
        expect(group['flex-wrap']).toBe('wrap');
        expect(group['justify-content']).toBe('center');
        expect(group.gap).toBe('6px');
    });

    test('has its text in the body colour, because secondary ink on the timeline is under the floor on some themes', () => {
        expect(declarationsOf(top, '.sb-conversation-event').color).toBe('var(--SmartThemeBodyColor)');
    });

    test('has flat pill buttons: transparent at rest so that their text is the body colour on the timeline, the flat fills under a pointer and when pressed, a target of the density floor (32px with a fine pointer, 44px with a coarse one), and the inset focus ring', () => {
        const button = declarationsOf(top, '.sb-conversation-event-action');

        expect(button['min-block-size']).toBe('var(--sb-density-floor, 32px)');
        expect(button['border-radius']).toBe('var(--sb-radius-pill)');
        expect(button.background).toBe('transparent');
        expect(button.color).toBe('var(--SmartThemeBodyColor)');
        expect(button['font-weight']).toBe('var(--sb-weight-control)');
        expect(declarationsOf(top, '.sb-conversation-event-action:active').background).toBe('var(--sb-flat-active-bg)');
        expect(declarationsOf(top, '.sb-conversation-event-action:focus-visible')['box-shadow']).toBe('var(--sb-focus-ring-inset)');

        const hover = top.filter(rule => rule.type === 'media' && rule.media === '(hover: hover)').flatMap(rule => rule.rules);
        expect(declarationsOf(hover, '.sb-conversation-event-action:hover').background).toBe('var(--sb-flat-hover-bg)');
    });

    test('is not animated, so that a reduced-motion setting has nothing to turn off', () => {
        for (const rule of selectorsMentioning('.sb-conversation-event')) {
            const properties = rule.declarations.filter(item => item.type === 'declaration').map(item => item.property);
            expect(properties).not.toContain('animation');
        }
    });

    test('is spaced with the values of the spacing scale', () => {
        const row = declarationsOf(top, '.sb-conversation-event');

        expect(row['margin-block']).toBe('12px 3px');
        expect(row.gap).toBe('6px 12px');
    });
});
