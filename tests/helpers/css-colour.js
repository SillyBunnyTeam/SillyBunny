/**
 * Colours as a stylesheet gives them, computed from the stylesheet text and the colours of a theme.
 *
 * A test names the rule that paints a part (a selector and a property). This module reads the value of that rule,
 * follows every `var()`, `color-mix()` and relative colour (`rgb(from ...)`, `oklab(from ...)`, `hsl(from ...)`) as the
 * CSS writes it, and returns the colour that reaches the screen. It holds no colour of the app, so a change to a mix in
 * the stylesheet changes the result.
 *
 * Only the constructs that the stylesheets use are supported. Any other construct throws, so that a new one is added
 * here on purpose and never skipped.
 */

/**
 * The `@supports` and `@media` conditions that hold in the current engines (Chromium, Firefox and Safari), all of which
 * read the relative colour syntaxes that the stylesheets guard. A hover is included because a desktop pointer hovers.
 * The guards of the toast and the notification test the shape of the declaration they protect (`min(l, 0.5)`,
 * `calc(a * ...)`, `max(l, 0.5)`), because Safari 16.4 and 17 read the channel keywords by an older draft, where such
 * math may be invalid; there an engine takes the declaration outside the guard. That fallback is not computed here, and
 * it is unverified on a real Safari 16.4 or 17. Safari before 18 also reads `calc()` on the channels of a relative colour
 * by that draft, so the hover colour of a link, which scales `s` and `l`, is computed here as the current engines compute it.
 */
export const BASELINE_CONDITIONS = new Set([
    '@supports (color: rgb(from black r g b / 1))',
    '@supports (color: oklab(from red l a b))',
    '@supports (color: oklab(from red max(l, 0.5) a b))',
    '@supports (color: oklab(from red min(l, 0.5) calc(a * min(1, 0.5 / l)) calc(b * min(1, 0.5 / l))))',
    '@supports (color: hsl(from red h s l))',
    '@supports (color: hsl(from red h calc(s * 1.1) calc(l * 1.1)))',
    '@media (hover: hover)',
]);

/** @typedef {{ rgb: number[], alpha: number }} Colour Un-premultiplied sRGB channels (0 to 255, outside that range for a colour beyond the sRGB gamut) and alpha (0 to 1). */

const normaliseSpace = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Splits at the separators that are not inside parentheses, brackets or quotes.
 * @param {string} text
 * @param {(character: string) => boolean} isSeparator
 */
function splitTopLevel(text, isSeparator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quote) {
            if (character === quote) quote = null;
        } else if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '(' || character === '[') {
            depth++;
        } else if (character === ')' || character === ']') {
            depth--;
        } else if (depth === 0 && isSeparator(character)) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map(part => part.trim()).filter(part => part !== '');
}

const splitCommas = (text) => splitTopLevel(text, character => character === ',');
const splitWords = (text) => splitTopLevel(text, character => /\s/.test(character));

// ---------------------------------------------------------------------------------------------------------------------
// Reading a stylesheet

/**
 * @typedef {{ type: 'declaration', name: string, value: string, important: boolean }} Declaration
 * @typedef {{ type: 'rule', selector: string, items: Item[] }} StyleRule
 * @typedef {{ type: 'at', prelude: string, items: Item[] }} AtRule
 * @typedef {Declaration | StyleRule | AtRule} Item
 */

/** @returns {Declaration | null} */
function readDeclaration(chunk) {
    const colon = chunk.indexOf(':');
    if (colon < 0) return null;
    const name = chunk.slice(0, colon).trim();
    let value = chunk.slice(colon + 1).trim();
    const important = /\s*!important$/i.test(value);
    if (important) value = value.replace(/\s*!important$/i, '');
    return name ? { type: 'declaration', name, value, important } : null;
}

