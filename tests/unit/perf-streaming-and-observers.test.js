/* global globalThis */
import vm from 'node:vm';
import { ReadableStream, TextDecoderStream, TransformStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import createDOMPurify from 'dompurify';
import showdown from 'showdown';
import { parse as parseCss, stringify as stringifyCss } from '@adobe/css-tools';
import { parseDocument } from 'htmlparser2';
import morphdom from 'morphdom';
import { loadDeclarations, readClientModule } from '../util/load-declarations.js';
import {
    extractOocBlocksForDisplay,
    restoreOocBlocksForDisplay,
} from '../../public/scripts/ooc-blocks.js';
import { removeUnscopableCss } from '../../public/scripts/sillybunny-style-tag-scope.js';
import {
    formatBasicMarkdownStreamingPreview,
    getStreamingUpdateInterval,
    IOS_MAX_ADAPTIVE_INTERVAL_MS,
    shouldReduceStreamingDomWork,
    shouldRenderLiveReasoningContent,
    shouldUsePlainTextStreamingPreview,
} from '../../public/scripts/mobile-streaming.js';

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Spec-compatible lightweight DOM implementation supporting `morphdom`, `TreeWalker`,
 * `innerHTML`/`outerHTML`, `cloneNode`, `isEqualNode`, `querySelectorAll`, and events
 * in Jest's `node` environment without requiring `jsdom`.
 */
function createDomEnvironment() {
    const ELEMENT_NODE = 1;
    const TEXT_NODE = 3;
    const COMMENT_NODE = 8;
    const DOCUMENT_FRAGMENT_NODE = 11;

    function escapeAttr(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeHtmlText(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    class DomNode {
        constructor(nodeType, ownerDocument) {
            this.nodeType = nodeType;
            this.ownerDocument = ownerDocument;
            this._parentNode = null;
            this._childNodes = [];
        }

        get parentNode() {
            return this._parentNode;
        }

        set parentNode(val) {
            this._parentNode = val;
        }

        get childNodes() {
            return this._childNodes;
        }

        set childNodes(val) {
            this._childNodes = val;
        }

        hasChildNodes() {
            return this._childNodes.length > 0;
        }

        get parentElement() {
            return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
        }

        get firstChild() {
            return this.childNodes[0] ?? null;
        }

        get lastChild() {
            return this.childNodes[this.childNodes.length - 1] ?? null;
        }

        get nextSibling() {
            if (!this.parentNode) return null;
            const idx = this.parentNode.childNodes.indexOf(this);
            return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
        }

        get previousSibling() {
            if (!this.parentNode) return null;
            const idx = this.parentNode.childNodes.indexOf(this);
            return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
        }

        get isConnected() {
            let cur = this;
            while (cur) {
                if (this.ownerDocument && (cur === this.ownerDocument.documentElement || cur === this.ownerDocument.body)) {
                    return true;
                }
                cur = cur.parentNode;
            }
            return false;
        }

        appendChild(child) {
            return this.insertBefore(child, null);
        }

        insertBefore(newNode, refNode) {
            if (newNode.nodeType === DOCUMENT_FRAGMENT_NODE) {
                for (const child of [...newNode.childNodes]) {
                    this.insertBefore(child, refNode);
                }
                return newNode;
            }
            if (newNode.parentNode) {
                newNode.parentNode.removeChild(newNode);
            }
            const refIdx = refNode ? this.childNodes.indexOf(refNode) : -1;
            if (refNode && refIdx >= 0) {
                this.childNodes.splice(refIdx, 0, newNode);
            } else {
                this.childNodes.push(newNode);
            }
            newNode.parentNode = this;
            return newNode;
        }

        removeChild(child) {
            const idx = this.childNodes.indexOf(child);
            if (idx >= 0) {
                this.childNodes.splice(idx, 1);
                child.parentNode = null;
            }
            return child;
        }

        replaceChild(newChild, oldChild) {
            this.insertBefore(newChild, oldChild);
            this.removeChild(oldChild);
            return oldChild;
        }

        remove() {
            if (this.parentNode) {
                this.parentNode.removeChild(this);
            }
        }

        replaceWith(...nodes) {
            if (!this.parentNode) return;
            const parent = this.parentNode;
            for (const node of nodes) {
                const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
                parent.insertBefore(child, this);
            }
            parent.removeChild(this);
        }

        normalize() {
            for (let i = 0; i < this.childNodes.length; i++) {
                const child = this.childNodes[i];
                if (child.nodeType === TEXT_NODE) {
                    if (child.data === '') {
                        this.removeChild(child);
                        i--;
                        continue;
                    }
                    while (i + 1 < this.childNodes.length && this.childNodes[i + 1].nodeType === TEXT_NODE) {
                        child.data += this.childNodes[i + 1].data;
                        this.removeChild(this.childNodes[i + 1]);
                    }
                } else if (child.childNodes.length > 0) {
                    child.normalize();
                }
            }
        }

        contains(other) {
            let cur = other;
            while (cur) {
                if (cur === this) return true;
                cur = cur.parentNode;
            }
            return false;
        }

        cloneNode(deep = false) {
            if (this.nodeType === TEXT_NODE) {
                return new DomText(this.data, this.ownerDocument);
            }
            if (this.nodeType === COMMENT_NODE) {
                return new DomComment(this.data, this.ownerDocument);
            }
            if (this.nodeType === DOCUMENT_FRAGMENT_NODE) {
                const frag = new DomFragment(this.ownerDocument);
                if (deep) {
                    for (const child of this.childNodes) {
                        frag.appendChild(child.cloneNode(true));
                    }
                }
                return frag;
            }
            const copy = this.ownerDocument.createElement(this.localName);
            for (const [k, v] of this._attrs.entries()) copy._attrs.set(k, v);
            if (deep) {
                for (const child of this.childNodes) {
                    copy.appendChild(child.cloneNode(true));
                }
            }
            return copy;
        }
    }

    class DomText extends DomNode {
        constructor(data, ownerDocument) {
            super(TEXT_NODE, ownerDocument);
            this.data = String(data ?? '');
        }

        get nodeName() { return '#text'; }
        get nodeValue() { return this.data; }
        set nodeValue(val) { this.data = String(val ?? ''); }
        get textContent() { return this.data; }
        set textContent(val) { this.data = String(val ?? ''); }

        cloneNode() {
            return new DomText(this.data, this.ownerDocument);
        }

        isEqualNode(other) {
            return Boolean(other && other.nodeType === TEXT_NODE && this.data === other.data);
        }
    }

    class DomComment extends DomNode {
        constructor(data, ownerDocument) {
            super(COMMENT_NODE, ownerDocument);
            this.data = String(data ?? '');
        }

        get nodeName() { return '#comment'; }
        get nodeValue() { return this.data; }
        set nodeValue(val) { this.data = String(val ?? ''); }
        get textContent() { return this.data; }

        cloneNode() {
            return new DomComment(this.data, this.ownerDocument);
        }

        isEqualNode(other) {
            return Boolean(other && other.nodeType === COMMENT_NODE && this.data === other.data);
        }
    }

    class DomFragment extends DomNode {
        constructor(ownerDocument) {
            super(DOCUMENT_FRAGMENT_NODE, ownerDocument);
        }

        get nodeName() { return '#document-fragment'; }
    }

    class DomElement extends DomNode {
        constructor(tagName, ownerDocument) {
            super(ELEMENT_NODE, ownerDocument);
            this.localName = String(tagName).toLowerCase();
            this.tagName = this.localName.toUpperCase();
            this.nodeName = this.tagName;
            this.namespaceURI = 'http://www.w3.org/1999/xhtml';
            this._attrs = new Map();
            this._listeners = new Map();
            this.style = { display: '' };
            const self = this;
            this.classList = {
                add(...names) {
                    const set = new Set(self._classListArray());
                    for (const name of names) if (name) set.add(name);
                    self.className = [...set].join(' ');
                },
                remove(...names) {
                    const removeSet = new Set(names);
                    const next = self._classListArray().filter(c => !removeSet.has(c));
                    if (next.length > 0) self.className = next.join(' ');
                    else self.removeAttribute('class');
                },
                toggle(name, force) {
                    const has = this.contains(name);
                    const shouldHave = force === undefined ? !has : Boolean(force);
                    if (shouldHave) this.add(name);
                    else this.remove(name);
                    return shouldHave;
                },
                contains(name) {
                    return self._classListArray().includes(name);
                },
            };
            this.dataset = new Proxy({}, {
                get(_target, prop) {
                    if (typeof prop !== 'string') return undefined;
                    const attr = 'data-' + prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
                    return self.getAttribute(attr) ?? undefined;
                },
                set(_target, prop, value) {
                    const attr = 'data-' + String(prop).replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
                    self.setAttribute(attr, String(value));
                    return true;
                },
                deleteProperty(_target, prop) {
                    const attr = 'data-' + String(prop).replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
                    self.removeAttribute(attr);
                    return true;
                },
            });
        }

        _classListArray() {
            const raw = this._attrs.get('class') ?? '';
            return raw ? raw.trim().split(/\s+/).filter(Boolean) : [];
        }

        get id() { return this._attrs.get('id') ?? ''; }
        set id(val) { this.setAttribute('id', val); }

        get className() { return this._attrs.get('class') ?? ''; }
        set className(val) {
            if (val === '') this.removeAttribute('class');
            else this.setAttribute('class', String(val));
        }

        get title() { return this._attrs.get('title') ?? ''; }
        set title(val) { this.setAttribute('title', String(val)); }

        get open() { return this._attrs.has('open'); }
        set open(val) {
            if (val) this.setAttribute('open', '');
            else this.removeAttribute('open');
        }

        get attributes() {
            const list = [];
            for (const [name, value] of this._attrs.entries()) {
                list.push({ name, value, namespaceURI: null });
            }
            return list;
        }

        get children() {
            return this.childNodes.filter(n => n.nodeType === ELEMENT_NODE);
        }

        get firstElementChild() {
            for (const child of this.childNodes) {
                if (child.nodeType === ELEMENT_NODE) return child;
            }
            return null;
        }

        get lastElementChild() {
            for (let i = this.childNodes.length - 1; i >= 0; i--) {
                if (this.childNodes[i].nodeType === ELEMENT_NODE) return this.childNodes[i];
            }
            return null;
        }

        get nextElementSibling() {
            for (let n = this.nextSibling; n; n = n.nextSibling) {
                if (n.nodeType === ELEMENT_NODE) return n;
            }
            return null;
        }

        get textContent() {
            let out = '';
            for (const child of this.childNodes) out += child.textContent;
            return out;
        }

        set textContent(val) {
            for (const child of this.childNodes) child.parentNode = null;
            this.childNodes = [];
            const str = String(val ?? '');
            if (str.length > 0) {
                this.appendChild(new DomText(str, this.ownerDocument));
            }
        }

        get innerHTML() {
            return this.childNodes.map(serializeNode).join('');
        }

        set innerHTML(html) {
            for (const child of this.childNodes) child.parentNode = null;
            this.childNodes = [];
            const parsed = parseDocument(String(html ?? ''), { decodeEntities: true });
            for (const child of parsed.children) {
                const converted = convertHtmlParserNode(child, this.ownerDocument);
                if (converted) this.appendChild(converted);
            }
        }

        get outerHTML() {
            return serializeNode(this);
        }

        hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
        getAttribute(name) {
            const key = String(name).toLowerCase();
            return this._attrs.has(key) ? this._attrs.get(key) : null;
        }
        setAttribute(name, value) {
            this._attrs.set(String(name).toLowerCase(), String(value));
        }
        removeAttribute(name) {
            this._attrs.delete(String(name).toLowerCase());
        }
        hasAttributeNS(_ns, name) { return this.hasAttribute(name); }
        setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }
        removeAttributeNS(_ns, name) { this.removeAttribute(name); }

        isEqualNode(other) {
            if (!other || other.nodeType !== ELEMENT_NODE || this.tagName !== other.tagName) return false;
            if (this._attrs.size !== other._attrs.size) return false;
            for (const [k, v] of this._attrs.entries()) {
                if (other._attrs.get(k) !== v) return false;
            }
            if (this.childNodes.length !== other.childNodes.length) return false;
            for (let i = 0; i < this.childNodes.length; i++) {
                if (!this.childNodes[i].isEqualNode(other.childNodes[i])) return false;
            }
            return true;
        }

        matches(selector) {
            return selector.split(',').some(part => matchSingleSelector(this, part.trim()));
        }

        closest(selector) {
            let cur = this;
            while (cur && cur.nodeType === ELEMENT_NODE) {
                if (cur.matches(selector)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }

        querySelectorAll(selector) {
            const results = [];
            const visit = (node) => {
                for (const child of node.childNodes) {
                    if (child.nodeType === ELEMENT_NODE) {
                        if (child.matches(selector)) results.push(child);
                        visit(child);
                    }
                }
            };
            visit(this);
            return results;
        }

        querySelector(selector) {
            return this.querySelectorAll(selector)[0] ?? null;
        }

        addEventListener(type, fn) {
            if (!this._listeners.has(type)) this._listeners.set(type, new Set());
            this._listeners.get(type).add(fn);
        }

        removeEventListener(type, fn) {
            this._listeners.get(type)?.delete(fn);
        }

        dispatchEvent(event) {
            const set = this._listeners.get(event.type);
            if (set) {
                for (const fn of [...set]) fn.call(this, event);
            }
            return true;
        }
    }

    class DomDetailsElement extends DomElement {}

    function matchCompound(el, compound) {
        let rest = compound.trim();
        if (!rest) return false;
        const attrRe = /\[([^\]=]+)(?:="([^"]*)")?\]/g;
        let m;
        while ((m = attrRe.exec(rest)) !== null) {
            if (!el.hasAttribute(m[1])) return false;
            if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
        }
        rest = rest.replace(attrRe, '');
        const parts = rest.match(/^[a-zA-Z0-9_-]+|[#.][a-zA-Z0-9_-]+/g) ?? [];
        for (const p of parts) {
            if (p.startsWith('#')) {
                if (el.id !== p.slice(1)) return false;
            } else if (p.startsWith('.')) {
                if (!el.classList.contains(p.slice(1))) return false;
            } else if (el.localName !== p.toLowerCase()) {
                return false;
            }
        }
        return true;
    }

    function matchSingleSelector(el, selector) {
        const parts = selector.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return false;
        if (!matchCompound(el, parts[parts.length - 1])) return false;
        let cur = el.parentElement;
        for (let i = parts.length - 2; i >= 0; i--) {
            while (cur && !matchCompound(cur, parts[i])) {
                cur = cur.parentElement;
            }
            if (!cur) return false;
            cur = cur.parentElement;
        }
        return true;
    }

    function serializeNode(node) {
        if (node.nodeType === TEXT_NODE) return escapeHtmlText(node.data);
        if (node.nodeType === COMMENT_NODE) return `<!--${node.data}-->`;
        if (node.nodeType === ELEMENT_NODE) {
            const attrs = [...node._attrs.entries()]
                .map(([k, v]) => v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)
                .join('');
            const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track']);
            if (voidTags.has(node.localName)) {
                return `<${node.localName}${attrs}>`;
            }
            return `<${node.localName}${attrs}>${node.innerHTML}</${node.localName}>`;
        }
        return '';
    }

    function convertHtmlParserNode(node, doc) {
        if (node.type === 'text') return new DomText(node.data, doc);
        if (node.type === 'comment') return new DomComment(node.data, doc);
        if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
            const el = doc.createElement(node.name);
            if (node.attribs) {
                for (const [k, v] of Object.entries(node.attribs)) {
                    el.setAttribute(k, v);
                }
            }
            if (node.children) {
                for (const child of node.children) {
                    const converted = convertHtmlParserNode(child, doc);
                    if (converted) el.appendChild(converted);
                }
            }
            return el;
        }
        return null;
    }

    function makeDocument() {
        const d = {
            nodeType: 9,
            body: null,
            documentElement: null,
            createElement(tag) {
                const lower = String(tag).toLowerCase();
                return lower === 'details' ? new DomDetailsElement('details', d) : new DomElement(lower, d);
            },
            createElementNS(_ns, tag) {
                return d.createElement(tag);
            },
            createTextNode(text) {
                return new DomText(text, d);
            },
            createComment(text) {
                return new DomComment(text, d);
            },
            createDocumentFragment() {
                return new DomFragment(d);
            },
            getElementsByTagName(tag) {
                const lower = String(tag).toLowerCase();
                const out = [];
                const doc = this && (this.documentElement || this.body) ? this : d;
                const root = doc.documentElement || doc.body;
                const walk = (n) => {
                    if (!n) return;
                    if (n.nodeType === ELEMENT_NODE && (lower === '*' || n.localName === lower)) {
                        out.push(n);
                    }
                    for (const child of n.childNodes) walk(child);
                };
                walk(root);
                return out;
            },
            createNodeIterator(root, _whatToShow) {
                let current = null;
                let started = false;
                const nextInPreOrder = (node) => {
                    if (node.childNodes.length > 0) return node.childNodes[0];
                    let cur = node;
                    while (cur && cur !== root) {
                        const next = cur.nextSibling;
                        if (next) return next;
                        cur = cur.parentNode;
                    }
                    return null;
                };
                // Track live tree safely even when DOMPurify removes `current` mid-iteration.
                let nextCandidate = null;
                const advanceAfter = (node) => {
                    let cur = node;
                    while (cur && cur !== root) {
                        const next = cur.nextSibling;
                        if (next) return next;
                        cur = cur.parentNode;
                    }
                    return null;
                };
                return {
                    nextNode() {
                        if (!started) {
                            started = true;
                            current = root.childNodes[0] ?? null;
                        } else if (current && current.parentNode) {
                            current = nextInPreOrder(current);
                        } else {
                            current = nextCandidate;
                        }
                        nextCandidate = current ? advanceAfter(current) : null;
                        return current;
                    },
                };
            },
            createTreeWalker(root, whatToShow) {
                const SHOW_TEXT = 4;
                const list = [];
                const walk = (n) => {
                    for (const child of n.childNodes) {
                        if (whatToShow === SHOW_TEXT ? child.nodeType === TEXT_NODE : true) {
                            list.push(child);
                        }
                        if (child.childNodes.length > 0) walk(child);
                    }
                };
                walk(root);
                let idx = -1;
                return {
                    currentNode: root,
                    nextNode() {
                        idx++;
                        if (idx >= list.length) return null;
                        this.currentNode = list[idx];
                        return this.currentNode;
                    },
                };
            },
            importNode(node, deep) {
                const cloned = node.cloneNode(deep);
                const reown = (n) => {
                    n.ownerDocument = d;
                    for (const c of n.childNodes) reown(c);
                };
                reown(cloned);
                return cloned;
            },
            implementation: {
                createHTMLDocument() {
                    return makeDocument();
                },
                createDocument(_ns, qualifiedName) {
                    const created = makeDocument();
                    if (qualifiedName) {
                        created.documentElement = created.createElement(qualifiedName);
                        created.body = created.documentElement;
                    }
                    return created;
                },
            },
            querySelector(sel) { return d.body.querySelector(sel); },
            querySelectorAll(sel) { return d.body.querySelectorAll(sel); },
            hasFocus: () => true,
        };
        const htmlEl = d.createElement('html');
        const bodyEl = d.createElement('body');
        htmlEl.appendChild(bodyEl);
        d.documentElement = htmlEl;
        d.body = bodyEl;
        return d;
    }

    const doc = makeDocument();

    class FakeDOMParser {
        parseFromString(markup) {
            const parsedDoc = makeDocument();
            parsedDoc.body.innerHTML = String(markup ?? '');
            return parsedDoc;
        }
    }

    class FakeNamedNodeMap {}
    class FakeHTMLFormElement extends DomElement {}

    const windowObj = {
        document: doc,
        DocumentFragment: DomFragment,
        Node: Object.assign(DomNode, { ELEMENT_NODE, TEXT_NODE, COMMENT_NODE, DOCUMENT_FRAGMENT_NODE }),
        Element: DomElement,
        HTMLElement: DomElement,
        HTMLDetailsElement: DomDetailsElement,
        HTMLFormElement: FakeHTMLFormElement,
        NamedNodeMap: FakeNamedNodeMap,
        NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, SHOW_COMMENT: 128 },
        DOMParser: FakeDOMParser,
        location: { origin: 'http://127.0.0.1:4444' },
    };

    return {
        window: windowObj,
        document: doc,
        Element: DomElement,
        HTMLElement: DomElement,
        HTMLDetailsElement: DomDetailsElement,
        Node: windowObj.Node,
        NodeFilter: windowObj.NodeFilter,
        DOMParser: FakeDOMParser,
    };
}

/**
 * Loads `stream-fadein.js` in an isolated VM context wired to `morphdom` and `createDomEnvironment`.
 */
function loadStreamFadeInModule() {
    const dom = createDomEnvironment();
    const context = vm.createContext({
        ...dom,
        Intl,
        Set,
        Map,
        WeakMap,
        setTimeout,
        clearTimeout,
        morphdom,
    });
    const names = [
        'MAX_TAIL_SEGMENTS',
        'TAIL_COLLAPSE_STEP',
        'SETTLE_FADE_MS',
        'DESCENDABLE_CONTAINER_TAGS',
        'UNSPLITTABLE_HTML_TAGS',
        'REFERENCE_DEF_RE',
        'REFERENCE_LINK_USE_RE',
        'FENCE_OPEN_OR_CLOSE_RE',
        'HTML_TAG_TOKEN_RE',
        'LIST_ITEM_START_RE',
        'INDENTED_CODE_START_RE',
        'CONTINUATION_BLOCK_START_RE',
        'segmenterCache',
        'segmentedBlockRecords',
        'pendingSegmentedElementsByRoot',
        'settleTimerByRoot',
        'getSegmenter',
        'isSegmenterSupported',
        'collectSegmentableTextNodes',
        'segmentTextInElement',
        'collapseTextSegments',
        'findActiveTailElement',
        'segmentTailElementBounded',
        'advanceLiveTailCollapsedPrefix',
        'areElementsFastEqual',
        'clearSettleTimer',
        'reconcilePendingSegmentedElements',
        'trackSegmentedElementForSettle',
        'applyStreamDomPatch',
        'applyStreamFadeIn',
        'splitStreamingBlocks',
        'createIncrementalBlockFormatter',
    ];
    loadDeclarations(context, 'scripts/util/stream-fadein.js', names);
    const exports = Object.fromEntries(names.map(name => [name, vm.runInContext(name, context)]));
    return { ...exports, dom, context };
}

/**
 * Production-faithful HTML sanitizer for differential parity tests: strips executable tags,
 * inline event handlers, and `javascript:`/`vbscript:`/`data:text/html` URLs while preserving
 * `<custom-style>` placeholders for `decodeStyleTags`.
 */
function sanitizeTestMessageHtml(html) {
    const dangerousTags = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'base', 'meta', 'link']);
    const urlAttrs = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);
    const dom = createDomEnvironment();
    const root = dom.document.createElement('div');
    root.innerHTML = html;

    const clean = (node) => {
        for (const child of [...node.childNodes]) {
            if (child.nodeType === 1) {
                if (dangerousTags.has(child.localName)) {
                    child.remove();
                    continue;
                }
                for (const { name, value } of child.attributes) {
                    if (name.startsWith('on')) {
                        child.removeAttribute(name);
                    } else if (urlAttrs.has(name) && /^\s*(?:javascript:|vbscript:|data:text\/html)/i.test(value)) {
                        child.removeAttribute(name);
                    }
                }
                clean(child);
            }
        }
    };
    clean(root);
    return root.innerHTML;
}

