import { describe, expect, test } from '@jest/globals';
import { parse, stringify } from '@adobe/css-tools';

import { removeUnscopableCss } from '../../public/scripts/sillybunny-style-tag-scope.js';

/**
 * Parses CSS the way decodeStyleTags() does, removes what it cannot scope, and prints the result.
 * @param {string} cssText Message CSS
 * @returns {string} Compressed CSS that is left
 */
function scope(cssText) {
    const ast = parse(cssText);
    removeUnscopableCss(ast.stylesheet);
    return stringify(ast, { compress: true });
}

describe('removeUnscopableCss', () => {
    test('keeps the rules and at-rules that decodeStyleTags scopes or that hold no selectors', () => {
        const kept = [
            '.a{color:red;}',
            '@media (min-width:1px){.b{color:blue;}}',
            '@supports (display:grid){.c{display:grid;}}',
            '@container (min-width:1px){.d{color:red;}}',
            '@layer x{.e{color:red;}}',
            '@keyframes k{from{opacity:0;}to{opacity:1;}}',
            '@font-face{font-family:X;src:url(a.woff);}',
        ].join('');

        expect(scope(kept)).toBe(kept);
    });

    test.each([
        ['@property', '@property --SmartThemeBodyColor{syntax:"<length>";inherits:true;initial-value:0px;}'],
        ['@counter-style', '@counter-style c{system:cyclic;symbols:"x";}'],
        ['@position-try', '@position-try --p{top:0;}'],
        ['@view-transition', '@view-transition{navigation:auto;}'],
        ['@scope', '@scope (.x){.y{color:red;}}'],
        ['@font-feature-values', '@font-feature-values F{@swash{fancy:1;}}'],
        ['an unknown at-rule', '@unknown-rule x{.a{color:red;}}'],
    ])('removes %s, which would apply to the whole page', (_, atRule) => {
        expect(scope(`${atRule}.a{color:red;}`)).toBe('.a{color:red;}');
    });

    test('removes such at-rules inside a grouping at-rule', () => {
        expect(scope('@media (x){@property --y{syntax:"*";inherits:true;}.b{color:red;}}')).toBe('@media (x){.b{color:red;}}');
    });

    test.each([
        ['a nested rule', '.a{color:red;.b{color:blue;}}'],
        ['a nested at-rule', '.a{color:red;@media (x){color:blue;}}'],
        ['a nested rule that selects outside its parent', '.a{color:red;:root:has(&) #send_form{display:none;}}'],
        ['a page margin box', '@page{margin:0;@top-left{content:"x";}}'],
    ])('rejects %s', (_, cssText) => {
        expect(() => scope(cssText)).toThrow('Nested CSS rules are not supported');
    });

    test('accepts comments among declarations', () => {
        expect(scope('.a{/* note */color:red;}')).toBe('.a{color:red;}');
    });
});
