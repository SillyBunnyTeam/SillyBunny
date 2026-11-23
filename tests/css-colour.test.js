import { describe, expect, test } from '@jest/globals';

import { BASELINE_CONDITIONS, colourOf, contrastRatio, createScope, declaredValue, displayed, paint, parseStylesheet, rootCustomProperties, toHex } from './helpers/css-colour.js';

const scopeOf = (properties = {}) => createScope(new Map(Object.entries(properties)));
const channelsOf = (value, properties) => displayed(colourOf(value, scopeOf(properties)));

/*
 * The expected channels below were read back from Chromium 156, Firefox 157 and WebKit 27.2, which agree with each other,
 * except for the opaque Libadwaita layers, whose values are the ones that `sillybunny-theme.css` documents beside the
 * declaration of the layers.
 */
describe('the CSS colour resolver', () => {
    test('mixes in sRGB premultiplied by alpha, so a transparent colour weighs nothing', () => {
        const mixed = colourOf('color-mix(in srgb, rgba(0, 0, 0, 0.5) 50%, rgba(255, 255, 255, 1) 50%)', scopeOf());

        expect(mixed.alpha).toBeCloseTo(0.75, 6);
        expect(mixed.rgb[0]).toBeCloseTo(170, 6);
        expect(channelsOf('color-mix(in srgb, rgb(200, 100, 50) 25%, transparent)')).toEqual([200, 100, 50]);
        expect(colourOf('color-mix(in srgb, rgb(200, 100, 50) 25%, transparent)', scopeOf()).alpha).toBeCloseTo(0.25, 6);
    });

    test('mixes translucent colours with the weights that their alpha gives them', () => {
        const mixed = colourOf('color-mix(in srgb, rgba(200, 100, 50, 0.8) 30%, rgb(10 20 30 / 40%))', scopeOf());

        expect(mixed.rgb.map(channel => Number(channel.toFixed(2)))).toEqual([97.69, 56.92, 39.23]);
        expect(mixed.alpha).toBeCloseTo(0.52, 6);
    });

    test('takes the other percentage from the one that is given, and mixes in OKLab when asked to', () => {
        expect(channelsOf('color-mix(in srgb, #fff 14%, #336699)')).toEqual([80, 123, 167]);
        expect(channelsOf('color-mix(in oklab, rgb(200, 100, 50) 40%, rgb(10, 120, 230))')).toEqual([117, 122, 168]);
    });

    test('makes a mix opaque with rgb(from ... / 1), keeping the channels of the translucent mix', () => {
        const layer = 'rgb(from color-mix(in srgb, rgba(34, 34, 38, 0.9) 81%, rgba(255, 255, 255, 1) 19%) r g b / 1)';

        expect(colourOf(layer, scopeOf()).alpha).toBe(1);
        expect(toHex(channelsOf(layer))).toBe('#505053');
    });

    test('reproduces the layers of the bundled Libadwaita Dark theme that the stylesheet documents', () => {
        const properties = { '--body': 'rgba(255, 255, 255, 1)', '--blur': 'rgba(34, 34, 38, 0.9)' };

        expect(toHex(channelsOf('rgb(from color-mix(in srgb, var(--blur) 81%, var(--body) 19%) r g b / 1)', properties))).toBe('#505053');
        expect(toHex(channelsOf('rgb(from color-mix(in srgb, var(--blur) 91.8%, var(--body) 8.2%) r g b / 1)', properties))).toBe('#36363a');
    });

    test('lifts the lightness of a colour in OKLab and clips what is beyond the sRGB gamut', () => {
        const lift = (colour) => toHex(channelsOf(`oklab(from ${colour} max(l, 0.76) a b)`));

        expect(lift('#ff938c')).toBe('#ff938c');
        expect(lift('#78e9ab')).toBe('#78e9ab');
        expect(lift('#c30000')).toBe('#ff705c');
        expect(lift('#905400')).toBe('#e3a160');
        expect(lift('#007c3d')).toBe('#67c985');
    });

    test('scales saturation and lightness of hsl(from ...) without clamping the saturation before the conversion', () => {
        expect(toHex(channelsOf('hsl(from rgb(255, 191, 0) h calc(s * 1.1) calc(l * 1.1))'))).toBe('#ffcb0e');
    });

    test('reads currentColor from the context, and refuses it without one', () => {
        const fill = colourOf('color-mix(in srgb, currentColor 10%, transparent)', scopeOf(), { currentColour: { rgb: [10, 20, 30], alpha: 1 } });

        expect(fill.rgb).toEqual([10, 20, 30]);
        expect(fill.alpha).toBeCloseTo(0.1, 6);
        expect(() => colourOf('currentColor', scopeOf())).toThrow(/currentColor/);
    });

    test('follows var() chains and fallbacks, and refuses a property that is not defined', () => {
        const properties = { '--a': 'var(--b)', '--b': 'var(--c, #102030)', '--d': 'var(--missing)' };

        expect(toHex(channelsOf('var(--a)', properties))).toBe('#102030');
        expect(toHex(channelsOf('var(--missing, var(--also-missing, #010203))', properties))).toBe('#010203');
        expect(toHex(channelsOf('var(--d, #040506)', properties))).toBe('#040506');
        expect(() => colourOf('var(--missing)', scopeOf(properties))).toThrow(/not defined/);
        expect(() => colourOf('var(--loop)', scopeOf({ '--loop': 'var(--loop)' }))).toThrow(/refers to itself/);
    });

    test('lets an element override a custom property that its parent computed, without changing the parent', () => {
        const parent = scopeOf({ '--ink': '#111111', '--derived': 'var(--ink)' });
        const child = createScope(new Map([['--ink', '#222222']]), parent);

        expect(parent.get('--derived')).toBe('#111111');
        expect(child.get('--derived')).toBe('#111111');
        expect(child.get('--ink')).toBe('#222222');
    });

    test('refuses a colour construct that it does not know', () => {
        expect(() => colourOf('oklch(0.5 0.1 200)', scopeOf())).toThrow(/Only the relative form|Unsupported/);
        expect(() => colourOf('color-mix(in hsl, red 50%, blue)', scopeOf())).toThrow(/Unsupported colour space/);
        expect(() => colourOf('rebeccapurple', scopeOf())).toThrow(/Cannot read the colour/);
    });

    test('paints a translucent colour over an opaque one, and measures WCAG contrast of the 8-bit result', () => {
        expect(paint({ rgb: [255, 255, 255], alpha: 0.1 }, [0, 0, 0])).toEqual([26, 26, 26]);
        expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 6);
        expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
    });
});

