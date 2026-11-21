import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    RULE_IDS,
    buildBaseline,
    listStylesheets,
    maskCss,
    scanCss,
    scanDesignRules,
} from '../scripts/audit-design-rules.js';

const temporaryRoots = [];
afterEach(() => temporaryRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function counts(css) {
    const result = scanCss(css).counts;
    return Object.fromEntries(Object.entries(result).filter(([, count]) => count > 0));
}

function treeFixture(files, upstream = []) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-design-rules-'));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/fixtures/upstream-origin-public-files.json'), JSON.stringify(upstream));
    for (const [file, css] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), css);
    }
    return root;
}

function cli(root, ...args) {
    return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/audit-design-rules.js', import.meta.url)), '--root', root, ...args], { encoding: 'utf8' });
}

describe('masking and parsing', () => {
    test('keeps offsets and newlines while blanking comments, strings and unquoted urls', () => {
        const source = '/* a\nb */ .x { content: "k;{}"; background: url(a;b.png); }\n';
        const masked = maskCss(source);
        expect(masked).toHaveLength(source.length);
        expect(masked.split('\n')).toHaveLength(source.split('\n').length);
        expect(masked).not.toMatch(/k;|a;b/);
        expect(masked).toContain('.x { content: "____"');
    });

    test('reads nothing from comments, strings and data urls that look like rules', () => {
        const css = `
.a::before { content: "}{ color: #fff; border-radius: 4px !important"; }
/* .x:hover { color: red; border-radius: 3px !important; text-transform: uppercase } */
.b { background: url(data:image/svg+xml;utf8,<svg fill='#fff'/>); }
.c { background: url("data:image/svg+xml;utf8,<svg fill='red'/>"); }
[data-x="a{b"] { color: var(--x); }
#abc, #fff { color: var(--x); }
`;
        expect(counts(css)).toEqual({});
    });

    test('reports the line of each declaration and of each hover selector', () => {
        const css = '.a {\n    color: #fff;\n}\n\n.b,\n.c:hover {\n    margin: 0;\n}\n';
        const { findings } = scanCss(css);
        expect(findings.map(({ rule, line }) => [rule, line])).toEqual([['color-literal', 2], ['hover-ungated', 6]]);
        expect(findings[1].detail).toBe('.c:hover');
    });

    test('reads declarations before and after a nested rule, and custom properties with braces', () => {
        const css = '.a { color: red; .b { color: blue; } border-radius: 4px; }\n.c { --x: { color: red }; letter-spacing: 1px; }';
        expect(counts(css)).toEqual({ 'color-literal': 2, 'radius-literal': 1, 'letter-spacing': 1 });
    });
});

describe('color-literal', () => {
    test('counts hex, functions and named colours, each literal once', () => {
        expect(counts('.a { color: #fff; }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { background: #0000; }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { border: 1px solid rgba(0, 0, 0, 0.2); }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { color: hsl(10 50% 50%); }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { color: red; }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { background: linear-gradient(to right, red, #000); }')).toEqual({ 'color-literal': 2 });
        expect(counts('.a { filter: drop-shadow(0 0 2px White); }')).toEqual({ 'color-literal': 1 });
    });

    test('does not count keywords, system colours, channel forms or relative colours', () => {
        expect(counts('.a { color: transparent; border-color: currentColor; outline-color: Highlight; background: Canvas; }')).toEqual({});
        expect(counts('.a { color: rgb(var(--x) / 0.5); background: rgba(var(--x), 0.2); }')).toEqual({});
        expect(counts('.a { color: rgb(from var(--x) r g b / 0.5); }')).toEqual({});
        expect(counts('.a { color: var(--SmartThemeBodyColor); transition: color 0s; }')).toEqual({});
    });

    test('counts a literal in color-mix() and a literal alpha next to var channels as literals', () => {
        expect(counts('.a { color: color-mix(in srgb, var(--a) 70%, red); }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { color: color-mix(in srgb, #fff 10%, transparent); }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a { color: rgba(0, 0, 0, var(--alpha)); }')).toEqual({ 'color-literal': 1 });
    });

    test('counts var() fallbacks apart from direct literals, nested fallbacks included', () => {
        expect(counts('.a { color: var(--x, #fff); }')).toEqual({ 'color-literal-fallback': 1 });
        expect(counts('.a { color: var(--x, var(--y, rgb(1 2 3))); }')).toEqual({ 'color-literal-fallback': 1 });
        expect(counts('.a { background: linear-gradient(var(--x, red), blue); }')).toEqual({ 'color-literal': 1, 'color-literal-fallback': 1 });
    });

    test('does not count literals in custom-property definitions or at-rule preludes', () => {
        expect(counts(':root { --a: #fff; --b: rgb(1 2 3); --c: color-mix(in srgb, red, blue); }')).toEqual({});
        expect(counts('@media (prefers-color-scheme: dark) { .a { color: var(--x); } }')).toEqual({});
    });

    test('does not count white and black as operands of color-mix(), but counts other named colours there and white elsewhere', () => {
        expect(counts('.a { color: color-mix(in srgb, var(--a) 86%, white 14%); background: color-mix(in srgb, black calc(0.85 * 65%), currentColor); }')).toEqual({});
        expect(counts('.a { color: color-mix(in srgb, color-mix(in srgb, var(--a), white), black); }')).toEqual({});
        expect(counts('.a { color: color-mix(in srgb, red 50%, white); border-color: white; }')).toEqual({ 'color-literal': 2 });
    });

    test('does not count the stops of a mask, which only read alpha', () => {
        expect(counts('.a { mask-image: linear-gradient(black, rgba(0, 0, 0, 0.5)); -webkit-mask-image: radial-gradient(#000, transparent); }')).toEqual({});
    });

    test('ignores colour-looking words in properties that take no colour', () => {
        expect(counts('.a { animation: gold var(--d) var(--e); font-family: Tan, serif; transition: background-color var(--t); }')).toEqual({});
        expect(counts('.a { animation-name: red; content: "white"; will-change: color; }')).toEqual({});
    });

    test('ignores #fff inside url() and reads uppercase property names and values', () => {
        expect(counts('.a { background: url(#fff); mask-image: url(#red); }')).toEqual({});
        expect(counts('.a { COLOR: #FFF; Border-Radius: 8PX; TEXT-TRANSFORM: UPPERCASE; Font-Style: ITALIC; LETTER-SPACING: 1PX; }')).toEqual({
            'color-literal': 1, 'radius-literal': 1, uppercase: 1, italic: 1, 'letter-spacing': 1,
        });
    });
});

