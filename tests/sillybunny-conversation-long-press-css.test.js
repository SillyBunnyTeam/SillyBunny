import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const conversation = parse(readFileSync(fileURLToPath(new URL('../public/css/sillybunny-conversation.css', import.meta.url)), 'utf8'), { source: 'sillybunny-conversation.css' });

const top = conversation.stylesheet.rules;
const coarse = top.filter(rule => rule.type === 'media' && rule.media === '(pointer: coarse)').flatMap(rule => rule.rules);

function declarationsOf(rules, selector) {
    const rule = rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    if (!rule) {
        throw new Error(`no rule for ${selector}`);
    }
    return Object.fromEntries(rule.declarations.filter(item => item.type === 'declaration').map(item => [item.property, item.value]));
}

describe('the message of the conversation under a long press with a finger', () => {
    test('has the callout of iOS and the selecting of text off, with the -webkit- companion that Safari 16 needs', () => {
        const message = declarationsOf(coarse, '.sb-conversation-message');

        expect(message['-webkit-touch-callout']).toBe('none');
        expect(message['-webkit-user-select']).toBe('none');
        expect(message['user-select']).toBe('none');
    });

    test('keeps the callout of a link, and the text of a field selectable, because Safari cannot type into a field under user-select none', () => {
        expect(declarationsOf(coarse, '.sb-conversation-message a[href]')['-webkit-touch-callout']).toBe('default');
        const field = declarationsOf(coarse, '.sb-conversation-message :is(textarea, input, [contenteditable])');

        expect(field['-webkit-user-select']).toBe('text');
        expect(field['user-select']).toBe('text');
    });

    test('does not let an image be dragged by the press', () => {
        expect(declarationsOf(coarse, '.sb-conversation-message img')['-webkit-user-drag']).toBe('none');
    });

    test('leaves a pointer that is fine as it was: no rule outside the coarse block turns the selecting of the message off', () => {
        const outside = top.filter(rule => rule.type === 'rule' && rule.selectors.includes('.sb-conversation-message'));

        for (const rule of outside) {
            const properties = rule.declarations.filter(item => item.type === 'declaration').map(item => item.property);
            expect(properties).not.toContain('user-select');
            expect(properties).not.toContain('-webkit-user-select');
            expect(properties).not.toContain('-webkit-touch-callout');
        }
    });
});