describe('reading a stylesheet', () => {
    const sheet = parseStylesheet(`
        /* A comment with { braces } inside. */
        :root { --a: red; --b: "a;b" ; }
        :root[data-tone='light'] { --a: blue; }
        :root { --a: green; --c: url(data:image/png;base64,AAAA); }
        @supports (color: rgb(from black r g b / 1)) {
            :root { --d: rgb(from var(--a) r g b / 1); }
        }
        @supports (unknown-feature: 1) {
            :root { --d: unknown; }
        }
        .one, .two > .three { color: red; color: blue !important; color: green; }
        @media (hover: hover) { .one { color: gold; } }
    `);

    test('lets a rule of higher specificity beat a later rule, and a later rule beat an earlier one of the same', () => {
        expect(rootCustomProperties([sheet], { attributes: {} }).get('--a')).toBe('green');
        expect(rootCustomProperties([sheet], { attributes: { 'data-tone': 'light' } }).get('--a')).toBe('blue');
    });

    test('keeps strings and url() values whole, and drops comments', () => {
        const properties = rootCustomProperties([sheet], { attributes: {} });

        expect(properties.get('--b')).toBe('"a;b"');
        expect(properties.get('--c')).toBe('url(data:image/png;base64,AAAA)');
    });

    test('applies an at-rule only when its condition holds', () => {
        expect(rootCustomProperties([sheet], { attributes: {} }).get('--d')).toBe('rgb(from var(--a) r g b / 1)');
        expect(rootCustomProperties([sheet], { attributes: {}, conditions: new Set() }).has('--d')).toBe(false);
    });

    test('puts the inline style of the root element above every stylesheet rule', () => {
        expect(rootCustomProperties([sheet], { attributes: {}, inline: { '--a': 'purple' } }).get('--a')).toBe('purple');
    });

    test('finds the value of a rule by selector, the important one first and then the last', () => {
        expect(declaredValue([sheet], { selector: '.two > .three', property: 'color', conditions: new Set() })).toBe('blue');
        expect(declaredValue([sheet], { selector: '.one', property: 'color', conditions: BASELINE_CONDITIONS })).toBe('blue');
    });

    test('names the selector when no rule declares the property', () => {
        expect(() => declaredValue([sheet], { selector: '.missing', property: 'color' })).toThrow(/\.missing/);
    });
});
