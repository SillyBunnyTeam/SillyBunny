import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../public/css/sillybunny-conversation.css', import.meta.url)), 'utf8');
const ast = parse(css, { source: 'sillybunny-conversation.css' });

function findMediaRule(predicate) {
    return ast.stylesheet.rules.find(rule => rule.type === 'media' && predicate(rule.media));
}

function getDeclarations(media, selector) {
    const rule = media.rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    expect(rule).toBeDefined();
    return Object.fromEntries(rule.declarations
        .filter(declaration => declaration.type === 'declaration')
        .map(declaration => [declaration.property, declaration.value]));
}

describe('Conversation mobile controls', () => {
    test('44px touch targets apply to coarse pointers and the 1000px project mobile breakpoint', () => {
        const media = findMediaRule(query => query.includes('pointer: coarse') && query.includes('max-width: 1000px'));
        expect(media).toBeDefined();
        // Comma-separated query: either condition alone is sufficient.
        expect(media.media).toMatch(/\(pointer: coarse\)\s*,\s*\(max-width: 1000px\)/);

        expect(getDeclarations(media, '.sb-conversation-selfie-action')).toMatchObject({
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
        expect(getDeclarations(media, '.sb-conversation-reply-cancel')).toMatchObject({
            'inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'block-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
    });

    test('touch-target sizing is not confined to the 768px phone breakpoint', () => {
        const phoneMedia = findMediaRule(query => query.includes('max-width: 768px') && !query.includes('pointer: coarse'));
        expect(phoneMedia).toBeDefined();
        const phoneSelectors = phoneMedia.rules
            .filter(rule => rule.type === 'rule')
            .flatMap(rule => rule.selectors);
        expect(phoneSelectors).not.toContain('.sb-conversation-selfie-action');
        expect(phoneSelectors).not.toContain('.sb-conversation-reply-cancel');
    });
});
