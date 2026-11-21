#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');
const defaultBase = 'v1.8.1';
const workingTreeLabel = 'working tree';
const maxBuffer = 1 << 30;

const stylesheetExtensions = new Set(['.css']);
const htmlExtensions = new Set(['.html', '.htm']);
const scriptExtensions = new Set(['.js', '.mjs']);
const conditionalGroupRules = new Set(['media', 'supports', 'container', 'layer', 'scope', 'document', '-moz-document', 'starting-style']);
const maxFilesShown = 8;

function printHelp() {
    console.log(`Usage: node scripts/list-sb-class-changes.js [--base <ref>] [--head <ref>] [--json] [--out <file>] [--renames <json file>] [--root <dir>]

Lists the .sb-* class names and #sb-* / #sb_* ids that exist at --base and no longer exist at --head.

Options:
  --base <ref>      Git ref to compare from. Defaults to ${defaultBase}.
  --head <ref>      Git ref to compare to. Defaults to the working tree.
  --json            Print JSON instead of Markdown.
  --out <file>      Write the output to this file instead of stdout.
  --renames <file>  JSON object that maps old names to new names. Matching removed
                    names move to "renamed". Prefix an id with "#".
  --root <dir>      Repository root. Defaults to the parent of scripts/.
  --help            Show this help message.

Stylesheet selectors under public/ are exact. Markup and script usage is heuristic, because
class names can be built at run time. public/lib/**, third-party and quick-image-gen are skipped.`);
}

function normalizeSource(source) {
    return String(source).replace(/\r\n/g, '\n');
}

function isExcludedPath(file) {
    return file.startsWith('public/lib/') || file.includes('/third-party/') || file.includes('/quick-image-gen/');
}

function decodeCssEscapes(value) {
    return value.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\f]?|([\s\S]))/g, (_match, hex, character) => {
        if (character !== undefined) return character;
        const codePoint = Number.parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : '\uFFFD';
    });
}

function isIdentifierCharacter(character) {
    return /[A-Za-z0-9_-]/.test(character) || character.charCodeAt(0) >= 0x80;
}

function skipString(source, index) {
    const quote = source[index];
    for (let cursor = index + 1; cursor < source.length; cursor++) {
        const character = source[cursor];
        if (character === '\\') cursor++;
        else if (character === quote || character === '\n') return cursor + 1;
    }
    return source.length;
}

const unquotedUrlPattern = /url\(\s*(?!["'\s])/iy;

function startsUnquotedUrl(source, index) {
    if (index > 0 && isIdentifierCharacter(source[index - 1])) return false;
    unquotedUrlPattern.lastIndex = index;
    return unquotedUrlPattern.test(source);
}

function skipUnquotedUrl(source, index) {
    for (let cursor = index + 4; cursor < source.length; cursor++) {
        if (source[cursor] === '\\') cursor++;
        else if (source[cursor] === ')') return cursor + 1;
    }
    return source.length;
}

function skipParentheses(source, index) {
    let depth = 0;
    for (let cursor = index; cursor < source.length; cursor++) {
        const character = source[cursor];
        if (character === '\\') cursor++;
        else if (character === '"' || character === '\'') cursor = skipString(source, cursor) - 1;
        else if (character === '(') depth++;
        else if (character === ')' && --depth === 0) return cursor + 1;
    }
    return source.length;
}

export function stripCssComments(source) {
    let output = '';
    for (let index = 0; index < source.length;) {
        const character = source[index];
        if (character === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2);
            output += ' ';
            index = end === -1 ? source.length : end + 2;
        } else if (character === '"' || character === '\'') {
            const end = skipString(source, index);
            output += source.slice(index, end);
            index = end;
        } else if (startsUnquotedUrl(source, index)) {
            const end = skipUnquotedUrl(source, index);
            output += source.slice(index, end);
            index = end;
        } else if (character === '\\') {
            output += source.slice(index, index + 2);
            index += 2;
        } else {
            output += character;
            index++;
        }
    }
    return output;
}

function findBlockEnd(source, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < source.length; index++) {
        const character = source[index];
        if (character === '\\') index++;
        else if (character === '"' || character === '\'') index = skipString(source, index) - 1;
        else if (startsUnquotedUrl(source, index)) index = skipUnquotedUrl(source, index) - 1;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) return index;
    }
    return source.length;
}

