/**
 * Option details: the extra line a model list shows under an option's name in the shared picker
 * (context size, price, capabilities, subscription). Provider files register one describer per select
 * id; a select row maps each of its options through it. Catalogue fields are untrusted, so details pass
 * through an allow-list and are only ever built as text nodes, a few inert elements, and links to an
 * absolute http or https address (see `link()`).
 *
 * A describer takes the `<option>` and returns one of:
 * - an array of segments, each a string, a node, a tree from `icon()` / `badge()`, or an array of those;
 * - the output of a select2 `templateResult` (a node or a jQuery object), split into segments at the `|`
 *   separators and block elements the templates use, with the bold name left out; a string, which
 *   templates return for an option they cannot describe, means no details.
 * Segments are joined by a middle dot.
 */

/** @typedef {string | { tag: string, attrs?: Record<string, string>, children?: DetailNode[] }} DetailNode */
/** @typedef {DetailNode[][]} Details */

const registry = new Map();

const INLINE_TAGS = new Set(['span', 'small', 'i']);
const BLOCK_TAGS = new Set(['div', 'p', 'br', 'ul', 'ol', 'li', 'section', 'tr']);
/** Elements whose content is never shown: markup that runs or loads, and the name the label already shows. */
const DROPPED_TAGS = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'textarea', 'select', 'head', 'title', 'strong']);
const ICON_CLASS = /^fa(-[a-z0-9]+)*$/;
const MAX_ATTRIBUTE_LENGTH = 300;
const MAX_URL_LENGTH = 2048;
const SEPARATOR = ' · ';

/**
 * @param {Record<string, (option: HTMLOptionElement) => unknown>} describers  Keyed by select id.
 */
export function registerOptionDetails(describers) {
    for (const [selectId, describe] of Object.entries(describers)) {
        if (typeof describe !== 'function') throw new TypeError(`Option details for ${selectId} must be a function.`);
        registry.set(selectId, describe);
    }
}

export function hasOptionDetails(selectId) {
    return registry.has(selectId);
}

/**
 * The normalised address when the value is an absolute http or https URL without credentials, else null.
 * A relative, protocol-relative or scheme-less value is rejected because no base is given.
 */
