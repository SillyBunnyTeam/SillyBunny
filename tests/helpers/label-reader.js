// Reads the labels that SillyBunny writes from the source, by the place where each is used, without running the app.
// A label is a string whose role the code states: a key of a row, menu, dialog or status page factory, a positional
// argument of a known label helper, a toast title, an attribute written into markup.
//
// What it does not see: a label built from parts, a label that passes through several functions before it is shown, a
// label held in a table that a loop reads, a label that a function returns, and a role that is decided at render (a check
// box that the settings pass draws as a switch row is the exception, read through the settings inventory). A rendered
// audit of the pages is the check for those.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as acorn from 'acorn';
import { parseFragment } from 'parse5';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKIPPED_PATH = /(^|\/)(lib|third-party|quick-image-gen|locales|node_modules)(\/|$)|\.min\./;
const MARKER = /SillyBunny:/;
// A statement that starts farther than this above its label is a long table, not the line that a marker introduces.
const STATEMENT_REACH = 12;

export const upstreamOriginFiles = () => new Set(JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/upstream-origin-public-files.json'), 'utf8')));

/** The strings that a locale translates: upstream wording, whose key must not change. */
export function translatedKeys() {
    const dir = path.join(ROOT, 'public/locales');
    const keys = new Set();
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name === 'lang.json') continue;
        for (const key of Object.keys(JSON.parse(readFileSync(path.join(dir, name), 'utf8')))) keys.add(key);
    }
    return keys;
}