function* walkStyleRules(source, conditions) {
    let preludeStart = 0;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '\\') {
            index++;
        } else if (character === '"' || character === '\'') {
            index = skipString(source, index) - 1;
        } else if (startsUnquotedUrl(source, index)) {
            index = skipUnquotedUrl(source, index) - 1;
        } else if (character === '(') {
            index = skipParentheses(source, index) - 1;
        } else if (character === ';' || character === '}') {
            preludeStart = index + 1;
        } else if (character === '{') {
            const prelude = source.slice(preludeStart, index).trim();
            const end = findBlockEnd(source, index);
            const inner = source.slice(index + 1, end);
            const atRule = /^@([\w-]+)/.exec(prelude);
            if (atRule) {
                const name = atRule[1].toLowerCase();
                if (name === 'scope') yield { conditions, selector: prelude, body: '' };
                if (conditionalGroupRules.has(name)) {
                    yield* walkStyleRules(inner, [...conditions, prelude.replace(/\s+/g, ' ')]);
                }
            } else if (prelude) {
                yield { conditions, selector: prelude, body: inner };
                if (inner.includes('{')) yield* walkStyleRules(inner, conditions);
            }
            index = end;
            preludeStart = end + 1;
        }
    }
}

export function parseStyleRules(css) {
    return [...walkStyleRules(stripCssComments(normalizeSource(css)), [])];
}

export function extractSelectorNames(selector) {
    const classes = [];
    const ids = [];
    for (let index = 0; index < selector.length; index++) {
        const character = selector[index];
        if (character === '\\') {
            index++;
        } else if (character === '"' || character === '\'') {
            index = skipString(selector, index) - 1;
        } else if (character === '[') {
            for (index++; index < selector.length && selector[index] !== ']'; index++) {
                if (selector[index] === '\\') index++;
                else if (selector[index] === '"' || selector[index] === '\'') index = skipString(selector, index) - 1;
            }
        } else if (character === '.' || character === '#') {
            let end = index + 1;
            while (end < selector.length) {
                if (selector[end] === '\\' && end + 1 < selector.length) {
                    const hex = /^[0-9a-fA-F]{1,6}[ \t\n\f]?/.exec(selector.slice(end + 1));
                    end += 1 + (hex ? hex[0].length : 1);
                } else if (isIdentifierCharacter(selector[end])) {
                    end++;
                } else {
                    break;
                }
            }
            const name = decodeCssEscapes(selector.slice(index + 1, end));
            if (character === '.' && /^sb-./.test(name)) classes.push(name);
            else if (character === '#' && /^sb[-_]./.test(name)) ids.push(name);
            index = Math.max(index, end - 1);
        }
    }
    return { classes, ids };
}

function normalizeBody(body) {
    return body.replace(/\s+/g, ' ').replace(/\s*([:;,{}])\s*/g, '$1').replace(/;(?=\})|;$/g, '').trim();
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleSignature(rule, marker, name) {
    const selector = rule.selector.replace(/\s+/g, ' ').replace(new RegExp(`${escapeRegExp(marker)}${escapeRegExp(name)}(?![\\w-])`, 'g'), `${marker}§`);
    return `${rule.conditions.join(' > ')} :: ${selector} :: ${normalizeBody(rule.body)}`;
}

export function extractStylesheetNames(css) {
    const classes = new Map();
    const ids = new Map();
    for (const rule of parseStyleRules(css)) {
        const names = extractSelectorNames(rule.selector);
        for (const [list, marker, target] of [[names.classes, '.', classes], [names.ids, '#', ids]]) {
            for (const name of new Set(list)) {
                const signatures = target.get(name) ?? [];
                signatures.push(ruleSignature(rule, marker, name));
                target.set(name, signatures);
            }
        }
    }
    return { classes, ids };
}

function skipBraces(text, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < text.length; index++) {
        const character = text[index];
        if (character === '\\') index++;
        else if (character === '"' || character === '\'' || character === '`') index = skipQuoted(text, index) - 1;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) return index + 1;
    }
    return text.length;
}

function skipQuoted(text, index) {
    const quote = text[index];
    for (let cursor = index + 1; cursor < text.length; cursor++) {
        const character = text[cursor];
        if (character === '\\') cursor++;
        else if (quote === '`' && character === '$' && text[cursor + 1] === '{') cursor = skipBraces(text, cursor + 1) - 1;
        else if (character === quote) return cursor + 1;
        else if (character === '\n' && quote !== '`') return cursor;
    }
    return text.length;
}

const regexPrecedingWords = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await', 'instanceof', 'new']);

