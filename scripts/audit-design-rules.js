#!/usr/bin/env node

// Counts design-rule violations per stylesheet under public/. Only stylesheets that are not listed in
// tests/fixtures/upstream-origin-public-files.json are ratcheted against the baseline.
//
// Not covered: blocks marked `SillyBunny:` inside upstream-origin sheets are counted with the rest of
// the sheet and are not ratcheted; inline <style> elements and CSS that scripts inject are not scanned.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');
const baselineVersion = 1;
const upstreamFixture = 'tests/fixtures/upstream-origin-public-files.json';

export const defaultBaselinePath = path.join(scriptDirectory, 'design-rule-baseline.json');

/**
 * Each entry is counted per stylesheet. A rule with `parent` is a subset of that rule and is counted
 * as well as it (`radius-over-20`, `breakpoint-1000`). The `-fallback` rules count literals inside the
 * fallback of a `var()` and are not part of the rule they are named after.
 */
export const RULES = Object.freeze([
    { id: 'color-literal', description: 'Hex, rgb(), hsl() and named colours used as a value, outside custom-property definitions and var() fallbacks; white and black as an operand of color-mix() do not count' },
    { id: 'color-literal-fallback', description: 'Colour literals inside the fallback of a var()' },
    { id: 'radius-literal', description: 'border-radius (and longhands) with a non-zero length or percentage literal instead of a token' },
    { id: 'radius-literal-fallback', description: 'border-radius declarations with a non-zero length or percentage inside the fallback of a var()' },
    { id: 'radius-over-20', parent: 'radius-literal', description: 'radius-literal declarations with a plain literal above 20px that is not a pill or circle' },
    { id: 'shadow-literal', description: 'box-shadow with a layer that is not none or a single shadow/focus token' },
    { id: 'duration-literal', description: 'Non-zero literal times in transition, animation and their duration and delay longhands' },
    { id: 'duration-literal-fallback', description: 'Non-zero literal times inside the fallback of a var() in those properties' },
    { id: 'letter-spacing', description: 'Non-zero letter-spacing' },
    { id: 'uppercase', description: 'text-transform: uppercase' },
    { id: 'italic', description: 'font-style: italic or oblique, or an italic font shorthand' },
    { id: 'important', description: '!important declarations' },
    { id: 'hover-ungated', description: 'Selectors with :hover outside @media (hover: hover)' },
    { id: 'breakpoint-off-set', description: 'min/max width/height media values outside the allowed set' },
    { id: 'breakpoint-1000', parent: 'breakpoint-off-set', description: 'breakpoint-off-set values of 1000 or 1001px' },
    { id: 'vh-without-dvh', description: 'vh declarations with no later dvh declaration of the same property in the same rule' },
    { id: 'focus-outline', description: 'Visible outline on :focus or :focus-visible that can stack with the inset ring' },
    {
        id: 'spacing-off-scale',
        description: 'Each px literal in padding, margin and gap properties (longhands, logical forms and legacy aliases) that is not 0 and not on the scale 3, 6, 9, 12, 18, 24, 36. '
            + 'A negative margin counts by its absolute value; 1px, 2px and fractions count. Not counted: auto, percentages, em, rem and every other unit, '
            + 'anything inside a function other than var() (calc, min, max, clamp, env), var() references and custom-property definitions',
    },
    { id: 'spacing-off-scale-fallback', description: 'Off-scale px literals inside the fallback of a var() in those properties, counted by the same rules, once per literal' },
]);

export const RULE_IDS = Object.freeze(RULES.map(rule => rule.id));

const ALLOWED_BREAKPOINTS = Object.freeze({
    width: new Set([450, 620, 621, 768, 769, 1024, 1279, 1280, 1439, 1440]),
    height: new Set([360, 450]),
});

const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
    + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey '
    + 'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey '
    + 'darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite '
    + 'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon '
    + 'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue '
    + 'lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid '
    + 'mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin '
    + 'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff '
    + 'peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver '
    + 'skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow '
    + 'yellowgreen').split(' '));