describe('radius-literal', () => {
    test('counts literal lengths and percentages, not tokens, zero or keywords', () => {
        expect(counts('.a { border-radius: var(--sb-radius-card); }')).toEqual({});
        expect(counts('.a { border-radius: 0; border-top-left-radius: 0px; border-radius: inherit; }')).toEqual({});
        expect(counts('.a { border-radius: var(--sb-radius-card) var(--sb-radius-card) 0 0; }')).toEqual({});
        expect(counts('.a { border-radius: 8px; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 0 0 12px 12px; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-start-start-radius: 4px; -webkit-border-radius: 4px; }')).toEqual({ 'radius-literal': 2 });
        expect(counts('.a { border-radius: var(--sb-radius-card) 4px 0 0; }')).toEqual({ 'radius-literal': 1 });
    });

    test('treats calc() on a token as a token and keeps the literal bounds of clamp()', () => {
        expect(counts('.a { border-radius: calc(var(--sb-radius-card) - 2px); }')).toEqual({});
        expect(counts('.a { border-radius: clamp(10px, calc(11px * var(--scale)), 14px); }')).toEqual({ 'radius-literal': 1 });
    });

    test('counts a literal in a var() fallback as radius-literal-fallback, once per declaration', () => {
        expect(counts('.a { border-radius: var(--sb-radius-card, 12px); }')).toEqual({ 'radius-literal-fallback': 1 });
        expect(counts('.a { border-radius: var(--a, 4px) var(--b, 4px) 0 0; }')).toEqual({ 'radius-literal-fallback': 1 });
        expect(counts('.a { border-radius: var(--a, var(--b, 4px)); }')).toEqual({ 'radius-literal-fallback': 1 });
        expect(counts('.a { border-radius: var(--a, 0); }')).toEqual({});
        expect(counts('.a { border-radius: var(--a, var(--b)); }')).toEqual({});
    });

    test('applies radius-over-20 to the plain literal only', () => {
        expect(counts('.a { border-radius: var(--a, 30px); }')).toEqual({ 'radius-literal-fallback': 1 });
        expect(counts('.a { border-radius: 30px var(--a, 30px); }')).toEqual({ 'radius-literal': 1, 'radius-over-20': 1, 'radius-literal-fallback': 1 });
    });

    test('counts pills and circles as literals but never as over 20px', () => {
        expect(counts('.a { border-radius: 999px; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 9999px; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 99px; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 50%; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 100%; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 50em; }')).toEqual({ 'radius-literal': 1 });
    });

    test('counts radii above 20px that are not pills in the over-20 sub-count', () => {
        expect(counts('.a { border-radius: 20px; }')).toEqual({ 'radius-literal': 1 });
        expect(counts('.a { border-radius: 22px; }')).toEqual({ 'radius-literal': 1, 'radius-over-20': 1 });
        expect(counts('.a { border-radius: 1.65rem; }')).toEqual({ 'radius-literal': 1, 'radius-over-20': 1 });
        expect(counts('.a { border-top-left-radius: 24px; }')).toEqual({ 'radius-literal': 1, 'radius-over-20': 1 });
        expect(counts('.a { border-radius: 8px 30px; }')).toEqual({ 'radius-literal': 1, 'radius-over-20': 1 });
    });
});

describe('shadow-literal', () => {
    test('accepts none, css-wide keywords and layers that are one shadow or focus token', () => {
        expect(counts('.a { box-shadow: none; }')).toEqual({});
        expect(counts('.a { box-shadow: var(--sb-shadow-popover); }')).toEqual({});
        expect(counts('.a { box-shadow: var(--sb-focus-ring-inset), var(--sb-shadow-control); }')).toEqual({});
        expect(counts('.a { box-shadow: var(--sb-composer-focus-ring, 0 0 0 1px red); }')).toEqual({ 'color-literal-fallback': 1 });
        expect(counts('.a { box-shadow: inherit; }')).toEqual({});
    });

    test('counts a declaration with any layer that is not a token', () => {
        expect(counts('.a { box-shadow: 0 1px 2px var(--SmartThemeShadowColor); }')).toEqual({ 'shadow-literal': 1 });
        expect(counts('.a { box-shadow: var(--sb-focus-ring-inset), 0 0 2px var(--x); }')).toEqual({ 'shadow-literal': 1 });
        expect(counts('.a { -webkit-box-shadow: inset 0 0 0 1px var(--x); }')).toEqual({ 'shadow-literal': 1 });
        expect(counts('.a { box-shadow: var(--panel-edge); }')).toEqual({ 'shadow-literal': 1 });
    });

    test('matches whole name segments of the token, not substrings', () => {
        expect(counts('.a { box-shadow: var(--sb-spring-sheet); }')).toEqual({ 'shadow-literal': 1 });
        expect(counts('.a { box-shadow: var(--sb-unfocused); }')).toEqual({ 'shadow-literal': 1 });
        expect(counts('.a { box-shadow: var(--sb-shaded); }')).toEqual({ 'shadow-literal': 1 });
        expect(counts('.a { box-shadow: var(--ring); }')).toEqual({});
        expect(counts('.a { box-shadow: var(--sb-headerbar-shade); }')).toEqual({});
        expect(counts('.a { box-shadow: var(--SB-FOCUS-RING); }')).toEqual({});
    });
});