// Finds comments and string literals in script source. Offsets refer to `source`.
function scanScript(source) {
    const length = source.length;
    const comments = [];
    const literals = [];
    let previousToken = '';

    function scanTemplate(start) {
        let index = start + 1;
        while (index < length) {
            const character = source[index];
            if (character === '\\') index += 2;
            else if (character === '`') {
                literals.push([start + 1, index]);
                return index + 1;
            } else if (character === '$' && source[index + 1] === '{') index = scanCode(index + 2, true);
            else index++;
        }
        literals.push([start + 1, length]);
        return length;
    }

    function scanRegex(start) {
        let inClass = false;
        for (let index = start + 1; index < length; index++) {
            const character = source[index];
            if (character === '\n') return -1;
            if (character === '\\') index++;
            else if (character === '[') inClass = true;
            else if (character === ']') inClass = false;
            else if (character === '/' && !inClass) return index + 1;
        }
        return -1;
    }

    function scanCode(start, inTemplateExpression) {
        let index = start;
        let depth = 0;
        while (index < length) {
            const character = source[index];
            const next = source[index + 1];
            if (character === '/' && next === '/') {
                const newline = source.indexOf('\n', index);
                const end = newline === -1 ? length : newline;
                comments.push([index, end]);
                index = end;
            } else if (character === '/' && next === '*') {
                const close = source.indexOf('*/', index + 2);
                const end = close === -1 ? length : close + 2;
                comments.push([index, end]);
                index = end;
            } else if (character === '"' || character === '\'') {
                let cursor = index + 1;
                while (cursor < length && source[cursor] !== character && source[cursor] !== '\n') cursor += source[cursor] === '\\' ? 2 : 1;
                cursor = Math.min(cursor, length);
                literals.push([index + 1, cursor]);
                index = source[cursor] === character ? cursor + 1 : cursor;
                previousToken = '"';
            } else if (character === '`') {
                index = scanTemplate(index);
                previousToken = '"';
            } else if (character === '/') {
                const regexAllowed = previousToken === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(previousToken) || regexPrecedingWords.has(previousToken);
                const end = regexAllowed ? scanRegex(index) : -1;
                index = end === -1 ? index + 1 : end;
                previousToken = end === -1 ? '/' : 'x';
            } else if (inTemplateExpression && character === '}' && depth === 0) {
                return index + 1;
            } else if (/[\w$\u0080-\uFFFF]/.test(character)) {
                let end = index + 1;
                while (end < length && /[\w$\u0080-\uFFFF]/.test(source[end])) end++;
                previousToken = source.slice(index, end);
                index = end;
            } else {
                if (inTemplateExpression && character === '{') depth++;
                else if (inTemplateExpression && character === '}') depth--;
                if (!/\s/.test(character)) previousToken = character;
                index++;
            }
        }
        return length;
    }

    scanCode(0, false);
    return { comments, literals };
}

function blankRanges(source, ranges) {
    if (ranges.length === 0) return source;
    let output = '';
    let position = 0;
    for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
        if (start < position) continue;
        output += source.slice(position, start) + source.slice(start, end).replace(/[^\n]/g, ' ');
        position = end;
    }
    return output + source.slice(position);
}

function blankHtmlCommentRanges(text, offset) {
    return [...text.matchAll(/<!--[\s\S]*?-->/g)].map(match => [offset + match.index, offset + match.index + match[0].length]);
}

export function splitHtmlBlocks(source) {
    const styles = [];
    const scripts = [];
    const markup = normalizeSource(source).replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>([\s\S]*?)(?:<\/\1\s*>|$)/gi, (match, tag, body) => {
        if (tag?.toLowerCase() === 'script') scripts.push(body);
        else if (tag) styles.push(body);
        return match.replace(/[^\n]/g, ' ');
    });
    return { markup, styles, scripts };
}

function skipDelimited(text, openIndex) {
    return text[openIndex] === '{' ? skipBraces(text, openIndex) : skipQuoted(text, openIndex);
}

function quotedValues(text, attribute) {
    const values = [];
    const opening = new RegExp(`\\b${attribute}\\s*=\\s*(\\\\?)(["'])`, 'g');
    for (let match; (match = opening.exec(text));) {
        const start = match.index + match[0].length;
        const closing = `${match[1]}${match[2]}`;
        let end = -1;
        for (let index = start; index < text.length && index - start <= 2000; index++) {
            if (text[index] === '$' && text[index + 1] === '{') index = skipDelimited(text, index + 1) - 1;
            else if (text.startsWith(closing, index)) {
                end = index;
                break;
            }
        }
        if (end !== -1) values.push(text.slice(start, end));
    }
    return values;
}

function unquotedValues(text, attribute) {
    const values = [];
    const pattern = new RegExp(`\\b${attribute}\\s*=(?![=>])\\s*(?!["'\`\\\\\\s])([^\\s>]+)`, 'g');
    for (const match of text.matchAll(pattern)) values.push(match[1]);
    return values;
}

function balancedArguments(text, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < text.length && index < openIndex + 2000; index++) {
        const character = text[index];
        if (character === '\\') index++;
        else if (character === '"' || character === '\'' || character === '`') index = skipQuoted(text, index) - 1;
        else if (character === '(') depth++;
        else if (character === ')' && --depth === 0) return text.slice(openIndex + 1, index);
    }
    return text.slice(openIndex + 1, openIndex + 400);
}

function callArguments(text, pattern) {
    const values = [];
    for (let match; (match = pattern.exec(text));) values.push(balancedArguments(text, match.index + match[0].length - 1));
    return values;
}