/** Reads items up to the `}` that closes the block, or to the end of the text. */
function readItems(text, from) {
    const items = [];
    let depth = 0;
    let quote = null;
    let chunkStart = from;
    let index = from;
    const flushDeclaration = (end) => {
        const declaration = readDeclaration(text.slice(chunkStart, end));
        if (declaration) items.push(declaration);
    };
    while (index < text.length) {
        const character = text[index];
        if (quote) {
            if (character === '\\') index++;
            else if (character === quote) quote = null;
        } else if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
        } else if (depth === 0 && character === '{') {
            const head = normaliseSpace(text.slice(chunkStart, index));
            const inner = readItems(text, index + 1);
            items.push(head.startsWith('@') ? { type: 'at', prelude: head, items: inner.items } : { type: 'rule', selector: head, items: inner.items });
            index = inner.end;
            chunkStart = index;
            continue;
        } else if (depth === 0 && character === ';') {
            flushDeclaration(index);
            chunkStart = index + 1;
        } else if (depth === 0 && character === '}') {
            flushDeclaration(index);
            return { items, end: index + 1 };
        }
        index++;
    }
    flushDeclaration(text.length);
    return { items, end: text.length };
}

/**
 * @param {string} source CSS text.
 * @returns {Item[]}
 */
export function parseStylesheet(source) {
    return readItems(source.replace(/\/\*[\s\S]*?\*\//g, ''), 0).items;
}

function* walkRules(items, path) {
    for (const item of items) {
        if (item.type === 'rule') {
            yield {
                path,
                selectors: splitCommas(item.selector).map(normaliseSpace),
                declarations: item.items.filter(child => child.type === 'declaration'),
            };
        } else if (item.type === 'at') {
            yield* walkRules(item.items, [...path, normaliseSpace(item.prelude)]);
        }
    }
}

const rulesBySheet = new WeakMap();

/**
 * Every style rule of a stylesheet, with the at-rules it sits in, in source order. A lookup walks the rules of a large
 * stylesheet many times over, so each sheet is flattened once.
 * @param {Item[]} items
 * @returns {{ path: string[], selectors: string[], declarations: Declaration[] }[]}
 */
function rulesOf(items) {
    if (!rulesBySheet.has(items)) {
        rulesBySheet.set(items, [...walkRules(items, [])]);
    }
    return rulesBySheet.get(items);
}

const holds = (path, conditions) => path.every(prelude => conditions.has(prelude));

/**
 * The value that a rule gives a property: the last declaration, in the source order of the stylesheets, of the rules
 * whose selector list holds `selector` and whose at-rules all hold under `conditions`. A rule inside an `@supports` that
 * holds therefore replaces the plain rule above it, as it does in the engine.
 * @param {Item[][]} sheets In cascade order.
 * @param {{ selector: string, property: string, conditions?: Set<string> }} query
 * @returns {string}
 */
export function declaredValue(sheets, { selector, property, conditions = BASELINE_CONDITIONS }) {
    const wanted = normaliseSpace(selector);
    let found = null;
    for (const sheet of sheets) {
        for (const rule of rulesOf(sheet)) {
            if (!rule.selectors.includes(wanted) || !holds(rule.path, conditions)) continue;
            for (const declaration of rule.declarations) {
                if (declaration.name === property && (!found?.important || declaration.important)) {
                    found = declaration;
                }
            }
        }
    }
    if (!found) {
        throw new Error(`No rule with the selector "${wanted}" declares ${property} under the given conditions`);
    }
    return found.value;
}

/**
 * Every declaration of every rule, with the selectors of its rule and the at-rules that the rule sits in.
 * @param {Item[][]} sheets
 * @returns {{ selectors: string[], name: string, value: string, path: string[] }[]}
 */
export function declarationsOf(sheets) {
    return sheets.flatMap(sheet => rulesOf(sheet).flatMap(({ selectors, path, declarations }) => declarations.map(({ name, value }) => ({ selectors, name, value, path }))));
}

// ---------------------------------------------------------------------------------------------------------------------
// Custom properties

/**
 * The specificity of a rule on the root element, or `null` when the selector does not select it. Only `:root` and
 * `html`, each with attribute selectors, are understood.
 * @param {string} selector
 * @param {Record<string, string>} attributes The attributes that the root element carries.
 */
function rootSpecificity(selector, attributes) {
    const match = /^(:root|html)((?:\[[^\]]+\])*)$/.exec(selector);
    if (!match) return null;
    let specificity = match[1] === ':root' ? 10 : 1;
    for (const [, name, quoted, doubleQuoted, bare] of match[2].matchAll(/\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]/g)) {
        const expected = quoted ?? doubleQuoted ?? bare;
        if (attributes[name] === undefined || (expected !== undefined && attributes[name] !== expected)) return null;
        specificity += 10;
    }
    return specificity;
}

