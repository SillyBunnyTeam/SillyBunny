import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const templatesDir = 'public/scripts/extensions/in-chat-agents/templates/';
const upstreamOriginFiles = new Set(JSON.parse(fs.readFileSync(new URL('./fixtures/upstream-origin-public-files.json', import.meta.url), 'utf8')));
const vendoredPathPattern = /^public\/(?:lib\/|scripts\/extensions\/(?:quick-image-gen|third-party)\/|scripts\/extensions\/[^/]+\/lib\/)|\.min\.(?:css|js)$/;
const prefixedProperties = ['backdrop-filter', 'user-select'];
const unprefixedDeclarationPattern = /(?<![\w-])(?:backdrop-filter|user-select)\s*:/g;
const styleElementPattern = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/**
 * Lists unprefixed declarations whose block has no -webkit- companion.
 * Declarations outside braces count as one block, as in a style attribute.
 * @param {string} css
 * @returns {{ property: string, offset: number }[]}
 */
function findUnpairedDeclarations(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
    const unpaired = [];
    const blocks = [new Map()];
    let declaration = '';
    let declarationStart = 0;
    let quote = null;

    const endDeclaration = () => {
        const property = declaration.match(/^\s*([\w-]+)\s*:/)?.[1].toLowerCase();
        if (property) {
            blocks.at(-1).set(property, declarationStart + declaration.search(/\S/));
        }
        declaration = '';
    };
    const closeBlock = block => {
        for (const property of prefixedProperties) {
            if (block.has(property) && !block.has(`-webkit-${property}`)) {
                unpaired.push({ property, offset: block.get(property) });
            }
        }
    };

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (declaration === '') {
            declarationStart = index;
        }

        if (quote) {
            if (char === '\\') {
                declaration += char + (text[index + 1] ?? '');
                index += 1;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            declaration += char;
        } else if (char === '"' || char === '\'') {
            quote = char;
            declaration += char;
        } else if (char === '{') {
            blocks.push(new Map());
            declaration = '';
        } else if (char === '}') {
            endDeclaration();
            if (blocks.length > 1) {
                closeBlock(blocks.pop());
            }
        } else if (char === ';') {
            endDeclaration();
        } else {
            declaration += char;
        }
    }

    endDeclaration();
    blocks.forEach(closeBlock);
    return unpaired;
}

/**
 * Finds the CSS around a declaration in JavaScript or HTML: the enclosing <style> element,
 * else the enclosing quoted string, template literal or attribute value, else the line.
 * @param {string} source
 * @param {number} index
 * @param {{ start: number, text: string }[]} styleElements
 * @returns {{ start: number, text: string }}
 */
function getCssContext(source, index, styleElements) {
    const styleElement = styleElements.find(element => index >= element.start && index < element.start + element.text.length);
    if (styleElement) {
        return styleElement;
    }

    let start = index - 1;
    while (start >= 0 && !'"\'`'.includes(source[start])) {
        start -= 1;
    }

    if (start < 0) {
        const lineStart = source.lastIndexOf('\n', index) + 1;
        const lineEnd = source.indexOf('\n', index);
        return { start: lineStart, text: source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd) };
    }

    const end = source.indexOf(source[start], index);
    return { start: start + 1, text: source.slice(start + 1, end === -1 ? undefined : end) };
}

/**
 * @param {string} source JavaScript, HTML, or a template string value.
 * @returns {{ property: string, offset: number }[]}
 */
function findUnpairedEmbeddedDeclarations(source) {
    const styleElements = [...source.matchAll(styleElementPattern)]
        .map(match => ({ start: match.index + match[0].indexOf('>') + 1, text: match[1] }));
    const scannedContexts = new Set();
    const unpaired = new Map();

    for (const match of source.matchAll(unprefixedDeclarationPattern)) {
        const context = getCssContext(source, match.index, styleElements);
        if (scannedContexts.has(context.start)) {
            continue;
        }
        scannedContexts.add(context.start);

        for (const { property, offset } of findUnpairedDeclarations(context.text)) {
            unpaired.set(context.start + offset, property);
        }
    }

    return [...unpaired].map(([offset, property]) => ({ property, offset }));
}

