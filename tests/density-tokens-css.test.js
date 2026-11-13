import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8');
const themeCss = read('public/css/sillybunny-theme.css');
const tabsCss = read('public/css/sillybunny-tabs.css');

const SHEETS = [
    'public/css/sillybunny-theme.css',
    'public/css/sillybunny-tabs.css',
    'public/css/sillybunny-mobile-shell.css',
    'public/css/mobile-styles.css',
    'public/css/sillybunny-conversation.css',
    'public/css/sillybunny-prompt-editor.css',
    'public/css/sillybunny-message-actions.css',
    'public/scripts/extensions/in-chat-agents/style.css',
];

/** The density tokens, as `[name, normal fine, normal coarse, compact fine, compact coarse]` in px. */
const TOKENS = [
    ['--sb-control-min-height', 38, 44, 32, 44],
    ['--sb-field-min-height', 46, 44, 40, 44],
    ['--sb-density-row-min-height', 50, 50, 46, 46],
    ['--sb-density-row-padding-block', 6, 6, 6, 6],
    ['--sb-density-row-padding-inline', 12, 12, 12, 12],
    ['--sb-density-row-gap', 6, 6, 6, 6],
    ['--sb-density-row-text-gap', 3, 3, 3, 3],
    ['--sb-settings-group-gap', 24, 24, 18, 18],
    ['--sb-settings-heading-gap', 6, 6, 6, 6],
    ['--sb-settings-inset', 12, 12, 9, 9],
    ['--sb-settings-inset-top', 24, 24, 18, 18],
    ['--sb-density-container-padding', 12, 12, 9, 9],
    ['--sb-row-gap', 10, 10, 8, 8],
];

/** Tokens that size a target; they never go under the pointer's floor. */
const TARGET_TOKENS = ['--sb-control-min-height', '--sb-field-min-height', '--sb-density-row-min-height', '--sb-icon-control-size', '--sb-inline-drawer-icon-size'];