/** Whether a declaration ranked `rank` beats one ranked `other`: important first, then specificity, then source order. */
function outranks(rank, other) {
    const at = rank.findIndex((part, index) => part !== other[index]);
    return at >= 0 && rank[at] > other[at];
}

/**
 * The custom properties that the rules for the root element declare, by the cascade: an important declaration, then
 * the rule with the higher specificity, then the later one. Values are specified values, still holding their `var()`.
 * @param {Item[][]} sheets In cascade order.
 * @param {{ attributes: Record<string, string>, inline?: Record<string, string>, conditions?: Set<string> }} root
 * @returns {Map<string, string>}
 */
export function rootCustomProperties(sheets, { attributes, inline = {}, conditions = BASELINE_CONDITIONS }) {
    const winners = new Map();
    let order = 0;
    for (const sheet of sheets) {
        for (const rule of rulesOf(sheet)) {
            const specificities = rule.selectors.map(selector => rootSpecificity(selector, attributes)).filter(value => value !== null);
            if (specificities.length === 0 || !holds(rule.path, conditions)) continue;
            const specificity = Math.max(...specificities);
            for (const { name, value, important } of rule.declarations) {
                if (!name.startsWith('--')) continue;
                const rank = [important ? 1 : 0, specificity, order++];
                if (!winners.has(name) || outranks(rank, winners.get(name).rank)) {
                    winners.set(name, { value, rank });
                }
            }
        }
    }
    const properties = new Map([...winners].map(([name, { value }]) => [name, value]));
    for (const [name, value] of Object.entries(inline)) {
        properties.set(name, value);
    }
    return properties;
}

/**
 * Replaces every `var()` of a value. A property that cannot be resolved makes the whole value invalid (`null`), as
 * "invalid at computed-value time" does.
 * @param {string} value
 * @param {(name: string) => string | null | undefined} lookup
 * @returns {string | null}
 */