export function sourceFiles() {
    const files = [];
    const visit = dir => {
        for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${entry.name}`;
            if (SKIPPED_PATH.test(rel)) continue;
            if (entry.isDirectory()) visit(rel);
            else if (/\.(js|mjs|html)$/.test(entry.name)) files.push(rel);
        }
    };
    visit('public');
    return files.sort();
}

const sources = new Map();
export const readSource = file => {
    if (!sources.has(file)) sources.set(file, readFileSync(path.join(ROOT, file), 'utf8'));
    return sources.get(file);
};
export const fileExists = file => existsSync(path.join(ROOT, file));

// ---------------------------------------------------------------- JavaScript

function walk(node, visit, ancestors = []) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, ancestors);
    ancestors.push(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, ancestors);
        } else if (value && typeof value.type === 'string') {
            walk(value, visit, ancestors);
        }
    }
    ancestors.pop();
}

function parseScript(source) {
    const options = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
    try {
        return acorn.parse(source, { ...options, sourceType: 'module' });
    } catch {
        return acorn.parse(source, { ...options, sourceType: 'script' });
    }
}

/** The text of a string literal, a template without expressions (a hole reads as `${}`), or a `t` or `translate` call on one. */
function staticText(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral') return node.quasis.map(quasi => quasi.value.cooked ?? '').join('${}');
    if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && node.tag.name === 't') return staticText(node.quasi);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'translate') return staticText(node.arguments[0]);
    return null;
}

const keyName = property => (property.computed ? null : property.key.type === 'Identifier' ? property.key.name : typeof property.key.value === 'string' ? property.key.value : null);

function calleeName(call) {
    const callee = call.callee;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
    return '';
}

const CONSTRUCT_AS_NOTHING = new Set(['freeze', 'map', 'forEach', 'filter', 'push', 'concat', 'flatMap', 'from', 'assign', 'set', 'add', 'resolve']);
const RESPONSE_KEYS = new Set(['affirmative', 'cancel', 'negative', 'extra', 'neutral']);
const ROW_FACTORY = /^create(?:Row|SwitchRow|ComboRow|SpinRow|EntryRow|ExpanderRow|PropertyRow|SelectRow|ProfileRow|ToggleRow|ButtonRow|CheckRow|LinkRow)$/;
const GROUP_FACTORY = /^(?:createPrefGroup|createStatusPage|createAppearanceGroup|createDataSecurityGroup|createBanner)$/;
const DIALOG_FACTORY = /^(?:openDialog|openAlert|openPicker|Popup|callGenericPopup|confirmConversationAction|promptConversationText|confirmDestructiveAction)$/;

/** The nearest enclosing call whose arguments hold the object, with the keys of the properties in between. */
function enclosingCall(ancestors) {
    const keys = [];
    for (let index = ancestors.length - 1; index >= 0; index--) {
        const node = ancestors[index];
        if (node.type === 'Property') keys.push(keyName(node));
        if ((node.type === 'CallExpression' || node.type === 'NewExpression') && !CONSTRUCT_AS_NOTHING.has(calleeName(node))) {
            return { name: node.type === 'NewExpression' && node.callee.type === 'Identifier' ? node.callee.name : calleeName(node), keys };
        }
    }
    return { name: '', keys };
}

/**
 * The role of a string held by `key` of an object, from the factory that receives the object. Only the keys whose role the
 * factory states are read; a key that several factories use for different things is read for the factories listed above.
 * @returns {string | null}
 */
function roleOfKey(key, siblings, call) {
    const { name, keys } = call;
    if (['okButton', 'cancelButton', 'confirmLabel', 'saveLabel'].includes(key)) return 'dialog response';
    if (['placeholder', 'searchPlaceholder'].includes(key)) return 'placeholder';
    if (key === 'tooltip') return 'tooltip';
    if (['ariaLabel', 'aria-label'].includes(key)) return 'accessible name';
    if (key === 'heading' && DIALOG_FACTORY.test(name)) return 'heading';
    if (key === 'subtitle' && (ROW_FACTORY.test(name) || name === 'createPrefGroup')) return 'row subtitle';
    // A description sits beside a title or a label (a status page, a group or a page of the settings shell), never beside a bare name.
    if (key === 'description' && (GROUP_FACTORY.test(name) || ROW_FACTORY.test(name) || siblings.has('title') || (siblings.has('label') && siblings.has('id')))) return 'caption';
    if (key === 'title') {
        if (DIALOG_FACTORY.test(name) || GROUP_FACTORY.test(name)) return 'heading';
        if (ROW_FACTORY.test(name)) return siblings.has('label') ? 'tooltip' : 'row title';
        return null;
    }
    if (key === 'label') {
        if (keys.some(each => RESPONSE_KEYS.has(each)) || keys.includes('responses')) return 'dialog response';
        if (name === 'createCheckRow') return 'check or radio label';
        if (name === 'createButtonRow') return 'button';
        if (ROW_FACTORY.test(name)) return 'row title';
        if ((siblings.has('onSelect') || siblings.has('onActivate')) && (siblings.has('id') || siblings.has('icon') || siblings.has('appearance') || siblings.has('danger'))) return 'menu item';
        // A page of the settings shell: a table row with an id, an icon and a tooltip or description.
        if (siblings.has('id') && siblings.has('icon') && (siblings.has('tooltip') || siblings.has('description') || siblings.has('searchAliases'))) return 'tab';
        return null;
    }
    return null;
}

// Helpers that take the label as a positional argument. A helper is local to the file that defines it, so the table is keyed by
// file; an entry is added only after the definition and every call were read. `index` is the position of the label.
const button = { index: 0, role: 'button' };
const tooltip = { index: 0, role: 'tooltip' };
const menuItem = { index: 0, role: 'menu item' };
const rowTitle = { index: 0, role: 'row title' };
const heading = { index: 0, role: 'heading' };
const menuTitle = { index: 1, role: 'heading' };
const caption = index => ({ index, role: 'caption' });
export const POSITIONAL_HELPERS = {
    'public/scripts/sillybunny-server-tools.js': {
        createServerButtonRow: button, createServerSection: heading, createServerToolsGroup: heading,
        createThumbnailFormatRow: rowTitle, createThumbnailQualityRow: rowTitle, createThumbnailSizeRow: rowTitle,
    },
    'public/scripts/sillybunny-appearance.js': { item: { index: 1, role: 'menu item' } },
    'public/scripts/sillybunny-background-gallery.js': { item: menuItem, iconButton: tooltip },
    'public/scripts/sillybunny-character-editor.js': { _createGreetingButton: { index: 1, role: 'tooltip' } },
    'public/scripts/sillybunny-character-list.js': { makeMenuItem: menuItem, actionButton: tooltip, menu: menuTitle },
    'public/scripts/sillybunny-folder-manager.js': { rowButton: tooltip },
    'public/scripts/sillybunny-persona-detail.js': { iconButton: tooltip, button },
    'public/scripts/sillybunny-persona-editor.js': { menuItem, menu: menuTitle, button },
    'public/scripts/sillybunny-prompt-editor.js': { menuItem, menu: menuTitle, headerIconButton: tooltip, button, actionButton: tooltip, rowButton: tooltip, property: rowTitle, segmented: rowTitle, switchControl: rowTitle, group: heading },
    'public/scripts/sillybunny-tag-manager.js': { item: menuItem, rowButton: tooltip, openMenu: { index: 2, role: 'heading' } },
    'public/scripts/sillybunny-world-info-editor.js': { menuItem, menu: menuTitle, action: button, button },
    'public/scripts/sillybunny-world-info-model.js': { bool: { index: 2, role: 'row title' }, text: { index: 2, role: 'row title' }, nullableSpin: { index: 2, role: 'row title' }, triState: { index: 2, role: 'row title' } },
    'public/scripts/sillybunny-home/assistant-picker.js': { createStatus: { index: 2, role: 'heading' } },
    'public/scripts/sillybunny-home/step-rows.js': { createFlatButton: button },
    'public/scripts/sillybunny-character-import.js': { button, resultButton: button },
    'public/scripts/sillybunny-tabs.js': {
        createBackendGroupHeader: [heading, caption(2)], createBackendPromptGroup: { index: 1, role: 'heading' },
        createGroup: [{ index: 1, role: 'heading' }, caption(2)], createPromptingGroup: [{ index: 1, role: 'heading' }, caption(2)],
    },
    // The panel builders of the tab split call the shell's two group helpers, and define `createGroup` and `createPromptingGroup` themselves.
    'public/scripts/sillybunny-tabs/backend-panels.js': {
        createBackendGroupHeader: [heading, caption(2)], createBackendPromptGroup: { index: 1, role: 'heading' },
        createGroup: [{ index: 1, role: 'heading' }, caption(2)], createPromptingGroup: [{ index: 1, role: 'heading' }, caption(2)],
    },
    'public/scripts/sillybunny-tabs/sampling-panel.js': { createBackendGroupHeader: [heading, caption(2)] },
    'public/scripts/sillybunny-editor/reorder-menu.js': { item: { index: 1, role: 'menu item' } },
    'public/scripts/sillybunny-color-picker.js': { range: rowTitle },
    'public/scripts/sillybunny-segmented-control.js': { createSegmentedControl: rowTitle },
    'public/scripts/sillybunny-welcome.js': { createActionButton: button },
    'public/scripts/extensions/in-chat-agents/ui/agent-editor.js': {
        button, group: { index: 1, role: 'heading' }, action: { index: 1, role: 'button' }, headerAction: { index: 1, role: 'tooltip' },
        text: { index: 2, role: 'row title' }, spin: { index: 2, role: 'row title' }, toggle: { index: 2, role: 'row title' },
        choice: { index: 2, role: 'row title' }, select: { index: 2, role: 'row title' }, area: { index: 2, role: 'row title' },
    },
    'public/scripts/extensions/in-chat-agents/ui/agent-list.js': { switchControl: rowTitle, showMenu: { index: 2, role: 'heading' } },
    'public/scripts/extensions/in-chat-agents/ui/companions-page.js': { action: button },
    'public/scripts/extensions/guided-generations/index.js': { createActionButton: { index: 1, role: 'tooltip' } },
};
// Files whose `[id, title, description]` tables are group tables: the second element is a group heading and the third its caption.
const ROW_TABLE_FILES = new Set(['public/scripts/sillybunny-tabs.js', 'public/scripts/sillybunny-tabs/backend-panels.js']);
const isIdLike = node => node?.type === 'Literal' && typeof node.value === 'string' && /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(node.value);

// Helpers that other files import by name.
const SHARED_HELPERS = { confirmVerb: { index: 0, role: 'dialog response' }, createIconButton: tooltip };
const POPUP_SHORTCUTS = new Set(['confirm', 'alert', 'input', 'text']);
const TOAST_METHODS = new Set(['success', 'info', 'warning', 'error']);
// Element builders, `el(tag, className, text)` and `createElement(tag, { text })`: the tag says what the text is.
const ELEMENT_BUILDERS = new Set(['el', 'element', 'node', 'pageElement', 'createElement']);
const TAG_ROLES = { button: 'button', option: 'drop-down item' };
const roleOfTag = tag => (/^h[1-6]$/.test(tag ?? '') ? 'heading' : TAG_ROLES[tag] ?? null);

// A `lorum ipsum` placeholder is matched by its text in code and a `TODO(copy)` placeholder is the maintainers' to fill.
const isPlaceholder = text => text === 'lorum ipsum' || text === 'TODO(copy)';
const isCodeLike = text => isPlaceholder(text) || /^[a-z][a-z0-9]*(?:[_-][a-z0-9${}]+)+$/.test(text) || !/\p{L}/u.test(text) || /^\$\{\}$/.test(text.trim());

/**
 * Role-tagged labels of one script.
 * @param {string} source
 * @param {string} file Path from the repository root, to look up the positional helpers.
 * @returns {{ line: number, anchor: number, text: string, role: string, via: string }[]}
 */
export function scriptLabels(source, file = '') {
    const labels = [];
    let ancestry = [];
    const add = (node, text, role, via) => {
        if (!text || !role || isCodeLike(text)) return;
        const line = node.loc.start.line;
        const statement = [...ancestry].reverse().find(each => /(?:Statement|Declaration)$/.test(each.type));
        const anchor = statement && line - statement.loc.start.line <= STATEMENT_REACH ? statement.loc.start.line : line;
        labels.push({ line, anchor, text, role, via });
    };
    const helpers = POSITIONAL_HELPERS[file] ?? {};
    walk(parseScript(source), (node, ancestors) => {
        ancestry = ancestors;
        if (node.type === 'Property' && !node.computed) {
            const text = staticText(node.value);
            const parent = ancestors[ancestors.length - 1];
            if (text === null || parent?.type !== 'ObjectExpression') return;
            const siblings = new Set(parent.properties.map(property => (property.type === 'Property' ? keyName(property) : null)).filter(Boolean));
            const call = enclosingCall(ancestors);
            add(node.value, text, roleOfKey(keyName(node), siblings, call), `${keyName(node)} in ${call.name || 'an object'}`);
        } else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed) {
            const role = { title: 'tooltip', ariaLabel: 'accessible name', placeholder: 'placeholder' }[node.left.property.name];
            add(node.right, staticText(node.right), role, `${node.left.property.name} assignment`);
        } else if (node.type === 'CallExpression') {
            const name = calleeName(node);
            if (name === 'setAttribute' && node.arguments.length >= 2) {
                const attribute = staticText(node.arguments[0]);
                add(node.arguments[1], staticText(node.arguments[1]), { title: 'tooltip', 'aria-label': 'accessible name', placeholder: 'placeholder' }[attribute], `setAttribute ${attribute}`);
            } else if (TOAST_METHODS.has(name) && /^(?:toastr|toast)$/.test(node.callee.object?.name ?? node.callee.object?.property?.name ?? '')) {
                add(node.arguments[0], staticText(node.arguments[0]), 'body', `${name} toast message`);
                add(node.arguments[1], staticText(node.arguments[1]), 'toast title', `${name} toast title`);
            } else if (POPUP_SHORTCUTS.has(name) && node.callee.object?.property?.name === 'show') {
                // `Popup.show.confirm(heading, text, options)`
                add(node.arguments[0], staticText(node.arguments[0]), 'heading', `Popup.show.${name} heading`);
                add(node.arguments[1], staticText(node.arguments[1]), 'body', `Popup.show.${name} text`);
            } else if (ELEMENT_BUILDERS.has(name) && node.callee.type === 'Identifier') {
                const tag = staticText(node.arguments[0]);
                const options = node.arguments[1]?.type === 'ObjectExpression' ? node.arguments[1].properties.find(property => property.type === 'Property' && keyName(property) === 'text') : null;
                const textNode = options ? options.value : node.arguments[2];
                add(textNode, staticText(textNode), roleOfTag(tag), `text of a <${tag}> built by ${name}`);
            } else if (node.callee.type === 'Identifier' && (helpers[name] || SHARED_HELPERS[name])) {
                for (const { index, role } of [helpers[name] ?? SHARED_HELPERS[name]].flat()) {
                    add(node.arguments[index], staticText(node.arguments[index]), role, `${name} argument ${index}`);
                }
            }
        } else if (node.type === 'ArrayExpression' && ROW_TABLE_FILES.has(file) && node.elements.length === 3 && isIdLike(node.elements[0])) {
            const [, title, description] = node.elements;
            if (staticText(title) !== null && staticText(description) !== null) {
                add(title, staticText(title), 'heading', 'title of an [id, title, description] table');
                add(description, staticText(description), 'caption', 'description of an [id, title, description] table');
            }
        }
        if (node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral') {
            const text = node.type === 'Literal' ? node.value : node.quasis.map(quasi => quasi.value.cooked ?? '').join('${}');
            if (!text.includes('<') || !text.includes('=')) return;
            for (const match of text.matchAll(/\s(title|aria-label|placeholder)="([^"]*)"/g)) {
                add(node, match[2], { title: 'tooltip', 'aria-label': 'accessible name', placeholder: 'placeholder' }[match[1]], `${match[1]} attribute in markup`);
            }
        }
    });
    return labels;
}

// ---------------------------------------------------------------- markup

const SKIPPED_TAGS = new Set(['script', 'style', 'pre', 'code', 'textarea', 'svg', 'template']);
const attributeOf = (element, name) => element.attrs?.find(attribute => attribute.name === name)?.value;

/**
 * Role-tagged labels of a markup file or fragment: the `title`, `aria-label` and `placeholder` attributes, and the text of headings and buttons.
 * @param {string} html
 * @returns {{ line: number, anchor: number, text: string, role: string, via: string }[]}
 */
export function markupLabels(html) {
    const labels = [];
    const root = parseFragment(html, { sourceCodeLocationInfo: true });
    const visit = node => {
        const tag = node.tagName;
        if (tag && SKIPPED_TAGS.has(tag)) return;
        if (tag) {
            for (const [name, role] of [['title', 'tooltip'], ['aria-label', 'accessible name'], ['placeholder', 'placeholder']]) {
                const value = attributeOf(node, name);
                if (value && !isCodeLike(value)) {
                    const anchor = node.sourceCodeLocation?.startLine ?? 1;
                    labels.push({ line: node.sourceCodeLocation?.attrs?.[name]?.startLine ?? anchor, anchor, text: value, role, via: `${name} of <${tag}>` });
                }
            }
            const onlyText = (node.childNodes ?? []).every(child => child.nodeName === '#text' || child.nodeName === '#comment');
            const text = (node.childNodes ?? []).filter(child => child.nodeName === '#text').map(child => child.value).join('').replace(/\s+/g, ' ').trim();
            if (onlyText && text && !isCodeLike(text)) {
                const role = roleOfTag(tag);
                if (role) labels.push({ line: node.sourceCodeLocation?.startLine ?? 1, anchor: node.sourceCodeLocation?.startLine ?? 1, text, role, via: `text of <${tag}>` });
            }
        }
        for (const child of node.childNodes ?? []) visit(child);
        if (node.content) visit(node.content);
    };
    visit(root);
    return labels;
}

/**
 * True when a label of an upstream-origin file may be read as SillyBunny-written: a marker sits on a line from the one above
 * its element or statement (`anchor`) down to its own line.
 */
export function isMarked(sourceLines, anchor, line = anchor) {
    return sourceLines.slice(Math.max(0, anchor - 2), line).some(text => MARKER.test(text));
}

// ---------------------------------------------------------------- switch rows

const decodeEntities = text => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, '\'');

/**
 * The switch rows of the settings pages, from the settings inventory. The settings pass draws a check box as a switch row, so
 * a check label that the markup writes in sentence case is a row title that takes header capitalisation, which no static
 * reading of the markup can see. The inventory records the rendered names. Each name is placed in the source: a name that
 * only upstream-origin lines hold (no marker) is upstream wording; a name that a SillyBunny-owned file or a marked line holds is
 * SillyBunny-written; a name that no scanned file holds (third-party code, a label built from parts) is not placed.
 * @returns {string[]} The distinct switch names, sorted.
 */
export function inventorySwitchNames() {
    const inventory = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/settings-inventory.json'), 'utf8'));
    const names = new Set();
    for (const section of Object.values(inventory.sections)) {
        for (const control of section.controls) if (control.kind === 'switch' && control.name && !isCodeLike(control.name)) names.add(control.name);
    }
    return [...names].sort();
}

/**
 * The lines of the scanned files that hold a text, entities decoded, with whether each line is SillyBunny-written.
 * @param {string} text
 * @param {string[]} files
 * @returns {{ file: string, line: number, ownedBySillyBunny: boolean }[]}
 */
export function placeText(text, files) {
    const upstream = upstreamOriginFiles();
    const places = [];
    for (const file of files) {
        if (!file.endsWith('.html') && !file.endsWith('.js')) continue;
        const source = readSource(file);
        if (!decodeEntities(source).includes(text)) continue;
        const lines = source.split('\n');
        lines.forEach((line, index) => {
            if (!decodeEntities(line).includes(text)) return;
            let anchor = index + 1;
            for (let up = 0; up <= 3 && index - up >= 0; up++) {
                if (/<label\b/.test(lines[index - up])) { anchor = index - up + 1; break; }
            }
            places.push({ file, line: index + 1, ownedBySillyBunny: !upstream.has(file) || isMarked(lines, anchor, index + 1) });
        });
    }
    return places;
}