describe('PR 8 — SmoothEventSourceStream, Incremental Block Streaming, and Closed Reasoning', () => {
    describe('SmoothEventSourceStream & StreamPacer', () => {
        function createSseContext({
            speed = 50,
            noThink = false,
            focus = false,
            rafQueue = null,
            cancelAnimationFrameSpy = null,
            setTimeoutImpl = setTimeout,
            clearTimeoutImpl = clearTimeout,
            IntlImpl = Intl,
        } = {}) {
            const cloneSpy = jest.fn(val => structuredClone(val));
            const delayCalls = [];
            let currentFocus = focus;
            const context = vm.createContext({
                TextDecoderStream,
                TransformStream,
                MessageEvent,
                Intl: IntlImpl,
                structuredClone: cloneSpy,
                console: { debug: jest.fn() },
                setTimeout: setTimeoutImpl,
                clearTimeout: clearTimeoutImpl,
                document: {
                    hasFocus: () => currentFocus,
                    visibilityState: 'visible',
                },
                requestAnimationFrame: rafQueue
                    ? (cb) => { rafQueue.push(cb); return rafQueue.length; }
                    : undefined,
                cancelAnimationFrame: cancelAnimationFrameSpy ?? (() => {}),
                delay: (ms) => {
                    delayCalls.push(ms);
                    return Promise.resolve();
                },
                power_user: {
                    smooth_streaming_speed: speed,
                    smooth_streaming_no_think: noThink,
                },
            });
            context.globalThis = context;
            const names = [
                'NOT_PRIMARY',
                'EventSourceStream',
                'getDelay',
                'parseStreamData',
                'SMOOTH_MIN_PAUSE_MS',
                'SMOOTH_FRAME_SLICE_MS',
                'SMOOTH_CATCH_UP_UNITS',
                'waitForAnimationFrameOrDelay',
                'graphemeSegmenter',
                'splitStreamUnits',
                'StreamPacer',
                'SmoothEventSourceStream',
            ];
            loadDeclarations(context, 'scripts/sse-stream.js', names);
            const exports = Object.fromEntries(names.map(n => [n, vm.runInContext(n, context)]));
            return {
                ...exports,
                cloneSpy,
                delayCalls,
                context,
                setFocus: (value) => { currentFocus = value; },
            };
        }

        async function runSmoothFrames(SmoothEventSourceStream, payloads) {
            const encoder = new TextEncoder();
            const wire = payloads
                .map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
                .join('');
            const source = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(wire));
                    controller.close();
                },
            });
            const reader = source.pipeThrough(new SmoothEventSourceStream()).getReader();
            const out = [];
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                out.push(value.data);
            }
            return out;
        }

        test('preserves astral emojis, ZWJ clusters, and CJK Extension B surrogate pairs without structuredClone', async () => {
            const { SmoothEventSourceStream, parseStreamData, cloneSpy } = createSseContext();
            const sample = 'Hello 😀🎉 👍🏽 👨‍👩‍👧‍👦 𠮷野家 \u{20BB7}\u{2F81A}!';

            const rawEvents = await runSmoothFrames(SmoothEventSourceStream, [
                { id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: sample } }] },
                '[DONE]',
            ]);

            expect(cloneSpy).not.toHaveBeenCalled();
            expect(rawEvents.at(-1)).toBe('[DONE]');

            const pieces = rawEvents.slice(0, -1).map((item) => {
                expect(item).not.toMatch(LONE_SURROGATE_RE);
                const parsed = JSON.parse(item);
                const deltaText = parsed.choices[0].delta.content;
                expect(deltaText).not.toMatch(LONE_SURROGATE_RE);
                return deltaText;
            });
            expect(pieces.join('')).toBe(sample);
            // Must never split a surrogate pair into 2 broken UTF-16 halves
            expect(pieces.length).toBeLessThan(sample.length);

            // Also verify direct parseStreamData code-point iteration across provider formats
            const claudeChunks = [];
            for await (const item of parseStreamData({ type: 'content_block_delta', delta: { text: '😀𠮷A' } })) {
                expect(item.chunk).not.toMatch(LONE_SURROGATE_RE);
                claudeChunks.push(item.chunk);
            }
            expect(claudeChunks).toEqual(['😀', '𠮷', 'A']);
            expect(cloneSpy).not.toHaveBeenCalled();
        });

        test('passes 11,000-char reasoning chunks intact with zero delay spin when smooth_streaming_no_think is true', async () => {
            const { SmoothEventSourceStream, delayCalls, cloneSpy } = createSseContext({
                speed: 50,
                noThink: true,
                focus: true,
            });
            const hugeReasoning = 'Think step by step 𠮷 '.repeat(550); // > 11,000 UTF-16 code units

            const startedAt = performance.now();
            const events = await runSmoothFrames(SmoothEventSourceStream, [
                { choices: [{ index: 0, delta: { reasoning_content: hugeReasoning, content: '' } }] },
                { choices: [{ index: 0, delta: { content: 'Ok' } }] },
                '[DONE]',
            ]);
            const elapsedMs = performance.now() - startedAt;

            // Reasoning passed through as ONE event + 2 content events ('O', 'k') + '[DONE]' = 4 events total!
            expect(events).toHaveLength(4);
            expect(JSON.parse(events[0]).choices[0].delta.reasoning_content).toBe(hugeReasoning);
            expect(JSON.parse(events[1]).choices[0].delta.content).toBe('O');
            expect(JSON.parse(events[2]).choices[0].delta.content).toBe('k');
            expect(cloneSpy).not.toHaveBeenCalled();
            // Zero delays during the 11,000-char reasoning chunk (only 2 pauses before 'O' and 'k')
            expect(delayCalls).toHaveLength(2);
            expect(elapsedMs).toBeLessThan(100);
        });

        test('StreamPacer coalesces sub-frame waits onto rAF and shrinks pauses under large backlog', async () => {
            const rafQueue = [];
            const { StreamPacer, delayCalls } = createSseContext({
                speed: 95, // (100 - 95) * 0.4 = 2 ms per char (< 12 ms sub-frame threshold)
                focus: true,
                rafQueue,
            });
            const pacer = new StreamPacer();
            pacer.lastUnit = 'a';

            // First 7 chars accumulate 2 * 7 = 14 ms (< 16 ms slice) -> null wait!
            for (let i = 0; i < 7; i++) {
                expect(pacer.pause(true, 10)).toBeNull();
            }
            // 8th char reaches 16 ms -> schedules rAF slice instead of setTimeout!
            const waitPromise = pacer.pause(true, 10);
            expect(typeof waitPromise?.then).toBe('function');
            expect(rafQueue).toHaveLength(1);
            expect(delayCalls).toHaveLength(0);
            rafQueue.shift()();
            await waitPromise;

            // Adaptive catch-up: at speed 50 (20 ms/char), backlog = 480 (4x SMOOTH_CATCH_UP_UNITS = 120)
            // scales step down to 20 * (120 / 480) = 5 ms (< 12 ms, coalesced!).
            const slowCtx = createSseContext({ speed: 50, focus: true });
            const catchupPacer = new slowCtx.StreamPacer();
            catchupPacer.lastUnit = 'a';
            expect(catchupPacer.pause(true, 480)).toBeNull();
            expect(catchupPacer.owedMs).toBeCloseTo(5, 5);
        });

        test('waitForAnimationFrameOrDelay falls back to bounded timer if rAF stalls, re-checks focus mid-chunk, and skips Intl.Segmenter on no_think reasoning', async () => {
            // 1. Hung rAF (e.g., tab hidden right after queueing) must settle via bounded fallback timer and cancel rAF.
            const rafQueue = [];
            const cancelSpy = jest.fn();
            const timerCallbacks = [];
            const clearTimeoutSpy = jest.fn();
            const { waitForAnimationFrameOrDelay } = createSseContext({
                rafQueue,
                cancelAnimationFrameSpy: cancelSpy,
                setTimeoutImpl: (cb, ms) => {
                    timerCallbacks.push({ cb, ms });
                    return timerCallbacks.length;
                },
                clearTimeoutImpl: clearTimeoutSpy,
            });

            const pending = waitForAnimationFrameOrDelay(16);
            expect(rafQueue).toHaveLength(1);
            expect(timerCallbacks).toHaveLength(1);
            expect(timerCallbacks[0].ms).toBe(50);

            // Simulate rAF never firing: fallback timer resolves and cancels rAF.
            timerCallbacks[0].cb();
            await pending;
            expect(cancelSpy).toHaveBeenCalledWith(1);

            // 2. When no_think is true, Intl.Segmenter must never be invoked for reasoning chunks.
            const segmentSpy = jest.fn();
            const FakeIntl = {
                Segmenter: class {
                    segment(text) {
                        segmentSpy(text);
                        return Array.from(text, segment => ({ segment }));
                    }
                },
            };
            const noThinkCtx = createSseContext({
                speed: 50,
                noThink: true,
                focus: true,
                IntlImpl: FakeIntl,
            });
            const events = await runSmoothFrames(noThinkCtx.SmoothEventSourceStream, [
                { choices: [{ index: 0, delta: { reasoning_content: 'Thought '.repeat(1000), content: '' } }] },
                '[DONE]',
            ]);
            expect(events).toHaveLength(2);
            expect(segmentSpy).not.toHaveBeenCalled();

            // 3. Re-checking document.hasFocus() mid-chunk stops pacing immediately when tab loses focus.
            const blurCtx = createSseContext({ speed: 50, focus: true });
            blurCtx.context.delay = (ms) => {
                blurCtx.delayCalls.push(ms);
                // Tab loses focus right after the first character pause.
                blurCtx.setFocus(false);
                return Promise.resolve();
            };
            const blurEvents = await runSmoothFrames(blurCtx.SmoothEventSourceStream, [
                { choices: [{ index: 0, delta: { content: 'abcdef' } }] },
                '[DONE]',
            ]);
            expect(blurEvents).toHaveLength(7);
            // Only 1 delay occurred before focus was lost; remaining characters did not wait.
            expect(blurCtx.delayCalls).toHaveLength(1);
        });
    });

    describe('Differential parity: splitStreamingBlocks & incremental formatting vs full formatting', () => {
        function createFormattingHarness() {
            const cssParseSpy = jest.fn(cssText => parseCss(cssText));
            let externalMediaAllowed = false;
            const dom = createDomEnvironment();
            const DOMPurify = createDOMPurify(dom.window);

            const chatsContext = vm.createContext({
                css: { parse: cssParseSpy, stringify: stringifyCss },
                removeUnscopableCss,
                isExternalMediaAllowed: jest.fn(() => externalMediaAllowed),
                DOMPurify,
                HTMLUnknownElement: class {},
                HTMLMediaElement: class {},
                Element: dom.Element,
                NodeFilter: dom.NodeFilter,
                document: dom.document,
                window: dom.window,
                console: { warn: jest.fn() },
                getCurrentEntityId: () => 'char-1',
                accountStorage: { getItem: () => 'shown', setItem: () => {} },
                toastr: { warning: jest.fn(), clear: jest.fn() },
                t: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), ''),
            });
            chatsContext.globalThis = chatsContext;
            loadDeclarations(chatsContext, 'scripts/chats.js', [
                'STYLE_ENCODE_REGEX',
                'STYLE_DECODE_REGEX',
                'PSEUDO_SELECTOR_REGEX',
                'CLASS_SELECTOR_REGEX',
                'SANITIZED_STYLE_CACHE_LIMIT',
                'sanitizedStyleCache',
                'EXTERNAL_MEDIA_TAG_NAMES',
                'sanitizeSimpleSelector',
                'sanitizeSelector',
                'encodeStyleTags',
                'decodeStyleTags',
                'addDOMPurifyHooks',
            ]);
            const encodeStyleTags = vm.runInContext('encodeStyleTags', chatsContext);
            const decodeStyleTags = vm.runInContext('decodeStyleTags', chatsContext);
            const addDOMPurifyHooks = vm.runInContext('addDOMPurifyHooks', chatsContext);

            const converter = new showdown.Converter({
                tables: true,
                strikethrough: true,
                underline: true,
                literalMidWordUnderscores: true,
                simpleLineBreaks: true,
            });

            function fullFormat(rawText) {
                const oocBlocks = [];
                const withoutOoc = extractOocBlocksForDisplay(rawText, oocBlocks);
                let html = converter.makeHtml(withoutOoc);
                html = encodeStyleTags(html);
                html = sanitizeTestMessageHtml(html);
                html = decodeStyleTags(html, { prefix: '.mes_text ' });
                html = restoreOocBlocksForDisplay(html, oocBlocks);
                return html.trim();
            }

            return {
                fullFormat,
                encodeStyleTags,
                decodeStyleTags,
                addDOMPurifyHooks,
                DOMPurify,
                cssParseSpy,
                isExternalMediaAllowedSpy: chatsContext.isExternalMediaAllowed,
                setExternalMediaAllowed: (v) => { externalMediaAllowed = v; },
            };
        }

        test('guarantees 100% final parity and sanitizes every interim tail across fences, OOC, refs, <style>, and XSS', () => {
            const { splitStreamingBlocks, createIncrementalBlockFormatter } = loadStreamFadeInModule();
            const { fullFormat } = createFormattingHarness();
            const incremental = createIncrementalBlockFormatter(fullFormat);

            const corpora = [
                // 1. Multi-paragraph prose + fenced code blocks with internal blank lines
                [
                    'First paragraph with **bold** and *italic* prose.',
                    '',
                    '```js',
                    'function greet(name) {',
                    '',
                    '    return `Hello ${name}`;',
                    '}',
                    '```',
                    '',
                    '~~~python',
                    'def calc():',
                    '',
                    '    return 42',
                    '~~~',
                    '',
                    'Closing summary paragraph.',
                ].join('\n'),

                // 2. Balanced and nested multi-paragraph OOC blocks + XSS inside OOC
                [
                    'Visible opener before note.',
                    '',
                    '((Outer OOC paragraph one',
                    '',
                    '((nested <img src=x onerror=alert(1)> inner)) still in OOC))',
                    '',
                    'Character continues speaking normally.',
                ].join('\n'),

                // 3. Late Markdown reference-style link definitions
                [
                    'Read the [official guide][guide-link] before continuing.',
                    '',
                    'Another middle paragraph with plain text.',
                    '',
                    '[guide-link]: https://example.com/guide',
                ].join('\n'),

                // 4. Scoped <style> & uppercase <STYLE> blocks + hostile </style><script> breakout attempt
                [
                    '<style>.badge { color: #ff5500; } :is(.card, .pill) { padding: 4px; }</style>',
                    '',
                    '<div class="badge">\n\nMulti-line HTML card body\n\n</div>',
                    '',
                    '<STYLE>.banner { background: url(https://evil.example/track.png); border: 1px solid red; }</STYLE>',
                    '',
                    'Final paragraph.',
                ].join('\n'),

                // 5. Hostile XSS payloads across prefix and active streaming tail
                [
                    'Safe intro <script>alert("prefix-xss")</script> paragraph.',
                    '',
                    'Middle block with <img src="x" onerror="alert(2)"> and [trap](javascript:alert(3)).',
                    '',
                    'Tail block with <svg onload="evil()"><iframe src="https://evil.example"></iframe></svg> end.',
                ].join('\n'),
            ];

            const checkDomEnv = createDomEnvironment();
            const findLiveXssViolations = (htmlFragment) => {
                const violations = [];
                const probe = checkDomEnv.document.createElement('div');
                probe.innerHTML = htmlFragment;
                for (const badTag of probe.querySelectorAll('script, iframe')) {
                    violations.push(`tag:${badTag.localName}`);
                }
                const visit = (node) => {
                    for (const child of node.childNodes) {
                        if (child.nodeType === 1) {
                            for (const { name, value } of child.attributes) {
                                if (name.startsWith('on')) {
                                    violations.push(`attr:${name}`);
                                }
                                if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
                                    violations.push(`url:${name}=${value}`);
                                }
                            }
                            visit(child);
                        }
                    }
                };
                visit(probe);
                return violations;
            };

            for (const documentText of corpora) {
                incremental.reset();
                // Stream in 19-char chunks to hit mid-tag, mid-fence, mid-OOC, and mid-XSS boundaries
                for (let cursor = 1; cursor < documentText.length; cursor += 19) {
                    const slice = documentText.slice(0, cursor);
                    const split = splitStreamingBlocks(slice, { isFinal: false });
                    expect(split.prefix + split.tail).toBe(slice);

                    const interimHtml = incremental.format(slice, { isFinal: false });
                    expect(findLiveXssViolations(interimHtml)).toEqual([]);
                }

                const finalIncremental = incremental.format(documentText, { isFinal: true });
                const finalReference = fullFormat(documentText);
                expect(finalIncremental).toBe(finalReference);
            }
        });

        test('splitStreamingBlocks never splits inside open fences, HTML blocks, or OOC blocks', () => {
            const { splitStreamingBlocks } = loadStreamFadeInModule();

            const openFence = 'Intro paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;';
            const fenceSplit = splitStreamingBlocks(openFence);
            expect(fenceSplit.prefix).toBe('Intro paragraph.\n\n');
            expect(fenceSplit.tail).toBe('```ts\nconst a = 1;\n\nconst b = 2;');

            const openOoc = 'Intro paragraph.\n\n((Unfinished OOC line 1\n\nline 2 still inside OOC';
            const oocSplit = splitStreamingBlocks(openOoc);
            expect(oocSplit.prefix).toBe('Intro paragraph.\n\n');
            expect(oocSplit.tail).toBe('((Unfinished OOC line 1\n\nline 2 still inside OOC');

            const openHtml = 'Intro paragraph.\n\n<div class="box">\n\nUnclosed HTML block paragraph';
            const htmlSplit = splitStreamingBlocks(openHtml);
            expect(htmlSplit.prefix).toBe('Intro paragraph.\n\n');
            expect(htmlSplit.tail).toBe('<div class="box">\n\nUnclosed HTML block paragraph');

            const withRef = 'See [item][1].\n\nMiddle.\n\n[1]: https://example.com';
            const refSplit = splitStreamingBlocks(withRef);
            expect(refSplit.canReusePrefix).toBe(false);
            expect(refSplit.prefix).toBe('');
            expect(refSplit.tail).toBe(withRef);

            // CommonMark: a leading tab is an indented code block, never a code fence
            const tabCodeThenPara = '\t```js\n\tconst x = 1;\n\nAfter indented code paragraph.';
            const tabSplit = splitStreamingBlocks(tabCodeThenPara);
            expect(tabSplit.canReusePrefix).toBe(true);
            expect(tabSplit.prefix).toBe('\t```js\n\tconst x = 1;\n\n');
            expect(tabSplit.tail).toBe('After indented code paragraph.');

            // Adjacent 4-space indented code blocks coalesce into a single Markdown code block
            const indentedCode = 'Intro.\n\n    line1();\n\n    line2();\n\nOutro.';
            const indentedSplit = splitStreamingBlocks(indentedCode);
            expect(indentedSplit.canReusePrefix).toBe(true);
            expect(indentedSplit.prefixBlocks).toEqual([
                'Intro.\n\n',
                '    line1();\n\n    line2();\n\n',
            ]);
            expect(indentedSplit.tail).toBe('Outro.');
        });

        test('LRU-caches sanitized <style> blocks, encodes mixed-case <sTyLe>, and safely caches isExternalMediaAllowed against real DOMPurify across disallowed tags', () => {
            const {
                encodeStyleTags,
                decodeStyleTags,
                addDOMPurifyHooks,
                DOMPurify,
                cssParseSpy,
                isExternalMediaAllowedSpy,
                setExternalMediaAllowed,
            } = createFormattingHarness();

            expect(DOMPurify.isSupported).toBe(true);

            // Fast-path when no <style> / <custom-style> is present
            expect(encodeStyleTags('<p>Plain paragraph</p>')).toBe('<p>Plain paragraph</p>');
            expect(decodeStyleTags('<p>Plain paragraph</p>')).toBe('<p>Plain paragraph</p>');
            expect(cssParseSpy).not.toHaveBeenCalled();

            // Mixed-case <sTyLe> must not bypass encodeStyleTags fast-path
            const mixedEncoded = encodeStyleTags('<sTyLe>.hero { color: blue; }</sTyLe><p>Ok</p>');
            expect(mixedEncoded).toContain('<custom-style>');
            expect(decodeStyleTags(mixedEncoded, { prefix: '.mes_text ' })).toContain('.mes_text .custom-hero');
            cssParseSpy.mockClear();

            // Repeated streaming ticks with identical <style> block hit the LRU cache
            const encoded = encodeStyleTags('<style>.box { color: green; background: url(https://img.example/a.png); }</style><p>Body</p>');
            const first = decodeStyleTags(encoded, { prefix: '.mes_text ' });
            const second = decodeStyleTags(encoded, { prefix: '.mes_text ' });
            expect(second).toBe(first);
            expect(cssParseSpy).toHaveBeenCalledTimes(1);
            expect(first).not.toContain('https://img.example/a.png');

            // Toggling external media invalidates via cache key and preserves external URL
            setExternalMediaAllowed(true);
            const third = decodeStyleTags(encoded, { prefix: '.mes_text ' });
            expect(cssParseSpy).toHaveBeenCalledTimes(2);
            expect(third).toContain('https://img.example/a.png');

            // Verify real DOMPurify with addDOMPurifyHooks():
            addDOMPurifyHooks();
            const sharedConfig = { MESSAGE_SANITIZE: true, ADD_TAGS: ['custom-style'] };

            // 1. Prose-only message with 50 non-media elements must NOT call isExternalMediaAllowed() at all.
            isExternalMediaAllowedSpy.mockClear();
            const proseHtml = Array.from({ length: 50 }, (_, i) => `<p><span>Line ${i}</span></p>`).join('');
            DOMPurify.sanitize(proseHtml, sharedConfig);
            expect(isExternalMediaAllowedSpy).toHaveBeenCalledTimes(0);

            // 2. Message with disallowed tags (<script>, <status>) + multiple <img> while allowed=true:
            //    caches once per pass, strips disallowed tags, preserves <img>, and NEVER leaks stale state.
            setExternalMediaAllowed(true);
            isExternalMediaAllowedSpy.mockClear();
            const allowedPass = DOMPurify.sanitize(
                '<script>alert(1)</script><status>hp:10</status><img src="https://evil.example/1.png"><img src="https://evil.example/2.png">',
                sharedConfig,
            );
            expect(isExternalMediaAllowedSpy).toHaveBeenCalledTimes(1);
            expect(allowedPass).not.toContain('<script');
            expect(allowedPass).not.toContain('<status');
            expect(allowedPass).toContain('https://evil.example/1.png');
            expect(allowedPass).toContain('https://evil.example/2.png');

            // 3. Switching to untrusted character (externalMediaAllowed=false) even with the SAME config object
            //    must STILL block external <img> tags (regression guard against depth-counter latch bug!).
            setExternalMediaAllowed(false);
            isExternalMediaAllowedSpy.mockClear();
            const blockedPass = DOMPurify.sanitize(
                '<script>alert(2)</script><status>hp:5</status><img src="https://evil.example/tracker.png"><p>Safe</p>',
                sharedConfig,
            );
            expect(isExternalMediaAllowedSpy).toHaveBeenCalledTimes(1);
            expect(blockedPass).not.toContain('https://evil.example/tracker.png');
            expect(blockedPass).toContain('<p>Safe</p>');

            // 4. Switching back to allowed=true after a blocked pass with disallowed tags must re-allow external media.
            setExternalMediaAllowed(true);
            isExternalMediaAllowedSpy.mockClear();
            const reAllowedPass = DOMPurify.sanitize(
                '<img src="https://good.example/art.png">',
                sharedConfig,
            );
            expect(isExternalMediaAllowedSpy).toHaveBeenCalledTimes(1);
            expect(reAllowedPass).toContain('https://good.example/art.png');
        });
    });

    describe('Tail-only applyStreamFadeIn & < 60 live .text_segment span budget', () => {
        test('keeps prefix blocks unsegmented, bounds live spans < 60, and collapses settled spans', async () => {
            const { applyStreamFadeIn, applyStreamDomPatch, dom } = loadStreamFadeInModule();
            const prevHTMLElement = globalThis.HTMLElement;
            const prevDocument = globalThis.document;
            globalThis.HTMLElement = dom.HTMLElement;
            globalThis.document = dom.document;
            try {
                const container = dom.document.createElement('div');
                dom.document.body.appendChild(container);

                applyStreamFadeIn(container, '<p>First <em>complete</em> block.</p><p>Starting tail</p>');
                const firstBlock = container.children[0];
                const emphasis = firstBlock.querySelector('em');

                // Prefix block was never segmented into .text_segment spans; only tail block was!
                expect(firstBlock.querySelectorAll('span.text_segment')).toHaveLength(0);
                expect(container.children[1].querySelectorAll('span.text_segment').length).toBeGreaterThan(0);

                // Stream 15 paragraphs + a 250-word tail paragraph: live .text_segment spans stay < 60!
                const prefixHtml = Array.from({ length: 15 }, (_, idx) => `<p>Paragraph ${idx} settled prose words here.</p>`).join('');
                const longTailWords = Array.from({ length: 250 }, (_, idx) => `word${idx}`).join(' ');
                applyStreamFadeIn(container, `<p>First <em>complete</em> block.</p>${prefixHtml}<p>${longTailWords}</p>`);

                expect(container.children[0]).toBe(firstBlock);
                expect(container.children[0].querySelector('em')).toBe(emphasis);
                const liveSpanCount = container.querySelectorAll('span.text_segment').length;
                expect(liveSpanCount).toBeGreaterThan(0);
                expect(liveSpanCount).toBeLessThan(60);

                // Final render collapses all remaining .text_segment spans and matches applyStreamDomPatch
                const finalHtml = `<p>First <em>complete</em> block.</p>${prefixHtml}<p>${longTailWords}</p>`;
                applyStreamFadeIn(container, finalHtml, { isFinal: true });
                expect(container.querySelectorAll('span.text_segment')).toHaveLength(0);

                const referenceContainer = dom.document.createElement('div');
                applyStreamDomPatch(referenceContainer, finalHtml);
                expect(container.outerHTML).toBe(referenceContainer.outerHTML);
            } finally {
                if (prevHTMLElement === undefined) delete globalThis.HTMLElement;
                else globalThis.HTMLElement = prevHTMLElement;
                if (prevDocument === undefined) delete globalThis.document;
                else globalThis.document = prevDocument;
            }
        });

        test('keeps live .text_segment spans <= 48 across continuous 50 ms multi-paragraph streaming without settle-timer starvation', () => {
            const { applyStreamFadeIn, dom } = loadStreamFadeInModule();
            const prevHTMLElement = globalThis.HTMLElement;
            const prevDocument = globalThis.document;
            globalThis.HTMLElement = dom.HTMLElement;
            globalThis.document = dom.document;
            jest.useFakeTimers();
            try {
                const container = dom.document.createElement('div');
                dom.document.body.appendChild(container);

                const paragraphs = [];
                let maxObservedSpans = 0;

                // Stream 20 paragraphs, advancing 50 ms on every tick (< 320 ms SETTLE_FADE_MS).
                // Each paragraph starts with 10 words and grows to 20 words across two 50 ms ticks.
                for (let p = 0; p < 20; p++) {
                    const firstHalf = Array.from({ length: 10 }, (_, w) => `p${p}w${w}`).join(' ');
                    const secondHalf = Array.from({ length: 10 }, (_, w) => `p${p}w${w + 10}`).join(' ');

                    paragraphs.push(`<p>${firstHalf}</p>`);
                    applyStreamFadeIn(container, paragraphs.join(''));
                    maxObservedSpans = Math.max(maxObservedSpans, container.querySelectorAll('span.text_segment').length);
                    expect(container.querySelectorAll('span.text_segment').length).toBeLessThanOrEqual(48);

                    jest.advanceTimersByTime(50);

                    paragraphs[p] = `<p>${firstHalf} ${secondHalf}</p>`;
                    applyStreamFadeIn(container, paragraphs.join(''));
                    maxObservedSpans = Math.max(maxObservedSpans, container.querySelectorAll('span.text_segment').length);
                    expect(container.querySelectorAll('span.text_segment').length).toBeLessThanOrEqual(48);

                    jest.advanceTimersByTime(50);
                }

                expect(maxObservedSpans).toBeGreaterThan(0);
                expect(maxObservedSpans).toBeLessThanOrEqual(48);
                // Early paragraphs must already have collapsed despite continuous 50 ms tail ticks.
                expect(container.children[0].querySelectorAll('span.text_segment')).toHaveLength(0);
                expect(container.children[5].querySelectorAll('span.text_segment')).toHaveLength(0);

                // Final render collapses all remaining tail spans to 0.
                applyStreamFadeIn(container, paragraphs.join(''), { isFinal: true });
                expect(container.querySelectorAll('span.text_segment')).toHaveLength(0);
            } finally {
                jest.useRealTimers();
                if (prevHTMLElement === undefined) delete globalThis.HTMLElement;
                else globalThis.HTMLElement = prevHTMLElement;
                if (prevDocument === undefined) delete globalThis.document;
                else globalThis.document = prevDocument;
            }
        });
    });

    describe('Universal zero-work closed <details> reasoning & lazy toggle render', () => {
        function createReasoningHarness({ detailsOpen = false, platform = 'Win32', streamFadeIn = true } = {}) {
            const dom = createDomEnvironment();
            const chatRoot = dom.document.createElement('div');
            chatRoot.id = 'chat';
            dom.document.body.appendChild(chatRoot);

            const mes = dom.document.createElement('div');
            mes.className = 'mes';
            mes.setAttribute('mesid', '0');
            mes.innerHTML = [
                '<details class="mes_reasoning_details">',
                '<summary><span class="mes_reasoning_header_title"></span></summary>',
                '<div class="mes_reasoning"></div>',
                '</details>',
                '<div class="mes_edit_add_reasoning"></div>',
            ].join('');
            chatRoot.appendChild(mes);

            const details = mes.querySelector('.mes_reasoning_details');
            details.open = detailsOpen;

            const messageFormattingSpy = jest.fn(text => `<p>${text}</p>`);
            const applyStreamFadeInSpy = jest.fn((el, html) => { el.innerHTML = html; });
            const applyStreamDomPatchSpy = jest.fn((el, html) => { el.innerHTML = html; });

            const context = vm.createContext({
                ...dom,
                Date,
                Number,
                String,
                Boolean,
                navigator: { platform, userAgent: platform, maxTouchPoints: 0 },
                chat: [{ mes: '', extra: {}, gen_started: new Date().toISOString() }],
                main_api: 'openai',
                power_user: {
                    reasoning: { auto_expand: false, auto_parse: false },
                    stream_fade_in: streamFadeIn,
                    ios_webkit_conservative_streaming: true,
                    android_conservative_streaming: true,
                    ios_webkit_disable_stream_fade_in: false,
                    android_disable_stream_fade_in: true,
                },
                getChatCompletionModel: () => 'deepseek-reasoner',
                getReasoningParseTemplates: () => [],
                getRegexedString: str => str,
                regex_placement: { REASONING: 6 },
                trimSpaces: str => String(str ?? '').trim(),
                setDatasetProperty: (el, prop, val) => {
                    if (val === null || val === undefined) delete el.dataset[prop];
                    else el.dataset[prop] = val;
                },
                shouldReduceStreamingDomWork,
                shouldRenderLiveReasoningContent,
                getStreamingReasoningRenderInterval: () => 1500,
                messageFormatting: messageFormattingSpy,
                applyStreamFadeIn: applyStreamFadeInSpy,
                applyStreamDomPatch: applyStreamDomPatchSpy,
                eventSource: { emit: jest.fn(async () => {}) },
                event_types: { STREAM_REASONING_DONE: 'stream_reasoning_done' },
                moment: {
                    duration: ms => ({
                        asSeconds: () => Math.round((ms / 1000) * 10) / 10,
                        locale: () => ({ humanize: () => '2 seconds' }),
                    }),
                },
                getCurrentLocale: () => 'en-us',
                t: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), ''),
                translate: s => s,
            });
            context.globalThis = context;

            loadDeclarations(context, 'scripts/reasoning.js', [
                'ReasoningType',
                'isHiddenReasoningModel',
                'ReasoningState',
                'ReasoningHandler',
            ]);
            const ReasoningHandler = vm.runInContext('ReasoningHandler', context);
            const ReasoningState = vm.runInContext('ReasoningState', context);

            return {
                handler: new ReasoningHandler(new Date(Date.now() - 2000)),
                ReasoningHandler,
                ReasoningState,
                details,
                reasoningContent: mes.querySelector('.mes_reasoning'),
                headerTitle: mes.querySelector('.mes_reasoning_header_title'),
                messageFormattingSpy,
                applyStreamFadeInSpy,
                applyStreamDomPatchSpy,
            };
        }

        test('does zero formatting/DOM work on Desktop while <details> is closed, and lazily renders on toggle open', () => {
            const {
                handler,
                ReasoningState,
                details,
                reasoningContent,
                headerTitle,
                messageFormattingSpy,
                applyStreamFadeInSpy,
                applyStreamDomPatchSpy,
            } = createReasoningHarness({ detailsOpen: false, platform: 'Win32' });

            handler.state = ReasoningState.Thinking;
            handler.startTime = handler.initialTime;

            // Simulate 25 live streaming reasoning ticks on Desktop while <details> is closed
            for (let tick = 1; tick <= 25; tick++) {
                handler.reasoning = `Step ${tick}: analyzing constraints and edge cases.`;
                handler.updateDom(0);
            }

            expect(messageFormattingSpy).not.toHaveBeenCalled();
            expect(applyStreamFadeInSpy).not.toHaveBeenCalled();
            expect(applyStreamDomPatchSpy).not.toHaveBeenCalled();
            expect(reasoningContent.innerHTML).toBe('');
            expect(headerTitle.textContent).toBe('Thinking...');
            expect(details.getAttribute('data-has-content')).toBe('true');
            expect(details.getAttribute('data-reasoning-pending-render')).toBe('true');

            // User clicks <details> open mid-stream -> immediate lazy render of latest reasoning!
            details.open = true;
            details.dispatchEvent({ type: 'toggle' });

            expect(messageFormattingSpy).toHaveBeenCalledTimes(1);
            expect(messageFormattingSpy).toHaveBeenLastCalledWith(
                'Step 25: analyzing constraints and edge cases.',
                '',
                false,
                false,
                0,
                {},
                true,
            );
            expect(applyStreamFadeInSpy).toHaveBeenCalledTimes(1);
            expect(reasoningContent.innerHTML).toBe('<p>Step 25: analyzing constraints and edge cases.</p>');
            expect(details.getAttribute('data-reasoning-pending-render')).toBeNull();
        });

        test('renders closed reasoning once on finish() so completed collapsed blocks hold final text', async () => {
            const {
                handler,
                ReasoningState,
                details,
                reasoningContent,
                headerTitle,
                messageFormattingSpy,
            } = createReasoningHarness({ detailsOpen: false, platform: 'Win32', streamFadeIn: false });

            handler.state = ReasoningState.Thinking;
            handler.startTime = handler.initialTime;
            handler.reasoning = 'Silent thought 1';
            handler.updateDom(0);
            handler.reasoning = 'Silent thought 2 final';
            handler.updateDom(0);

            expect(messageFormattingSpy).not.toHaveBeenCalled();

            await handler.finish(0);

            expect(details.open).toBe(false);
            expect(messageFormattingSpy).toHaveBeenCalledTimes(1);
            expect(reasoningContent.innerHTML).toBe('<p>Silent thought 2 final</p>');
            expect(headerTitle.textContent).toBe('Thought for 2 seconds');
            expect(details.getAttribute('data-reasoning-pending-render')).toBeNull();
        });

        test('attaches toggle listener only while pending, detaches on expand/finish, and prevents stale aborted handlers from overwriting after swipe/regenerate', async () => {
            const {
                handler: handler1,
                ReasoningHandler,
                ReasoningState,
                details,
                reasoningContent,
                messageFormattingSpy,
                applyStreamFadeInSpy,
            } = createReasoningHarness({ detailsOpen: false, platform: 'Win32', streamFadeIn: true });

            // 1. Non-thinking render (e.g., updateReasoningUI on Done message) must attach 0 toggle listeners.
            const nonStreamingHandler = new ReasoningHandler(new Date(Date.now() - 1000));
            nonStreamingHandler.state = ReasoningState.Done;
            nonStreamingHandler.reasoning = 'Historical reasoning';
            nonStreamingHandler.updateDom(0);
            expect(details._listeners.get('toggle')?.size ?? 0).toBe(0);
            expect(applyStreamFadeInSpy).toHaveBeenLastCalledWith(
                reasoningContent,
                '<p>Historical reasoning</p>',
                expect.objectContaining({ isFinal: true }),
            );

            // 2. Handler #1 streams closed thinking (pending render -> 1 listener attached) and then errors/aborts without finish().
            messageFormattingSpy.mockClear();
            applyStreamFadeInSpy.mockClear();
            reasoningContent.innerHTML = '';
            handler1.state = ReasoningState.Thinking;
            handler1.startTime = handler1.initialTime;
            handler1.reasoning = 'Stale aborted thought from generation 1';
            handler1.updateDom(0);
            expect(details._listeners.get('toggle')?.size ?? 0).toBe(1);
            expect(messageFormattingSpy).not.toHaveBeenCalled();

            // 3. Swipe/regenerate creates Handler #2 on the SAME <details> element -> supersedes Handler #1's listener.
            const handler2 = new ReasoningHandler(new Date(Date.now() - 500));
            handler2.state = ReasoningState.Thinking;
            handler2.startTime = handler2.initialTime;
            handler2.reasoning = 'Fresh thought from generation 2';
            handler2.updateDom(0);
            expect(details._listeners.get('toggle')?.size ?? 0).toBe(1);

            // Expanding <details> must render ONLY Handler #2's reasoning and detach the toggle listener.
            details.open = true;
            details.dispatchEvent({ type: 'toggle' });
            expect(messageFormattingSpy).toHaveBeenCalledTimes(1);
            expect(reasoningContent.innerHTML).toBe('<p>Fresh thought from generation 2</p>');
            expect(details._listeners.get('toggle')?.size ?? 0).toBe(0);

            // Finishing closed reasoning passes isFinal: true and leaves 0 toggle listeners attached.
            details.open = false;
            handler2.reasoning = 'Final thought from generation 2';
            handler2.updateDom(0);
            expect(details._listeners.get('toggle')?.size ?? 0).toBe(1);
            await handler2.finish(0);
            expect(details._listeners.get('toggle')?.size ?? 0).toBe(0);
            expect(applyStreamFadeInSpy).toHaveBeenLastCalledWith(
                reasoningContent,
                '<p>Final thought from generation 2</p>',
                expect.objectContaining({ isFinal: true }),
            );
        });

        test('wires createIncrementalBlockFormatter, applyStreamFadeIn({ isFinal }), and iOS WebKit adaptive plain-text preview live in public/script.js', async () => {
            const { applyStreamDomPatch, applyStreamFadeIn, createIncrementalBlockFormatter, dom } = loadStreamFadeInModule();
            const { source: scriptSource } = readClientModule('script.js');
            const classStart = scriptSource.indexOf('class StreamingProcessor {');
            const classEnd = scriptSource.indexOf('\n/**', scriptSource.indexOf('\n}\n', classStart));
            const classSource = scriptSource.slice(classStart, classEnd);
            const applyWriteSource = scriptSource.match(/^function applyStreamingVisibleWrite\([\s\S]*?^}$/m)[0];

            const mes = dom.document.createElement('div');
            mes.className = 'mes';
            mes.setAttribute('mesid', '0');
            const mesText = dom.document.createElement('div');
            mesText.className = 'mes_text';
            mes.appendChild(mesText);
            const chatEl = dom.document.createElement('div');
            chatEl.id = 'chat';
            chatEl.appendChild(mes);
            dom.document.body.appendChild(chatEl);

            const messageFormattingSpy = jest.fn(text => `<p>${text.trim()}</p>`);
            const applyStreamFadeInSpy = jest.fn((el, html, opts) => applyStreamFadeIn(el, html, opts));
            const formatMobileStreamingPreviewSpy = jest.fn(text => `<p class="plain-preview">${text}</p>`);
            let navRef = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', maxTouchPoints: 0 };

            const prevHTMLElement = globalThis.HTMLElement;
            const prevDocument = globalThis.document;
            globalThis.HTMLElement = dom.HTMLElement;
            globalThis.document = dom.document;
            try {
                const ctx = vm.createContext({
                    console,
                    AbortController,
                    structuredClone,
                    performance,
                    document: dom.document,
                    HTMLElement: dom.HTMLElement,
                    get navigator() { return navRef; },
                    chat: [{ mes: '', name: 'Char', is_system: false, is_user: false, extra: {}, swipe_id: 0, swipes: [''], swipe_info: [{}] }],
                    chatGeneration: 1,
                    activeGenerationRun: {},
                    streamingProcessor: null,
                    getCurrentChatId: () => 'chat-1',
                    power_user: {
                        streaming_fps: 30,
                        stream_fade_in: true,
                        ios_webkit_reduce_streaming_work: false,
                        android_reduce_streaming_work: false,
                        ios_webkit_disable_stream_fade_in: false,
                        android_disable_stream_fade_in: false,
                        android_streaming_basic_markdown: false,
                    },
                    main_api: 'openai',
                    scrollLock: false,
                    scrollLockImmunityUntil: 0,
                    IN_CHAT_AGENT_TRANSFORM_HISTORY_KEY: 'history',
                    IN_CHAT_AGENT_PRE_GENERATION_INTERCEPT_HISTORY_KEY: 'intercept',
                    GENERATION_PLACEHOLDER_KEY: 'server_generation_placeholder',
                    ReasoningHandler: class {
                        reasoning = '';
                        process = async () => {};
                        updateDom() {}
                        updateReasoning() {}
                        hasReasoningContent() { return false; }
                        getDuration() { return 0; }
                    },
                    event_types: { STREAM_TOKEN_RECEIVED: 'token' },
                    eventSource: { emit: jest.fn(async () => {}) },
                    delay: async () => {},
                    Stopwatch: class { async tick(cb) { await cb(); } },
                    getStoppingStrings: () => [],
                    getStreamingUpdateInterval,
                    cleanUpMessage: ({ getMessage }) => getMessage,
                    shouldReduceStreamingDomWork,
                    shouldUsePlainTextStreamingPreview,
                    shouldGuardMobileChatScroll: () => false,
                    shouldPinMobileChatToBottom: () => false,
                    isMobileChatManualScrollSuppressionActive: () => false,
                    isAndroidStreamingPlatform: () => false,
                    isIOSWebKitPlatform: nav => Boolean(nav && /iPhone|iPad/i.test(`${nav.platform} ${nav.userAgent}`)),
                    prepareMessageDisplayText: text => ({ mes: text, isSystem: false }),
                    formatMobileStreamingPreview: formatMobileStreamingPreviewSpy,
                    converter: null,
                    sanitizeMessageHtml: html => html,
                    getPositiveTokenCount: value => Number(value) || 0,
                    updateMessageTokenAccounting: async () => ({ outputTokens: 1, reasoningTokens: 0 }),
                    balanceStreamingMarkdown: value => value,
                    messageFormatting: messageFormattingSpy,
                    applyStreamDomPatch,
                    applyStreamFadeIn: applyStreamFadeInSpy,
                    createIncrementalBlockFormatter,
                    formatGenerationTimer: () => ({ timerValue: '0s', timerTitle: '' }),
                    updateMessageMetaBadges: () => {},
                    scrollChatToBottom: () => {},
                    CHAT_RENDER_LIFECYCLE_ROUTE: { STREAM_PROGRESS: 'stream' },
                    isChatRenderLifecycleRolloutEnabled: () => false,
                });
                ctx.globalThis = ctx;

                vm.runInContext(`${classSource}\n${applyWriteSource}\nthis.StreamingProcessor = StreamingProcessor;`, ctx);
                const processor = new ctx.StreamingProcessor('normal', false, new Date(), '', { prefixReasoning: '', removePrefix: text => text });
                ctx.streamingProcessor = processor;
                processor.messageId = 0;
                processor.message = ctx.chat[0];
                processor.swipeId = 0;

                // 1. Multi-paragraph streaming reuses cached prefix block via createIncrementalBlockFormatter.
                await processor.onProgressStreaming(0, 'First settled paragraph.\n\nSecond active tick 1', false);
                const callsAfterTick1 = messageFormattingSpy.mock.calls.map(c => c[0]);
                expect(callsAfterTick1).toEqual(['First settled paragraph.\n\n', 'Second active tick 1']);

                messageFormattingSpy.mockClear();
                await processor.onProgressStreaming(0, 'First settled paragraph.\n\nSecond active tick 2', false);
                // Settled prefix was served from cache; only the active tail was formatted!
                expect(messageFormattingSpy.mock.calls.map(c => c[0])).toEqual(['Second active tick 2']);

                // 2. Final render runs full-document messageFormatting and passes isFinal: true to applyStreamFadeIn.
                messageFormattingSpy.mockClear();
                await processor.onProgressStreaming(0, 'First settled paragraph.\n\nSecond active final', true);
                expect(messageFormattingSpy.mock.calls.map(c => c[0])).toEqual(['First settled paragraph.\n\nSecond active final']);
                expect(applyStreamFadeInSpy).toHaveBeenLastCalledWith(
                    mesText,
                    expect.any(String),
                    expect.objectContaining({ isFinal: true }),
                );
                expect(mesText.querySelectorAll('span.text_segment')).toHaveLength(0);

                // 3. On iOS WebKit with slow renderDurationMs (> 33 ms), plain-text preview fallback activates live,
                //    and final render still uses full messageFormatting.
                navRef = { platform: 'iPhone', userAgent: 'iPhone AppleWebKit/605.1.15', maxTouchPoints: 5 };
                processor.streamingRenderDurationMs = 50;
                messageFormattingSpy.mockClear();
                formatMobileStreamingPreviewSpy.mockClear();
                await processor.onProgressStreaming(0, 'Slow iOS frame prose', false);
                expect(formatMobileStreamingPreviewSpy).toHaveBeenCalledTimes(1);
                expect(messageFormattingSpy).not.toHaveBeenCalled();

                await processor.onProgressStreaming(0, 'Slow iOS frame final', true);
                expect(messageFormattingSpy).toHaveBeenCalledTimes(1);
            } finally {
                if (prevHTMLElement === undefined) delete globalThis.HTMLElement;
                else globalThis.HTMLElement = prevHTMLElement;
                if (prevDocument === undefined) delete globalThis.document;
                else globalThis.document = prevDocument;
            }
        });

        test('extends adaptive frame-budget backoff and plain-text fallback to iOS WebKit', () => {
            const iosNav = { platform: 'iPhone', maxTouchPoints: 5 };
            expect(shouldReduceStreamingDomWork(iosNav, { iosEnabled: false, renderDurationMs: 10 })).toBe(false);
            expect(shouldReduceStreamingDomWork(iosNav, { iosEnabled: false, renderDurationMs: 50 })).toBe(true);

            expect(shouldUsePlainTextStreamingPreview({
                isFinal: false,
                isReducedDomWork: true,
                isAndroidPlatform: false,
                isIOSWebKit: true,
                renderDurationMs: 50,
            })).toBe(true);

            expect(getStreamingUpdateInterval(33, {
                navigatorRef: iosNav,
                iosEnabled: false,
                renderDurationMs: 140,
            })).toBe(Math.min(IOS_MAX_ADAPTIVE_INTERVAL_MS, 140 * 3));

            // Dead \u0000 newline round-trip removed while keeping code block newlines intact
            const codePreview = formatBasicMarkdownStreamingPreview('```\nline1\nline2\n```', {
                converter: { makeHtml: s => `<pre><code>${s}</code></pre>` },
                sanitizeHtml: s => s,
            });
            expect(codePreview).toContain('line1\nline2');
        });
    });

    describe('StreamingDisplay rAF + >= 66 ms coalescing', () => {
        test('coalesces rapid updateReasoning/updateContent chunks and flushes synchronously on complete()', () => {
            const dom = createDomEnvironment();
            const rafCallbacks = [];
            const timers = [];
            let nowMs = 1000;
            const formatSpy = jest.fn(text => `<p>${text}</p>`);

            const context = vm.createContext({
                ...dom,
                Array,
                Date: { now: () => nowMs },
                HTMLImageElement: class {},
                SVGInject: async () => {},
                t: strings => strings.join(''),
                animation_duration: 0,
                messageFormatting: formatSpy,
                requestAnimationFrame: (cb) => { rafCallbacks.push(cb); return rafCallbacks.length; },
                cancelAnimationFrame: () => { rafCallbacks.length = 0; },
                setTimeout: (cb, ms) => {
                    const entry = { cb, ms, cleared: false };
                    timers.push(entry);
                    return entry;
                },
                clearTimeout: (entry) => { if (entry) entry.cleared = true; },
                console,
            });
            loadDeclarations(context, 'scripts/streaming-display.js', [
                'CSS_PREFIX',
                'STREAMING_DISPLAY_MIN_INTERVAL_MS',
                'StreamingDisplay',
            ]);
            const StreamingDisplay = vm.runInContext('StreamingDisplay', context);

            const display = new StreamingDisplay().show({ label: 'Generating...' });
            // Trigger entrance rAF
            rafCallbacks.shift()?.();

            // 20 rapid token chunks within the same frame -> ZERO synchronous formatting calls!
            for (let i = 1; i <= 20; i++) {
                display.updateReasoning(`Think ${i}`).updateContent(`Answer ${i}`);
            }
            expect(formatSpy).not.toHaveBeenCalled();
            expect(rafCallbacks).toHaveLength(1);

            // Flush single coalesced rAF -> formats ONLY latest reasoning + latest content once each!
            rafCallbacks.shift()();
            expect(formatSpy).toHaveBeenCalledTimes(2);
            expect(formatSpy).toHaveBeenNthCalledWith(1, 'Think 20', '', false, false, -1, {}, true);
            expect(formatSpy).toHaveBeenNthCalledWith(2, 'Answer 20', '', false, false, -1, {}, false);

            // Next update 10 ms later (< 66 ms floor) waits on >= 56 ms timer before scheduling rAF
            nowMs = 1010;
            display.updateContent('Answer 21');
            expect(rafCallbacks).toHaveLength(0);
            expect(timers.filter(t => !t.cleared && t.ms >= 56)).toHaveLength(1);

            // Calling complete() flushes pending content immediately without waiting for timer
            display.complete({ label: 'Done', delay: null });
            expect(formatSpy).toHaveBeenCalledTimes(3);
            expect(formatSpy).toHaveBeenLastCalledWith('Answer 21', '', false, false, -1, {}, false);
        });
    });
});