function substituteVariables(value, lookup) {
    let result = '';
    let index = 0;
    for (const match of value.matchAll(/(?<![\w-])var\(/g)) {
        if (match.index < index) continue;
        let depth = 1;
        let end = match.index + match[0].length;
        while (depth > 0 && end < value.length) {
            if (value[end] === '(') depth++;
            else if (value[end] === ')') depth--;
            end++;
        }
        const [name, ...fallbackParts] = splitCommas(value.slice(match.index + 4, end - 1));
        const referenced = lookup(name);
        let replacement = referenced ?? null;
        if (replacement === null && fallbackParts.length > 0) {
            replacement = substituteVariables(fallbackParts.join(', '), lookup);
        }
        if (replacement === null) return null;
        result += value.slice(index, match.index) + replacement;
        index = end;
    }
    return result + value.slice(index);
}

/**
 * The computed custom properties of an element: its own declarations, and the properties it inherits from its parent.
 * @param {Map<string, string>} specified
 * @param {{ get: (name: string) => string | null | undefined } | null} [parent]
 */
export function createScope(specified, parent = null) {
    const computed = new Map();
    const resolving = new Set();
    const scope = {
        get(name) {
            if (computed.has(name)) return computed.get(name);
            if (!specified.has(name)) return parent ? parent.get(name) : undefined;
            if (resolving.has(name)) throw new Error(`The custom property ${name} refers to itself`);
            resolving.add(name);
            const value = substituteVariables(specified.get(name), scope.get);
            resolving.delete(name);
            computed.set(name, value);
            return value;
        },
    };
    return scope;
}

// ---------------------------------------------------------------------------------------------------------------------
// Colour maths

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const toLinear = (channel) => Math.sign(channel) * (Math.abs(channel) <= 0.04045 ? Math.abs(channel) / 12.92 : ((Math.abs(channel) + 0.055) / 1.055) ** 2.4);
const toGamma = (channel) => Math.sign(channel) * (Math.abs(channel) <= 0.0031308 ? Math.abs(channel) * 12.92 : 1.055 * Math.abs(channel) ** (1 / 2.4) - 0.055);

/** @param {number[]} rgb 0 to 255. @returns {number[]} OKLab L, a, b. */
export function rgbToOklab(rgb) {
    const [red, green, blue] = rgb.map(channel => toLinear(channel / 255));
    const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
    const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
    const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

/** @param {number[]} lab OKLab L, a, b. @returns {number[]} sRGB 0 to 255, not clipped. */
function oklabToRgb([lightness, a, b]) {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ].map(channel => toGamma(channel) * 255);
}

/** @param {number[]} rgb 0 to 255. @returns {number[]} Hue in degrees, saturation and lightness from 0 to 100. */
function rgbToHsl(rgb) {
    const [red, green, blue] = rgb.map(channel => clamp(channel, 0, 255) / 255);
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const lightness = (high + low) / 2;
    const spread = high - low;
    if (spread === 0) return [0, 0, lightness * 100];
    const saturation = spread / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (high === red) hue = ((green - blue) / spread) % 6;
    else if (high === green) hue = (blue - red) / spread + 2;
    else hue = (red - green) / spread + 4;
    return [(hue * 60 + 360) % 360, saturation * 100, lightness * 100];
}

/**
 * CSS Color 4's conversion. A saturation above 100 is not clamped, because every engine converts it as it is and clips
 * the channels afterwards, so `calc(s * 1.1)` on a fully saturated colour gives a more vivid one than saturation 100.
 * @param {number[]} hsl Hue in degrees, saturation and lightness from 0 to 100.
 * @returns {number[]} sRGB 0 to 255.
 */
function hslToRgb([hue, saturation, lightness]) {
    const s = Math.max(saturation, 0) / 100;
    const l = lightness / 100;
    const channelAt = (offset) => {
        const position = (offset + hue / 30) % 12;
        return (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(position - 3, 9 - position, 1))) * 255;
    };
    return [channelAt(0), channelAt(8), channelAt(4)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading colours and numbers

/** Evaluates `calc()`, `max()`, `min()`, the four operations and the channel keywords of a relative colour. */
function evaluateExpression(source, keywords) {
    const tokens = source.match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z]+|[()*/+,-]/gi) ?? [];
    let index = 0;
    const peek = () => tokens[index];
    const next = () => tokens[index++];
    const expect = (token) => {
        if (next() !== token) throw new Error(`Expected ${token} in ${source}`);
    };
    function sum() {
        let value = product();
        while (peek() === '+' || peek() === '-') {
            const operator = next();
            const right = product();
            value = operator === '+' ? value + right : value - right;
        }
        return value;
    }
    function product() {
        let value = unary();
        while (peek() === '*' || peek() === '/') {
            const operator = next();
            const right = unary();
            value = operator === '*' ? value * right : value / right;
        }
        return value;
    }
    function unary() {
        if (peek() === '-') {
            next();
            return -unary();
        }
        return primary();
    }
    function primary() {
        const token = next();
        if (token === '(') {
            const value = sum();
            expect(')');
            return value;
        }
        if (/^[\d.]/.test(token)) return Number(token);
        if (token === undefined) throw new Error(`Unfinished expression: ${source}`);
        if (peek() === '(') {
            next();
            const args = [sum()];
            while (peek() === ',') {
                next();
                args.push(sum());
            }
            expect(')');
            if (token === 'calc' && args.length === 1) return args[0];
            if (token === 'max') return Math.max(...args);
            if (token === 'min') return Math.min(...args);
            throw new Error(`Unsupported function ${token}() in ${source}`);
        }
        if (!(token in keywords)) throw new Error(`Unknown keyword ${token} in ${source}`);
        return keywords[token];
    }
    const value = sum();
    if (index !== tokens.length) throw new Error(`Unexpected ${peek()} in ${source}`);
    return value;
}