function safeUrl(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(text)) return null;
    try {
        const url = new URL(text);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * Keeps only the attributes an element of the allow-list may carry, and only values that are plain text.
 * A link also keeps its address when it is safe; with an unsafe one this returns null and the link is dropped.
 */
function cleanAttributes(tag, raw = {}) {
    const attrs = {};
    if (tag === 'a') {
        const href = safeUrl(raw.href);
        if (!href) return null;
        attrs.href = href;
    }
    for (const name of ['title', 'aria-label']) {
        const value = raw[name];
        if (typeof value === 'string' && value.trim()) attrs[name] = value.trim().slice(0, MAX_ATTRIBUTE_LENGTH);
    }
    if (raw['aria-hidden'] === 'true' || raw['aria-hidden'] === true) attrs['aria-hidden'] = 'true';
    if ((tag === 'i' || tag === 'a') && typeof raw.class === 'string') {
        const classes = raw.class.split(/\s+/).filter(name => ICON_CLASS.test(name));
        if (classes.length) attrs.class = classes.join(' ');
    }
    return attrs;
}

function readAttributes(element) {
    const raw = {};
    for (const name of ['title', 'aria-label', 'aria-hidden', 'class', 'href']) {
        if (element.hasAttribute(name)) raw[name] = element.getAttribute(name);
    }
    return raw;
}

const collapse = text => text.replace(/\s+/g, ' ');

/** Appends a cleaned tree, or its children when it carries nothing that must be kept. */
function appendTree(tree, out, inLink = false) {
    const tag = typeof tree.tag === 'string' ? tree.tag.toLowerCase() : '';
    if (DROPPED_TAGS.has(tag)) return;
    const children = [];
    for (const child of Array.isArray(tree.children) ? tree.children : []) appendItem(child, children, inLink || tag === 'a');
    if (tag === 'a') {
        // A link with an unsafe address goes with its content; links never nest.
        const attrs = inLink ? null : cleanAttributes('a', tree.attrs);
        if (attrs) out.push({ tag, attrs, children });
        return;
    }
    const attrs = INLINE_TAGS.has(tag) ? cleanAttributes(tag, tree.attrs) : {};
    // An element with no attribute to keep adds nothing; its content joins the surrounding text.
    if (Object.keys(attrs).length) out.push({ tag, attrs, children });
    else out.push(...children);
}

function appendNode(node, out, inLink = false) {
    if (node.nodeType === 3) {
        out.push(collapse(node.nodeValue ?? ''));
        return;
    }
    if (node.nodeType !== 1 || DROPPED_TAGS.has(node.localName)) return;
    const children = [];
    for (const child of node.childNodes) appendNode(child, children, inLink || node.localName === 'a');
    appendTree({ tag: node.localName, attrs: readAttributes(node), children }, out, inLink);
}

function appendItem(item, out, inLink = false) {
    if (item == null || item === false) return;
    if (typeof item === 'string') out.push(collapse(item));
    else if (typeof item === 'number') out.push(String(item));
    else if (Array.isArray(item)) item.forEach(entry => appendItem(entry, out, inLink));
    else if (typeof item.nodeType === 'number') appendNode(item, out, inLink);
    else if (typeof item === 'object') appendTree(item, out, inLink);
}

/** Merges neighbouring strings, trims the ends, and separates neighbouring elements. */
function tidySegment(nodes) {
    const merged = [];
    for (const node of nodes) {
        if (typeof node === 'string' && typeof merged.at(-1) === 'string') merged[merged.length - 1] += node;
        else if (typeof node !== 'string' || node) merged.push(node);
    }
    if (typeof merged[0] === 'string') merged[0] = merged[0].trimStart();
    if (typeof merged.at(-1) === 'string') merged[merged.length - 1] = merged.at(-1).trimEnd();
    const result = [];
    for (const node of merged) {
        if (node === '') continue;
        if (typeof node !== 'string' && typeof result.at(-1) === 'object') result.push(' ');
        result.push(node);
    }
    return result;
}

/** Splits template output into segments at `|` and block boundaries; inline elements stay whole. */
function templateSegments(roots) {
    const segments = [[]];
    const split = () => { if (segments.at(-1).length) segments.push([]); };
    const visit = (node, top) => {
        if (node.nodeType === 3) {
            (node.nodeValue ?? '').split('|').forEach((piece, index) => {
                if (index) split();
                segments.at(-1).push(collapse(piece));
            });
            return;
        }
        if (node.nodeType !== 1 || DROPPED_TAGS.has(node.localName)) return;
        const tag = node.localName;
        if (tag === 'a') {
            const kept = [];
            appendNode(node, kept);
            segments.at(-1).push(...kept);
            return;
        }
        // The outer element of a template only lays the row out; its tooltip repeats the model id.
        if (top || BLOCK_TAGS.has(tag) || (INLINE_TAGS.has(tag) && !Object.keys(cleanAttributes(tag, readAttributes(node))).length)) {
            const block = BLOCK_TAGS.has(tag);
            if (block) split();
            for (const child of node.childNodes) visit(child, false);
            if (block) split();
            return;
        }
        const kept = [];
        appendNode(node, kept);
        segments.at(-1).push(...kept);
    };
    roots.forEach(root => visit(root, true));
    return segments;
}

/**
 * Turns a describer's result into details, or null when there is nothing to show.
 * @param {unknown} result
 * @returns {Details | null}
 */
export function toDetails(result) {
    if (result == null || result === false) return null;
    /** @type {unknown[][]} */
    let segments;
    if (Array.isArray(result)) {
        segments = result.map(segment => {
            const nodes = [];
            appendItem(segment, nodes);
            return nodes;
        });
    } else if (typeof result === 'string') {
        // A template returns the option's own text when it has nothing to add.
        return null;
    } else {
        const roots = result.jquery ? result.toArray() : [result];
        segments = templateSegments(roots.filter(root => typeof root?.nodeType === 'number'));
    }
    const details = segments.map(tidySegment).filter(segment => segment.length);
    return details.length ? details : null;
}

function nodeText(node) {
    if (typeof node === 'string') return node;
    if (node.attrs?.['aria-hidden'] === 'true' || node.tag === 'a') return '';
    if (node.tag === 'i') return node.attrs?.['aria-label'] ?? node.attrs?.title ?? '';
    return (node.children ?? []).map(nodeText).join('');
}

/** The same content as plain text: what search matches and what a consumer without elements shows. */
export function detailsToText(details) {
    return details.map(segment => collapse(segment.map(nodeText).join('')).trim()).filter(Boolean).join(SEPARATOR);
}

/** @returns {Node|null} Null for a link whose address is not safe. */
function renderNode(node) {
    if (typeof node === 'string') return document.createTextNode(node);
    const tag = node.tag === 'a' || INLINE_TAGS.has(node.tag) ? node.tag : 'span';
    const attrs = cleanAttributes(tag, node.attrs);
    if (!attrs) return null;
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    // An icon with a name is an image to assistive technology; `aria-label` alone does not name a generic element.
    if (tag === 'i' && attrs['aria-label']) element.setAttribute('role', 'img');
    // Where a link opens and what it may reach is never taken from the catalogue.
    if (tag === 'a') {
        element.target = '_blank';
        element.rel = 'noopener noreferrer';
    }
    for (const child of node.children ?? []) element.append(renderNode(child) ?? '');
    return element;
}

/** @param {Details} details */
export function renderDetails(details) {
    const fragment = document.createDocumentFragment();
    details.forEach((segment, index) => {
        if (index) fragment.append(document.createTextNode(SEPARATOR));
        for (const node of segment) fragment.append(renderNode(node) ?? '');
    });
    return fragment;
}

/** An icon that carries its meaning: `classes` must be Font Awesome class names, `label` its name and tooltip. */
export function icon(classes, label) {
    return { tag: 'i', attrs: { class: classes, ...(label ? { title: label, 'aria-label': label } : { 'aria-hidden': 'true' }) } };
}

/**
 * A link to an address from the catalogue, shown as an icon. It is kept only when `url` is an absolute
 * http or https address without credentials; it always opens in a new tab with `noopener noreferrer`.
 * `label` is its accessible name and tooltip.
 */
export function link(url, { classes, label } = {}) {
    return { tag: 'a', attrs: { href: url, class: classes, ...(label ? { title: label, 'aria-label': label } : {}) }, children: [] };
}

/** A short state with an optional icon and tooltip, such as a subscription badge. */
export function badge(text, { title, classes } = {}) {
    return { tag: 'small', attrs: title ? { title } : {}, children: [...(classes ? [icon(classes)] : []), ` ${text}`] };
}

/**
 * Item mapper for `createSelectRow` that adds the details registered for `selectId`. The lookup runs on
 * every call, so a describer registered after the row was built still applies.
 * @param {string} selectId
 * @returns {(item: object, option: HTMLOptionElement) => object}
 */
export function createDetailsMapper(selectId) {
    return (item, option) => {
        const describe = registry.get(selectId);
        if (!describe) return item;
        let details;
        try {
            details = toDetails(describe(option));
        } catch {
            // A catalogue entry the describer cannot read must not stop the list from opening.
            return item;
        }
        return details ? { ...item, subtitle: detailsToText(details), details } : item;
    };
}
