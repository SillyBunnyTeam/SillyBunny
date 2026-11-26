#!/usr/bin/env node

// Lists every toastr call in the bundled browser code with the form (toast or in-app notification) that the
// call decides before it runs. The form of the rest depends on text, options or layout that only exist at run time.
//
// Not covered: a call that passes its message or options through a variable, a spread or a helper function, and
// a call whose kind is computed (`toastr[type](...)`, listed apart). The width of a message is estimated from its
// length in characters, so only a short literal text is predicted to be a toast.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import { defaultTreeAdapter, html as parse5Html, parseFragment } from 'parse5';
import { NOTIFICATION_FORM, TOAST_FORM } from '../public/scripts/sillybunny-toast-form.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

export const RUN_TIME_FORM = 'run time';

/** A literal text of this many characters or more is left to run time. At 0.6em for a character that is 27em, under the 34em limit. */
export const ESTIMATED_TOAST_MAX_CHARACTERS = 45;

const TOAST_KINDS = new Set(['info', 'success', 'warning', 'error']);
const FORM_ORDER = [TOAST_FORM, NOTIFICATION_FORM, RUN_TIME_FORM];

/** Vendored and generated code is not SillyBunny's own, so it is not part of the report. */
const EXCLUDED_DIRECTORIES = [
    'public/lib',
    'public/scripts/extensions/third-party',
    'public/scripts/extensions/quick-image-gen',
];

// These sets repeat the ones in `public/scripts/sillybunny-toast-form.js`, which counts on a browser DOM and not
// on a parsed fragment. A unit test compares the counts of the two.
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
const ONE_BLOCK_TAGS = new Set(['img', 'picture', 'video', 'audio', 'canvas', 'table', 'select', 'textarea', 'progress', 'meter', 'hr']);
const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
    'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'ul',
]);
const NOT_DRAWN_TAGS = new Set(['script', 'style', 'template', 'noscript']);

/**
 * @typedef {object} Prediction
 * @property {string} form `toast`, `notification` or `run time`.
 * @property {string} reason
 */

/**
 * @typedef {Prediction & { kind: string, line: number, alias: boolean }} SourceCall `alias` is true for a call through a name other than `toastr`.
 */

// Literal markup

const isElement = node => typeof node.tagName === 'string';
const attribute = (node, name) => node.attrs.find(entry => entry.name === name)?.value;

function isButtonNode(node) {
    if (node.tagName === 'button' || attribute(node, 'role') === 'button') {
        return true;
    }
    if (node.tagName === 'input' && BUTTON_INPUT_TYPES.has((attribute(node, 'type') ?? '').toLowerCase())) {
        return true;
    }
    return (attribute(node, 'class') ?? '').split(/\s+/).includes('menu_button');
}

function countButtonNodes(parent) {
    let buttons = 0;
    for (const node of parent.childNodes) {
        if (!isElement(node)) {
            continue;
        }
        buttons += isButtonNode(node) ? 1 : countButtonNodes(node);
    }
    return buttons;
}

function addBlockNodes(parent, insideInline, count) {
    for (const node of parent.childNodes) {
        if (node.nodeName === '#text') {
            if (node.value.trim() && !count.inRun) {
                count.blocks += 1;
                count.inRun = true;
            }
            continue;
        }
        if (!isElement(node) || isButtonNode(node) || NOT_DRAWN_TAGS.has(node.tagName)) {
            continue;
        }

        const name = node.tagName;
        if (name === 'br') {
            count.inRun = false;
        } else if (name === 'svg' && insideInline) {
            continue;
        } else if (name === 'svg' || ONE_BLOCK_TAGS.has(name) || (name === 'input' && (attribute(node, 'type') ?? '').toLowerCase() !== 'hidden')) {
            count.blocks += 1;
            count.inRun = false;
        } else if (BLOCK_TAGS.has(name)) {
            count.inRun = false;
            addBlockNodes(node, false, count);
            count.inRun = false;
        } else {
            addBlockNodes(node, true, count);
        }
    }
}

/**
 * Counts the buttons and the blocks of text that a literal HTML message has, as the classifier counts them in the browser.
 * @param {string} markup
 * @returns {{ buttons: number, blocks: number }}
 */