/**
 * One slot of a colour function: a number, a percentage of `percentOf`, a keyword or an expression.
 * @param {string} token
 * @param {Record<string, number>} keywords
 * @param {number} percentOf What 100% stands for.
 */
function evaluateSlot(token, keywords, percentOf) {
    if (/^[+-]?(\d*\.?\d+)(e[+-]?\d+)?%$/i.test(token)) return parseFloat(token) / 100 * percentOf;
    if (/^[+-]?(\d*\.?\d+)(e[+-]?\d+)?$/i.test(token)) return parseFloat(token);
    return evaluateExpression(token, keywords);
}

/** Splits `from <origin> c1 c2 c3 [/ alpha]` or `c1 c2 c3 [/ alpha]` (and the comma form) into its parts. */
function colourArguments(inner) {
    const words = splitWords(splitCommas(inner).join(' '));
    const origin = words[0] === 'from' ? words[1] : null;
    const rest = origin === null ? words : words.slice(2);
    const slash = rest.indexOf('/');
    const channels = slash < 0 ? rest.slice(0, 3) : rest.slice(0, slash);
    const alpha = slash < 0 ? rest[3] : rest[slash + 1];
    if (channels.length !== 3) throw new Error(`Expected three colour channels in ${inner}`);
    return { origin, channels, alpha };
}

const HEX_COLOUR = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

function parseHex(value) {
    if (!HEX_COLOUR.test(value)) throw new Error(`Not a hex colour: ${value}`);
    const digits = value.slice(1);
    const full = digits.length <= 4 ? [...digits].map(digit => digit + digit).join('') : digits;
    const channels = [0, 2, 4, 6].map(at => (full.length > at ? parseInt(full.slice(at, at + 2), 16) : null));
    return { rgb: channels.slice(0, 3), alpha: channels[3] === null ? 1 : channels[3] / 255 };
}

/**
 * @param {string} text A colour with no `var()` left in it.
 * @param {{ currentColour?: Colour }} context What `currentColor` stands for.
 * @returns {Colour}
 */
