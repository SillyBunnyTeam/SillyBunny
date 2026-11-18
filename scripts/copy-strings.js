#!/usr/bin/env node
/**
 * The strings that a tree can show a user: every string literal, template text, HTML text node and attribute value, and JSON key and
 * value, of `public/**` (`.js`, `.mjs`, `.html`, `.json`, without `public/lib` and minified files). The copy check of the surface
 * audit (`tests/audit/surface-audit.e2e.js`) reads two such sets:
 *
 *   upstream   the tree of the upstream base commit. A rendered string in it is upstream's wording, which the project does not change.
 *   tree       the working tree. A rendered string that is in no set of it is data (a name, a file, a model id), not a label.
 *
 * Usage: node scripts/copy-strings.js upstream|tree [--base <sha>] [--out <file>]
 * Without `--out` the set goes to the cache directory (see `cacheFile`). The upstream set is large (several MB), so it is built on
 * demand and never committed; the audit commits only the violations that it finds.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_BASE = 'ad29cbda62e92f145e44d7a10398a38af22ca986';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const norm = text => String(text).replace(/\s+/g, ' ').trim();
const normalise = text => norm(String(text).replace(/\$\{[^}]*\}/g, '${}'));
const inScope = file => /^public\/.+\.(?:js|mjs|html|json)$/.test(file) && !file.startsWith('public/lib/') && !/\.min\./.test(file);

const INLINE_TAGS = new Set(['code', 'b', 'i', 'em', 'strong', 'a', 'span', 'kbd', 'u', 'mark', 'small', 'sub', 'sup', 'br', 'abbr', 'wbr']);
const HTML_TAG_HINT = /<(?:div|span|button|label|input|select|option|h[1-6]|p|a|b|i|small|strong|em|ul|ol|li|table|tr|td|th|img|svg|textarea|section|header|footer|nav|summary|details|form|legend|fieldset)\b/i;

function parseJs(acorn, source) {
    const base = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
    try {
        return acorn.parse(source, { ...base, sourceType: 'module' });
    } catch {
        return acorn.parse(source, { ...base, sourceType: 'script' });
    }
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') {
        return;
    }
    visit(node);
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
            value.forEach(child => walk(child, visit));
        } else if (value && typeof value.type === 'string') {
            walk(value, visit);
        }
    }
}

/** Adds the strings of one file to `set`. A file that does not parse adds nothing and is counted by the caller. */
function addFile(parse5, acorn, name, content, set) {
    const add = text => {
        const normalised = normalise(text);
        // A Handlebars template draws one of its texts: `{{#if pinned}}Unpin Chat{{else}}Pin Chat{{/if}}` shows either, and
        // `Hello {{name}}` shows its text around a hole.
        if (normalised.includes('{{')) {
            for (const segment of normalised.split(/\{\{[#^/!]?[^}]*\}\}/)) {
                const piece = norm(segment);
                if (piece && piece !== normalised) {
                    set.add(piece);
                }
            }
            const holes = norm(normalised.replace(/\{\{(?![#^/!])[^}]*\}\}/g, '${}').replace(/\{\{[#^/!][^}]*\}\}/g, ' '));
            if (holes && !holes.includes('{{')) {
                set.add(holes);
            }
        }
        if (normalised) {
            set.add(normalised);
            // The settings pass strips the colon of an upstream caption when it turns the caption into a row title.
            const stripped = normalised.replace(/\s*[：:]$/, '');
            if (stripped && stripped !== normalised) {
                set.add(stripped);
            }
        }
    };
    const textContentOf = node => (node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textContentOf).join(''));
    const addNodeStrings = node => {
        for (const attribute of node.attrs ?? []) {
            add(attribute.value);
        }
        if (node.nodeName === '#text') {
            add(node.value);
        }
        const children = node.childNodes ?? [];
        // An element that mixes text with inline elements ("Show <code>{{char}}</code>: in responses") is one string where it is drawn.
        if (children.some(child => child.nodeName !== '#text' && child.nodeName !== '#comment')
            && children.every(child => child.nodeName === '#text' || child.nodeName === '#comment' || INLINE_TAGS.has(child.nodeName))) {
            add(textContentOf(node));
        }
        children.forEach(addNodeStrings);
        if (node.content) {
            addNodeStrings(node.content);
        }
    };
    const addMarkup = html => {
        try {
            addNodeStrings(parse5.parseFragment(html.replace(/\$\{[^}]*\}/g, 'x')));
        } catch {
            // Markup that the parser rejects has no strings to record.
        }
    };
    if (name.endsWith('.json')) {
        const visit = value => {
            if (typeof value === 'string') {
                add(value);
            } else if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                for (const [key, item] of Object.entries(value)) {
                    add(key);
                    visit(item);
                }
            }
        };
        visit(JSON.parse(content));
    } else if (name.endsWith('.html')) {
        addNodeStrings(parse5.parse(content));
    } else {
        walk(parseJs(acorn, content), node => {
            if (node.type === 'Literal' && typeof node.value === 'string') {
                add(node.value);
                if (HTML_TAG_HINT.test(node.value)) {
                    addMarkup(node.value);
                }
            } else if (node.type === 'BinaryExpression' && node.operator === '+') {
                // 'Delete ' + name: the text of a label that is joined at run time is a template, with a hole for each part that is not text.
                const parts = [];
                const flatten = expression => {
                    if (expression.type === 'BinaryExpression' && expression.operator === '+') {
                        flatten(expression.left);
                        flatten(expression.right);
                    } else if (expression.type === 'Literal' && typeof expression.value === 'string') {
                        parts.push(expression.value);
                    } else {
                        parts.push('${}');
                    }
                };
                flatten(node);
                if (parts.some(part => part !== '${}')) {
                    add(parts.join(''));
                }
            } else if (node.type === 'TemplateLiteral') {
                const joined = node.quasis.map(quasi => quasi.value.cooked ?? '').join('${}');
                add(joined);
                node.quasis.forEach(quasi => add(quasi.value.cooked ?? ''));
                if (HTML_TAG_HINT.test(joined)) {
                    addMarkup(joined);
                }
            }
        });
    }
}

function buildSet(files) {
    const parse5 = require('parse5');
    const acorn = require('acorn');
    const set = new Set();
    let failed = 0;
    for (const [name, content] of files) {
        try {
            addFile(parse5, acorn, name, content, set);
        } catch {
            failed++;
        }
    }
    return { strings: [...set].sort(), files: files.length, failed };
}

function git(args, options = {}) {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, ...options });
}

/** The files of `public` in the tree of a commit, as [name, content] pairs. */
function commitFiles(commit) {
    const names = git(['ls-tree', '-r', '--name-only', commit, '--', 'public']).split('\n').filter(inScope);
    const { stdout } = spawnSync('git', ['-C', ROOT, 'cat-file', '--batch'], { input: `${names.map(name => `${commit}:${name}`).join('\n')}\n`, maxBuffer: 1 << 30 });
    const files = [];
    let position = 0;
    for (const name of names) {
        const lineEnd = stdout.indexOf(10, position);
        const size = Number(stdout.toString('utf8', position, lineEnd).split(' ')[2]);
        files.push([name, stdout.toString('utf8', lineEnd + 1, lineEnd + 1 + size)]);
        position = lineEnd + 1 + size + 1;
    }
    return files;
}

/** The files of `public` in the working tree, as [name, content] pairs, with a key that changes when any of them does. */
function treeFiles() {
    const names = git(['ls-files', '-z', '--', 'public'], {}).split('\0').filter(inScope);
    const hash = crypto.createHash('sha1');
    const files = [];
    for (const name of names) {
        const full = path.join(ROOT, name);
        let stat;
        try {
            stat = fs.statSync(full);
        } catch {
            continue;
        }
        hash.update(`${name}\0${stat.size}\0${stat.mtimeMs}\n`);
        files.push([name, fs.readFileSync(full, 'utf8')]);
    }
    return { files, key: hash.digest('hex').slice(0, 16) };
}

/** Part of the name of a cache file: raise it when the extraction changes, so that an old file is not read. */
const CACHE_VERSION = 4;
export const cacheDirectory = () => path.join(os.tmpdir(), 'sb-copy-strings');

function readOrBuild(file, build) {
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            // A half-written or damaged cache file is built again.
        }
    }
    const built = build();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(built));
    fs.renameSync(temporary, file);
    return built;
}

/**
 * The strings of the upstream base commit.
 * @param {{ base?: string, file?: string }} [options] `file` is where the set is cached (default: the cache directory, keyed by the commit).
 */
export function upstreamStrings({ base = UPSTREAM_BASE, file } = {}) {
    return readOrBuild(file ?? path.join(cacheDirectory(), `upstream-v${CACHE_VERSION}-${base.slice(0, 12)}.json`), () => ({ base, ...buildSet(commitFiles(base)) }));
}

/**
 * Code of quick-image-gen, of third-party extensions and the libraries of an extension, and the bundled agent templates: the first
 * three are not the project's wording, and the names in the templates are content that the user can edit and delete.
 */
const isForeign = name => /\/(?:quick-image-gen|third-party)\//.test(name) || /\/extensions\/[^/]+\/lib\//.test(name) || /\/in-chat-agents\/templates\//.test(name);

/**
 * The strings of the working tree (cached by the names, sizes and times of its files). `strings` are those of the project's own
 * files and `foreign` those of files that it does not own; the audit leaves a text alone that only `foreign` holds. `content` holds the
 * names of the bundled content, which are data wherever a file repeats them.
 */
export function treeStrings({ file } = {}) {
    const { files, key } = treeFiles();
    return readOrBuild(file ?? path.join(cacheDirectory(), `tree-v${CACHE_VERSION}-${key}.json`), () => {
        const own = buildSet(files.filter(([name]) => !isForeign(name)));
        const foreign = buildSet(files.filter(([name]) => isForeign(name)));
        // The manifest of the bundled content (preset, character and lorebook names) lists names that the user can edit and delete.
        const content = buildSet([['default/content/index.json', fs.readFileSync(path.join(ROOT, 'default/content/index.json'), 'utf8')]]);
        return { key, strings: own.strings, foreign: foreign.strings, content: content.strings, files: files.length, failed: own.failed + foreign.failed };
    });
}

/**
 * A lookup over a set of strings. A string with `${}` in it (a template) also matches text that fills the holes, as long as the
 * template keeps at least three letters of its own, so that "Actions for ${}" counts and "${} ${}" does not. A hole does not
 * cross the end of a sentence, so a text of several sentences is not a template's data when only its first sentence is the template's.
 * @param {readonly string[]} strings
 */
export function stringLookup(strings) {
    // A hole holds one piece of data (a name, a number), so text that fills it does not run on past the end of a sentence.
    const crossesSentence = filled => /[.!?\u2026\u3002\uff01\uff1f]["')\]\u201d\u2019]*\s+\S/u.test(filled);
    const exact = new Set(strings);
    const templates = strings.filter(text => text.includes('${}')).map(text => {
        const chunks = text.split('${}');
        const letters = chunks.join('').replace(/[^\p{L}]/gu, '').length;
        return letters < 3 ? null : { chunks, longest: chunks.reduce((a, b) => (b.length > a.length ? b : a), '') };
    }).filter(Boolean);
    const cache = new Map();
    const matchesTemplate = (text, { chunks }) => {
        let position = 0;
        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            if (index === 0) {
                if (!text.startsWith(chunk)) {
                    return false;
                }
                position = chunk.length;
            } else if (index === chunks.length - 1) {
                return text.length - position >= 1 + chunk.length && text.endsWith(chunk)
                    && !crossesSentence(text.slice(position, text.length - chunk.length));
            } else {
                const found = text.indexOf(chunk, position + 1);
                if (found < 0 || crossesSentence(text.slice(position, found))) {
                    return false;
                }
                position = found + chunk.length;
            }
        }
        return false;
    };
    /**
     * The string that the text is: itself when it is one of the strings, the template whose holes it fills (the one with the most
     * letters of its own) when it is not, and `null` when it is neither.
     */
    return text => {
        const key = norm(text);
        if (exact.has(key)) {
            return key;
        }
        if (!cache.has(key)) {
            const matching = templates.filter(template => key.includes(template.longest) && matchesTemplate(key, template));
            const own = template => template.chunks.join('').length;
            const best = matching.sort((a, b) => own(b) - own(a))[0];
            cache.set(key, best ? best.chunks.join('${}') : null);
        }
        return cache.get(key);
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [kind, ...rest] = process.argv.slice(2);
    const option = name => rest[rest.indexOf(name) + 1];
    const out = rest.includes('--out') ? path.resolve(option('--out')) : undefined;
    if (kind !== 'upstream' && kind !== 'tree') {
        console.error('usage: node scripts/copy-strings.js upstream|tree [--base <sha>] [--out <file>]');
        process.exit(2);
    }
    if (out) {
        fs.rmSync(out, { force: true });
    }
    const result = kind === 'upstream' ? upstreamStrings({ base: rest.includes('--base') ? option('--base') : UPSTREAM_BASE, file: out }) : treeStrings({ file: out });
    console.log(`${kind}: ${result.strings.length} strings from ${result.files} files (${result.failed} did not parse)`);
}