/**
 * Lightweight Node-side DOM + MutationObserver harness so browser observer modules can be tested
 * directly without requiring jsdom or booting public/script.js.
 */
function createMiniDom() {
    const observers = [];

    class MiniNode {
        constructor(nodeType) {
            this.nodeType = nodeType;
            this.parentElement = null;
            this.parentNode = null;
            this.childNodes = [];
            this._isConnected = false;
        }

        get isConnected() {
            return this._isConnected;
        }

        remove() {
            if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
                this.parentNode.removeChild(this);
            }
        }
    }

    class MiniText extends MiniNode {
        constructor(text) {
            super(3);
            this.textContent = String(text);
        }
    }

    function matchesSimplePart(el, part) {
        let rest = part.trim();
        if (!rest) return false;

        // Strip simple :not(...) negation clauses used by keyboard.js / a11y.js selectors.
        const notClauses = [];
        rest = rest.replace(/:not\(([^()]+)\)/g, (_, inner) => {
            notClauses.push(inner);
            return '';
        });
        for (const clause of notClauses) {
            if (matchesSelectorList(el, clause)) return false;
        }

        // Attribute selectors like [data-i18n], [mesid], [aria-expanded], [title]
        const attrMatches = [...rest.matchAll(/\[([^\]=~|^$*]+)(?:="([^"]*)")?\]/g)];
        rest = rest.replace(/\[[^\]]+\]/g, '');
        for (const [, attrName, attrVal] of attrMatches) {
            if (!el.hasAttribute(attrName)) return false;
            if (attrVal !== undefined && el.getAttribute(attrName) !== attrVal) return false;
        }

        const tokens = rest.match(/^[a-zA-Z0-9_-]+|[#.][a-zA-Z0-9_-]+/g) || [];
        if (tokens.length === 0 && attrMatches.length === 0 && notClauses.length === 0) return false;
        for (const token of tokens) {
            if (token.startsWith('#')) {
                if (el.id !== token.slice(1)) return false;
            } else if (token.startsWith('.')) {
                if (!el.classList.contains(token.slice(1))) return false;
            } else {
                if (el.localName !== token.toLowerCase()) return false;
            }
        }
        return true;
    }

    function matchesComplexSelector(el, selector) {
        // Handle :is(...) by expanding simple comma lists inside :is(...)
        if (selector.includes(':is(')) {
            return false;
        }
        if (selector.includes('+')) return false;
        const rawTokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
        let current = el;
        let idx = rawTokens.length - 1;
        while (idx >= 0) {
            const token = rawTokens[idx];
            if (token === '>') {
                idx--;
                const parentSel = rawTokens[idx];
                if (!current.parentElement || !matchesSimplePart(current.parentElement, parentSel)) {
                    return false;
                }
                current = current.parentElement;
                idx--;
            } else if (idx === rawTokens.length - 1) {
                if (!matchesSimplePart(current, token)) return false;
                idx--;
            } else {
                let ancestor = current.parentElement;
                let matched = null;
                while (ancestor) {
                    if (matchesSimplePart(ancestor, token)) {
                        matched = ancestor;
                        break;
                    }
                    ancestor = ancestor.parentElement;
                }
                if (!matched) return false;
                current = matched;
                idx--;
            }
        }
        return true;
    }

    function splitTopLevelCommas(selector) {
        const parts = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < selector.length; i++) {
            const ch = selector[i];
            if (ch === '(' || ch === '[') depth++;
            else if (ch === ')' || ch === ']') depth--;
            else if (ch === ',' && depth === 0) {
                parts.push(selector.slice(start, i).trim());
                start = i + 1;
            }
        }
        parts.push(selector.slice(start).trim());
        return parts.filter(Boolean);
    }

    function matchesSelectorList(el, selector) {
        if (!selector || typeof selector !== 'string') return false;
        const parts = splitTopLevelCommas(selector);
        return parts.some(part => matchesComplexSelector(el, part));
    }

    class MiniClassList {
        constructor(el) {
            this._el = el;
            this._set = new Set();
        }

        _syncAttr() {
            const val = [...this._set].join(' ');
            if (val) this._el._attrs.set('class', val);
            else this._el._attrs.delete('class');
            notifyObservers({ type: 'attributes', target: this._el, attributeName: 'class', addedNodes: [], removedNodes: [] });
        }

        add(...names) {
            for (const n of names) {
                if (n) this._set.add(n);
            }
            this._syncAttr();
        }

        remove(...names) {
            for (const n of names) this._set.delete(n);
            this._syncAttr();
        }

        toggle(name, force) {
            const has = this._set.has(name);
            const next = force === undefined ? !has : Boolean(force);
            if (next) this._set.add(name);
            else this._set.delete(name);
            this._syncAttr();
            return next;
        }

        contains(name) {
            return this._set.has(name);
        }

        [Symbol.iterator]() {
            return this._set[Symbol.iterator]();
        }
    }

    class MiniElement extends MiniNode {
        constructor(tagName) {
            super(1);
            this.localName = tagName.toLowerCase();
            this.tagName = tagName.toUpperCase();
            this._attrs = new Map();
            this.classList = new MiniClassList(this);
            this.dataset = {};
            this.listeners = new Map();
            this.hidden = false;
            this._textContent = '';
            this.querySelectorAllCalls = 0;
            this.getElementsByTagNameCalls = 0;
        }

        get id() {
            return this._attrs.get('id') || '';
        }

        set id(value) {
            if (value) this._attrs.set('id', String(value));
            else this._attrs.delete('id');
        }

        get className() {
            return this._attrs.get('class') || '';
        }

        set className(value) {
            this.classList._set = new Set(String(value || '').split(/\s+/).filter(Boolean));
            this.classList._syncAttr();
        }

        get title() {
            return this._attrs.get('title') || '';
        }

        set title(value) {
            this.setAttribute('title', String(value));
        }

        get textContent() {
            if (this.childNodes.length === 0) return this._textContent;
            return this.childNodes.map(c => c.textContent).join('');
        }

        set textContent(value) {
            this.childNodes = [];
            this._textContent = String(value ?? '');
        }

        get children() {
            return this.childNodes.filter(n => n instanceof MiniElement);
        }

        get childElementCount() {
            return this.children.length;
        }

        get firstElementChild() {
            return this.children[0] ?? null;
        }

        get firstChild() {
            return this.childNodes[0] ?? null;
        }

        hasAttribute(name) {
            return this._attrs.has(name);
        }

        getAttribute(name) {
            return this._attrs.has(name) ? this._attrs.get(name) : null;
        }

        setAttribute(name, value) {
            this._attrs.set(name, String(value));
            if (name === 'class') {
                this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
            }
            notifyObservers({ type: 'attributes', target: this, attributeName: name, addedNodes: [], removedNodes: [] });
        }

        removeAttribute(name) {
            this._attrs.delete(name);
            if (name === 'class') this.classList._set.clear();
            notifyObservers({ type: 'attributes', target: this, attributeName: name, addedNodes: [], removedNodes: [] });
        }

        _markConnected(connected) {
            this._isConnected = connected;
            for (const child of this.childNodes) {
                if (child instanceof MiniElement) child._markConnected(connected);
                else child._isConnected = connected;
            }
        }

        appendChild(node) {
            if (node.parentElement) {
                const idx = node.parentElement.childNodes.indexOf(node);
                if (idx !== -1) node.parentElement.childNodes.splice(idx, 1);
            }
            node.parentElement = this;
            node.parentNode = this;
            this.childNodes.push(node);
            if (node instanceof MiniElement) node._markConnected(this._isConnected);
            else node._isConnected = this._isConnected;
            notifyObservers({ type: 'childList', target: this, addedNodes: [node], removedNodes: [], attributeName: null });
            return node;
        }

        removeChild(node) {
            const idx = this.childNodes.indexOf(node);
            if (idx !== -1) {
                this.childNodes.splice(idx, 1);
                node.parentElement = null;
                node.parentNode = null;
                if (node instanceof MiniElement) node._markConnected(false);
                else node._isConnected = false;
                notifyObservers({ type: 'childList', target: this, addedNodes: [], removedNodes: [node], attributeName: null });
            }
            return node;
        }

        append(...nodes) {
            for (const node of nodes) {
                this.appendChild(typeof node === 'string' ? new MiniText(node) : node);
            }
        }

        insertBefore(node, reference) {
            if (node.parentElement) {
                const oldIdx = node.parentElement.childNodes.indexOf(node);
                if (oldIdx !== -1) node.parentElement.childNodes.splice(oldIdx, 1);
            }
            const refIdx = reference ? this.childNodes.indexOf(reference) : -1;
            if (refIdx === -1) this.childNodes.push(node);
            else this.childNodes.splice(refIdx, 0, node);
            node.parentElement = this;
            node.parentNode = this;
            if (node instanceof MiniElement) node._markConnected(this._isConnected);
            else node._isConnected = this._isConnected;
            notifyObservers({ type: 'childList', target: this, addedNodes: [node], removedNodes: [], attributeName: null });
            return node;
        }

        insertAdjacentElement(position, node) {
            if (position !== 'afterend') throw new Error(`Unsupported position: ${position}`);
            const siblings = this.parentElement.childNodes;
            const next = siblings[siblings.indexOf(this) + 1] ?? null;
            return this.parentElement.insertBefore(node, next);
        }

        contains(node) {
            let cur = node;
            while (cur) {
                if (cur === this) return true;
                cur = cur.parentElement;
            }
            return false;
        }

        matches(selector) {
            return matchesSelectorList(this, selector);
        }

        closest(selector) {
            let cur = this;
            while (cur) {
                if (cur.matches(selector)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }

        querySelectorAll(selector) {
            this.querySelectorAllCalls++;
            const results = [];
            const walk = (el) => {
                for (const child of el.children) {
                    if (child.matches(selector)) results.push(child);
                    walk(child);
                }
            };
            walk(this);
            return results;
        }

        querySelector(selector) {
            const walk = (el) => {
                for (const child of el.children) {
                    if (child.matches(selector)) return child;
                    const found = walk(child);
                    if (found) return found;
                }
                return null;
            };
            return walk(this);
        }

        getElementsByTagName(tagName) {
            this.getElementsByTagNameCalls++;
            const lower = tagName.toLowerCase();
            const results = [];
            const walk = (el) => {
                for (const child of el.children) {
                    if (lower === '*' || child.localName === lower) results.push(child);
                    walk(child);
                }
            };
            walk(this);
            return results;
        }

        addEventListener(event, fn) {
            if (!this.listeners.has(event)) this.listeners.set(event, []);
            this.listeners.get(event).push(fn);
        }

        dispatchEvent(event) {
            for (const fn of this.listeners.get(event.type) || []) {
                fn(event);
            }
        }
    }

    class MiniHTMLElement extends MiniElement {}
    class MiniHTMLButtonElement extends MiniHTMLElement {
        constructor() {
            super('button');
        }
    }

    function notifyObservers(record) {
        for (const obs of observers) {
            if (!obs.active) continue;
            let matched = false;
            for (const entry of obs.targets) {
                const { target, options } = entry;
                const isTarget = record.target === target;
                const isDescendant = Boolean(options.subtree && (target === doc || target.contains(record.target)));
                if (!isTarget && !isDescendant) continue;
                if (record.type === 'childList' && options.childList) {
                    matched = true;
                    break;
                }
                if (record.type === 'attributes' && options.attributes) {
                    if (!options.attributeFilter || options.attributeFilter.includes(record.attributeName)) {
                        matched = true;
                        break;
                    }
                }
            }
            if (matched) {
                obs.queue.push(record);
                if (!obs.scheduled) {
                    obs.scheduled = true;
                    queueMicrotask(() => {
                        obs.scheduled = false;
                        if (!obs.active || obs.queue.length === 0) return;
                        const batch = obs.queue.splice(0);
                        obs.callback(batch, obs);
                    });
                }
            }
        }
    }

    class MiniMutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            this.queue = [];
            this.scheduled = false;
            this.active = false;
            observers.push(this);
        }

        observe(target, options = {}) {
            this.active = true;
            this.targets.push({ target, options });
        }

        disconnect() {
            this.active = false;
            this.targets = [];
            this.queue = [];
        }
    }

    const html = new MiniHTMLElement('html');
    html._isConnected = true;
    const body = new MiniHTMLElement('body');
    html.appendChild(body);

    class MiniDocument {
        constructor() {
            this.documentElement = html;
            this.body = body;
            this.hidden = false;
            this.listeners = new Map();
        }

        createElement(tag) {
            if (tag.toLowerCase() === 'button') return new MiniHTMLButtonElement();
            return new MiniHTMLElement(tag);
        }

        createTextNode(text) {
            return new MiniText(text);
        }

        getElementById(id) {
            return html.querySelector(`#${id}`);
        }

        querySelector(selector) {
            return html.querySelector(selector);
        }

        querySelectorAll(selector) {
            return html.querySelectorAll(selector);
        }

        contains(node) {
            return html.contains(node);
        }

        addEventListener(event, fn) {
            if (!this.listeners.has(event)) this.listeners.set(event, []);
            this.listeners.get(event).push(fn);
        }

        dispatchEvent(event) {
            for (const fn of this.listeners.get(event.type) || []) {
                fn(event);
            }
        }
    }

    const doc = new MiniDocument();

    const flushMicrotasks = async () => {
        await new Promise(resolve => queueMicrotask(resolve));
        await new Promise(resolve => queueMicrotask(resolve));
    };

    return {
        document: doc,
        Document: MiniDocument,
        Element: MiniElement,
        HTMLElement: MiniHTMLElement,
        HTMLButtonElement: MiniHTMLButtonElement,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        MutationObserver: MiniMutationObserver,
        observers,
        flushMicrotasks,
    };
}