function parseColour(text, context) {
    const value = text.trim();
    const keyword = value.toLowerCase();
    if (keyword === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
    if (keyword === 'white') return { rgb: [255, 255, 255], alpha: 1 };
    if (keyword === 'black') return { rgb: [0, 0, 0], alpha: 1 };
    if (keyword === 'currentcolor') {
        if (!context.currentColour) throw new Error('currentColor has no colour to stand for here');
        return context.currentColour;
    }
    if (value.startsWith('#')) return parseHex(value);
    const call = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(value);
    if (!call) throw new Error(`Cannot read the colour: ${value}`);
    const name = call[1].toLowerCase();
    if (name === 'color-mix') return parseColorMix(call[2], context);
    const { origin, channels, alpha } = colourArguments(call[2]);
    const from = origin === null ? null : parseColour(origin, context);
    if (name === 'rgb' || name === 'rgba') {
        const keywords = from ? { r: from.rgb[0], g: from.rgb[1], b: from.rgb[2], alpha: from.alpha } : {};
        return {
            rgb: channels.map(token => evaluateSlot(token, keywords, 255)),
            alpha: alpha === undefined ? 1 : clamp(evaluateSlot(alpha, keywords, 1), 0, 1),
        };
    }
    if (!from) throw new Error(`Only the relative form of ${name}() is supported: ${value}`);
    if (name === 'oklab') {
        const [l, a, b] = rgbToOklab(from.rgb);
        const keywords = { l, a, b, alpha: from.alpha };
        return {
            rgb: oklabToRgb(channels.map((token, at) => evaluateSlot(token, keywords, at === 0 ? 1 : 0.4))),
            alpha: alpha === undefined ? from.alpha : clamp(evaluateSlot(alpha, keywords, 1), 0, 1),
        };
    }
    if (name === 'hsl') {
        const [h, s, l] = rgbToHsl(from.rgb);
        const keywords = { h, s, l, alpha: from.alpha };
        return {
            rgb: hslToRgb(channels.map((token, at) => evaluateSlot(token, keywords, at === 0 ? 360 : 100))),
            alpha: alpha === undefined ? from.alpha : clamp(evaluateSlot(alpha, keywords, 1), 0, 1),
        };
    }
    throw new Error(`Unsupported colour function ${name}(): ${value}`);
}

/**
 * `color-mix(in srgb|oklab, <colour> [<percentage>], <colour> [<percentage>])`, interpolated premultiplied by alpha.
 * @param {string} inner
 * @param {{ currentColour?: Colour }} context
 * @returns {Colour}
 */
function parseColorMix(inner, context) {
    const [method, ...operands] = splitCommas(inner);
    const space = /^in\s+(srgb|oklab)$/.exec(method)?.[1];
    if (!space) throw new Error(`Unsupported colour space in color-mix(${inner})`);
    if (operands.length !== 2) throw new Error(`Expected two colours in color-mix(${inner})`);
    const entries = operands.map((operand) => {
        const words = splitWords(operand);
        const percentage = words.find(word => word.endsWith('%'));
        const colour = parseColour(words.filter(word => word !== percentage).join(' '), context);
        return { colour, percentage: percentage === undefined ? null : parseFloat(percentage) };
    });
    let [first, second] = entries.map(entry => entry.percentage);
    if (first === null && second === null) [first, second] = [50, 50];
    else if (first === null) first = 100 - second;
    else if (second === null) second = 100 - first;
    const total = first + second;
    if (total <= 0) throw new Error(`The percentages of color-mix(${inner}) add up to nothing`);
    const alphaFactor = total < 100 - 1e-9 ? total / 100 : 1;
    const weights = [first / total, second / total];
    const alpha = entries.reduce((sum, { colour }, at) => sum + colour.alpha * weights[at], 0);
    if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
    const coordinates = entries.map(({ colour }) => (space === 'srgb' ? colour.rgb.map(channel => channel / 255) : rgbToOklab(colour.rgb)));
    const mixed = [0, 1, 2].map(at => entries.reduce((sum, { colour }, entry) => sum + coordinates[entry][at] * colour.alpha * weights[entry], 0) / alpha);
    return { rgb: space === 'srgb' ? mixed.map(channel => channel * 255) : oklabToRgb(mixed), alpha: alpha * alphaFactor };
}

/**
 * The colour that a declaration's value stands for.
 * @param {string} value As declared, with its `var()`.
 * @param {{ get: (name: string) => string | null | undefined }} scope
 * @param {{ currentColour?: Colour }} [context]
 * @returns {Colour}
 */
export function colourOf(value, scope, context = {}) {
    const resolved = substituteVariables(value, scope.get);
    if (resolved === null) {
        throw new Error(`The value "${value}" refers to a custom property that is not defined`);
    }
    return parseColour(resolved, context);
}

// ---------------------------------------------------------------------------------------------------------------------
// Painting and contrast

/** The 8-bit channels that the screen shows for an opaque colour; a colour beyond the sRGB gamut is clipped, as every engine does. */
export const displayed = (colour) => colour.rgb.map(channel => clamp(Math.round(channel), 0, 255));

/** `top` painted over the opaque 8-bit colour `under`. */
export const paint = (top, under) => top.rgb.map((channel, index) => clamp(Math.round(clamp(channel, 0, 255) * top.alpha + under[index] * (1 - top.alpha)), 0, 255));

/** WCAG 2.2 relative luminance of 8-bit sRGB channels. */
export function luminance(channels) {
    return channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

/** WCAG 2.2 contrast ratio of two opaque colours given as 8-bit channels. */
export function contrastRatio(first, second) {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
}

export const toHex = (channels) => `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