function lineAt(source, offset) {
    return source.slice(0, offset).split('\n').length;
}

function* walkStrings(value, jsonPath = '$') {
    if (typeof value === 'string') {
        yield { jsonPath, value };
    } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            yield* walkStrings(child, Array.isArray(value) ? `${jsonPath}[${key}]` : `${jsonPath}.${key}`);
        }
    }
}

const scannedFiles = execFileSync('git', ['ls-files', '-z', '--', 'public'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => /\.(?:css|js|html)$/.test(file) || (file.startsWith(templatesDir) && file.endsWith('.json')))
    .filter(file => !vendoredPathPattern.test(file) && !upstreamOriginFiles.has(file))
    .filter(file => fs.existsSync(path.join(repoRoot, file)));

function findProblems(extensionPattern) {
    const problems = [];

    for (const file of scannedFiles.filter(candidate => extensionPattern.test(candidate))) {
        const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');

        if (file.endsWith('.json')) {
            for (const { jsonPath, value } of walkStrings(JSON.parse(source))) {
                for (const { property } of findUnpairedEmbeddedDeclarations(value)) {
                    problems.push(`${file} ${jsonPath} ${property}`);
                }
            }
            continue;
        }

        const unpaired = file.endsWith('.css') ? findUnpairedDeclarations(source) : findUnpairedEmbeddedDeclarations(source);
        for (const { property, offset } of unpaired) {
            problems.push(`${file}:${lineAt(source, offset)} ${property}`);
        }
    }

    return problems.sort();
}

describe('WebKit prefix companions', () => {
    test('scans fork files and skips upstream-origin and vendored files', () => {
        expect(scannedFiles).toContain('public/css/sillybunny-theme.css');
        expect(scannedFiles).toContain('public/scripts/sillybunny-conversation/settings-panel.js');
        expect(scannedFiles).toContain(`${templatesDir}index.json`);
        expect(upstreamOriginFiles.has('public/style.css')).toBe(true);
        expect(scannedFiles).not.toContain('public/style.css');
        expect(scannedFiles.some(file => vendoredPathPattern.test(file))).toBe(false);
    });

    test('finds unpaired declarations in nested CSS, style attributes, strings and <style> elements', () => {
        expect(findUnpairedDeclarations('.a { color: red; .b { backdrop-filter: blur(2px); } }')).toEqual([{ property: 'backdrop-filter', offset: 22 }]);
        expect(findUnpairedDeclarations('.a { -webkit-user-select: none; user-select: none; }')).toEqual([]);
        expect(findUnpairedDeclarations('.a { /* backdrop-filter: none; */ color: red; }')).toEqual([]);
        expect(findUnpairedDeclarations('@supports (backdrop-filter: blur(1px)) { .a { color: red; } }')).toEqual([]);
        expect(findUnpairedEmbeddedDeclarations('html = `<div style="color: red; backdrop-filter: blur(4px);"></div>`;').map(({ property }) => property)).toEqual(['backdrop-filter']);
        expect(findUnpairedEmbeddedDeclarations('el.style.cssText = `\n  -webkit-backdrop-filter: blur(8px);\n  backdrop-filter: blur(8px);\n`;')).toEqual([]);
        expect(findUnpairedEmbeddedDeclarations('<style>\n.a { user-select: none; }\n.b { -webkit-user-select: none; user-select: none; }\n</style>').map(({ property }) => property)).toEqual(['user-select']);
    });

    test('fork stylesheets pair backdrop-filter and user-select with -webkit- companions', () => {
        expect(findProblems(/\.css$/)).toEqual([]);
    });

    test('fork JavaScript and HTML pair inline backdrop-filter and user-select with -webkit- companions', () => {
        expect(findProblems(/\.(?:js|html)$/)).toEqual([]);
    });

    test('bundled agent templates pair backdrop-filter and user-select with -webkit- companions', () => {
        expect(findProblems(/\.json$/)).toEqual([]);
    });
});