function buildMessageElement(dom, mesId = '0') {
    const { document } = dom;
    const mes = document.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', mesId);

    const swipeLeft = document.createElement('div');
    swipeLeft.className = 'swipe_left';
    mes.appendChild(swipeLeft);

    const mesBlock = document.createElement('div');
    mesBlock.className = 'mes_block';
    mes.appendChild(mesBlock);

    const buttons = document.createElement('div');
    buttons.className = 'mes_buttons';
    mesBlock.appendChild(buttons);

    const extraButtons = document.createElement('div');
    extraButtons.className = 'extraMesButtons';
    buttons.appendChild(extraButtons);

    const editBtn = document.createElement('div');
    editBtn.className = 'mes_button mes_edit';
    editBtn.setAttribute('data-i18n', '[title]Edit');
    editBtn.setAttribute('title', 'Edit');
    buttons.appendChild(editBtn);

    const reasoning = document.createElement('div');
    reasoning.className = 'mes_reasoning';
    mesBlock.appendChild(reasoning);

    const mesText = document.createElement('div');
    mesText.className = 'mes_text';
    mesBlock.appendChild(mesText);

    const swipeRight = document.createElement('div');
    swipeRight.className = 'swipe_right';
    mes.appendChild(swipeRight);

    return { mes, swipeLeft, swipeRight, editBtn, extraButtons, mesText, reasoning };
}