/** The declarations of the first rule `selector { ... }` that starts a line, or of the one in the `@media` block that starts at `media`. */
function declarations(css, selector, media) {
    const scope = media ? css.slice(css.indexOf(media)) : css;
    const start = scope.search(new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm'));
    expect(start).toBeGreaterThanOrEqual(0);
    const body = scope.slice(scope.indexOf('{', start) + 1, scope.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

/** A small evaluator for the values that the tokens use: calc(), max(), min(), var(), px and rem, + - * /. */
function evaluate(value, vars) {
    const tokens = value.match(/--[\w-]+|var\(|[a-z]+\(|[\d.]+(?:px|rem)?|[-+*/(),]/g);
    let index = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];
    function parseArguments() {
        const values = [expression()];
        while (peek() === ',') {
            take();
            values.push(expression());
        }
        expect(take()).toBe(')');
        return values;
    }
    function primary() {
        const token = take();
        if (token === 'var(') {
            const name = take();
            const fallback = peek() === ',' ? (take(), expression()) : undefined;
            expect(take()).toBe(')');
            if (!(name in vars)) {
                if (fallback === undefined) {
                    throw new Error(`${name} has no value`);
                }
                return fallback;
            }
            return evaluate(vars[name], vars);
        }
        if (token === '(') {
            const inner = expression();
            expect(take()).toBe(')');
            return inner;
        }
        if (token === 'calc(') {
            return parseArguments()[0];
        }
        if (token === 'max(') {
            return Math.max(...parseArguments());
        }
        if (token === 'min(') {
            return Math.min(...parseArguments());
        }
        if (token === '-') {
            return -primary();
        }
        expect(token).toMatch(/^[\d.]+(px|rem)?$/);
        return token.endsWith('rem') ? parseFloat(token) * 16 : parseFloat(token);
    }
    function product() {
        let result = primary();
        while (peek() === '*' || peek() === '/') {
            const operator = take();
            const right = primary();
            result = operator === '*' ? result * right : result / right;
        }
        return result;
    }
    function expression() {
        let result = product();
        while (peek() === '+' || peek() === '-') {
            const operator = take();
            const right = product();
            result = operator === '+' ? result + right : result - right;
        }
        return result;
    }
    const result = expression();
    expect(index).toBe(tokens.length);
    return result;
}

const rootBlock = declarations(themeCss, ':root');
const coarseBlock = declarations(themeCss, ':root', '@media (pointer: coarse) {\n    :root {\n        --sb-density-floor');

/** The value of a token for a pointer and a density, as the cascade gives it: the coarse form wins on a coarse pointer. */
function valueOf(name, { coarse, compact }) {
    const compactScale = evaluate(rootBlock['--sb-density-compact-scale'], {});
    const vars = { ...rootBlock, ...(coarse ? coarseBlock : {}), '--sb-density-scale': String(compact ? compactScale : 1), '--sb-mobile-touch-target': '44px' };
    return evaluate(vars[name], vars);
}

describe('density tokens', () => {
    test.each(TOKENS)('%s reads %p px (normal fine), %p (normal coarse), %p (compact fine), %p (compact coarse)', (name, normalFine, normalCoarse, compactFine, compactCoarse) => {
        expect(valueOf(name, { coarse: false, compact: false })).toBeCloseTo(normalFine, 3);
        expect(valueOf(name, { coarse: true, compact: false })).toBeCloseTo(normalCoarse, 3);
        expect(valueOf(name, { coarse: false, compact: true })).toBeCloseTo(compactFine, 3);
        expect(valueOf(name, { coarse: true, compact: true })).toBeCloseTo(compactCoarse, 3);
    });

    test.each(TARGET_TOKENS)('%s is at least 32px on a fine pointer and 44px on a coarse one, in both densities', (name) => {
        for (const compact of [false, true]) {
            expect(valueOf(name, { coarse: false, compact })).toBeGreaterThanOrEqual(32);
            expect(valueOf(name, { coarse: true, compact })).toBeGreaterThanOrEqual(44);
        }
    });

    test('the floor is 32px, and the coarse form of it is the 44px touch target', () => {
        expect(rootBlock['--sb-density-floor']).toBe('32px');
        expect(coarseBlock['--sb-density-floor']).toBe('var(--sb-mobile-touch-target)');
        expect(themeCss).toMatch(/--sb-mobile-touch-target:\s*44px;/);
    });

    test('compact density is one scale, defined once, that the tokens read', () => {
        expect(rootBlock['--sb-density-compact-scale']).toBe('0.88');
        expect(rootBlock['--sb-density-t']).toContain('var(--sb-density-scale');
        expect(tabsCss).toMatch(/:root\[data-sb-compact-mode='true'\] \{\s*--sb-density-scale: var\(--sb-density-compact-scale\);/);
        expect(themeCss.match(/--sb-density-compact-scale:/g)).toHaveLength(1);
    });

    test.each([...TOKENS.map(([name]) => name), '--sb-density-t', '--sb-density-floor'])('%s is declared only by the theme sheet, outside any compact selector', (name) => {
        const declaring = [];
        for (const file of ['public/style.css', ...readdirSync(path.join(repoRoot, 'public/css')).map(sheet => `public/css/${sheet}`)].filter(file => file.endsWith('.css') && !file.endsWith('.min.css'))) {
            const css = read(file);
            for (const match of css.matchAll(new RegExp(`(^|[;{\\s])${name}:`, 'g'))) {
                const rule = css.lastIndexOf('{', match.index);
                const selector = css.slice(Math.max(css.lastIndexOf('}', rule), css.lastIndexOf('{', rule - 1)) + 1, rule);
                declaring.push({ file, compact: selector.includes('data-sb-compact-mode') });
            }
        }
        expect(declaring.filter(item => item.file !== 'public/css/sillybunny-theme.css')).toEqual([]);
        expect(declaring.filter(item => item.compact)).toEqual([]);
    });
});

describe('compact rules in the SillyBunny sheets', () => {
    const rules = SHEETS.flatMap(file => [...read(file).matchAll(/([^{}]*data-sb-compact-mode[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
        file: path.basename(file),
        selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '),
        body,
    })));

    test('the compact rules are the ones that the tokens do not cover', () => {
        expect(rules.length).toBeGreaterThan(0);
        expect(rules.length).toBeLessThanOrEqual(43);
    });

    test('no compact rule changes the size of text', () => {
        // Icon glyphs inside a control are not text; their size follows the control.
        const glyphs = ['.sb-settings-tab .fa-solid', '.sb-conversation-message-action'];
        const resizing = rules.filter(rule => /(^|[;\s])font-size:/.test(rule.body) && !glyphs.some(glyph => rule.selector.endsWith(glyph)));
        expect(resizing.map(rule => `${rule.file}: ${rule.selector}`)).toEqual([]);
    });

    test('no compact rule sets a target under the floor', () => {
        // Sizes under 44px that are not targets: an icon glyph and a divider.
        const notTargets = ['.sb-settings-tab .fa-solid', '.sb-conversation-message-divider'];
        const under = [];
        for (const rule of rules.filter(candidate => !notTargets.some(item => candidate.selector.endsWith(item)))) {
            for (const [, property, value] of rule.body.matchAll(/(?:^|[;\s])((?:min-|max-)?(?:height|width|block-size|inline-size)):\s*(\d+(?:\.\d+)?)px/g)) {
                if (!property.startsWith('max-') && Number(value) < 44) {
                    under.push(`${rule.file}: ${rule.selector} { ${property}: ${value}px }`);
                }
            }
        }
        expect(under).toEqual([]);
    });

    test('the composer sizes keep the pointer floor', () => {
        const mobileShell = read('public/css/sillybunny-mobile-shell.css');
        const mobileStyles = read('public/css/mobile-styles.css');
        const sized = [];
        for (const source of [mobileShell, mobileStyles, themeCss]) {
            for (const [, property, value] of source.matchAll(/(--(?:sb-mobile-composer-action-size|sb-mobile-composer-input-height|sb-composer-action-size|bottomFormBlockSize)):\s*([^;]+);/g)) {
                if (/\bclamp\(|\bmax\(/.test(value) && !/^var\(/.test(value)) {
                    sized.push({ property, value, floor: value.includes('var(--sb-density-floor)') });
                }
            }
        }
        expect(sized.length).toBeGreaterThan(0);
        expect(sized.filter(item => !item.floor)).toEqual([]);
    });
});