export function countHtmlParts(markup) {
    const context = defaultTreeAdapter.createElement('div', parse5Html.NS.HTML, []);
    const fragment = parseFragment(context, markup);
    const count = { blocks: 0, inRun: false };
    addBlockNodes(fragment, false, count);
    return { buttons: countButtonNodes(fragment), blocks: count.blocks };
}

// Reading a call

const isTranslationTag = node => node.type === 'Identifier' && node.name === 't';
const isTranslationCall = node => node.callee.type === 'Identifier' && (node.callee.name === 't' || node.callee.name === 'translate');
const isUndefinedNode = node => node.type === 'Identifier' && node.name === 'undefined';
const isVoidNode = node => node.type === 'UnaryExpression' && node.operator === 'void';

/** The text of a node that holds a fixed string, or null when it holds anything that is known only at run time. */
function staticText(node) {
    switch (node.type) {
        case 'Literal':
            return typeof node.value === 'string' ? node.value : null;
        case 'TemplateLiteral':
            return node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
        case 'TaggedTemplateExpression':
            return isTranslationTag(node.tag) ? staticText(node.quasi) : null;
        case 'CallExpression':
            return isTranslationCall(node) && node.arguments.length > 0 ? staticText(node.arguments[0]) : null;
        case 'BinaryExpression': {
            if (node.operator !== '+') {
                return null;
            }
            const left = staticText(node.left);
            const right = left === null ? null : staticText(node.right);
            return right === null ? null : left + right;
        }
        default:
            return null;
    }
}

/** The markup of a message, with each part that is known only at run time replaced by a word of text. */
function markupSkeleton(node) {
    switch (node.type) {
        case 'Literal':
            return typeof node.value === 'string' ? node.value : 'X';
        case 'TemplateLiteral':
            return node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('X');
        case 'TaggedTemplateExpression':
            return isTranslationTag(node.tag) ? markupSkeleton(node.quasi) : 'X';
        case 'BinaryExpression':
            return node.operator === '+' ? markupSkeleton(node.left) + markupSkeleton(node.right) : 'X';
        default:
            return 'X';
    }
}

/** True for an argument that toastr treats as absent: an omitted one, `null`, `undefined`, `false`, `0` and blank text. */
function isEmptyArgument(node) {
    if (!node || isUndefinedNode(node) || isVoidNode(node)) {
        return true;
    }
    if (node.type === 'Literal') {
        return !node.value || (typeof node.value === 'string' && !node.value.trim());
    }
    const text = staticText(node);
    return text !== null && !text.trim();
}

/**
 * @param {object|undefined} node The third argument of a call.
 * @returns {{ known: boolean, unknownKeys: boolean, props: Map<string, object> }}
 */
function readOptions(node) {
    const options = { known: true, unknownKeys: false, props: new Map() };
    if (!node || (node.type === 'Literal' && node.value === null) || isUndefinedNode(node)) {
        return options;
    }
    if (node.type !== 'ObjectExpression') {
        options.known = false;
        return options;
    }
    for (const property of node.properties) {
        if (property.type === 'SpreadElement' || property.computed) {
            options.unknownKeys = true;
            continue;
        }
        const name = property.key.type === 'Identifier' ? property.key.name : String(property.key.value);
        options.props.set(name, property.value);
    }
    return options;
}

const isBooleanLiteral = (node, value) => node.type === 'Literal' && node.value === value;

/**
 * Predicts the form of one call from its arguments, in the order of the rules of the classifier.
 * @param {{ arguments: object[] }} call The `CallExpression` of a toastr call.
 * @returns {Prediction}
 */
