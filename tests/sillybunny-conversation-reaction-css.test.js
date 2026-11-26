import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = name => parse(readFileSync(fileURLToPath(new URL(`../public/css/${name}`, import.meta.url)), 'utf8'), { source: name });
const conversation = read('sillybunny-conversation.css');
const actions = read('sillybunny-message-actions.css');

function declarationsOf(rules, selector) {
    const rule = rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    if (!rule) {
        throw new Error(`no rule for ${selector}`);
    }
    return Object.fromEntries(rule.declarations.filter(item => item.type === 'declaration').map(item => [item.property, item.value]));
}

const top = sheet => sheet.stylesheet.rules;
const coarse = sheet => top(sheet).filter(rule => rule.type === 'media' && rule.media === '(pointer: coarse)').flatMap(rule => rule.rules);

describe('the reaction chips', () => {
    test('show the pressed state with a ring and a heavier count as well as the tint, so colour is not the only cue', () => {
        const pressed = declarationsOf(top(conversation), '.sb-conversation-message-reaction-chip[aria-pressed=\'true\']');

        expect(pressed['border-color']).toBe('var(--sb-accent)');
        expect(pressed['font-weight']).toBe('var(--sb-weight-control)');
        expect(pressed.background).toContain('var(--sb-accent) 16%');
    });

    test('keep the body colour as their ink at rest and pressed, because a lighter ink on the tint fails the contrast floor on many themes', () => {
        expect(declarationsOf(top(conversation), '.sb-conversation-message-reaction-chip').color).toBe('var(--SmartThemeBodyColor)');
    });

    test('keep the count in the text font by drawing it apart from the emoji', () => {
        expect(declarationsOf(top(conversation), '.sb-conversation-reaction-count')).toHaveProperty('font-variant-numeric', 'tabular-nums');
        expect(declarationsOf(top(conversation), '.sb-conversation-reaction-emoji')).toHaveProperty('font-size');
    });

    test('grow to the density floor on a coarse pointer, with a hit area past the border and room between rows for it', () => {
        expect(declarationsOf(coarse(conversation), '.sb-conversation-message-reaction-chip')).toMatchObject({ 'min-block-size': 'var(--sb-density-floor)' });
        expect(declarationsOf(coarse(conversation), '.sb-conversation-message-reaction-chip::after')).toMatchObject({ position: 'absolute', inset: '-6px -2px' });
        expect(declarationsOf(coarse(conversation), '.sb-conversation-message-reactions')).toHaveProperty('row-gap', '12px');
    });

    test('hand a long press to the list of who reacted, not to the callout and the text selection of the browser', () => {
        const chip = declarationsOf(top(conversation), '.sb-conversation-message-reaction-chip');

        expect(chip['-webkit-touch-callout']).toBe('none');
        expect(chip['-webkit-user-select']).toBe('none');
        expect(chip['user-select']).toBe('none');
    });
});

describe('the reaction row of the menu', () => {
    test('is a grid of equal columns in the sheet, so that six emoji and More Reactions stay one row at any width', () => {
        expect(declarationsOf(top(actions), '.sb-action-sheet .sb-action-menu-reactions')).toMatchObject({
            display: 'grid',
            'grid-auto-flow': 'column',
            'grid-auto-columns': 'minmax(0, 1fr)',
        });
        expect(declarationsOf(top(actions), '.sb-action-sheet .sb-action-menu-reaction')).toMatchObject({ 'aspect-ratio': '1' });
    });

    test('is the same grid in a popover on a coarse pointer, where 44px cells do not fit a popover of 300px in a row of seven', () => {
        expect(declarationsOf(coarse(actions), '.sb-action-popover .sb-action-menu-reactions')).toMatchObject({ display: 'grid' });
    });

    test('stays a flex row of 32px cells in a popover with a fine pointer', () => {
        expect(declarationsOf(top(actions), '.sb-action-menu-reactions')).toMatchObject({ display: 'flex', gap: '4px' });
    });
});