const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
// A mask reads only the alpha of its colours, so its gradient stops are not colour choices and are not counted.
const COLOR_PROPERTY = /(?:^|-)(?:color|background|border|outline|shadow|fill|stroke|filter|decoration|rule|emphasis)(?:-|$)/;
const RADIUS_PROPERTY = /^border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius$/;
const SPACING_PROPERTY = /^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block|start|end|before|after)(?:-(?:start|end))?)?|(?:grid-)?(?:(?:row|column)-)?gap)$/;
const SPACING_SCALE_PIXELS = new Set([3, 6, 9, 12, 18, 24, 36]);
const MOTION_PROPERTY = /^(?:transition|animation)(?:-(?:duration|delay))?$/;
const CSS_WIDE_KEYWORD = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const PLACEHOLDER = '\u0001';
const excludedPathPattern = /(?:^public\/lib\/|\/quick-image-gen\/|\/third-party\/|\.min\.css$|^public\/css\/user\.css$)/;

/**
 * Blanks out comments, string bodies and unquoted url() bodies, keeping every character offset and
 * newline, so that rule-like text inside them is never read as CSS.
 */
export function maskCss(source) {
    const text = String(source).replace(/\r\n?/g, '\n');
    const length = text.length;
    const pieces = [];
    let runStart = 0;
    let index = 0;
    const blank = value => value.replace(/[^\n]/g, ' ');
    const flush = end => {
        if (end > runStart) pieces.push(text.slice(runStart, end));
    };

    while (index < length) {
        const char = text[index];
        if (char === '/' && text[index + 1] === '*') {
            flush(index);
            const close = text.indexOf('*/', index + 2);
            const stop = close === -1 ? length : close + 2;
            pieces.push(blank(text.slice(index, stop)));
            index = runStart = stop;
        } else if (char === '"' || char === '\'') {
            flush(index);
            let cursor = index + 1;
            while (cursor < length && text[cursor] !== char && text[cursor] !== '\n') cursor += text[cursor] === '\\' ? 2 : 1;
            const closeAt = Math.min(cursor, length);
            pieces.push(char + text.slice(index + 1, closeAt).replace(/[^\n]/g, '_'));
            if (text[closeAt] === char) {
                pieces.push(char);
                index = closeAt + 1;
            } else {
                index = closeAt;
            }
            runStart = index;
        } else if ((char === 'u' || char === 'U') && !/[\w-]/.test(text[index - 1] ?? '') && /^url\(\s*[^\s"')]/i.test(text.slice(index, index + 40))) {
            flush(index);
            const opening = /^url\(\s*/i.exec(text.slice(index, index + 40))[0].length;
            const close = text.indexOf(')', index + opening);
            const stop = close === -1 ? length : close;
            pieces.push(text.slice(index, index + opening) + text.slice(index + opening, stop).replace(/[^\n]/g, '_'));
            index = runStart = stop;
        } else {
            index++;
        }
    }
    flush(length);
    return pieces.join('');
}

function matchParen(text, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < text.length; index++) {
        if (text[index] === '(') depth++;
        else if (text[index] === ')' && --depth === 0) return index;
    }
    return -1;
}

/**
 * Walks the function calls of a value from left to right. `visit(name, args)` returns a replacement
 * string for the whole call, or null to leave it and look inside its arguments.
 */
function replaceCalls(text, visit) {
    const pattern = /(?<![\w-])(-?[a-z][\w-]*)\(/gi;
    let out = '';
    let cursor = 0;
    for (let match; (match = pattern.exec(text));) {
        const open = match.index + match[0].length - 1;
        const close = matchParen(text, open);
        if (close === -1) break;
        const replacement = visit(match[1].toLowerCase(), text.slice(open + 1, close));
        if (replacement === null) continue;
        out += text.slice(cursor, match.index) + replacement;
        cursor = close + 1;
        pattern.lastIndex = cursor;
    }
    return out + text.slice(cursor);
}

function splitTopLevel(text, separator) {
    const pieces = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
        else if (char === separator && depth === 0) {
            pieces.push({ text: text.slice(start, index), offset: start });
            start = index + 1;
        }
    }
    pieces.push({ text: text.slice(start), offset: start });
    return pieces.map(piece => {
        const lead = piece.text.search(/\S/);
        return { text: piece.text.trim(), offset: piece.offset + Math.max(0, lead) };
    });
}

function parseStylesheet(masked, original) {
    const lineStarts = [0];
    for (let index = 0; index < masked.length; index++) {
        if (masked[index] === '\n') lineStarts.push(index + 1);
    }
    const lineAt = offset => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (lineStarts[middle] <= offset) low = middle;
            else high = middle - 1;
        }
        return low + 1;
    };

    const root = { type: 'root', prelude: '', display: '', line: 1, offset: 0, declarations: [], children: [], parent: null };
    let current = root;
    let start = 0;
    let depth = 0;

    const takeStatement = end => {
        const raw = masked.slice(start, end);
        const lead = raw.search(/\S/);
        if (lead === -1) return;
        const text = raw.trim();
        if (text.startsWith('@')) return;
        const colon = text.indexOf(':');
        if (colon < 1) return;
        const name = text.slice(0, colon).trim();
        current.declarations.push({
            property: name.startsWith('--') ? name : name.toLowerCase(),
            value: text.slice(colon + 1).trim(),
            line: lineAt(start + lead),
            display: original.slice(start + lead, end).trim(),
        });
    };

    for (let index = 0; index < masked.length; index++) {
        const char = masked[index];
        if (char === '(' || char === '[') {
            depth++;
        } else if (char === ')' || char === ']') {
            depth = Math.max(0, depth - 1);
        } else if (char === ';' && depth === 0) {
            takeStatement(index);
            start = index + 1;
        } else if (char === '{') {
            const raw = masked.slice(start, index);
            const lead = Math.max(0, raw.search(/\S/));
            const text = raw.trim();
            if (/^--[^\s:]+\s*:/.test(text)) {
                let braces = 1;
                let cursor = index + 1;
                while (cursor < masked.length && braces > 0) {
                    if (masked[cursor] === '{') braces++;
                    else if (masked[cursor] === '}') braces--;
                    cursor++;
                }
                current.declarations.push({ property: text.slice(0, text.indexOf(':')).trim(), value: '{}', line: lineAt(start + lead), display: text });
                index = cursor - 1;
                start = cursor;
                continue;
            }
            const isAtRule = text.startsWith('@');
            const node = {
                type: isAtRule ? 'at' : 'rule',
                prelude: text,
                display: original.slice(start + lead, index).trim(),
                name: isAtRule ? (/^@([\w-]+)/.exec(text)?.[1] ?? '').toLowerCase() : '',
                params: isAtRule ? text.replace(/^@[\w-]+/, '').trim() : '',
                line: lineAt(start + lead),
                offset: start + lead,
                declarations: [],
                children: [],
                parent: current,
            };
            current.children.push(node);
            current = node;
            start = index + 1;
            depth = 0;
        } else if (char === '}') {
            takeStatement(index);
            if (current.parent) current = current.parent;
            start = index + 1;
            depth = 0;
        }
    }
    return { root, lineAt };
}