// The expression that follows a `className =` or `class:` style marker. It may continue on the next lines.
function expressionAfter(text, pattern) {
    const values = [];
    for (let match; (match = pattern.exec(text));) {
        const start = match.index + match[0].length;
        const limit = Math.min(text.length, start + 800);
        let depth = 0;
        let end = limit;
        for (let index = start; index < limit; index++) {
            const character = text[index];
            if (character === '"' || character === '\'' || character === '`') {
                index = skipQuoted(text, index) - 1;
            } else if ('([{'.includes(character)) {
                depth++;
            } else if (')]}'.includes(character)) {
                if (depth === 0) {
                    end = index;
                    break;
                }
                depth--;
            } else if (depth === 0 && (character === ';' || character === ',' || (character === '>' && text[index - 1] !== '=' && text[index - 1] !== '-'))) {
                end = index;
                break;
            } else if (depth === 0 && character === '\n') {
                const before = text.slice(start, index).trimEnd().slice(-1);
                const after = /^\s*(.)/.exec(text.slice(index))?.[1] ?? '';
                const continues = before === '' || '=+?:|&(,'.includes(before) || (after !== '' && '?:+|&.'.includes(after));
                if (!continues) {
                    end = index;
                    break;
                }
            }
        }
        values.push(text.slice(start, end));
    }
    return values;
}

const tokenBody = '[\\w-]*(?:\\$\\{[^}]*\\}[\\w-]*)*';
const classTokenPattern = new RegExp(`(?<![\\w$-])(sb-${tokenBody})`, 'g');
const idTokenPattern = new RegExp(`(?<![\\w$-])(sb[-_]${tokenBody})`, 'g');
const mentionTokenPattern = idTokenPattern;
const dotClassPattern = new RegExp(`\\.(sb-${tokenBody})`, 'g');
const hashIdPattern = new RegExp(`(?<![\\w&])#(sb[-_]${tokenBody})`, 'g');
const fileExtensionPattern = /^\.(?:js|mjs|cjs|css|json|html?|png|svg|jpe?g|gif|webp|ico|woff2?|ttf|md|txt|map)\b/i;

function recordName(rawName, names, dynamicPatterns) {
    const name = rawName.replace(/\$\{[^}]*\}/g, '${}');
    if (name.includes('${') || /[-_]$/.test(name)) {
        if (name.length > 3 || name.includes('${')) dynamicPatterns.add(name);
    } else {
        names.add(name);
    }
}

function collectTokens(text, tokenPattern, names, dynamicPatterns) {
    for (const match of text.matchAll(tokenPattern)) recordName(match[1], names, dynamicPatterns);
}