describe('duration-literal', () => {
    test('counts each non-zero literal time in transition and animation', () => {
        expect(counts('.a { transition: color var(--sb-transition-fast); }')).toEqual({});
        expect(counts('.a { transition: color 0.2s; }')).toEqual({ 'duration-literal': 1 });
        expect(counts('.a { transition: a 150ms var(--sb-ease), b 200ms; }')).toEqual({ 'duration-literal': 2 });
        expect(counts('.a { animation: spin 1s linear infinite; }')).toEqual({ 'duration-literal': 1 });
        expect(counts('.a { animation-delay: 0.2s; transition-duration: 120ms; }')).toEqual({ 'duration-literal': 2 });
        expect(counts('.a { -webkit-transition: opacity 0.15s; }')).toEqual({ 'duration-literal': 1 });
    });

    test('counts both the duration and the delay of an animation with two times', () => {
        expect(counts('.a { animation: spin 1s linear 0.5s infinite; }')).toEqual({ 'duration-literal': 2 });
        expect(counts('.a { animation: spin var(--d) linear 0.5s; }')).toEqual({ 'duration-literal': 1 });
    });

    test('puts the guard threshold at 1ms: 1ms is a guard, 1.5ms is a literal', () => {
        expect(counts('.a { transition-duration: 1ms; animation-duration: 0.001s; }')).toEqual({});
        expect(counts('.a { transition-duration: 1.5ms; }')).toEqual({ 'duration-literal': 1 });
    });

    test('counts a literal in a var() fallback as duration-literal-fallback', () => {
        expect(counts('.a { transition: transform var(--x, 200ms) steps(4, end); }')).toEqual({ 'duration-literal-fallback': 1 });
        expect(counts('.a { transition: a var(--x, 1s), b var(--y, var(--z, 2s)); }')).toEqual({ 'duration-literal-fallback': 2 });
        expect(counts('.a { transition: a var(--x, 150ms) 200ms; }')).toEqual({ 'duration-literal': 1, 'duration-literal-fallback': 1 });
        expect(counts('.a { transition: a var(--x, 0s); }')).toEqual({});
    });

    test('accepts zero, the instant guard time, tokens, easings and animation names with digits', () => {
        expect(counts('.a { transition: none; transition-duration: 0s; animation-duration: 0ms; }')).toEqual({});
        expect(counts('.a { transition-duration: 0.01ms !important; animation-duration: 0.01ms; }')).toEqual({ important: 1 });
        expect(counts('.a { transition: opacity calc(var(--d) * 2) cubic-bezier(0.25, 0.1, 0.25, 1); }')).toEqual({});
        expect(counts('.a { animation: fade-in-3s var(--sb-transition); }')).toEqual({});
    });
});

describe('letter-spacing, uppercase, italic', () => {
    test('counts non-zero letter-spacing, including a token', () => {
        expect(counts('.a { letter-spacing: 0.06em; }')).toEqual({ 'letter-spacing': 1 });
        expect(counts('.a { letter-spacing: -0.01em; }')).toEqual({ 'letter-spacing': 1 });
        expect(counts('.a { letter-spacing: var(--sb-tracking-label); }')).toEqual({ 'letter-spacing': 1 });
        expect(counts('.a { letter-spacing: normal; letter-spacing: 0; letter-spacing: 0px; letter-spacing: inherit; }')).toEqual({});
    });

    test('counts text-transform: uppercase only', () => {
        expect(counts('.a { text-transform: uppercase; }')).toEqual({ uppercase: 1 });
        expect(counts('.a { text-transform: capitalize; } .b { text-transform: none; }')).toEqual({});
        expect(counts('.a::before { content: "text-transform: uppercase"; }')).toEqual({});
    });

    test('counts italic and oblique styles and an italic font shorthand', () => {
        expect(counts('.a { font-style: italic; }')).toEqual({ italic: 1 });
        expect(counts('.a { font-style: oblique 10deg; }')).toEqual({ italic: 1 });
        expect(counts('.a { font: italic 12px/1.2 serif; }')).toEqual({ italic: 1 });
        expect(counts('.a { font: oblique 12px/1.2 serif; }')).toEqual({ italic: 1 });
        expect(counts('.a { font: oblique 10deg 12px/1.2 serif; }')).toEqual({ italic: 1 });
        expect(counts('.a { font-style: normal; font: 12px serif; }')).toEqual({});
    });

    test('does not count the descriptors of an @font-face rule', () => {
        expect(counts('@font-face { font-family: "A"; font-style: italic; src: url(a.woff2); }')).toEqual({});
    });
});