const MIX_OPERAND = /^(?:white|black)(?:\s[^,]*)?$/i;

/** Drops the `white` and `black` operands of color-mix(), which lighten or darken a colour as libadwaita's stylesheet does. */
function dropMixOperands(text) {
    return replaceCalls(text, (name, args) => {
        if (name !== 'color-mix') return null;
        const parts = splitTopLevel(args, ',').map(part => (MIX_OPERAND.test(part.text) ? ' ' : dropMixOperands(part.text)));
        return `color-mix(${parts.join(',')})`;
    });
}

function literalsInColorValue(text) {
    const direct = [];
    const fallback = [];
    const withoutVars = replaceCalls(text, (name, args) => {
        if (name !== 'var') return null;
        const parts = splitTopLevel(args, ',');
        if (parts.length > 1) {
            const inner = literalsInColorValue(args.slice(args.indexOf(',') + 1));
            fallback.push(...inner.direct, ...inner.fallback);
        }
        return PLACEHOLDER;
    });
    const withoutFunctions = replaceCalls(dropMixOperands(withoutVars), (name, args) => {
        if (!COLOR_FUNCTIONS.has(name)) return null;
        if (!/^\s*(?:\u0001|from\b)/i.test(args)) direct.push(`${name}(${args.trim()})`);
        return ' ';
    });
    for (const match of withoutFunctions.matchAll(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])/gi)) direct.push(match[0]);
    for (const match of withoutFunctions.matchAll(/(?<![\w#.-])([a-z]+)(?![\w(-])/gi)) {
        if (NAMED_COLORS.has(match[1].toLowerCase())) direct.push(match[1]);
    }
    return { direct, fallback };
}

function stripTokenReferences(value) {
    const withoutMath = replaceCalls(value, (name, args) => (name === 'calc' && args.includes('var(') ? ' ' : null));
    return replaceCalls(withoutMath, name => (name === 'var' ? ' ' : null));
}

function toPixels(number, unit) {
    switch (unit.toLowerCase()) {
        case 'px': return number;
        case 'rem':
        case 'em': return number * 16;
        case 'pt': return number * 4 / 3;
        default: return null;
    }
}

const PILL_PIXELS = 99;

function radiusLiterals(value) {
    const literals = [];
    for (const match of stripTokenReferences(value).matchAll(/(?<![\w.#-])(\d*\.?\d+)(px|rem|em|%|vw|vh|vmin|vmax|ch|pt|cm|mm|in|cqw|cqh)(?![\w-])/gi)) {
        const number = Number(match[1]);
        if (number === 0) continue;
        literals.push({ text: match[0], pixels: toPixels(number, match[2]) });
    }
    return literals;
}

// Every function call is blanked first, var() included: a var() fallback is read on its own by
// varFallbacks(), and the arguments of calc(), min(), max(), clamp() and env() are computed, not chosen steps.
function spacingLiterals(value) {
    const literals = [];
    for (const match of replaceCalls(value, () => ' ').matchAll(/(?<![\w.#])-?(\d*\.?\d+)px(?![\w-])/gi)) {
        const pixels = Number(match[1]);
        if (pixels !== 0 && !SPACING_SCALE_PIXELS.has(pixels)) literals.push(match[0]);
    }
    return literals;
}

function timeLiterals(value) {
    const cleaned = replaceCalls(stripTokenReferences(value), name => (/^(?:cubic-bezier|steps|linear)$/.test(name) ? ' ' : null));
    const times = [];
    for (const match of cleaned.matchAll(/(?<![\w.#-])-?(\d*\.?\d+)(ms|s)(?![\w-])/gi)) {
        const milliseconds = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
        if (milliseconds > 1) times.push(match[0]);
    }
    return times;
}

function varFallbacks(value) {
    const fallbacks = [];
    replaceCalls(value, (name, args) => {
        if (name === 'var' && args.includes(',')) fallbacks.push(args.slice(args.indexOf(',') + 1));
        return null;
    });
    return fallbacks;
}

function stripNegations(selector) {
    return replaceCalls(selector, name => (name === 'not' ? ' ' : null));
}

function isTokenShadowLayer(layer) {
    if (/^none$/i.test(layer) || CSS_WIDE_KEYWORD.test(layer)) return true;
    if (!/^var\(/i.test(layer) || matchParen(layer, 3) !== layer.length - 1) return false;
    const name = /^var\(\s*--([\w-]+)/i.exec(layer)?.[1];
    return Boolean(name) && name.toLowerCase().split('-').some(segment => ['shadow', 'focus', 'ring', 'shade'].includes(segment));
}

function mediaFeatures(params) {
    const features = [];
    for (const group of params.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
        const body = group[1];
        const dimension = /(?<![\w-])(?:min-|max-)?(?:device-)?(width|height)(?![\w-])/i.exec(body);
        if (!dimension) continue;
        const name = dimension[1].toLowerCase();
        const values = [...body.matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem|em)(?![\w-])/gi)];
        if (values.length === 0 || /calc\(|var\(/i.test(body)) {
            features.push({ dimension: name, value: null, text: body.trim() });
            continue;
        }
        for (const value of values) features.push({ dimension: name, value: toPixels(Number(value[1]), value[2]), text: value[0] });
    }
    return features;
}

// Gated only by @media, and only when every comma-separated query is a non-negated one holding (hover: hover).
function isHoverGated(atRules) {
    return atRules.some(rule => rule.name === 'media' && splitTopLevel(rule.params, ',').every(query => (
        !/^not\b/i.test(query.text) && !/\bnot\s*\(\s*hover\s*:\s*hover\s*\)/i.test(query.text) && /\(\s*hover\s*:\s*hover\s*\)/i.test(query.text)
    )));
}

function isForcedColors(atRules) {
    return atRules.some(rule => /forced-colors\s*:\s*active/i.test(rule.params));
}

function visibleOutline(property, value) {
    if (CSS_WIDE_KEYWORD.test(value)) return false;
    switch (property) {
        case 'outline-style': return !/^(?:none|hidden)$/i.test(value);
        case 'outline-width': return !/^0(?:\.0+)?(?:px|em|rem)?$/i.test(value);
        case 'outline-color': return !/^transparent$/i.test(value);
        case 'outline': return !/(?:^|\s)(?:none|hidden|transparent|0(?:\.0+)?(?:px|em|rem)?)(?:\s|$)/i.test(replaceCalls(value, () => ' '));
        default: return false;
    }
}

/** Findings carry a `detail` that is truncated to 120 characters. */
export function scanCss(source) {
    const { root, lineAt } = parseStylesheet(maskCss(source), String(source).replace(/\r\n?/g, '\n'));
    const findings = [];
    const add = (rule, line, detail) => findings.push({ rule, line, detail: String(detail).replace(/\s+/g, ' ').slice(0, 120) });

    const visit = (node, atRules, ruleChain, ruleDisplays) => {
        const here = node.type === 'at' ? [...atRules, node] : atRules;
        const chain = node.type === 'rule' ? [...ruleChain, node.prelude] : ruleChain;
        const displays = node.type === 'rule' ? [...ruleDisplays, node.display] : ruleDisplays;

        if (node.type === 'at' && node.name === 'media') {
            for (const feature of mediaFeatures(node.params)) {
                const allowed = feature.value !== null && ALLOWED_BREAKPOINTS[feature.dimension].has(Math.round(feature.value * 100) / 100);
                if (allowed) continue;
                add('breakpoint-off-set', node.line, `@media ${feature.dimension} ${feature.text}`);
                if (feature.value === 1000 || feature.value === 1001) add('breakpoint-1000', node.line, `@media ${feature.dimension} ${feature.text}`);
            }
        }

        if (node.type === 'rule' && !isHoverGated(atRules)) {
            for (const selector of splitTopLevel(node.prelude, ',')) {
                if (/:hover(?![\w-])/i.test(stripNegations(selector.text))) {
                    add('hover-ungated', lineAt(node.offset + selector.offset), node.display.slice(selector.offset, selector.offset + selector.text.length));
                }
            }
        }

        const sameProperty = new Map();
        for (const declaration of node.declarations) {
            const list = sameProperty.get(declaration.property) ?? [];
            list.push(declaration);
            sameProperty.set(declaration.property, list);
        }
        const focusSelector = chain.some(selector => /:focus(?:-visible)?(?![\w-])/i.test(stripNegations(selector)));
        const removesRing = node.declarations.some(declaration => /^(?:-\w+-)?box-shadow$/.test(declaration.property) && /^none\b/i.test(declaration.value));

        // @font-face descriptors describe a font file (font-style: italic names its italic face), not interface chrome.
        for (const declaration of node.type === 'at' && node.name === 'font-face' ? [] : node.declarations) {
            const { property, line } = declaration;
            if (/!\s*important\s*$/i.test(declaration.value)) add('important', line, declaration.display);
            if (property.startsWith('--')) continue;

            const value = declaration.value.replace(/\s*!\s*important\s*$/i, '').trim();
            const base = property.replace(/^-(?:webkit|moz|ms|o)-/, '');

            if (COLOR_PROPERTY.test(base) && !MOTION_PROPERTY.test(base)) {
                const { direct, fallback } = literalsInColorValue(value);
                for (const literal of direct) add('color-literal', line, `${property}: ${literal}`);
                for (const literal of fallback) add('color-literal-fallback', line, `${property}: ${literal}`);
            }

            if (RADIUS_PROPERTY.test(base) && !CSS_WIDE_KEYWORD.test(value)) {
                const literals = radiusLiterals(value);
                if (literals.length > 0) {
                    add('radius-literal', line, declaration.display);
                    if (literals.some(literal => literal.pixels !== null && literal.pixels > 20 && literal.pixels < PILL_PIXELS)) {
                        add('radius-over-20', line, declaration.display);
                    }
                }
                if (varFallbacks(value).some(fallback => radiusLiterals(fallback).length > 0)) add('radius-literal-fallback', line, declaration.display);
            }

            if (SPACING_PROPERTY.test(base) && !CSS_WIDE_KEYWORD.test(value)) {
                spacingLiterals(value).forEach(() => add('spacing-off-scale', line, declaration.display));
                for (const fallback of varFallbacks(value)) {
                    spacingLiterals(fallback).forEach(() => add('spacing-off-scale-fallback', line, declaration.display));
                }
            }

            if (base === 'box-shadow' && !splitTopLevel(value, ',').every(layer => isTokenShadowLayer(layer.text))) {
                add('shadow-literal', line, declaration.display);
            }

            if (MOTION_PROPERTY.test(base)) {
                for (const time of timeLiterals(value)) add('duration-literal', line, `${property}: ${time}`);
                for (const fallback of varFallbacks(value)) {
                    for (const time of timeLiterals(fallback)) add('duration-literal-fallback', line, `${property}: ${time}`);
                }
            }

            if (base === 'letter-spacing' && !/^(?:normal|0(?:\.0+)?(?:px|em|rem|ch)?)$/i.test(value) && !CSS_WIDE_KEYWORD.test(value)) {
                add('letter-spacing', line, declaration.display);
            }

            if (base === 'text-transform' && /(?:^|\s)uppercase(?:\s|$)/i.test(value)) add('uppercase', line, declaration.display);

            if ((base === 'font-style' && /(?:^|\s)(?:italic|oblique)(?:\s|$)/i.test(value))
                || (base === 'font' && /(?:^|\s)(?:italic|oblique)(?:\s|$)/i.test(value))) {
                add('italic', line, declaration.display);
            }

            if (/(?<![\w.#-])\d*\.?\d+vh(?![\w-])/i.test(value)) {
                const siblings = sameProperty.get(property);
                const later = siblings.slice(siblings.indexOf(declaration));
                if (!later.some(sibling => /(?<![\w.#-])\d*\.?\d+dvh(?![\w-])/i.test(sibling.value))) add('vh-without-dvh', line, declaration.display);
            }

            if (focusSelector && !removesRing && !isForcedColors(here) && visibleOutline(property, value)) {
                add('focus-outline', line, `${displays.at(-1)} { ${declaration.display} }`);
            }
        }

        for (const child of node.children) visit(child, here, chain, displays);
    };
    visit(root, [], [], []);

    const counts = Object.fromEntries(RULE_IDS.map(id => [id, 0]));
    for (const finding of findings) counts[finding.rule]++;
    findings.sort((left, right) => left.line - right.line || RULE_IDS.indexOf(left.rule) - RULE_IDS.indexOf(right.rule));
    return { counts, findings };
}

function toPosix(value) {
    return value.split(path.sep).join('/');
}

function collectCssFiles(directory, repoRoot, files) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') collectCssFiles(absolute, repoRoot, files);
        } else if (entry.isFile() && entry.name.endsWith('.css')) {
            files.push(toPosix(path.relative(repoRoot, absolute)));
        }
    }
}

export function listStylesheets(repoRoot = defaultRepoRoot) {
    const files = [];
    const publicRoot = path.join(repoRoot, 'public');
    if (fs.existsSync(publicRoot)) collectCssFiles(publicRoot, repoRoot, files);
    return files.filter(file => !excludedPathPattern.test(file)).sort();
}

function readUpstreamFiles(repoRoot) {
    const fixturePath = path.join(repoRoot, upstreamFixture);
    if (!fs.existsSync(fixturePath)) throw new Error(`Missing ${upstreamFixture} under ${repoRoot}`);
    const files = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    if (!Array.isArray(files)) throw new Error(`${upstreamFixture} must hold an array of paths`);
    return new Set(files);
}

function emptyTotals() {
    return Object.fromEntries(RULE_IDS.map(id => [id, 0]));
}

function emptySection() {
    return { fileCount: 0, totals: emptyTotals(), files: {} };
}

export function scanDesignRules({ repoRoot = defaultRepoRoot, upstreamFiles } = {}) {
    const upstream = upstreamFiles ? new Set(upstreamFiles) : readUpstreamFiles(repoRoot);
    const report = { version: baselineVersion, rules: RULES.map(rule => rule.id), sillybunny: emptySection(), upstreamOrigin: emptySection() };

    for (const file of listStylesheets(repoRoot)) {
        const section = upstream.has(file) ? report.upstreamOrigin : report.sillybunny;
        const { counts, findings } = scanCss(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
        section.files[file] = { counts, findings };
        section.fileCount++;
        for (const id of RULE_IDS) section.totals[id] += counts[id];
    }
    return report;
}

export function buildBaseline(report) {
    const files = {};
    for (const file of Object.keys(report.sillybunny.files).sort()) {
        const counts = Object.fromEntries(RULE_IDS.filter(id => report.sillybunny.files[file].counts[id] > 0).map(id => [id, report.sillybunny.files[file].counts[id]]));
        if (Object.keys(counts).length > 0) files[file] = counts;
    }
    return { version: baselineVersion, files };
}

export function validateBaseline(baseline) {
    const valid = baseline && baseline.version === baselineVersion && baseline.files && typeof baseline.files === 'object'
        && Object.values(baseline.files).every(counts => counts && typeof counts === 'object'
            && Object.entries(counts).every(([rule, count]) => RULE_IDS.includes(rule) && Number.isSafeInteger(count) && count > 0));
    if (!valid) throw new Error('Invalid design-rule baseline');
    return baseline;
}

/**
 * `above` lists counts over their baseline, `below` lists counts under it, `missing` lists baseline
 * files that are no longer a SillyBunny stylesheet of the scan. A file with no baseline entry has a
 * baseline of zero in every rule.
 */
export function compareToBaseline(report, baseline) {
    validateBaseline(baseline);
    const above = [];
    const below = [];
    const missing = Object.keys(baseline.files).filter(file => !report.sillybunny.files[file]).sort();
    for (const file of Object.keys(report.sillybunny.files).sort()) {
        for (const rule of RULE_IDS) {
            const current = report.sillybunny.files[file].counts[rule];
            const allowed = baseline.files[file]?.[rule] ?? 0;
            if (current > allowed) above.push({ file, rule, current, baseline: allowed });
            else if (current < allowed) below.push({ file, rule, current, baseline: allowed });
        }
    }
    return { above, below, missing };
}

/** Counts in `next` that are higher than in `previous`, and every count of a file `previous` does not hold. */
export function findIncreases(previous, next) {
    const rises = [];
    for (const [file, counts] of Object.entries(next.files)) {
        for (const [rule, count] of Object.entries(counts)) {
            const before = previous.files[file]?.[rule] ?? 0;
            if (count > before) rises.push({ file, rule, before, after: count, newFile: !previous.files[file] });
        }
    }
    return rises;
}

export const UPDATE_COMMAND = 'node scripts/audit-design-rules.js --update';

export function formatComparison({ above, below, missing = [] }) {
    const lines = [];
    for (const item of above) lines.push(`[ABOVE BASELINE] ${item.file} ${item.rule}: ${item.current} > ${item.baseline}`);
    for (const item of below) lines.push(`[BELOW BASELINE] ${item.file} ${item.rule}: ${item.current} < ${item.baseline}`);
    for (const file of missing) lines.push(`[MISSING] ${file}`);
    if (below.length > 0 || missing.length > 0) lines.push(`Counts went down or a stylesheet is gone. Lock it in with: ${UPDATE_COMMAND}`);
    return lines.join('\n');
}

export function formatIncreases(rises) {
    return [
        ...rises.map(rise => `[RISE] ${rise.file} ${rise.rule}: ${rise.before} -> ${rise.after}${rise.newFile ? ' (new file)' : ''}`),
        'The baseline was not written. Fix the stylesheet, or add --allow-increase when the rise is intended.',
    ].join('\n');
}

export function formatMarkdownSummary(report) {
    const rows = RULES.map(rule => `| \`${rule.id}\` | ${report.sillybunny.totals[rule.id]} | ${report.upstreamOrigin.totals[rule.id]} | ${rule.description}${rule.parent ? ` (subset of \`${rule.parent}\`)` : ''} |`);
    return [
        '| Rule | SillyBunny-authored | Upstream-origin | Meaning |',
        '|---|---:|---:|---|',
        ...rows,
        '',
        `Files scanned: ${report.sillybunny.fileCount} SillyBunny-authored (ratcheted), ${report.upstreamOrigin.fileCount} upstream-origin (reported only).`,
    ].join('\n');
}

export function formatReport(report) {
    const width = Math.max(...RULE_IDS.map(id => id.length));
    const lines = [`${'rule'.padEnd(width)}  sillybunny  upstream`];
    for (const id of RULE_IDS) lines.push(`${id.padEnd(width)}  ${String(report.sillybunny.totals[id]).padStart(10)}  ${String(report.upstreamOrigin.totals[id]).padStart(8)}`);
    lines.push('', `Files scanned: ${report.sillybunny.fileCount} SillyBunny-authored, ${report.upstreamOrigin.fileCount} upstream-origin.`);
    return lines.join('\n');
}

function parseArguments(argumentsList) {
    const options = { json: false, markdown: false, check: false, update: false, strict: false, allowIncrease: false };
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--allow-increase') options.allowIncrease = true;
        else if (['--json', '--markdown', '--check', '--update', '--strict'].includes(argument)) options[argument.slice(2)] = true;
        else if (['--baseline', '--root'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
            options[argument.slice(2)] = path.resolve(value);
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function runCli() {
    const options = parseArguments(process.argv.slice(2));
    const repoRoot = options.root ?? defaultRepoRoot;
    const baselinePath = options.baseline ?? (options.root ? path.join(options.root, 'scripts/design-rule-baseline.json') : defaultBaselinePath);
    const report = scanDesignRules({ repoRoot });

    if (options.update) {
        const next = buildBaseline(report);
        if (!options.allowIncrease && fs.existsSync(baselinePath)) {
            const rises = findIncreases(validateBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))), next);
            if (rises.length > 0) {
                console.error(formatIncreases(rises));
                process.exitCode = 1;
                return;
            }
        }
        fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
        fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 4)}\n`);
        console.log(`Wrote ${toPosix(path.relative(repoRoot, baselinePath))}`);
        return;
    }

    if (options.json) console.log(JSON.stringify(report, null, 4));
    else if (options.markdown) console.log(formatMarkdownSummary(report));
    else if (!options.check) console.log(formatReport(report));

    if (options.check) {
        const comparison = compareToBaseline(report, JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
        const message = formatComparison(comparison);
        if (message) console.error(message);
        else console.log('Design-rule counts match the baseline.');
        if (comparison.above.length > 0 || (options.strict && (comparison.below.length > 0 || comparison.missing.length > 0))) process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runCli();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