function isDottedClassUse(literal, match) {
    const end = match.index + match[0].length;
    if (fileExtensionPattern.test(literal.slice(end))) return false;
    let chunkStart = match.index;
    while (chunkStart > 0 && !/[\s"'`,]/.test(literal[chunkStart - 1])) chunkStart--;
    return !literal.slice(chunkStart, end).includes('/');
}

function createMarkupResult() {
    return {
        classes: new Set(),
        ids: new Set(),
        mentions: new Set(),
        dynamicClassPrefixes: new Set(),
        dynamicIdPrefixes: new Set(),
        dynamicMentions: new Set(),
    };
}

// `code` is script or markup without comments; `literals` are the string literals or attribute values inside it.
function extractFromCode(code, literals, result) {
    const classContexts = [
        ...quotedValues(code, 'class'),
        ...unquotedValues(code, 'class'),
        ...callArguments(code, /classList\s*\??\.\s*(?:add|remove|toggle|contains|replace)\s*\(/g),
        ...callArguments(code, /\.\s*(?:addClass|removeClass|toggleClass|hasClass)\s*\(/g),
        ...expressionAfter(code, /(?:setAttribute|attr)\s*\(\s*['"]class['"]\s*,/g),
        ...expressionAfter(code, /\bclassName\b/g),
        ...expressionAfter(code, /\bclass\s*:/g),
    ];
    for (const context of classContexts) collectTokens(context, classTokenPattern, result.classes, result.dynamicClassPrefixes);

    const idContexts = [
        ...quotedValues(code, 'id'),
        ...unquotedValues(code, 'id'),
        ...callArguments(code, /getElementById\s*\(/g),
        ...expressionAfter(code, /\b(?:[\w$]*Id|id)\s*(?::|=(?![=>]))/g),
    ];
    for (const context of idContexts) collectTokens(context, idTokenPattern, result.ids, result.dynamicIdPrefixes);

    for (const literal of literals) {
        for (const match of literal.matchAll(dotClassPattern)) {
            if (isDottedClassUse(literal, match)) recordName(match[1], result.classes, result.dynamicClassPrefixes);
        }
        collectTokens(literal, hashIdPattern, result.ids, result.dynamicIdPrefixes);
        collectTokens(literal, mentionTokenPattern, result.mentions, result.dynamicMentions);
    }
}

function attributeValues(html) {
    const values = [];
    for (const tag of html.matchAll(/<[a-zA-Z][\w:-]*\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
        for (const value of tag[1].matchAll(/=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) values.push(value[1] ?? value[2] ?? value[3]);
    }
    return values;
}

function mergeMarkupResult(target, source) {
    for (const key of Object.keys(target)) for (const name of source[key]) target[key].add(name);
}

function extractFromScript(source) {
    const text = normalizeSource(source);
    const scan = scanScript(text);
    const uncommented = blankRanges(text, scan.comments);
    const code = blankRanges(uncommented, scan.literals.flatMap(([start, end]) => blankHtmlCommentRanges(uncommented.slice(start, end), start)));
    const result = createMarkupResult();
    extractFromCode(code, scan.literals.map(([start, end]) => code.slice(start, end)), result);
    return result;
}

// Heuristic: classes and ids are read from the usual markup and script contexts. Every other
// sb-* token inside a string literal is returned as a mention.
export function extractMarkupNames(source, { html = false } = {}) {
    if (!html) return extractFromScript(source);
    const { markup, scripts } = splitHtmlBlocks(source);
    const result = createMarkupResult();
    extractFromCode(markup, attributeValues(markup), result);
    for (const script of scripts) mergeMarkupResult(result, extractFromScript(script));
    return result;
}

function createSideIndex() {
    return {
        css: { classes: new Map(), ids: new Map() },
        markup: { classes: new Map(), ids: new Map() },
        mentions: new Map(),
        dynamicPrefixes: { classes: new Set(), ids: new Set(), mentions: new Set() },
        fileCount: 0,
    };
}

function addToMap(map, name, file, signatures) {
    const entry = map.get(name) ?? { files: new Set(), signatures: [] };
    entry.files.add(file);
    if (signatures) entry.signatures.push(...signatures);
    map.set(name, entry);
}

function indexFile(index, file, source) {
    const extension = path.extname(file).toLowerCase();
    const addCss = css => {
        const names = extractStylesheetNames(css);
        for (const [kind, map] of Object.entries(names)) {
            for (const [name, signatures] of map) addToMap(index.css[kind], name, file, signatures);
        }
    };
    const addMarkup = (text, html) => {
        const names = extractMarkupNames(text, { html });
        for (const name of names.classes) addToMap(index.markup.classes, name, file);
        for (const name of names.ids) addToMap(index.markup.ids, name, file);
        for (const name of names.mentions) addToMap(index.mentions, name, file);
        for (const prefix of names.dynamicClassPrefixes) index.dynamicPrefixes.classes.add(prefix);
        for (const prefix of names.dynamicIdPrefixes) index.dynamicPrefixes.ids.add(prefix);
        for (const prefix of names.dynamicMentions) index.dynamicPrefixes.mentions.add(prefix);
    };

    if (stylesheetExtensions.has(extension)) {
        addCss(source);
    } else if (htmlExtensions.has(extension)) {
        for (const css of splitHtmlBlocks(source).styles) addCss(css);
        addMarkup(source, true);
    } else if (scriptExtensions.has(extension)) {
        addMarkup(source, false);
    } else {
        return;
    }
    index.fileCount++;
}

function isScannedExtension(file) {
    const extension = path.extname(file).toLowerCase();
    return stylesheetExtensions.has(extension) || htmlExtensions.has(extension) || scriptExtensions.has(extension);
}

function git(repoRoot, args, input) {
    return execFileSync('git', args, { cwd: repoRoot, maxBuffer, input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function resolveCommit(repoRoot, ref) {
    try {
        return git(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
    } catch {
        throw new Error(`Cannot resolve git ref: ${ref}`);
    }
}

export function readFilesAtRef(repoRoot, ref) {
    const listing = git(repoRoot, ['ls-tree', '-r', '-z', ref, '--', 'public']).toString('utf8').split('\0').filter(Boolean);
    const entries = [];
    for (const line of listing) {
        const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
        if (match && isScannedExtension(match[2]) && !isExcludedPath(match[2])) entries.push({ oid: match[1], file: match[2] });
    }
    const files = [];
    if (entries.length === 0) return files;

    const result = spawnSync('git', ['cat-file', '--batch'], { cwd: repoRoot, input: `${entries.map(entry => entry.oid).join('\n')}\n`, maxBuffer });
    if (result.status !== 0) throw new Error(`git cat-file failed: ${String(result.stderr ?? '').trim()}`);
    const output = result.stdout;
    let position = 0;
    for (const entry of entries) {
        const newline = output.indexOf(0x0A, position);
        const [, type, size] = output.subarray(position, newline).toString('utf8').split(' ');
        if (type === 'missing') {
            position = newline + 1;
            continue;
        }
        const length = Number(size);
        files.push({ file: entry.file, source: output.subarray(newline + 1, newline + 1 + length).toString('utf8') });
        position = newline + 1 + length + 1;
    }
    return files;
}

function readWorkingTreeFiles(repoRoot) {
    const listing = git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'public']).toString('utf8').split('\0').filter(Boolean);
    const files = [];
    for (const file of new Set(listing)) {
        if (!isScannedExtension(file) || isExcludedPath(file)) continue;
        const absolute = path.join(repoRoot, file);
        try {
            if (fs.statSync(absolute).isFile()) files.push({ file, source: fs.readFileSync(absolute, 'utf8') });
        } catch {
            // Tracked but deleted in the working tree.
        }
    }
    return files;
}

function buildIndex(files) {
    const index = createSideIndex();
    for (const { file, source } of files) indexFile(index, file, source);
    return index;
}

function sortedNames(iterable) {
    return [...iterable].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sortedFiles(entry) {
    return entry ? sortedNames(entry.files) : [];
}

function classifyKind(baseIndex, headIndex, kind, renames) {
    const baseNames = new Set([...baseIndex.css[kind].keys(), ...baseIndex.markup[kind].keys()]);
    const headNames = new Set([...headIndex.css[kind].keys(), ...headIndex.markup[kind].keys()]);
    const headPresent = name => headNames.has(name) || headIndex.mentions.has(name);
    const removedNames = sortedNames([...baseNames].filter(name => !headPresent(name)));
    const addedNames = sortedNames([...headNames].filter(name => !baseNames.has(name) && !baseIndex.mentions.has(name)));

    const cssOnlySources = new Set([...baseIndex.markup[kind].keys(), ...baseIndex.mentions.keys()]);
    const cssOnlyAtHead = sortedNames([...cssOnlySources].filter(name => headIndex.css[kind].has(name) && !headIndex.markup[kind].has(name))).map(name => ({
        name,
        baseTier: baseIndex.markup[kind].has(name) ? 'markup' : 'string mention',
        baseMarkupFiles: sortedFiles(baseIndex.markup[kind].get(name) ?? baseIndex.mentions.get(name)),
        headCssFiles: sortedFiles(headIndex.css[kind].get(name)),
        headMentionFiles: sortedFiles(headIndex.mentions.get(name)),
    }));

    const describe = name => ({
        name,
        cssFiles: sortedFiles(baseIndex.css[kind].get(name)),
        markupFiles: sortedFiles(baseIndex.markup[kind].get(name)),
    });

    const renamed = [];
    const withCssRules = [];
    const markupOnly = [];
    for (const name of removedNames) {
        const entry = describe(name);
        const target = renames.get(name);
        if (target) renamed.push({ ...entry, to: target, hadCssRules: entry.cssFiles.length > 0, presentAtHead: headPresent(target) });
        else if (entry.cssFiles.length > 0) withCssRules.push(entry);
        else markupOnly.push({ name, files: entry.markupFiles });
    }

    const unusedRenames = sortedNames([...renames.keys()].filter(name => !removedNames.includes(name)));

    const headBySignature = new Map();
    for (const name of addedNames) {
        const signatures = headIndex.css[kind].get(name)?.signatures;
        if (!signatures?.length) continue;
        const key = sortedNames(new Set(signatures)).join('\n');
        headBySignature.set(key, [...(headBySignature.get(key) ?? []), name]);
    }
    const mappedTargets = new Set(renames.values());
    const renameCandidates = [];
    for (const entry of withCssRules) {
        const key = sortedNames(new Set(baseIndex.css[kind].get(entry.name).signatures)).join('\n');
        const matches = (headBySignature.get(key) ?? []).filter(name => !mappedTargets.has(name));
        if (matches.length > 0) renameCandidates.push({ from: entry.name, to: matches, ambiguous: matches.length > 1 });
    }

    return {
        removed: { withCssRules, markupOnly },
        renamed,
        renameCandidates,
        cssOnlyAtHead,
        added: addedNames,
        unusedRenames,
        counts: {
            baseNames: baseNames.size,
            headNames: headNames.size,
            removed: removedNames.length,
            removedWithCssRules: withCssRules.length,
            removedMarkupOnly: markupOnly.length,
            renamed: renamed.length,
            renameCandidates: renameCandidates.length,
            cssOnlyAtHead: cssOnlyAtHead.length,
            added: addedNames.length,
        },
    };
}

function classifyMentions(baseIndex, headIndex) {
    const known = index => new Set([...index.css.classes.keys(), ...index.css.ids.keys(), ...index.markup.classes.keys(), ...index.markup.ids.keys(), ...index.mentions.keys()]);
    const baseClassified = new Set([...baseIndex.css.classes.keys(), ...baseIndex.css.ids.keys(), ...baseIndex.markup.classes.keys(), ...baseIndex.markup.ids.keys()]);
    const headKnown = known(headIndex);
    const removed = sortedNames([...baseIndex.mentions.keys()].filter(name => !baseClassified.has(name) && !headKnown.has(name)))
        .map(name => ({ name, files: sortedFiles(baseIndex.mentions.get(name)) }));
    return { removed, counts: { removed: removed.length } };
}

export function parseRenameMap(data) {
    const isWrapped = data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 1 && data.renames && typeof data.renames === 'object';
    const source = isWrapped ? data.renames : data;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('The rename map must be a JSON object that maps old names to new names.');
    const classes = new Map();
    const ids = new Map();
    for (const [from, to] of Object.entries(source)) {
        if (typeof to !== 'string' || !to.trim()) throw new Error(`Rename map entry has no new name: ${from}`);
        const isId = from.trim().startsWith('#');
        const clean = value => value.trim().replace(/^[.#]/, '');
        (isId ? ids : classes).set(clean(from), clean(to));
    }
    return { classes, ids };
}

function dynamicLists(index) {
    return {
        classes: sortedNames(index.dynamicPrefixes.classes),
        ids: sortedNames(index.dynamicPrefixes.ids),
        strings: sortedNames(index.dynamicPrefixes.mentions),
    };
}

export function compareSbNames({ baseFiles, headFiles, renames = { classes: new Map(), ids: new Map() } }) {
    const baseIndex = buildIndex(baseFiles);
    const headIndex = buildIndex(headFiles);
    return {
        classes: classifyKind(baseIndex, headIndex, 'classes', renames.classes),
        ids: classifyKind(baseIndex, headIndex, 'ids', renames.ids),
        mentionedInStrings: classifyMentions(baseIndex, headIndex),
        filesScanned: { base: baseIndex.fileCount, head: headIndex.fileCount },
        dynamicPrefixes: {
            base: dynamicLists(baseIndex),
            head: dynamicLists(headIndex),
        },
    };
}

export function buildReport({ repoRoot = defaultRepoRoot, base = defaultBase, head = null, renames } = {}) {
    const baseCommit = resolveCommit(repoRoot, base);
    const headCommit = head ? resolveCommit(repoRoot, head) : null;
    const baseFiles = readFilesAtRef(repoRoot, baseCommit);
    const headFiles = head ? readFilesAtRef(repoRoot, headCommit) : readWorkingTreeFiles(repoRoot);
    const comparison = compareSbNames({ baseFiles, headFiles, renames });
    return {
        base: { ref: base, commit: baseCommit },
        head: { ref: head ?? workingTreeLabel, commit: headCommit },
        ...comparison,
    };
}

function cell(value) {
    return String(value).replace(/\|/g, '\\|');
}

function fileList(files) {
    if (files.length === 0) return '-';
    const shown = files.slice(0, maxFilesShown).map(file => `\`${cell(file)}\``);
    return files.length > maxFilesShown ? `${shown.join(', ')} (+${files.length - maxFilesShown} more)` : shown.join(', ');
}

function formatKindMarkdown(result, title, marker) {
    const lines = [`## ${title}`, ''];
    const { counts } = result;
    lines.push(`Present at the base: ${counts.baseNames}. Present at the head: ${counts.headNames}. Removed: ${counts.removed} (${counts.removedWithCssRules} with CSS rules at the base, ${counts.removedMarkupOnly} in markup or script only), renamed by the map: ${counts.renamed}. CSS rules only at the head: ${counts.cssOnlyAtHead}. Added at the head: ${counts.added}.`, '');
    lines.push('A name counts as present at the head when the head mentions it in a string literal, so names a script still spells out are not listed as removed.', '');

    lines.push('### Removed: had CSS rules at the base', '');
    if (result.removed.withCssRules.length === 0) lines.push('None.', '');
    else {
        lines.push('| Name | CSS files at the base | Also used in markup or script (heuristic) |', '| --- | --- | --- |');
        for (const entry of result.removed.withCssRules) lines.push(`| \`${marker}${cell(entry.name)}\` | ${fileList(entry.cssFiles)} | ${fileList(entry.markupFiles)} |`);
        lines.push('');
    }

    lines.push('### Removed: markup or script only (heuristic)', '');
    if (result.removed.markupOnly.length === 0) lines.push('None.', '');
    else {
        lines.push('| Name | Base files |', '| --- | --- |');
        for (const entry of result.removed.markupOnly) lines.push(`| \`${marker}${cell(entry.name)}\` | ${fileList(entry.files)} |`);
        lines.push('');
    }

    lines.push('### Renamed (from the rename map)', '');
    if (result.renamed.length === 0) lines.push('None.', '');
    else {
        lines.push('| Old | New | New name present at the head | Base files |', '| --- | --- | --- | --- |');
        for (const entry of result.renamed) lines.push(`| \`${marker}${cell(entry.name)}\` | \`${marker}${cell(entry.to)}\` | ${entry.presentAtHead ? 'yes' : '**no**'} | ${fileList([...entry.cssFiles, ...entry.markupFiles.filter(file => !entry.cssFiles.includes(file))])} |`);
        lines.push('');
    }
    if (result.unusedRenames.length > 0) lines.push(`Rename map entries that are not removed names: ${result.unusedRenames.map(name => `\`${marker}${name}\``).join(', ')}.`, '');

    lines.push('### CSS rules only at the head (heuristic)', '');
    lines.push('Used at the base, either in a class or id context ("markup") or only spelled out in a string ("string mention"). At the head the stylesheet still has rules for the name, but no markup or script uses it as a class or id, so nothing may emit it any more.', '');
    if (result.cssOnlyAtHead.length === 0) lines.push('None.', '');
    else {
        lines.push('| Name | Base tier | Base files | CSS files at the head | Also mentioned in a string at the head |', '| --- | --- | --- | --- | --- |');
        for (const entry of result.cssOnlyAtHead) lines.push(`| \`${marker}${cell(entry.name)}\` | ${entry.baseTier} | ${fileList(entry.baseMarkupFiles)} | ${fileList(entry.headCssFiles)} | ${fileList(entry.headMentionFiles)} |`);
        lines.push('');
    }

    lines.push('### Rename candidates (guesses)', '');
    lines.push('Guesses only: a removed name and an added name whose rule bodies are identical at the base and the head. Confirm each one, then add it to the rename map.', '');
    if (result.renameCandidates.length === 0) lines.push('None.', '');
    else {
        lines.push('| Removed | Added with identical rules | Ambiguous |', '| --- | --- | --- |');
        for (const entry of result.renameCandidates) lines.push(`| \`${marker}${cell(entry.from)}\` | ${entry.to.map(name => `\`${marker}${cell(name)}\``).join(', ')} | ${entry.ambiguous ? 'yes' : 'no'} |`);
        lines.push('');
    }
    return lines;
}

export function formatMarkdown(report) {
    const lines = [
        `# \`.sb-*\` class and id changes: ${report.base.ref} to ${report.head.ref}`,
        '',
        `Base: \`${report.base.ref}\` (${report.base.commit.slice(0, 12)}). Head: ${report.head.commit ? `\`${report.head.ref}\` (${report.head.commit.slice(0, 12)})` : report.head.ref}.`,
        `Files scanned: ${report.filesScanned.base} at the base, ${report.filesScanned.head} at the head (stylesheets, HTML and scripts under \`public/\`, without \`public/lib/**\`, third-party and quick-image-gen).`,
        'Stylesheet results come from selectors. Markup and script results are heuristic: names built at run time are not seen.',
        '',
        ...formatKindMarkdown(report.classes, 'Classes', '.'),
        ...formatKindMarkdown(report.ids, 'Ids', '#'),
        '## Mentioned in a string only (heuristic)',
        '',
        'Removed names that the base spelled out only inside a string literal, in a context this script does not recognise as a class or an id. Storage keys, event names and message text land here; they are not filtered.',
        '',
    ];
    if (report.mentionedInStrings.removed.length === 0) lines.push('None.', '');
    else {
        lines.push('| Name | Base files |', '| --- | --- |');
        for (const entry of report.mentionedInStrings.removed) lines.push(`| \`${cell(entry.name)}\` | ${fileList(entry.files)} |`);
        lines.push('');
    }
    const dynamicBase = report.dynamicPrefixes.base;
    if (dynamicBase.classes.length > 0 || dynamicBase.ids.length > 0 || dynamicBase.strings.length > 0) {
        lines.push('## Names built at run time', '', 'These patterns at the base have a computed part (`${}` is a template expression), so the names they produce are not listed above:', '');
        for (const prefix of dynamicBase.classes) lines.push(`- class \`${prefix}\``);
        for (const prefix of dynamicBase.ids) lines.push(`- id \`${prefix}\``);
        for (const prefix of dynamicBase.strings) lines.push(`- string, context unknown \`${prefix}\``);
        lines.push('');
    }
    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function formatJson(report) {
    return `${JSON.stringify(report, null, 4)}\n`;
}

function parseArguments(argumentsList) {
    const options = { base: defaultBase, head: null, json: false, out: null, renames: null, root: defaultRepoRoot, help: false };
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--json') options.json = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (['--base', '--head', '--out', '--renames', '--root'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
            if ((argument === '--base' || argument === '--head') && value.startsWith('-')) throw new Error(`Invalid git ref for ${argument}: ${value}`);
            options[argument.slice(2)] = ['--out', '--renames', '--root'].includes(argument) ? path.resolve(value) : value;
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function runCli() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const renames = options.renames ? parseRenameMap(JSON.parse(fs.readFileSync(options.renames, 'utf8'))) : undefined;
    const report = buildReport({ repoRoot: options.root, base: options.base, head: options.head, renames });
    const output = options.json ? formatJson(report) : formatMarkdown(report);
    if (options.out) fs.writeFileSync(options.out, output);
    else process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runCli();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