const savedGlobals = {};
function installDomGlobals(dom) {
    const keys = ['document', 'Document', 'Element', 'HTMLElement', 'HTMLButtonElement', 'Node', 'MutationObserver', 'CSS', 'window', 'navigator', 'localStorage', 'fetch', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', '$'];
    for (const key of keys) {
        if (!(key in savedGlobals)) {
            savedGlobals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
        }
    }
    globalThis.document = dom.document;
    globalThis.Document = dom.Document;
    globalThis.Element = dom.Element;
    globalThis.HTMLElement = dom.HTMLElement;
    globalThis.HTMLButtonElement = dom.HTMLButtonElement;
    globalThis.Node = dom.Node;
    globalThis.MutationObserver = dom.MutationObserver;
    globalThis.CSS = { supports: () => false };
    globalThis.window = globalThis;
}

function restoreGlobals() {
    for (const [key, desc] of Object.entries(savedGlobals)) {
        if (desc === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, desc);
        delete savedGlobals[key];
    }
}

afterEach(() => {
    restoreGlobals();
    jest.restoreAllMocks();
    jest.resetModules();
});

describe('PR 8 observer firewalls', () => {
    test('a11y.js skips .mes_text / .mes_reasoning span churn while preserving .mes chrome ARIA roles', async () => {
        const dom = createMiniDom();
        installDomGlobals(dom);
        const chat = dom.document.createElement('div');
        chat.id = 'chat';
        dom.document.body.appendChild(chat);

        const { initAccessibility } = await import('../../public/scripts/a11y.js');
        initAccessibility();
        initAccessibility();
        expect(dom.observers).toHaveLength(1);

        // Adding a message must initialize chrome roles.
        const { mes, swipeLeft, swipeRight, editBtn, mesText, reasoning } = buildMessageElement(dom, '0');
        chat.appendChild(mes);
        await dom.flushMicrotasks();

        expect(editBtn.getAttribute('role')).toBe('button');
        expect(swipeLeft.getAttribute('role')).toBe('button');
        expect(swipeRight.getAttribute('role')).toBe('button');

        // Streaming churn inside .mes_text and .mes_reasoning must not scan added spans.
        const proseSpan = dom.document.createElement('span');
        proseSpan.textContent = 'chunk';
        const prosePara = dom.document.createElement('p');
        prosePara.appendChild(dom.document.createElement('span'));
        const reasonSpan = dom.document.createElement('span');
        reasonSpan.textContent = 'thinking...';

        mesText.appendChild(proseSpan);
        mesText.appendChild(prosePara);
        reasoning.appendChild(reasonSpan);
        await dom.flushMicrotasks();

        expect(proseSpan.querySelectorAllCalls).toBe(0);
        expect(prosePara.querySelectorAllCalls).toBe(0);
        expect(reasonSpan.querySelectorAllCalls).toBe(0);

        // Standalone nested addition invariant (mirrors tests/streaming-render-work.e2e.js).
        const parent = dom.document.createElement('div');
        dom.document.body.appendChild(parent);
        const child = dom.document.createElement('div');
        child.className = 'mes_button';
        const grandChild = dom.document.createElement('span');
        grandChild.className = 'menu_button';
        child.appendChild(grandChild);
        parent.appendChild(child);
        await dom.flushMicrotasks();

        expect(parent.querySelectorAllCalls).toBe(1);
        expect(child.querySelectorAllCalls).toBe(0);
        expect(child.getAttribute('role')).toBe('button');
        expect(grandChild.getAttribute('role')).toBe('button');
    });

    test('keyboard.js skips .mes_text / .mes_reasoning span churn while preserving .mes chrome tabindex and code-copy', async () => {
        const dom = createMiniDom();
        installDomGlobals(dom);
        const chat = dom.document.createElement('div');
        chat.id = 'chat';
        dom.document.body.appendChild(chat);

        const { initKeyboard } = await import('../../public/scripts/keyboard.js');
        initKeyboard();

        // Adding a message must initialize chrome tabindex and .interactable.
        const { mes, swipeLeft, swipeRight, editBtn, mesText, reasoning } = buildMessageElement(dom, '0');
        chat.appendChild(mes);
        await dom.flushMicrotasks();

        expect(editBtn.getAttribute('tabindex')).toBe('0');
        expect(swipeLeft.getAttribute('tabindex')).toBe('0');
        expect(swipeRight.getAttribute('tabindex')).toBe('0');

        // Streaming text/span churn inside .mes_text and .mes_reasoning is skipped without scanning.
        const streamSpan = dom.document.createElement('span');
        streamSpan.className = 'hljs-keyword';
        const streamPara = dom.document.createElement('p');
        streamPara.appendChild(dom.document.createElement('span'));
        const reasonSpan = dom.document.createElement('span');

        mesText.appendChild(streamSpan);
        mesText.appendChild(streamPara);
        reasoning.appendChild(reasonSpan);
        await dom.flushMicrotasks();

        expect(streamSpan.querySelectorAllCalls).toBe(0);
        expect(streamPara.querySelectorAllCalls).toBe(0);
        expect(reasonSpan.querySelectorAllCalls).toBe(0);

        // Explicitly interactive copy buttons inside .mes_text still receive tabindex="0" without subtree scan.
        const copyBtn = dom.document.createElement('i');
        copyBtn.className = 'fa-solid fa-copy code-copy interactable';
        mesText.appendChild(copyBtn);
        await dom.flushMicrotasks();

        expect(copyBtn.getAttribute('tabindex')).toBe('0');
        expect(copyBtn.querySelectorAllCalls).toBe(0);
    });

    test('i18n.js skips observing in default en-us without translation map, and short-circuits chat prose for non-English locales', async () => {
        const mockI18nDeps = async () => {
            await jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
                registerDebugFunction: jest.fn(),
            }));
            await jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
                updateSecretDisplay: jest.fn(),
            }));
            await jest.unstable_mockModule('../../public/scripts/sillybunny-settings-macros.js', () => ({
                formatSettingsMacroExamples: jest.fn(),
            }));
        };

        // Case 1: default en-us with no translation map -> observer never attaches.
        const domEn = createMiniDom();
        installDomGlobals(domEn);
        Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
        globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
        globalThis.$ = () => ({ find: () => ({ filter: () => ({ append: () => {}, each: () => {}, on: () => {}, val: () => {} }) }) });
        globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => [{ lang: 'fr-fr', display: 'French' }] }));
        await mockI18nDeps();

        const i18nEn = await import('../../public/scripts/i18n.js');
        await i18nEn.initLocales();
        expect(domEn.observers.every(obs => !obs.active)).toBe(true);

        // Case 2: non-English locale with translation map -> translates chrome, skips #chat .mes_text / .mes_reasoning.
        jest.resetModules();
        restoreGlobals();
        const domFr = createMiniDom();
        installDomGlobals(domFr);
        Object.defineProperty(globalThis, 'navigator', { value: { language: 'fr-FR' }, configurable: true });
        globalThis.localStorage = { getItem: () => 'fr-fr', setItem: () => {}, removeItem: () => {} };
        globalThis.$ = () => ({
            find: () => ({
                filter: () => ({ append: () => {}, each: () => {}, on: () => {}, val: () => {} }),
                each: () => {},
            }),
        });
        globalThis.fetch = jest.fn(async (url) => {
            if (String(url).includes('lang.json')) {
                return { ok: true, json: async () => [{ lang: 'fr-fr', display: 'French' }] };
            }
            return { ok: true, json: async () => ({ Edit: 'Modifier' }) };
        });
        await mockI18nDeps();

        const chat = domFr.document.createElement('div');
        chat.id = 'chat';
        domFr.document.body.appendChild(chat);

        const i18nFr = await import('../../public/scripts/i18n.js');
        await i18nFr.initLocales();
        expect(domFr.observers.some(obs => obs.active)).toBe(true);

        const { mes, editBtn, mesText, reasoning } = buildMessageElement(domFr, '0');
        chat.appendChild(mes);
        await domFr.flushMicrotasks();
        expect(editBtn.getAttribute('title')).toBe('Modifier');

        const streamSpan = domFr.document.createElement('span');
        const reasonSpan = domFr.document.createElement('span');
        mesText.appendChild(streamSpan);
        reasoning.appendChild(reasonSpan);
        await domFr.flushMicrotasks();

        expect(streamSpan.querySelectorAllCalls).toBe(0);
        expect(reasonSpan.querySelectorAllCalls).toBe(0);
    });

    test('RossAscends-mods.js avoids getElementsByTagName(math) for non-math added nodes in .mes_text', async () => {
        const dom = createMiniDom();
        const context = vm.createContext({
            document: dom.document,
            Element: dom.Element,
            HTMLElement: dom.HTMLElement,
            Node: dom.Node,
            MutationObserver: dom.MutationObserver,
            SelectedCharacterTab: null,
            RA_CountCharTokens: () => {},
            RA_checkOnlineStatus: () => {},
            debounce: fn => fn,
            debounce_timeout: { relaxed: 10, short: 10 },
        });
        loadDeclarations(context, 'scripts/RossAscends-mods.js', [
            'observerConfig',
            'countTokensDebounced',
            'countTokensShortDebounced',
            'checkStatusDebounced',
            'clearMathTextNodes',
            'observer',
        ]);
        vm.runInContext('observer.observe(document.documentElement, observerConfig);', context);

        const mesText = dom.document.createElement('div');
        mesText.className = 'mes_text';
        dom.document.body.appendChild(mesText);

        // Plain leaf span and nested non-math paragraph must never call getElementsByTagName.
        const leafSpan = dom.document.createElement('span');
        leafSpan.textContent = 'streaming token';
        const para = dom.document.createElement('p');
        const em = dom.document.createElement('em');
        em.textContent = 'italic';
        para.appendChild(em);

        mesText.appendChild(leafSpan);
        mesText.appendChild(para);
        await dom.flushMicrotasks();

        expect(mesText.getElementsByTagNameCalls).toBe(0);
        expect(leafSpan.getElementsByTagNameCalls).toBe(0);
        expect(para.getElementsByTagNameCalls).toBe(0);

        // Direct <math> and container with <math> must clear direct text nodes inside <math>.
        const directMath = dom.document.createElement('math');
        const directText = dom.document.createTextNode('raw text');
        directMath.appendChild(directText);
        mesText.appendChild(directMath);

        const wrapper = dom.document.createElement('div');
        const nestedMath = dom.document.createElement('math');
        const nestedText = dom.document.createTextNode('nested raw');
        nestedMath.appendChild(nestedText);
        wrapper.appendChild(nestedMath);
        mesText.appendChild(wrapper);
        await dom.flushMicrotasks();

        expect(directText.textContent).toBe('');
        expect(nestedText.textContent).toBe('');
        expect(wrapper.getElementsByTagNameCalls).toBe(1);
    });

    test('guided-generations scopes qrObserver to #send_form (subtree:false), keeps it active for QR bar re-renders while clearing poll timer, drops style filter, and uses events instead of setInterval', async () => {
        const dom = createMiniDom();
        installDomGlobals(dom);
        globalThis.ResizeObserver = class {
            observe() {}
            disconnect() {}
        };
        globalThis.requestAnimationFrame = () => 1;

        const eventHandlers = new Map();
        const eventSource = {
            on: jest.fn((event, handler) => {
                if (!eventHandlers.has(event)) eventHandlers.set(event, []);
                eventHandlers.get(event).push(handler);
            }),
        };
        const event_types = {
            CHAT_CHANGED: 'chat_changed',
            GENERATION_ENDED: 'generation_ended',
        };
        let activeGuides = [];

        await jest.unstable_mockModule('../../public/script.js', () => ({
            saveSettingsDebounced: jest.fn(),
            eventSource,
            event_types,
        }));
        await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extensionNames: [],
            extension_settings: {},
            renderExtensionTemplateAsync: jest.fn(async () => ''),
        }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/shared.js', () => ({
            extensionName: 'guided-generations',
            flushActiveGuides: jest.fn(async () => []),
            getActiveGuides: jest.fn(() => activeGuides),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileList: jest.fn(async () => []),
            resolveStoredProfile: jest.fn(() => null),
        }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js', () => ({ guidedCorrection: jest.fn() }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js', () => ({ guidedImpersonate: jest.fn() }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/guidedResponse.js', () => ({ guidedResponse: jest.fn() }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js', () => ({ guidedSwipe: jest.fn() }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/legacyForkWarning.js', () => ({
            markOldExtensionWarningDismissed: jest.fn(),
            shouldWarnOldExtensionDeprecated: jest.fn(() => false),
        }));
        await jest.unstable_mockModule('../../public/scripts/extensions/guided-generations/scripts/simpleSend.js', () => ({ simpleSend: jest.fn() }));

        const sendForm = dom.document.createElement('form');
        sendForm.id = 'send_form';
        const nonQr = dom.document.createElement('div');
        nonQr.id = 'nonQRFormItems';
        sendForm.appendChild(nonQr);
        dom.document.body.appendChild(sendForm);

        const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(() => 123);
        const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
        jest.spyOn(globalThis, 'setTimeout').mockImplementation(() => 456);
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const gg = await import('../../public/scripts/extensions/guided-generations/index.js');
        await gg.init();

        // No 500ms flush guide setInterval polling.
        const flushIntervals = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 500);
        expect(flushIntervals).toHaveLength(0);

        // documentElement observer must not include 'style' in attributeFilter.
        const docElObs = dom.observers.find(obs => obs.targets.some(t => t.target === dom.document.documentElement));
        expect(docElObs).toBeDefined();
        expect(docElObs.targets[0].options.attributeFilter).not.toContain('style');

        // qrObserver must observe #send_form with subtree: false, stop qrPollTimer once integrated,
        // and stay attached so a recreated #qr--bar re-integrates cleanly.
        const qrObs = dom.observers.find(obs => obs.targets.some(t => t.target === sendForm));
        expect(qrObs).toBeDefined();
        expect(qrObs.targets[0].options).toEqual({ childList: true, subtree: false });
        expect(qrObs.active).toBe(true);

        const qrBar = dom.document.createElement('div');
        qrBar.id = 'qr--bar';
        sendForm.appendChild(qrBar);
        await dom.flushMicrotasks();

        expect(qrBar.parentElement.id).toBe('gg-qr-container');
        expect(clearIntervalSpy).toHaveBeenCalledWith(123);
        expect(qrObs.active).toBe(true);

        // Simulate Quick Reply destroying and recreating #qr--bar (e.g., character switch or popout toggle).
        qrBar.remove();
        const recreatedQrBar = dom.document.createElement('div');
        recreatedQrBar.id = 'qr--bar';
        sendForm.appendChild(recreatedQrBar);
        await dom.flushMicrotasks();
        expect(recreatedQrBar.parentElement.id).toBe('gg-qr-container');

        // Event-driven flush button updates respond to eventSource events.
        activeGuides = ['gg-guided-response'];
        for (const fn of eventHandlers.get(event_types.GENERATION_ENDED) || []) {
            fn();
        }
        const flushBtn = dom.document.getElementById('gg_flush_guides_button');
        expect(flushBtn.dataset.activeCount).toBe('1');
    });

    test('quick-image-gen defers top-level localStorage JSON.parse and scopes qigMessageActionObserver to #chat addedNodes', async () => {
        const { source } = readClientModule('scripts/extensions/quick-image-gen/index.js');

        // Top-level store declarations must not synchronously call safeParse during module evaluation.
        expect(source).not.toMatch(/^let charSettings = safeParse\(/m);
        expect(source).not.toMatch(/^let configurations = safeParse\(/m);
        expect(source).toContain('function ensureLocalStoresHydrated()');

        // Load qigMessageActionObserver functions in isolation via vm to verify subtree:false + addedNodes-only processing.
        const dom = createMiniDom();
        const ensured = [];
        const chat = dom.document.createElement('div');
        chat.id = 'chat';
        dom.document.body.appendChild(chat);

        const existingMes = dom.document.createElement('div');
        existingMes.className = 'mes';
        existingMes.setAttribute('mesid', '0');
        chat.appendChild(existingMes);

        const scheduledFrames = [];
        const context = vm.createContext({
            document: dom.document,
            window: {
                requestAnimationFrame: (fn) => {
                    scheduledFrames.push(fn);
                    return scheduledFrames.length;
                },
                cancelAnimationFrame: () => {},
            },
            Element: dom.Element,
            MutationObserver: dom.MutationObserver,
            setTimeout,
            clearTimeout,
            getContext: () => ({ chat: [{ mes: 'a' }, { mes: 'b' }] }),
            ensureMessageGenerateAction: (el) => ensured.push(el.getAttribute('mesid')),
        });
        loadDeclarations(context, 'scripts/extensions/quick-image-gen/index.js', [
            'qigMessageActionObserver',
            'qigMessageActionObserverRetryTimer',
            'qigMessageActionRefreshQueued',
            'qigMessageActionRefreshCancel',
            'qigMessageActionAddedQueued',
            'qigMessageActionAddedCancel',
            'qigPendingAddedMessageNodes',
            'getMessageElementsWithin',
            'refreshMessageGenerateActions',
            'scheduleRefreshMessageGenerateActions',
            'flushPendingAddedMessageGenerateActions',
            'scheduleAddedMessageGenerateActions',
            'initMessageGenerateActionObserver',
        ]);

        vm.runInContext('initMessageGenerateActionObserver();', context);
        expect(dom.observers).toHaveLength(1);
        expect(dom.observers[0].targets[0]).toEqual({ target: chat, options: { childList: true, subtree: false } });

        // Drain initial refresh frame.
        while (scheduledFrames.length) scheduledFrames.shift()();
        ensured.length = 0;
        chat.querySelectorAllCalls = 0;

        // Streaming mutation inside existing message must not trigger observer at all (subtree: false).
        const mesText = dom.document.createElement('div');
        mesText.className = 'mes_text';
        existingMes.appendChild(mesText);
        mesText.appendChild(dom.document.createElement('span'));
        await dom.flushMicrotasks();
        expect(scheduledFrames).toHaveLength(0);

        // Appending a new message directly under #chat processes ONLY that added node without re-querying #chat.
        const newMes = dom.document.createElement('div');
        newMes.className = 'mes';
        newMes.setAttribute('mesid', '1');
        chat.appendChild(newMes);
        await dom.flushMicrotasks();
        while (scheduledFrames.length) scheduledFrames.shift()();

        expect(ensured).toEqual(['1']);
        expect(chat.querySelectorAllCalls).toBe(0);

        // bindHostEventHandlers must subscribe MESSAGE_SWIPED and CHARACTER_MESSAGE_RENDERED for in-place privacy refresh.
        expect(source).toContain('eventTypes.MESSAGE_SWIPED');
        expect(source).toContain('eventTypes.CHARACTER_MESSAGE_RENDERED');
    });

    test('in-chat-agents postGenerationRecoveryObserver uses subtree:false, disarms only #chat while streaming (keeping body[data-generating] watched), and re-arms on CHAT_CHANGED', () => {
        const dom = createMiniDom();
        const chat = dom.document.createElement('div');
        chat.id = 'chat';
        dom.document.body.appendChild(chat);

        const context = vm.createContext({
            document: dom.document,
            MutationObserver: dom.MutationObserver,
            console,
            streamingProcessor: null,
        });
        loadDeclarations(context, 'scripts/extensions/in-chat-agents/agent-runner.js', [
            'postGenerationRecoveryObserver',
            'postGenerationRecoveryObserverArmed',
            'isStreamingActiveForRecoveryObserver',
            'observePostGenerationRecoveryTargets',
        ]);

        vm.runInContext('postGenerationRecoveryObserver = new MutationObserver(() => {}); observePostGenerationRecoveryTargets();', context);
        expect(dom.observers).toHaveLength(1);
        const obs = dom.observers[0];
        expect(obs.active).toBe(true);
        const chatTarget = obs.targets.find(t => t.target === chat);
        expect(chatTarget.options).toEqual({ childList: true, subtree: false });
        expect(obs.targets.find(t => t.target === dom.document.body)?.options).toEqual({ attributes: true, attributeFilter: ['data-generating'] });

        // While streaming is active, #chat is disarmed but document.body[data-generating] stays watched for missed-end recovery.
        context.streamingProcessor = { isFinished: false, isStopped: false };
        vm.runInContext('observePostGenerationRecoveryTargets();', context);
        expect(obs.active).toBe(true);
        expect(obs.targets.find(t => t.target === chat)).toBeUndefined();
        expect(obs.targets.find(t => t.target === dom.document.body)?.options).toEqual({ attributes: true, attributeFilter: ['data-generating'] });

        // Once streaming finishes, #chat re-arms with subtree: false alongside document.body[data-generating].
        context.streamingProcessor = { isFinished: true, isStopped: false };
        vm.runInContext('observePostGenerationRecoveryTargets();', context);
        expect(obs.active).toBe(true);
        expect(obs.targets.find(t => t.target === chat).options).toEqual({ childList: true, subtree: false });
        expect(obs.targets.find(t => t.target === dom.document.body)?.options).toEqual({ attributes: true, attributeFilter: ['data-generating'] });

        // CHAT_CHANGED registration must include observePostGenerationRecoveryTargets so mid-stream chat switches re-arm #chat.
        const { source: runnerSource } = readClientModule('scripts/extensions/in-chat-agents/agent-runner.js');
        expect(runnerSource).toContain('eventSource.on(event_types.CHAT_CHANGED, observePostGenerationRecoveryTargets);');
    });
});