export function predictCall(call) {
    const [message, title, optionsNode] = call.arguments;
    if (call.arguments.some(argument => argument.type === 'SpreadElement')) {
        return { form: RUN_TIME_FORM, reason: 'spread arguments' };
    }
    if (title && !isEmptyArgument(title)) {
        return { form: NOTIFICATION_FORM, reason: 'title' };
    }

    const options = readOptions(optionsNode);
    const onclick = options.props.get('onclick');
    if (onclick && !isEmptyArgument(onclick)) {
        return { form: NOTIFICATION_FORM, reason: 'onclick' };
    }
    if (!options.known) {
        return { form: RUN_TIME_FORM, reason: 'dynamic options' };
    }
    const escapeHtml = options.props.get('escapeHtml');
    if (escapeHtml && !isBooleanLiteral(escapeHtml, true) && !isBooleanLiteral(escapeHtml, false)) {
        return { form: RUN_TIME_FORM, reason: 'dynamic options' };
    }
    if (options.unknownKeys) {
        return { form: RUN_TIME_FORM, reason: 'spread options' };
    }
    if (isEmptyArgument(message)) {
        return { form: TOAST_FORM, reason: 'fits' };
    }

    const skeleton = escapeHtml && isBooleanLiteral(escapeHtml, false) ? markupSkeleton(message) : '';
    if (skeleton.includes('<')) {
        const { buttons, blocks } = countHtmlParts(skeleton);
        if (buttons > 1) {
            return { form: NOTIFICATION_FORM, reason: 'buttons' };
        }
        if (blocks > 1) {
            return { form: NOTIFICATION_FORM, reason: 'blocks' };
        }
        return { form: RUN_TIME_FORM, reason: 'markup' };
    }

    const text = staticText(message);
    if (text === null) {
        return { form: RUN_TIME_FORM, reason: 'dynamic message' };
    }
    if (text.length >= ESTIMATED_TOAST_MAX_CHARACTERS) {
        return { form: RUN_TIME_FORM, reason: 'long text' };
    }
    return { form: TOAST_FORM, reason: 'fits' };
}

// Finding the calls

/** True for `toastr`, `window.toastr`, `globalThis.toastr` and a name that the file made an alias of one of them. */
function isToastrReference(node, aliases) {
    if (node.type === 'Identifier') {
        return aliases.has(node.name);
    }
    return node.type === 'MemberExpression'
        && !node.computed
        && node.property.type === 'Identifier'
        && node.property.name === 'toastr'
        && node.object.type === 'Identifier'
        && (node.object.name === 'window' || node.object.name === 'globalThis');
}

/** @returns {string|null|undefined} The name of the method that the callee names, null when it is computed, undefined when it is not a toastr call. */
function toastrMethodName(callee, aliases) {
    if (callee.type !== 'MemberExpression' || !isToastrReference(callee.object, aliases)) {
        return undefined;
    }
    if (!callee.computed) {
        return callee.property.type === 'Identifier' ? callee.property.name : undefined;
    }
    return staticText(callee.property);
}

function visitNodes(node, callback) {
    callback(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            value.forEach(child => child && typeof child.type === 'string' && visitNodes(child, callback));
        } else if (value && typeof value.type === 'string') {
            visitNodes(value, callback);
        }
    }
}

/**
 * Finds the names that a file uses for toastr when code receives it as a parameter or copies it, such as
 * `{ toast = globalThis.toastr }` or `const notify = window.toastr`. A name counts in the whole file, in any scope.
 * @returns {Set<string>}
 */
function findToastrAliases(ast) {
    const aliases = new Set(['toastr']);
    visitNodes(ast, (node) => {
        const [target, value] = {
            AssignmentPattern: [node.left, node.right],
            VariableDeclarator: [node.id, node.init],
            AssignmentExpression: [node.left, node.right],
        }[node.type] ?? [];
        if (target?.type === 'Identifier' && value && isToastrReference(value, aliases)) {
            aliases.add(target.name);
        }
    });
    return aliases;
}

function parseSource(source) {
    const options = { ecmaVersion: 'latest', loc: true };
    try {
        return espree.parse(source, { ...options, sourceType: 'module' });
    } catch {
        try {
            return espree.parse(source, { ...options, sourceType: 'script' });
        } catch {
            return null;
        }
    }
}

/**
 * @param {string} source The text of one JavaScript file.
 * @returns {{ calls: SourceCall[], computedKind: number[] } | null} Null when the file does not parse. `computedKind` holds the lines of calls such as `toastr[type](...)`.
 */
export function analyzeSource(source) {
    const ast = parseSource(source);
    if (!ast) {
        return null;
    }

    const aliases = findToastrAliases(ast);
    const calls = [];
    const computedKind = [];
    visitNodes(ast, (node) => {
        if (node.type !== 'CallExpression') {
            return;
        }
        const name = toastrMethodName(node.callee, aliases);
        if (name === null) {
            computedKind.push(node.loc.start.line);
        } else if (TOAST_KINDS.has(name)) {
            const alias = node.callee.object.type === 'Identifier' && node.callee.object.name !== 'toastr';
            calls.push({ kind: name, line: node.loc.start.line, alias, ...predictCall(node) });
        }
    });
    const byPosition = (left, right) => left.line - right.line;
    return { calls: calls.sort(byPosition), computedKind: computedKind.sort((left, right) => left - right) };
}