describe('important', () => {
    test('counts each declaration, with or without a space, and in custom properties', () => {
        expect(counts('.a { color: var(--x) !important; margin: 0 ! important; --y: 1 !important; padding: 0; }')).toEqual({ important: 3 });
    });

    test('does not count the word in a comment or a string', () => {
        expect(counts('/* !important */ .a { content: "!important"; }')).toEqual({});
    });
});

describe('hover-ungated', () => {
    test('counts a :hover selector outside @media (hover: hover), one per selector', () => {
        expect(counts('.a:hover { margin: 0; }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('.a:hover, .b:hover, .c { margin: 0; }')).toEqual({ 'hover-ungated': 2 });
        expect(counts('.a { &:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('.a:hover:active { margin: 0; }')).toEqual({ 'hover-ungated': 1 });
    });

    test('treats any ancestor at-rule that holds the hover query as the gate', () => {
        expect(counts('@media (hover: hover) { .a:hover { margin: 0; } }')).toEqual({});
        expect(counts('@media (hover:hover) and (min-width: 769px) { .a:hover { margin: 0; } }')).toEqual({});
        expect(counts('@media (hover: hover) { @supports (display: grid) { .a:hover { margin: 0; } } }')).toEqual({});
        expect(counts('@supports (display: grid) { @media (hover: hover) { .a:hover { margin: 0; } } }')).toEqual({});
        expect(counts('.a { @media (hover: hover) { &:hover { margin: 0; } } }')).toEqual({});
    });

    test('is not gated by a negated query, a query list with an ungated part, or a non-@media rule', () => {
        expect(counts('@media not all and (hover: hover) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media (hover: hover), print { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media (hover: none), (hover: hover) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media not (hover: hover), (hover: hover) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media screen and not (hover: hover) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media screen AND NOT ( hover : hover ) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@supports (hover: hover) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
    });

    test('is gated when every part of a query list holds the hover query', () => {
        expect(counts('@media (hover: hover) and (min-width: 769px), (hover: hover) and (pointer: fine) { .a:hover { margin: 0; } }')).toEqual({});
        expect(counts('@media only screen and (hover: hover) { .a:hover { margin: 0; } }')).toEqual({});
    });

    test('counts :is(:hover) and matches the pseudo-class without regard to case', () => {
        expect(counts('.a:is(:hover) { margin: 0; }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('.a:HOVER { margin: 0; }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('.a:not(:HOVER) { margin: 0; }')).toEqual({});
        expect(counts('.a:not(.b):hover { margin: 0; }')).toEqual({ 'hover-ungated': 1 });
    });

    test('does not count a gate that is negated, another query, or a selector that only excludes hover', () => {
        expect(counts('@media (hover: none) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media not (hover: hover) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('@media (min-width: 769px) { .a:hover { margin: 0; } }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('.a:not(:hover) { margin: 0; }')).toEqual({});
        expect(counts('.a:hover-ish, .b-hover { margin: 0; }')).toEqual({});
    });
});

describe('breakpoint-off-set', () => {
    test('accepts the allowed widths and the 360px and 450px heights', () => {
        const css = [
            '@media (max-width: 768px) { .a { margin: 0; } }',
            '@media (min-width: 769px) { .a { margin: 0; } }',
            '@media (max-width: 450px), (max-height: 360px) { .a { margin: 0; } }',
            '@media (max-width: 1279px) { .a { margin: 0; } }',
            '@media (min-width: 1280px) { .a { margin: 0; } }',
            '@media (max-width: 1439px) { .a { margin: 0; } }',
            '@media (min-width: 1440px) { .a { margin: 0; } }',
            '@media (pointer: coarse) and (max-height: 450px) { .a { margin: 0; } }',
            '@media (max-height: 22.5rem) { .a { margin: 0; } }',
            '@media (max-width: 620px) { .a { margin: 0; } }',
            '@media (min-width: 621px) { .a { margin: 0; } }',
            '@media screen and (min-width: 1024px) { .a { margin: 0; } }',
            '@media (pointer: coarse) and (max-width: 768px) { .a { margin: 0; } }',
        ].join('\n');
        expect(counts(css)).toEqual({});
    });

    test('counts each off-set feature, a width of 360 and a height other than 360 and 450', () => {
        expect(counts('@media (max-width: 600px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
        expect(counts('@media (min-width: 600px) and (max-width: 900px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 2 });
        expect(counts('@media (max-width: 360px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
        expect(counts('@media (max-height: 860px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
        expect(counts('@media (max-width: 1100px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
        expect(counts('@media (max-width: 1180px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
        expect(counts('@media (width <= 700px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
        expect(counts('@media (400px <= width <= 800px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 2 });
        expect(counts('@media (max-width: calc(750px / 0.9)) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1 });
    });

    test('counts 1000 and 1001 in the off-set total and in their own sub-count', () => {
        expect(counts('@media (max-width: 1000px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1, 'breakpoint-1000': 1 });
        expect(counts('@media (min-width: 1001px) { .a { margin: 0; } }')).toEqual({ 'breakpoint-off-set': 1, 'breakpoint-1000': 1 });
    });

    test('reads nested at-rules once each and ignores container queries', () => {
        const css = '@media (min-width: 769px) { @media (max-width: 1000px) { .a { margin: 0; } } }\n@container (max-width: 500px) { .b { margin: 0; } }';
        expect(counts(css)).toEqual({ 'breakpoint-off-set': 1, 'breakpoint-1000': 1 });
    });
});

describe('vh-without-dvh', () => {
    test('counts a vh declaration that has no dvh declaration of the same property in the rule', () => {
        expect(counts('.a { height: 100vh; }')).toEqual({ 'vh-without-dvh': 1 });
        expect(counts('.a { max-height: min(50vh, 28rem); }')).toEqual({ 'vh-without-dvh': 1 });
        expect(counts('.a { height: 100vh; max-height: 100dvh; }')).toEqual({ 'vh-without-dvh': 1 });
        expect(counts('.a { height: 100vh; } .a { height: 100dvh; }')).toEqual({ 'vh-without-dvh': 1 });
    });

    test('requires the dvh declaration to come after the vh one, as the later one wins', () => {
        expect(counts('.a { height: 100dvh; height: 100vh; }')).toEqual({ 'vh-without-dvh': 1 });
        expect(counts('.a { height: 100dvh; height: 100vh; height: 100dvh; }')).toEqual({});
        expect(counts('.a { max-height: min(50vh, 50dvh); }')).toEqual({});
    });

    test('accepts a dvh companion for the same property, dvh alone and custom properties', () => {
        expect(counts('.a { height: 100vh; height: 100dvh; }')).toEqual({});
        expect(counts('.a { max-height: calc(100vh - 2px); max-height: calc(100dvh - 2px); }')).toEqual({});
        expect(counts('.a { height: 100dvh; }')).toEqual({});
        expect(counts(':root { --panel: clamp(42px, 5vh, 76px); }')).toEqual({});
        expect(counts('.a { margin: 5vw; }')).toEqual({});
    });
});

describe('focus-outline', () => {
    test('counts a visible outline set on :focus or :focus-visible, nested selectors included', () => {
        expect(counts('.a:focus-visible { outline: 2px solid red; }')).toMatchObject({ 'focus-outline': 1 });
        expect(counts('.a:focus { outline: 1px solid var(--x); }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a { &:focus-visible { outline: auto; } }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:focus-visible { outline-style: solid; }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:hover, .a:focus-visible { outline: 2px solid var(--x); }')).toEqual({ 'focus-outline': 1, 'hover-ungated': 1 });
    });

    test('does not read a zero inside a function as the outline width', () => {
        expect(counts('.a:focus-visible { outline: 2px solid rgb(0 0 0 / .5); }')).toEqual({ 'color-literal': 1, 'focus-outline': 1 });
        expect(counts('.a:focus-visible { outline: 2px solid var(--x, 0 0); }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:focus-visible { outline: 2px solid color-mix(in srgb, var(--x) 0%, transparent); }')).toEqual({ 'focus-outline': 1 });
    });

    test('counts outline-width and outline-color when they make the outline visible, and :is() and any case', () => {
        expect(counts('.a:focus-visible { outline-width: 2px; }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:focus-visible { outline-color: var(--x); }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:FOCUS-VISIBLE { outline: 2px solid var(--x); }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:is(:focus) { outline: 2px solid var(--x); }')).toEqual({ 'focus-outline': 1 });
        expect(counts('.a:focus-visible { outline-width: 0; }')).toEqual({});
        expect(counts('.a:focus-visible { outline-color: transparent; }')).toEqual({});
    });

    test('does not count outline: 0 with other parts, or a focus pseudo-class that only sits inside :not()', () => {
        expect(counts('.a:focus-visible { outline: 0 solid var(--x); }')).toEqual({});
        expect(counts('.a:focus-visible { outline: 0 solid red; }')).toEqual({ 'color-literal': 1 });
        expect(counts('.a:focus-visible { outline: 2px solid var(--x) 0px; }')).toEqual({});
        expect(counts('.a:not(:focus-visible) { outline: 2px solid var(--x); }')).toEqual({});
        expect(counts('.a:not(:focus) .b:focus-visible { outline: 2px solid var(--x); }')).toEqual({ 'focus-outline': 1 });
    });

    test('does not count outlines that are off, transparent, replace the ring or sit in forced colours', () => {
        expect(counts('.a:focus-visible { outline: none; }')).toEqual({});
        expect(counts('.a:focus-visible { outline: 0; outline-style: none; }')).toEqual({});
        expect(counts('.a:focus-visible { outline: 2px solid transparent; }')).toEqual({});
        expect(counts('.a:focus-visible { outline: 2px solid var(--x); box-shadow: none; }')).toEqual({});
        expect(counts('@media (forced-colors: active) { .a:focus-visible { outline: 2px solid CanvasText; } }')).toEqual({});
        expect(counts('.a:hover { outline: 2px solid var(--x); }')).toEqual({ 'hover-ungated': 1 });
        expect(counts('.a:focus-within { outline: 2px solid var(--x); }')).toEqual({});
    });
});

describe('spacing-off-scale', () => {
    test('counts each px literal that is not zero and not on the scale, one finding per literal', () => {
        expect(counts('.a { padding: 5px; }')).toEqual({ 'spacing-off-scale': 1 });
        expect(counts('.a { margin: 5px 7px 6px 8px; }')).toEqual({ 'spacing-off-scale': 3 });
        expect(counts('.a { gap: 10px 14px; }')).toEqual({ 'spacing-off-scale': 2 });
        expect(counts('.a { padding: 4px; margin: 8px; }')).toEqual({ 'spacing-off-scale': 2 });
        expect(counts('@media (max-width: 768px) { .a { .b { padding: 10px; } } }')).toEqual({ 'spacing-off-scale': 1 });
    });

    test('accepts the scale, zero and auto', () => {
        expect(counts('.a { padding: 3px 6px 9px 12px; margin: 18px 24px 36px 0; }')).toEqual({});
        expect(counts('.a { gap: 0 0px; padding: 0.0px; margin: 0 auto; margin-inline: auto; }')).toEqual({});
        expect(counts('.a { padding: 6.0px 12.00px; margin: 9PX; }')).toEqual({});
        expect(counts('.a { padding: inherit; margin: unset; gap: normal; }')).toEqual({});
    });

    test('reads longhands, logical forms, legacy aliases and prefixed names', () => {
        const properties = [
            'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
            'padding-inline', 'padding-block', 'padding-inline-start', 'padding-inline-end', 'padding-block-start', 'padding-block-end',
            'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
            'margin-inline', 'margin-block', 'margin-inline-start', 'margin-inline-end', 'margin-block-start', 'margin-block-end',
            'gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-row-gap', 'grid-column-gap',
            '-webkit-margin-start', '-webkit-padding-end', '-webkit-margin-before', '-webkit-padding-after',
        ];
        expect(counts(`.a { ${properties.map(property => `${property}: 5px;`).join(' ')} }`)).toEqual({ 'spacing-off-scale': properties.length });
        expect(counts('.a { PADDING: 5PX; Margin-Inline-Start: 7Px; }')).toEqual({ 'spacing-off-scale': 2 });
    });

    test('leaves other properties alone, including scroll-margin, scroll-padding and border-spacing', () => {
        expect(counts('.a { width: 5px; top: 5px; inset: 5px; border-width: 5px; border-spacing: 5px; font-size: 13px; }')).toEqual({});
        expect(counts('.a { scroll-margin: 5px; scroll-padding: 5px; margin-trim: block; text-indent: 5px; }')).toEqual({});
        expect(counts('.a { padding-box: 5px; gap-x: 5px; }')).toEqual({});
    });

    test('counts a negative margin by its absolute value', () => {
        expect(counts('.a { margin: -5px; }')).toEqual({ 'spacing-off-scale': 1 });
        expect(counts('.a { margin-left: -6px; margin: -12px -3px 0 -36px; }')).toEqual({});
        expect(counts('.a { margin: -1px -7px; }')).toEqual({ 'spacing-off-scale': 2 });
        expect(counts('.a { margin-inline-start: -2px; }')).toEqual({ 'spacing-off-scale': 1 });
    });

    test('counts 1px and 2px, and fractions, because the scale has no such step', () => {
        expect(counts('.a { padding: 1px 2px; }')).toEqual({ 'spacing-off-scale': 2 });
        expect(counts('.a { margin: 0.5px; padding: 1.5px; gap: .5px; }')).toEqual({ 'spacing-off-scale': 3 });
        expect(counts('.a { padding: 4.5px; }')).toEqual({ 'spacing-off-scale': 1 });
    });

    test('does not count percentages, em, rem or other units, because the scale is in px', () => {
        expect(counts('.a { padding: 5% 1em 0.3125rem; margin: 5vw 5pt 5ch; gap: 0.5em 1.25rem; }')).toEqual({});
        expect(counts('.a { padding: 5px 1em 7%; }')).toEqual({ 'spacing-off-scale': 1 });
    });

    test('does not count a literal inside calc(), min(), max(), clamp() or env()', () => {
        expect(counts('.a { padding: calc(100% - 5px); margin: calc(var(--x) + 7px); }')).toEqual({});
        expect(counts('.a { padding: clamp(5px, 2vw, 7px); margin: min(5px, 2vw); gap: max(5px, 1rem); }')).toEqual({});
        expect(counts('.a { padding-top: env(safe-area-inset-top, 5px); padding-bottom: max(5px, env(safe-area-inset-bottom)); }')).toEqual({});
        expect(counts('.a { padding: 5px calc(100% - 7px) 9px; }')).toEqual({ 'spacing-off-scale': 1 });
    });

    test('does not count var() references, custom-property definitions or token arithmetic', () => {
        expect(counts('.a { padding: var(--sb-space-6) var(--x); margin: calc(var(--x) * 2); }')).toEqual({});
        expect(counts(':root { --gap: 5px; --pad: 1px 2px; --margin-x: -7px; }')).toEqual({});
        expect(counts('.a { --pad: 5px; padding: var(--pad); }')).toEqual({});
        expect(counts('.a { padding: 5px var(--x) 7px; }')).toEqual({ 'spacing-off-scale': 2 });
    });

    test('counts a literal in a var() fallback as spacing-off-scale-fallback, once per literal', () => {
        expect(counts('.a { padding: var(--x, 5px); }')).toEqual({ 'spacing-off-scale-fallback': 1 });
        expect(counts('.a { margin: var(--a, 5px) var(--b, 7px); }')).toEqual({ 'spacing-off-scale-fallback': 2 });
        expect(counts('.a { padding: var(--a, 5px 7px); }')).toEqual({ 'spacing-off-scale-fallback': 2 });
        expect(counts('.a { padding: var(--a, var(--b, 5px)); }')).toEqual({ 'spacing-off-scale-fallback': 1 });
        expect(counts('.a { padding: var(--a, 5px var(--b, 7px)); }')).toEqual({ 'spacing-off-scale-fallback': 2 });
        expect(counts('.a { padding: 5px var(--a, 7px); }')).toEqual({ 'spacing-off-scale': 1, 'spacing-off-scale-fallback': 1 });
        expect(counts('.a { margin: var(--a, -5px); }')).toEqual({ 'spacing-off-scale-fallback': 1 });
        expect(counts('.a { padding: calc(var(--a, 5px) * 2); }')).toEqual({ 'spacing-off-scale-fallback': 1 });
    });

    test('accepts a fallback that is zero, on the scale, in another unit, computed or another token', () => {
        expect(counts('.a { padding: var(--x, 0); margin: var(--x, 6px); gap: var(--x, 1rem); }')).toEqual({});
        expect(counts('.a { padding: var(--x, calc(100% - 5px)); margin: var(--x, var(--y)); gap: var(--x, auto); }')).toEqual({});
    });

    test('names the declaration in each finding and reports its line', () => {
        const css = '.a {\n    color: var(--x);\n    margin: 5px 7px;\n    padding: var(--y, 9px 10px) !important;\n}';
        const { findings } = scanCss(css);
        expect(findings.map(({ rule, line, detail }) => [rule, line, detail])).toEqual([
            ['spacing-off-scale', 3, 'margin: 5px 7px'],
            ['spacing-off-scale', 3, 'margin: 5px 7px'],
            ['important', 4, 'padding: var(--y, 9px 10px) !important'],
            ['spacing-off-scale-fallback', 4, 'padding: var(--y, 9px 10px) !important'],
        ]);
    });

    test('reads nothing from comments and strings, and keeps the important count apart', () => {
        expect(counts('/* padding: 5px */ .a::before { content: "margin: 5px"; }')).toEqual({});
        expect(counts('.a { padding: 5px !important; }')).toEqual({ 'spacing-off-scale': 1, important: 1 });
    });
});

describe('scope and report', () => {
    const upstream = ['public/style.css'];

    test('lists SillyBunny and upstream-origin sheets and leaves out vendored ones', () => {
        const root = treeFixture({
            'public/style.css': '.a { color: #fff; }',
            'public/css/sillybunny-x.css': '.a { color: #fff; }',
            'public/css/vendor.min.css': '.a{color:#fff}',
            'public/css/user.css': '.a { color: #fff; }',
            'public/lib/x/y.css': '.a { color: #fff; }',
            'public/scripts/extensions/quick-image-gen/style.css': '.a { color: #fff; }',
            'public/scripts/extensions/third-party/Z/style.css': '.a { color: #fff; }',
            'public/scripts/extensions/in-chat-agents/style.css': '.a { color: #fff; }',
            'public/readme.txt': 'color: #fff',
        }, upstream);
        expect(listStylesheets(root)).toEqual([
            'public/css/sillybunny-x.css',
            'public/scripts/extensions/in-chat-agents/style.css',
            'public/style.css',
        ]);

        const report = scanDesignRules({ repoRoot: root });
        expect(Object.keys(report.sillybunny.files)).toEqual(['public/css/sillybunny-x.css', 'public/scripts/extensions/in-chat-agents/style.css']);
        expect(Object.keys(report.upstreamOrigin.files)).toEqual(['public/style.css']);
        expect(report.sillybunny.totals['color-literal']).toBe(2);
        expect(report.upstreamOrigin.totals['color-literal']).toBe(1);
        expect(report.sillybunny.files['public/css/sillybunny-x.css'].findings).toEqual([{ rule: 'color-literal', line: 1, detail: 'color: #fff' }]);
    });

    test('keeps zero counts out of the baseline and the upstream sheets out of it entirely', () => {
        const root = treeFixture({
            'public/style.css': '.a { color: #fff; }',
            'public/css/sillybunny-clean.css': '.a { color: var(--x); }',
            'public/css/sillybunny-dirty.css': '.a { color: #fff; margin: 0 !important; }',
        }, upstream);
        expect(buildBaseline(scanDesignRules({ repoRoot: root }))).toEqual({
            version: 1,
            files: { 'public/css/sillybunny-dirty.css': { 'color-literal': 1, important: 1 } },
        });
    });

    test('fails clearly when the upstream-origin fixture is missing', () => {
        const root = treeFixture({});
        fs.rmSync(path.join(root, 'tests/fixtures/upstream-origin-public-files.json'));
        expect(() => scanDesignRules({ repoRoot: root })).toThrow(/upstream-origin-public-files/);
    });

    test('names every rule in the report', () => {
        const root = treeFixture({}, upstream);
        const report = scanDesignRules({ repoRoot: root });
        expect(report.rules).toEqual(RULE_IDS);
        expect(Object.keys(report.sillybunny.totals)).toEqual(RULE_IDS);
    });
});

describe('command line', () => {
    const upstream = ['public/style.css'];

    test('--update writes the baseline and --check then passes', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; }' }, upstream);
        expect(cli(root, '--update').status).toBe(0);
        const written = JSON.parse(fs.readFileSync(path.join(root, 'scripts/design-rule-baseline.json'), 'utf8'));
        expect(written).toEqual({ version: 1, files: { 'public/css/sillybunny-x.css': { 'color-literal': 1 } } });
        expect(cli(root, '--check').status).toBe(0);
    });

    test('--check exits non-zero when a count is above the baseline and names the file and rule', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; }' }, upstream);
        cli(root, '--update');
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-x.css'), '.a { color: #fff; border-radius: 8px; }');
        const result = cli(root, '--check');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('public/css/sillybunny-x.css radius-literal: 1 > 0');
    });

    test('--check passes with a notice when a count is below the baseline, and fails under --strict', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; }' }, upstream);
        cli(root, '--update');
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-x.css'), '.a { color: var(--x); }');
        const relaxed = cli(root, '--check');
        expect(relaxed.status).toBe(0);
        expect(relaxed.stderr).toContain('node scripts/audit-design-rules.js --update');
        expect(cli(root, '--check', '--strict').status).toBe(1);
    });

    test('--baseline reads and writes another baseline file', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; }' }, upstream);
        const custom = path.join(root, 'custom/baseline.json');
        expect(cli(root, '--update', '--baseline', custom).status).toBe(0);
        expect(JSON.parse(fs.readFileSync(custom, 'utf8')).files['public/css/sillybunny-x.css']).toEqual({ 'color-literal': 1 });
        expect(fs.existsSync(path.join(root, 'scripts/design-rule-baseline.json'))).toBe(false);
        expect(cli(root, '--check', '--baseline', custom).status).toBe(0);
        expect(cli(root, '--check').status).toBe(1);
        expect(cli(root, '--check', '--baseline').stderr).toContain('Missing value for --baseline');
    });

    test('--update writes a lower count without --allow-increase', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; border-radius: 8px; }' }, upstream);
        cli(root, '--update');
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-x.css'), '.a { color: #fff; }');
        expect(cli(root, '--update').status).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'scripts/design-rule-baseline.json'), 'utf8')).files['public/css/sillybunny-x.css']).toEqual({ 'color-literal': 1 });
        expect(cli(root, '--check', '--strict').status).toBe(0);
    });

    test('--update refuses a raised count and a new file, lists the rises, and leaves the baseline alone', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; }' }, upstream);
        cli(root, '--update');
        const baselineFile = path.join(root, 'scripts/design-rule-baseline.json');
        const before = fs.readFileSync(baselineFile, 'utf8');
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-x.css'), '.a { color: #fff; color: red; }');
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-y.css'), '.a { border-radius: 8px; }');

        const refused = cli(root, '--update');
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain('[RISE] public/css/sillybunny-x.css color-literal: 1 -> 2');
        expect(refused.stderr).toContain('[RISE] public/css/sillybunny-y.css radius-literal: 0 -> 1 (new file)');
        expect(refused.stderr).toContain('--allow-increase');
        expect(fs.readFileSync(baselineFile, 'utf8')).toBe(before);

        expect(cli(root, '--update', '--allow-increase').status).toBe(0);
        expect(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).files).toEqual({
            'public/css/sillybunny-x.css': { 'color-literal': 2 },
            'public/css/sillybunny-y.css': { 'radius-literal': 1 },
        });
    });

    test('--check reports a deleted or renamed sheet as one [MISSING] line, and --strict fails on it', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { color: #fff; border-radius: 8px; }' }, upstream);
        cli(root, '--update');
        fs.renameSync(path.join(root, 'public/css/sillybunny-x.css'), path.join(root, 'public/css/sillybunny-z.css'));
        const renamed = cli(root, '--check');
        expect(renamed.status).toBe(1);
        expect(renamed.stderr).toContain('[MISSING] public/css/sillybunny-x.css');
        expect(renamed.stderr).toContain('[ABOVE BASELINE] public/css/sillybunny-z.css color-literal: 1 > 0');
        expect(renamed.stderr).not.toContain('[BELOW BASELINE]');

        fs.rmSync(path.join(root, 'public/css/sillybunny-z.css'));
        const deleted = cli(root, '--check');
        expect(deleted.status).toBe(0);
        expect(deleted.stderr.match(/\[MISSING\]/g)).toHaveLength(1);
        expect(deleted.stderr).not.toContain('[BELOW BASELINE]');
        expect(cli(root, '--check', '--strict').status).toBe(1);
    });

    test('--json prints the full report with a line per finding, --markdown a table', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '\n.a { color: #fff; }' }, upstream);
        const report = JSON.parse(cli(root, '--json').stdout);
        expect(report.sillybunny.files['public/css/sillybunny-x.css'].findings).toEqual([{ rule: 'color-literal', line: 2, detail: 'color: #fff' }]);
        expect(cli(root, '--markdown').stdout).toContain('| `color-literal` | 1 | 0 |');
    });

    test('lists the spacing rules in the report, the table and the baseline', () => {
        const root = treeFixture({ 'public/css/sillybunny-x.css': '.a { padding: 5px; margin: var(--x, 7px); }' }, upstream);
        expect(RULE_IDS.slice(-2)).toEqual(['spacing-off-scale', 'spacing-off-scale-fallback']);
        const markdown = cli(root, '--markdown').stdout;
        expect(markdown).toContain('| `spacing-off-scale` | 1 | 0 |');
        expect(markdown).toContain('| `spacing-off-scale-fallback` | 1 | 0 |');
        expect(cli(root, '--update').status).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'scripts/design-rule-baseline.json'), 'utf8')).files).toEqual({
            'public/css/sillybunny-x.css': { 'spacing-off-scale': 1, 'spacing-off-scale-fallback': 1 },
        });
        expect(cli(root, '--check', '--strict').status).toBe(0);
    });

    test('rejects an unknown argument', () => {
        const result = cli(treeFixture({}, upstream), '--nope');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Unknown argument: --nope');
    });
});