describe('PR 8 regex memoization and engine cache invalidation', () => {
    const mockRegexFromString = value => {
        const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
    };

    test('in-chat-agents regex-scripts memoizes normalized scripts via WeakMap and invalidates on field or array mutations', async () => {
        let uuidCounter = 0;
        const uuidv4 = jest.fn(() => `uuid-${++uuidCounter}`);
        await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            regexFromString: jest.fn(mockRegexFromString),
            uuidv4,
        }));

        const {
            AGENT_REGEX_PLACEMENT,
            applyRegexScriptList,
            getNormalizedRegexScript,
            normalizeRegexScript,
        } = await import('../../public/scripts/extensions/in-chat-agents/regex-scripts.js');

        const rawScript = {
            scriptName: 'Replace foo',
            findRegex: '/foo/g',
            replaceString: 'bar',
            trimStrings: ['!'],
            placement: [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
            disabled: false,
            markdownOnly: true,
        };

        const first = getNormalizedRegexScript(rawScript);
        expect(uuidv4).toHaveBeenCalledTimes(1);
        const second = getNormalizedRegexScript(rawScript);
        expect(second).toBe(first);
        expect(uuidv4).toHaveBeenCalledTimes(1);

        // normalizeRegexScript still returns fresh independent copies for callers that mutate them.
        const copyA = normalizeRegexScript({ ...rawScript, id: 'explicit-id' });
        const copyB = normalizeRegexScript({ ...rawScript, id: 'explicit-id' });
        expect(copyA).not.toBe(copyB);
        expect(uuidv4).toHaveBeenCalledTimes(1);

        expect(applyRegexScriptList('foo world', [rawScript], AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }))
            .toBe('bar world');
        expect(uuidv4).toHaveBeenCalledTimes(1);

        // Mutating scalar field invalidates memoized entry immediately.
        rawScript.replaceString = 'baz';
        const third = getNormalizedRegexScript(rawScript);
        expect(third).not.toBe(first);
        expect(applyRegexScriptList('foo world', [rawScript], AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }))
            .toBe('baz world');

        // Mutating placement array in place invalidates memoized entry immediately.
        rawScript.placement.push(AGENT_REGEX_PLACEMENT.REASONING);
        const fourth = getNormalizedRegexScript(rawScript);
        expect(fourth).not.toBe(third);
        expect(applyRegexScriptList('foo thought', [rawScript], AGENT_REGEX_PLACEMENT.REASONING, { isMarkdown: true }))
            .toBe('baz thought');

        // Mutating trimStrings array in place invalidates memoized entry immediately.
        rawScript.findRegex = '/(foo!)/g';
        rawScript.replaceString = '$1';
        expect(applyRegexScriptList('foo!', [rawScript], AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }))
            .toBe('foo');
        rawScript.trimStrings.push('o');
        expect(applyRegexScriptList('foo!', [rawScript], AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }))
            .toBe('f');
    });

    test('regex/engine.js caches buckets by (placement, mode), skips substituteParamsExtended without {{, gates console.debug, and invalidates on changes', async () => {
        const regexFromString = jest.fn(mockRegexFromString);
        const substituteParams = jest.fn(value => value);
        const substituteParamsExtended = jest.fn(value => value
            .replace(/\{\{char\}\}|<CHAR>|<BOT>/gi, 'Alice')
            .replace(/\{\{user\}\}|<USER>/gi, 'Bob'));
        const saveSettingsDebounced = jest.fn();
        const extension_settings = {
            disabledExtensions: [],
            regex: [],
            character_allowed_regex: [],
            preset_allowed_regex: {},
        };
        const characters = [
            {
                avatar: 'alice.png',
                data: {
                    extensions: {
                        regex_scripts: [
                            {
                                id: 'scoped-1',
                                scriptName: 'Scoped',
                                findRegex: '/hello/g',
                                replaceString: 'hi',
                                trimStrings: [],
                                placement: [2],
                                disabled: false,
                                markdownOnly: true,
                                promptOnly: false,
                                runOnEdit: false,
                                substituteRegex: 1,
                                minDepth: 0,
                                maxDepth: 2,
                            },
                        ],
                    },
                },
            },
        ];

        await jest.unstable_mockModule('../../public/script.js', () => ({
            characters,
            saveSettingsDebounced,
            substituteParams,
            substituteParamsExtended,
            this_chid: 0,
        }));
        await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extension_settings,
            writeExtensionField: jest.fn(async () => {}),
        }));
        await jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
            getPresetManager: () => null,
        }));
        await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            regexFromString,
        }));
        await jest.unstable_mockModule('../../public/lib.js', () => ({
            lodash: { set: jest.fn() },
        }));

        const engine = await import('../../public/scripts/extensions/regex/engine.js');
        const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

        const globalScript = {
            id: 'global-1',
            scriptName: 'Static Global',
            findRegex: '/cat/g',
            replaceString: 'dog',
            trimStrings: [],
            placement: [engine.regex_placement.AI_OUTPUT],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: false,
            substituteRegex: engine.substitute_find_regex.RAW,
            minDepth: 0,
            maxDepth: 5,
        };
        extension_settings.regex.push(globalScript);

        // Repeated calls with static regex (no '{{') must NOT call substituteParamsExtended.
        expect(engine.getRegexedString('a cat', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('a dog');
        expect(engine.getRegexedString('two cat', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('two dog');
        expect(substituteParamsExtended).not.toHaveBeenCalled();

        // Skipped due to isEdit / depth must NOT spam console.debug when debug flag is off.
        expect(engine.getRegexedString('a cat', engine.regex_placement.AI_OUTPUT, { isMarkdown: true, isEdit: true })).toBe('a cat');
        expect(engine.getRegexedString('a cat', engine.regex_placement.AI_OUTPUT, { isMarkdown: true, depth: 99 })).toBe('a cat');
        expect(debugSpy).not.toHaveBeenCalled();

        // In-place script mutations (disabled / findRegex) invalidate cache immediately.
        globalScript.disabled = true;
        expect(engine.getRegexedString('a cat', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('a cat');

        globalScript.disabled = false;
        globalScript.findRegex = '/{{char}}/g';
        expect(engine.getRegexedString('hi Alice', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('hi dog');
        expect(substituteParamsExtended).toHaveBeenCalledTimes(1);

        // Legacy non-curly macros (<USER>, <CHAR>, <BOT>) and escaped braces must NOT be treated as static.
        globalScript.findRegex = '/<USER> and <CHAR>/g';
        expect(engine.getRegexedString('Bob and Alice', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('dog');
        expect(substituteParamsExtended).toHaveBeenCalledTimes(2);

        globalScript.findRegex = '/<bot>/gi';
        expect(engine.getRegexedString('Meet ALICE', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('Meet dog');
        expect(substituteParamsExtended).toHaveBeenCalledTimes(3);

        globalScript.findRegex = '/a\\{2\\}/g';
        engine.getRegexedString('aa', engine.regex_placement.AI_OUTPUT, { isMarkdown: true });
        expect(substituteParamsExtended).toHaveBeenCalledTimes(4);

        // allowScopedScripts / disallowScopedScripts invalidate cache immediately.
        expect(engine.getRegexedString('hello', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('hello');
        engine.allowScopedScripts(characters[0]);
        expect(engine.getRegexedString('hello', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('hi');
        engine.disallowScopedScripts(characters[0]);
        expect(engine.getRegexedString('hello', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('hello');

        // saveScriptsByType invalidates cache immediately.
        await engine.saveScriptsByType([
            {
                ...globalScript,
                findRegex: '/bird/g',
                replaceString: 'owl',
            },
        ], engine.SCRIPT_TYPES.GLOBAL);
        expect(engine.getRegexedString('one bird', engine.regex_placement.AI_OUTPUT, { isMarkdown: true })).toBe('one owl');
    });
});