function listSourceFiles(repoRoot) {
    const excluded = new Set(EXCLUDED_DIRECTORIES);
    const files = [];
    const walk = (directory) => {
        const entries = fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })
            .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        for (const entry of entries) {
            const relative = `${directory}/${entry.name}`;
            if (entry.isDirectory() && !excluded.has(relative)) {
                walk(relative);
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                files.push(relative);
            }
        }
    };
    if (fs.existsSync(path.join(repoRoot, 'public'))) {
        walk('public');
    }
    return files;
}

const tally = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
const sortedObject = counts => Object.fromEntries([...counts].sort(([left], [right]) => (left < right ? -1 : 1)));

/**
 * @typedef {object} Report
 * @property {{ file: string, line: number, kind: string, alias: boolean, form: string, reason: string }[]} calls
 * @property {{ calls: number, viaAlias: number, byForm: Record<string, number>, byReason: Record<string, number> }} totals
 * @property {{ file: string, line: number }[]} computedKind Calls whose kind is computed. They are not in the totals.
 * @property {string[]} skipped Files that do not parse.
 */

/**
 * @param {string} [repoRoot] The repository root; `public/` under it is scanned.
 * @returns {Report}
 */
export function analyzeProject(repoRoot = defaultRepoRoot) {
    const calls = [];
    const computedKind = [];
    const skipped = [];
    for (const file of listSourceFiles(repoRoot)) {
        const found = analyzeSource(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
        if (!found) {
            skipped.push(file);
            continue;
        }
        calls.push(...found.calls.map(call => ({ file, ...call })));
        computedKind.push(...found.computedKind.map(line => ({ file, line })));
    }

    const byForm = new Map();
    const byReason = new Map();
    for (const { form, reason } of calls) {
        tally(byForm, form);
        tally(byReason, `${form}: ${reason}`);
    }
    return {
        calls: calls.map(({ file, line, kind, alias, form, reason }) => ({ file, line, kind, alias, form, reason })),
        totals: {
            calls: calls.length,
            viaAlias: calls.filter(call => call.alias).length,
            byForm: sortedObject(byForm),
            byReason: sortedObject(byReason),
        },
        computedKind,
        skipped,
    };
}

// Output

/** @param {Report} report */
export function renderJson(report) {
    return `${JSON.stringify(report, null, 2)}\n`;
}

/** @param {Report} report */
export function renderMarkdown(report) {
    const { totals } = report;
    const lines = [
        '# Toast call sites and their predicted form',
        '',
        'Static prediction for every `toastr.info`, `success`, `warning` and `error` call in `public/**/*.js`, without `public/lib`, `public/scripts/extensions/third-party` and `public/scripts/extensions/quick-image-gen`. A call that is `run time` has text, options or layout that only exist when it runs.',
        '',
        `Calls: ${totals.calls}`,
        '',
        `Calls through an alias of toastr (included in the calls): ${totals.viaAlias}`,
        '',
        '| Predicted form | Calls |',
        '|---|---|',
        ...FORM_ORDER.map(form => `| ${form} | ${totals.byForm[form] ?? 0} |`),
        '',
        '## By reason',
        '',
        '| Form | Reason | Calls |',
        '|---|---|---|',
        ...Object.entries(totals.byReason).map(([key, count]) => {
            const [form, reason] = key.split(': ');
            return `| ${form} | ${reason} | ${count} |`;
        }),
        '',
        '## Calls',
        '',
        '| File | Line | Kind | Form | Reason |',
        '|---|---|---|---|---|',
        ...report.calls.map(({ file, line, kind, form, reason }) => `| ${file} | ${line} | ${kind} | ${form} | ${reason} |`),
    ];
    if (report.computedKind.length > 0) {
        lines.push('', '## Calls with a computed kind (not in the totals)', '', ...report.computedKind.map(({ file, line }) => `- ${file}:${line}`));
    }
    if (report.skipped.length > 0) {
        lines.push('', '## Files that do not parse (not in the totals)', '', ...report.skipped.map(file => `- ${file}`));
    }
    return `${lines.join('\n')}\n`;
}

function main(argv) {
    const report = analyzeProject();
    process.stdout.write(argv.includes('--json') ? renderJson(report) : renderMarkdown(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
