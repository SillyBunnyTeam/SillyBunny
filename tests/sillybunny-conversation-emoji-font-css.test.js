import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const sources = JSON.parse(read('scripts/emoji/sources.json'));
const { BLOCK_BEGIN, BLOCK_END, findFontFaceBlock, renderFontFaceBlock } = await import(fileURLToPath(new URL('scripts/emoji/font-face-block.js', root)));

const css = read('public/css/sillybunny-conversation.css');
const ast = parse(css, { source: 'sillybunny-conversation.css' });
const chooserCss = read('public/css/sillybunny-emoji-chooser.css');
const chooserAst = parse(chooserCss, { source: 'sillybunny-emoji-chooser.css' });

const LEAD_STACK = 'var(--sb-emoji-lead), var(--mainFontFamily)';

function declarationsOf(tree, selector) {
    const rules = tree.stylesheet.rules.filter(rule => rule.type === 'rule' && rule.selectors.includes(selector));
    expect(rules.length).toBeGreaterThan(0);
    return Object.assign({}, ...rules.map(rule => Object.fromEntries(rule.declarations.filter(item => item.type === 'declaration').map(item => [item.property, item.value]))));
}

/** The code points of a `unicode-range` value. */
function parseRange(range) {
    const points = new Set();
    for (const part of range.split(',').map(item => item.trim())) {
        const [from, to = from] = part.replace(/^U\+/i, '').split('-').map(hex => Number.parseInt(hex, 16));
        for (let point = from; point <= to; point++) {
            points.add(point);
        }
    }
    return points;
}

describe('the generated font face', () => {
    const block = findFontFaceBlock(css);

    test('is the block that the font script writes from its own output, byte for byte', () => {
        expect(block).not.toBeNull();
        expect(block).toBe(renderFontFaceBlock({
            family: sources.font.family,
            file: sources.font.file,
            cacheKey: sources.font.cacheKey,
            range: read('scripts/emoji/font-unicode-range.txt'),
        }));
        expect(css.split(BLOCK_BEGIN)).toHaveLength(2);
        expect(css.split(BLOCK_END)).toHaveLength(2);
    });

    test('is one face with the swap period, whose file is the one that ships and whose address carries a key', () => {
        const face = ast.stylesheet.rules.find(rule => rule.type === 'font-face');
        const values = Object.fromEntries(face.declarations.filter(item => item.type === 'declaration').map(item => [item.property, item.value]));
        expect(ast.stylesheet.rules.filter(rule => rule.type === 'font-face')).toHaveLength(1);
        expect(values['font-family']).toBe(`'${sources.font.family}'`);
        expect(values['font-display']).toBe('swap');
        expect(values.src).toBe(`url('../webfonts/SBEmoji/${sources.font.file}?v=${sources.font.cacheKey}') format('woff2')`);
        expect(existsSync(new URL(`public/webfonts/SBEmoji/${sources.font.file}`, root))).toBe(true);
    });

    test('leaves the characters of ordinary text to the text font, and keeps the parts that a sequence needs', () => {
        const face = ast.stylesheet.rules.find(rule => rule.type === 'font-face');
        const range = parseRange(face.declarations.find(item => item.property === 'unicode-range').value);
        // The space, # and *, the digits, the copyright, registered and trade mark signs.
        for (const point of [0x20, 0x23, 0x2A, ...Array.from({ length: 10 }, (_, index) => 0x30 + index), 0xA9, 0xAE, 0x2122, 0x41, 0x61]) {
            expect([point, range.has(point)]).toEqual([point, false]);
        }
        // The joiner, the selector, the keycap mark and the tag characters, and emoji themselves.
        for (const point of [0x200D, 0xFE0F, 0x20E3, 0xE0020, 0xE007F, 0x1F600, 0x2764, 0x1F1E6, 0x1F3FB, 0x1F349]) {
            expect([point, range.has(point)]).toEqual([point, true]);
        }
    });
});

describe('the font on the surfaces of the mode', () => {
    test('is a leading family that a preference and a failed check turn into the text font again', () => {
        expect(declarationsOf(ast, ':root')['--sb-emoji-lead']).toBe(`'${sources.font.family}'`);
        expect(declarationsOf(ast, ':root[data-sb-emoji-font=\'device\']')['--sb-emoji-lead']).toBe('var(--mainFontFamily)');
    });

    test('leads the stack of the workspace, so that everything inside it that does not set its own family takes it', () => {
        expect(declarationsOf(ast, '#sheld[data-sb-conversation-mode=\'on\']')['font-family']).toBe(LEAD_STACK);
        expect(declarationsOf(ast, '#sheld[data-sb-conversation-mode=\'on\'] textarea')['font-family']).toBe('inherit');
    });

    test('leads the stack of the surfaces that are outside the workspace: the reaction row of the menu, the chooser, the details window', () => {
        for (const selector of ['.sb-action-menu-reaction', '.sb-details-window', '.sb-details-frame']) {
            expect([selector, declarationsOf(ast, selector)['font-family']]).toEqual([selector, LEAD_STACK]);
        }
        for (const selector of ['.sb-emoji-chooser', '.sb-emoji-variants']) {
            expect([selector, declarationsOf(chooserAst, selector)['font-family']]).toEqual([selector, LEAD_STACK]);
        }
    });

    test('is named only in the sheet that loads with the mode: no sheet of the start-up carries the face', () => {
        const names = [];
        const visit = (directory) => {
            for (const entry of readdirSync(directory)) {
                const path = `${directory}/${entry}`;
                if (statSync(path).isDirectory()) {
                    if (entry !== 'webfonts' && entry !== 'lib' && entry !== 'scripts') {
                        visit(path);
                    }
                } else if (/\.(css|html)$/.test(entry) && readFileSync(path, 'utf8').includes(sources.font.family)) {
                    names.push(path.replace(fileURLToPath(root), ''));
                }
            }
        };
        visit(fileURLToPath(new URL('public', root)));
        expect(names.sort()).toEqual(['public/css/sillybunny-conversation.css']);
    });
});
