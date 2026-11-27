import { morphdom } from '../../lib.js';
import { extractOocBlocksForDisplay } from '../ooc-blocks.js';

// SillyBunny: bound live stream fade-in spans to the active tail and provide incremental block splitting/caching.
/** Maximum `.text_segment` spans kept live in the active streaming tail (< 60 budget). */
const MAX_TAIL_SEGMENTS = 48;
/** Batch size used when collapsing older `.text_segment` spans inside a single long block. */
const TAIL_COLLAPSE_STEP = 24;
/** Delay after `.text_segment` CSS fade-in (300ms) before settled prefix blocks collapse spans. */
const SETTLE_FADE_MS = 320;

const DESCENDABLE_CONTAINER_TAGS = new Set([
    'UL', 'OL', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE',
]);

// The tags that markdown-it keeps raw from the opening tag to the matching closing tag across blank lines
// (`SHOWDOWN_BLOCK_TAGS` in markdown-engine.js), plus `details` and `svg`.
const UNSPLITTABLE_HTML_TAGS = new Set([
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul',
    'script', 'noscript', 'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header',
    'footer', 'nav', 'article', 'aside', 'address', 'audio', 'canvas', 'figure', 'hgroup',
    'output', 'video', 'details', 'svg', 'p',
]);

// Markdown ends a block at a line that holds only spaces and tabs. A no-break space or another Unicode space
// is text, which `String.prototype.trim` would treat as blank.
const MARKDOWN_BLANK_LINE_RE = /^[ \t]*$/;
const REFERENCE_DEF_RE = /^[ \t]{0,3}\[[^\r\n\]]+\]:[ \t]*/m;
const REFERENCE_LINK_USE_RE = /\]\[[^\r\n\]]*\]/;
// CommonMark fenced code blocks allow 0-3 leading spaces (a leading tab starts an indented code block).
const FENCE_OPEN_OR_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HTML_TAG_TOKEN_RE = /<!--|-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*?)(\/?)>/g;
// A marker with nothing after it is an empty list item, and the next item of the list starts with it
// while the user has not typed the text of the item yet. The markdown-it HTML block rule lets text that follows
// the closing tag on the same line start a new block, so a marker can follow a `>` on its line.
const LIST_MARKER_SOURCE = String.raw`(?:[ \t]{0,3}|[^\n]*>[ \t]*)(?:[-*+]|\d+[.)])(?:[ \t\r\n]|$)`;
const LIST_ITEM_START_RE = new RegExp(`^${LIST_MARKER_SOURCE}`);
// A list can start in the middle of a block, after a line of text, and still go on in the next block.
const LIST_ITEM_LINE_RE = new RegExp(`^${LIST_MARKER_SOURCE}`, 'm');
// A tab after up to three spaces reaches the fourth column as well.
const INDENTED_CODE_START_RE = /^(?: {4}| {0,3}\t)/;
// Indented code can also start after a `>`, because text after a closing HTML tag on its line starts a new block.
const INDENTED_CODE_LINE_RE = /(?:^|>)(?: {4}| {0,3}\t)/;
const LIST_CONTINUATION_INDENT_RE = /^(?:[ \t]{2,}|\t)/;
const CONTINUATION_BLOCK_START_RE = new RegExp(`^(?:[ \\t]{4,}| {0,3}\\t|${LIST_MARKER_SOURCE}|[ \\t]{0,3}>|[ \\t]{0,3}\\||[ \\t]{0,3}(?:===+|---+)[ \\t]*(?:\\r?\\n|$))`);

/** @type {Map<string, Intl.Segmenter>} */
const segmenterCache = new Map();

/**
 * Metadata for blocks that still contain live `.text_segment` spans from a recent tail render.
 * @type {WeakMap<Element, { unsegmentedClone: Element, childCount: number, textContent: string, collapsedCount: number }>}
 */
const segmentedBlockRecords = new WeakMap();

/**
 * Per-root map of segmented elements to the timestamp (`settledAt`) when each left the active tail,
 * or `null` while it is still the active tail.
 * @type {WeakMap<HTMLElement, Map<Element, number | null>>}
 */
const pendingSegmentedElementsByRoot = new WeakMap();

/** @type {WeakMap<HTMLElement, { timer: ReturnType<typeof setTimeout>, deadline: number }>} */
const settleTimerByRoot = new WeakMap();

/**
 * Returns a cached `Intl.Segmenter` for the requested granularity.
 * @param {'word'|'grapheme'|'sentence'} granularity
 * @returns {Intl.Segmenter}
 */
function getSegmenter(granularity = 'word') {
    let segmenter = segmenterCache.get(granularity);
    if (!segmenter) {
        segmenter = new Intl.Segmenter('en-US', { granularity });
        segmenterCache.set(granularity, segmenter);
    }
    return segmenter;
}

/**
 * Check if the current browser supports native segmentation function.
 * @returns {boolean} True if the Segmenter is supported by the current browser.
 */
export function isSegmenterSupported() {
    return typeof Intl.Segmenter === 'function';
}

/**
 * Collects segmentable text nodes under `root`, excluding `pre`/`code` and whitespace-only nodes.
 * @param {Element} root
 * @returns {Text[]}
 */
function collectSegmentableTextNodes(root) {
    const doc = root.ownerDocument ?? document;
    const textNodes = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = /** @type {Text} */ (walker.currentNode);
        if (textNode.parentElement && textNode.parentElement.closest('pre, code, style, script')) {
            continue;
        }
        if (/^\s*$/.test(textNode.data)) {
            continue;
        }
        textNodes.push(textNode);
    }
    return textNodes;
}

/**
 * Segment text in the given HTML content using Intl.Segmenter.
 * @param {HTMLElement} htmlElement Target HTML element
 * @param {string} htmlContent HTML content to segment
 * @param {'word'|'grapheme'|'sentence'} [granularity='word'] Text split granularity
 */
export function segmentTextInElement(htmlElement, htmlContent, granularity = 'word') {
    htmlElement.innerHTML = htmlContent;

    if (!isSegmenterSupported()) {
        return;
    }

    const doc = htmlElement.ownerDocument ?? document;
    const segmenter = getSegmenter(granularity);
    const textNodes = collectSegmentableTextNodes(htmlElement);

    for (const textNode of textNodes) {
        const fragment = doc.createDocumentFragment();
        const segments = segmenter.segment(textNode.data);
        for (const segment of segments) {
            const span = doc.createElement('span');
            span.textContent = segment.segment;
            span.className = 'text_segment';
            fragment.appendChild(span);
        }
        textNode.replaceWith(fragment);
    }
}

/**
 * Collapses `.text_segment` spans inside `root` back into normalized plain text nodes.
 * @param {Element | null | undefined} root
 */
export function collapseTextSegments(root) {
    if (!root) {
        return;
    }
    const spans = root.querySelectorAll('span.text_segment');
    if (spans.length === 0) {
        segmentedBlockRecords.delete(root);
        return;
    }
    const doc = root.ownerDocument ?? document;
    for (const span of spans) {
        span.replaceWith(doc.createTextNode(span.textContent ?? ''));
    }
    root.normalize();
    segmentedBlockRecords.delete(root);
}

/**
 * Finds the active leaf block element at the end of a message container.
 * @param {HTMLElement} root
 * @returns {Element | null}
 */
function findActiveTailElement(root) {
    /** @type {Element | null} */
    let current = root.lastElementChild;
    if (!current) {
        return root.childNodes.length > 0 ? root : null;
    }

    // If non-whitespace text trails after `lastElementChild`, segment the container itself.
    for (let node = current.nextSibling; node; node = node.nextSibling) {
        if (node.nodeType === 3 && !/^\s*$/.test(node.nodeValue ?? '')) {
            return root;
        }
    }

    while (current && DESCENDABLE_CONTAINER_TAGS.has(current.tagName) && current.lastElementChild) {
        let hasTrailingText = false;
        for (let node = current.lastElementChild.nextSibling; node; node = node.nextSibling) {
            if (node.nodeType === 3 && !/^\s*$/.test(node.nodeValue ?? '')) {
                hasTrailingText = true;
                break;
            }
        }
        if (hasTrailingText) {
            break;
        }
        current = current.lastElementChild;
    }

    return current;
}

/**
 * Segments ONLY `tailElement` while capping total live `.text_segment` spans to `MAX_TAIL_SEGMENTS` (< 60).
 * Older segments in a long single-block paragraph are merged in fixed `TAIL_COLLAPSE_STEP` chunks
 * so existing spans keep stable positions across frames and newly appended words still fade in.
 * @param {Element} tailElement
 * @param {'word'|'grapheme'|'sentence'} [granularity='word']
 * @returns {number} Number of leading segments collapsed into plain text
 */
function segmentTailElementBounded(tailElement, granularity = 'word') {
    if (!isSegmenterSupported()) {
        return 0;
    }

    const doc = tailElement.ownerDocument ?? document;
    const segmenter = getSegmenter(granularity);
    const textNodes = collectSegmentableTextNodes(tailElement);
    if (textNodes.length === 0) {
        return 0;
    }

    const perNodeSegments = textNodes.map((textNode) => {
        const list = [];
        for (const item of segmenter.segment(textNode.data)) {
            list.push(item.segment);
        }
        return list;
    });

    const totalSegments = perNodeSegments.reduce((sum, list) => sum + list.length, 0);
    const collapseBudget = totalSegments > MAX_TAIL_SEGMENTS
        ? Math.floor((totalSegments - TAIL_COLLAPSE_STEP) / TAIL_COLLAPSE_STEP) * TAIL_COLLAPSE_STEP
        : 0;

    let remainingToCollapse = collapseBudget;

    for (let idx = 0; idx < textNodes.length; idx++) {
        const textNode = textNodes[idx];
        const segments = perNodeSegments[idx];
        if (segments.length === 0) {
            continue;
        }

        const collapseHere = Math.min(remainingToCollapse, segments.length);
        remainingToCollapse -= collapseHere;

        if (collapseHere === segments.length) {
            // Entire text node is already past the fade window; leave it as an untouched Text node.
            continue;
        }

        const fragment = doc.createDocumentFragment();
        if (collapseHere > 0) {
            fragment.appendChild(doc.createTextNode(segments.slice(0, collapseHere).join('')));
        }
        for (let s = collapseHere; s < segments.length; s++) {
            const span = doc.createElement('span');
            span.textContent = segments[s];
            span.className = 'text_segment';
            fragment.appendChild(span);
        }
        textNode.replaceWith(fragment);
    }

    return collapseBudget;
}

/**
 * Aligns a live tail element's leading collapsed text when `collapseBudget` advances by a step,
 * so surviving `.text_segment` spans remain aligned 1-to-1 during `morphdom`.
 * @param {Element | null} liveTail
 * @param {number} nextCollapsedCount
 */
function advanceLiveTailCollapsedPrefix(liveTail, nextCollapsedCount) {
    if (!liveTail || nextCollapsedCount <= 0) {
        return;
    }
    const record = segmentedBlockRecords.get(liveTail);
    const prevCollapsed = record?.collapsedCount ?? 0;
    const delta = nextCollapsedCount - prevCollapsed;
    if (delta <= 0) {
        return;
    }

    const doc = liveTail.ownerDocument ?? document;
    const spans = liveTail.querySelectorAll('span.text_segment');
    const count = Math.min(delta, spans.length);
    for (let i = 0; i < count; i++) {
        const span = spans[i];
        const prev = span.previousSibling;
        if (prev && prev.nodeType === 3) {
            prev.nodeValue = (prev.nodeValue ?? '') + (span.textContent ?? '');
            span.remove();
        } else {
            span.replaceWith(doc.createTextNode(span.textContent ?? ''));
        }
    }
}

/**
 * Fast equality check for unsegmented DOM elements before falling back to `isEqualNode`.
 * @param {Element} from
 * @param {Element} to
 * @returns {boolean}
 */
function areElementsFastEqual(from, to) {
    if (from.tagName !== to.tagName) {
        return false;
    }
    if (from.attributes.length !== to.attributes.length) {
        return false;
    }
    if (from.childNodes.length !== to.childNodes.length) {
        return false;
    }
    if (
        from.attributes.length === 0
        && from.childNodes.length === 1
        && from.firstChild?.nodeType === 3
        && to.firstChild?.nodeType === 3
    ) {
        return from.firstChild.nodeValue === to.firstChild.nodeValue;
    }
    return from.isEqualNode(to);
}

/**
 * Cancels any pending settle timer for `messageTextElement`.
 * @param {HTMLElement} messageTextElement
 */
function clearSettleTimer(messageTextElement) {
    const existing = settleTimerByRoot.get(messageTextElement);
    if (existing !== undefined) {
        clearTimeout(existing.timer);
        settleTimerByRoot.delete(messageTextElement);
    }
}

/**
 * Collapses non-tail segmented blocks whose fade window has elapsed, enforces the
 * `MAX_TAIL_SEGMENTS` total live-span cap across `messageTextElement`, and schedules a
 * non-starved timer for the earliest remaining settle deadline.
 * @param {HTMLElement} messageTextElement
 * @param {Element | null} currentTail
 * @param {number} [now]
 */
function reconcilePendingSegmentedElements(messageTextElement, currentTail, now = Date.now()) {
    const tracked = pendingSegmentedElementsByRoot.get(messageTextElement);
    if (!tracked || tracked.size === 0) {
        clearSettleTimer(messageTextElement);
        return;
    }

    /** @type {Array<[Element, number]>} */
    const settledNonTail = [];
    for (const [el, settledAt] of Array.from(tracked.entries())) {
        if (!el.isConnected) {
            tracked.delete(el);
            segmentedBlockRecords.delete(el);
            continue;
        }
        if (el === currentTail) {
            if (settledAt !== null) {
                tracked.set(el, null);
            }
            continue;
        }
        const effectiveSettledAt = settledAt ?? now;
        if (settledAt === null) {
            tracked.set(el, effectiveSettledAt);
        }
        if (now - effectiveSettledAt >= SETTLE_FADE_MS) {
            collapseTextSegments(el);
            tracked.delete(el);
            continue;
        }
        settledNonTail.push([el, effectiveSettledAt]);
    }

    // Enforce the live `.text_segment` budget across all tracked blocks by collapsing oldest non-tail blocks first.
    if (settledNonTail.length > 0) {
        let totalSpans = currentTail ? currentTail.querySelectorAll('span.text_segment').length : 0;
        const nonTailCounts = settledNonTail.map(([el]) => el.querySelectorAll('span.text_segment').length);
        for (const count of nonTailCounts) {
            totalSpans += count;
        }
        let earliestDeadline = Infinity;
        for (let i = 0; i < settledNonTail.length; i++) {
            const [el, settledAt] = settledNonTail[i];
            if (totalSpans > MAX_TAIL_SEGMENTS) {
                collapseTextSegments(el);
                tracked.delete(el);
                totalSpans -= nonTailCounts[i];
            } else {
                const deadline = settledAt + SETTLE_FADE_MS;
                if (deadline < earliestDeadline) {
                    earliestDeadline = deadline;
                }
            }
        }

        if (earliestDeadline === Infinity) {
            clearSettleTimer(messageTextElement);
            return;
        }

        // Only reschedule when no timer is active or an earlier deadline exists; active-tail ticks must never starve older blocks.
        const existing = settleTimerByRoot.get(messageTextElement);
        if (!existing || earliestDeadline < existing.deadline) {
            clearSettleTimer(messageTextElement);
            const delayMs = Math.max(0, earliestDeadline - now);
            const timer = setTimeout(() => {
                settleTimerByRoot.delete(messageTextElement);
                const tail = messageTextElement.isConnected ? findActiveTailElement(messageTextElement) : null;
                reconcilePendingSegmentedElements(messageTextElement, tail, Date.now());
            }, delayMs);
            timer?.unref?.();
            settleTimerByRoot.set(messageTextElement, { timer, deadline: earliestDeadline });
        }
        return;
    }

    clearSettleTimer(messageTextElement);
}

/**
 * Tracks the active tail element and reconciles settled non-tail blocks without starving their timer.
 * @param {HTMLElement} messageTextElement
 * @param {Element} segmentedElement
 */
function trackSegmentedElementForSettle(messageTextElement, segmentedElement) {
    if (segmentedElement === messageTextElement) {
        return;
    }

    let pending = pendingSegmentedElementsByRoot.get(messageTextElement);
    if (!pending) {
        pending = new Map();
        pendingSegmentedElementsByRoot.set(messageTextElement, pending);
    }
    if (!pending.has(segmentedElement)) {
        pending.set(segmentedElement, null);
    }

    reconcilePendingSegmentedElements(messageTextElement, segmentedElement, Date.now());
}

/**
 * Apply formatted streaming content by morphing the existing message DOM in place.
 * This keeps live rich formatting while avoiding full child teardown on every chunk.
 * @param {HTMLElement} messageTextElement Message text element
 * @param {string} htmlContent New HTML content to apply
 */
export function applyStreamDomPatch(messageTextElement, htmlContent) {
    const targetElement = /** @type {HTMLElement} */ (messageTextElement.cloneNode());
    targetElement.innerHTML = htmlContent;
    morphdom(messageTextElement, targetElement, {
        // Full formatting still runs: late references or extension transforms may change earlier blocks.
        onBeforeElUpdated: (from, to) => from === messageTextElement || !areElementsFastEqual(from, to),
    });
}

/**
 * Apply stream fade-in effect to the given message text element by morphing its content.
 * Prefix blocks stay unsegmented and immutable when unchanged; only the active tail block is
 * segmented (`< 60` live `.text_segment` spans).
 * @param {HTMLElement} messageTextElement Message text element
 * @param {string} htmlContent New HTML content to apply
 * @param {object} [options]
 * @param {boolean} [options.bypassFadeIn] Use the lighter DOM patch path instead of segmenting text
 * @param {boolean} [options.isFinal] Collapse all temporary `.text_segment` spans for final parity
 */
export function applyStreamFadeIn(messageTextElement, htmlContent, { bypassFadeIn = false, isFinal = false } = {}) {
    // SillyBunny: bypass/final renders collapse temporary .text_segment spans for full final DOM parity.
    if (bypassFadeIn || isFinal) {
        clearSettleTimer(messageTextElement);
        pendingSegmentedElementsByRoot.delete(messageTextElement);
        if (isFinal) {
            collapseTextSegments(messageTextElement);
        }
        applyStreamDomPatch(messageTextElement, htmlContent);
        return;
    }

    const targetElement = /** @type {HTMLElement} */ (messageTextElement.cloneNode());
    targetElement.innerHTML = htmlContent;

    const targetTail = findActiveTailElement(targetElement);
    /** @type {Element | null} */
    let rawTailClone = null;
    let collapsedCount = 0;

    if (targetTail) {
        if (targetTail !== targetElement) {
            rawTailClone = /** @type {Element} */ (targetTail.cloneNode(true));
        }
        collapsedCount = segmentTailElementBounded(targetTail);
        if (collapsedCount > 0) {
            const liveTail = findActiveTailElement(messageTextElement);
            if (liveTail && liveTail.tagName === targetTail.tagName) {
                advanceLiveTailCollapsedPrefix(liveTail, collapsedCount);
            }
        }
    }

    morphdom(messageTextElement, targetElement, {
        onBeforeElUpdated: (from, to) => {
            if (from === messageTextElement) {
                return true;
            }
            if (to !== targetTail) {
                const record = segmentedBlockRecords.get(from);
                if (record) {
                    if (
                        from.childNodes.length === record.childCount
                        && from.textContent === record.textContent
                        && record.unsegmentedClone.isEqualNode(to)
                    ) {
                        return false;
                    }
                    segmentedBlockRecords.delete(from);
                    return true;
                }
            }
            return !areElementsFastEqual(from, to);
        },
    });

    if (targetTail && targetTail !== targetElement && rawTailClone) {
        const liveTail = findActiveTailElement(messageTextElement);
        if (liveTail && liveTail !== messageTextElement) {
            segmentedBlockRecords.set(liveTail, {
                unsegmentedClone: rawTailClone,
                childCount: liveTail.childNodes.length,
                textContent: liveTail.textContent ?? '',
                collapsedCount,
            });
            trackSegmentedElementForSettle(messageTextElement, liveTail);
        }
    }
}

/**
 * @param {string} text
 * @returns {string} The last line of `text` that holds a character other than whitespace, or an empty string
 */
function lastNonBlankLine(text) {
    const trimmed = text.trimEnd();
    return trimmed.slice(trimmed.lastIndexOf('\n') + 1);
}

/**
 * Splits a streaming Markdown source string into an immutable settled `prefix` and an active `tail`.
 *
 * Never splits inside:
 * - Open or balanced fenced code blocks (`` ``` `` / `~~~`)
 * - Open or balanced HTML blocks (`<div>`, `<style>`, `<details>`, `<pre>`, `<table>`, `<!-- -->`, etc.)
 * - Open or balanced OOC blocks `((...))` (including nested `((...))`)
 * - Loose lists, blockquotes, tables, or setext heading candidates
 *
 * Falls back to `{ prefix: '', tail: source, canReusePrefix: false }` whenever reference-style
 * link definitions/usages (`[ref]: url` / `[text][ref]`) appear or when `isFinal = true`,
 * guaranteeing 100% parity on final render.
 *
 * @param {string} text Raw Markdown text
 * @param {object} [options]
 * @param {boolean} [options.isFinal=false] Whether this is the final complete render
 * @returns {{ prefix: string, tail: string, prefixBlocks: string[], blocks: string[], canReusePrefix: boolean, isFinal: boolean }}
 */
export function splitStreamingBlocks(text, { isFinal = false } = {}) {
    const source = String(text ?? '');
    if (!source) {
        return { prefix: '', tail: '', prefixBlocks: [], blocks: [], canReusePrefix: false, isFinal: Boolean(isFinal) };
    }

    if (isFinal || REFERENCE_DEF_RE.test(source) || REFERENCE_LINK_USE_RE.test(source)) {
        return {
            prefix: '',
            tail: source,
            prefixBlocks: [],
            blocks: [source],
            canReusePrefix: false,
            isFinal: Boolean(isFinal),
        };
    }

    /** @type {string[]} */
    const rawBlocks = [];
    let blockStart = 0;
    let sawContentInBlock = false;

    let fenceChar = '';
    let fenceLength = 0;
    let sawIndentedFence = false;
    let oocDepth = 0;
    let inHtmlComment = false;
    /** @type {string[]} */
    const htmlTagStack = [];

    let lineStart = 0;
    while (lineStart < source.length) {
        let newlineIdx = source.indexOf('\n', lineStart);
        let lineEnd = newlineIdx === -1 ? source.length : newlineIdx + 1;
        const lineBodyEnd = newlineIdx === -1
            ? source.length
            : (newlineIdx > lineStart && source.charCodeAt(newlineIdx - 1) === 0x0D ? newlineIdx - 1 : newlineIdx);
        const line = source.slice(lineStart, lineBodyEnd);
        const isBlankLine = MARKDOWN_BLANK_LINE_RE.test(line);
        const oocDepthAtLineStart = oocDepth;

        // OOC extraction reads the raw text, so a `((` inside a fence or a comment counts as well.
        if (oocDepth > 0 || line.includes('((')) {
            for (let i = 0; i < line.length - 1; i++) {
                const c = line.charCodeAt(i);
                if (c === 0x28 && line.charCodeAt(i + 1) === 0x28) {
                    oocDepth++;
                    i++;
                } else if (oocDepth > 0 && c === 0x29 && line.charCodeAt(i + 1) === 0x29) {
                    oocDepth--;
                    i++;
                }
            }
        }

        if (!inHtmlComment && oocDepthAtLineStart === 0 && htmlTagStack.length === 0) {
            const fenceMatch = FENCE_OPEN_OR_CLOSE_RE.exec(line);
            if (fenceMatch) {
                const marker = fenceMatch[1];
                const rest = fenceMatch[2];
                if (fenceLength === 0) {
                    if (!(marker[0] === '`' && rest.includes('`'))) {
                        // An indented fence can belong to a list item that ends before the fence is closed, and
                        // this scan does not know where list items end, so it makes no further split.
                        if (line.charCodeAt(0) === 0x20) {
                            sawIndentedFence = true;
                        }
                        fenceChar = marker[0];
                        fenceLength = marker.length;
                        sawContentInBlock = true;
                        lineStart = lineEnd;
                        continue;
                    }
                } else if (marker[0] === fenceChar && marker.length >= fenceLength && MARKDOWN_BLANK_LINE_RE.test(rest)) {
                    fenceChar = '';
                    fenceLength = 0;
                    sawContentInBlock = true;
                    lineStart = lineEnd;
                    continue;
                }
            }
        }

        if (fenceLength === 0) {
            // Track HTML comments & block-level HTML tags outside OOC
            if (oocDepth === 0 && (inHtmlComment || htmlTagStack.length > 0 || line.includes('<'))) {
                HTML_TAG_TOKEN_RE.lastIndex = 0;
                for (let match = HTML_TAG_TOKEN_RE.exec(line); match; match = HTML_TAG_TOKEN_RE.exec(line)) {
                    const token = match[0];
                    if (inHtmlComment) {
                        if (token === '-->') {
                            inHtmlComment = false;
                        }
                        continue;
                    }
                    if (token === '<!--') {
                        inHtmlComment = true;
                        continue;
                    }
                    // A `-->` outside a comment, as in the arrow `<-->`, is plain text and has no tag name.
                    if (token === '-->') {
                        continue;
                    }
                    const isClosing = match[1] === '/';
                    const tagName = match[2].toLowerCase();
                    const isSelfClosing = match[4] === '/';
                    if (isSelfClosing || !UNSPLITTABLE_HTML_TAGS.has(tagName)) {
                        continue;
                    }
                    if (!isClosing) {
                        // Start tracking block tags when opened at block level or nested inside an active HTML block
                        if (htmlTagStack.length > 0 || line.slice(0, match.index).trim() === '') {
                            htmlTagStack.push(tagName);
                        }
                    } else if (htmlTagStack.length > 0) {
                        const lastIdx = htmlTagStack.lastIndexOf(tagName);
                        if (lastIdx !== -1) {
                            htmlTagStack.length = lastIdx;
                        }
                    }
                }
            }
        }

        const isTopLevel = fenceLength === 0 && oocDepth === 0 && !inHtmlComment && htmlTagStack.length === 0 && !sawIndentedFence;
        if (isTopLevel && isBlankLine && sawContentInBlock) {
            // Absorb consecutive blank lines into the completed block's trailing separator.
            while (lineEnd < source.length) {
                const nextNl = source.indexOf('\n', lineEnd);
                const nextEnd = nextNl === -1 ? source.length : nextNl + 1;
                const nextBodyEnd = nextNl === -1
                    ? source.length
                    : (nextNl > lineEnd && source.charCodeAt(nextNl - 1) === 0x0D ? nextNl - 1 : nextNl);
                if (!MARKDOWN_BLANK_LINE_RE.test(source.slice(lineEnd, nextBodyEnd))) {
                    break;
                }
                lineEnd = nextEnd;
            }
            rawBlocks.push(source.slice(blockStart, lineEnd));
            blockStart = lineEnd;
            sawContentInBlock = false;
            lineStart = lineEnd;
            continue;
        }

        if (!isBlankLine) {
            sawContentInBlock = true;
        }
        lineStart = lineEnd;
    }

    if (blockStart < source.length) {
        rawBlocks.push(source.slice(blockStart));
    }

    // Merge adjacent blocks that can coalesce in Markdown (loose lists, indented continuations/code, tables, blockquotes).
    /** @type {string[]} */
    const blocks = [];
    for (const block of rawBlocks) {
        if (blocks.length > 0) {
            const prev = blocks[blocks.length - 1];
            const prevTrimmed = prev.replace(/^\s+/, '');
            const currTrimmed = block.replace(/^\s+/, '');
            const bothLists = LIST_ITEM_LINE_RE.test(prev) && (LIST_ITEM_START_RE.test(currTrimmed) || LIST_CONTINUATION_INDENT_RE.test(block));
            const bothQuotes = prevTrimmed.startsWith('>') && currTrimmed.startsWith('>');
            const bothTables = prevTrimmed.startsWith('|') && currTrimmed.startsWith('|');
            const bothIndentedCode = INDENTED_CODE_START_RE.test(block) && INDENTED_CODE_LINE_RE.test(lastNonBlankLine(prev));
            if (bothLists || bothQuotes || bothTables || bothIndentedCode) {
                blocks[blocks.length - 1] = prev + block;
                continue;
            }
        }
        blocks.push(block);
    }

    if (blocks.length <= 1) {
        return {
            prefix: '',
            tail: source,
            prefixBlocks: [],
            blocks: [source],
            canReusePrefix: false,
            isFinal: false,
        };
    }

    // Keep the last block in `tail`, plus the preceding block if `tail` is still blank or could extend it.
    let splitIndex = blocks.length - 1;
    const lastBlock = blocks[blocks.length - 1];
    if (splitIndex > 0 && (lastBlock.trim().length === 0 || CONTINUATION_BLOCK_START_RE.test(lastBlock))) {
        splitIndex--;
    }

    if (splitIndex <= 0) {
        return {
            prefix: '',
            tail: source,
            prefixBlocks: [],
            blocks,
            canReusePrefix: false,
            isFinal: false,
        };
    }

    const prefixBlocks = blocks.slice(0, splitIndex);
    const prefix = prefixBlocks.join('');
    const tail = blocks.slice(splitIndex).join('');

    return {
        prefix,
        tail,
        prefixBlocks,
        blocks,
        canReusePrefix: true,
        isFinal: false,
    };
}

const HTML_VOID_TAGS = new Set([
    'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input',
    'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text up to the matching end tag, so tags inside them are not markup. */
const HTML_RAW_TEXT_TAGS = new Set(['iframe', 'noembed', 'noframes', 'script', 'style', 'textarea', 'title', 'xmp']);

/**
 * Elements that change parser state beyond their own subtree (document structure, foreign content,
 * insertion modes). A block that holds one is never treated as standing alone.
 */
const HTML_STATEFUL_TAGS = new Set(['body', 'frameset', 'head', 'html', 'math', 'plaintext', 'svg', 'template']);

const HTML_WHITESPACE_CODES = new Set([0x09, 0x0A, 0x0C, 0x0D, 0x20]);

function isAsciiLetterCode(code) {
    return (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A);
}

/**
 * Reads one tag from `html`, starting at the `<` at `start`, as the HTML tokenizer does.
 * @param {string} html
 * @param {number} start Index of the `<`
 * @returns {{ name: string, isClosing: boolean, end: number } | null} `end` is the index after the `>`; null for
 *   markup that is not a plain, complete tag (an unquoted `"` or `<` in an attribute, a missing `>`, and so on)
 */
function readHtmlTag(html, start) {
    const length = html.length;
    const isClosing = html.charCodeAt(start + 1) === 0x2F;
    const nameStart = start + (isClosing ? 2 : 1);
    let i = nameStart;
    while (i < length) {
        const code = html.charCodeAt(i);
        if (HTML_WHITESPACE_CODES.has(code) || code === 0x2F || code === 0x3E) break;
        i++;
    }
    const name = html.slice(nameStart, i).toLowerCase();

    while (i < length) {
        while (i < length && HTML_WHITESPACE_CODES.has(html.charCodeAt(i))) i++;
        const code = html.charCodeAt(i);
        if (code === 0x3E) {
            return { name, isClosing, end: i + 1 };
        }
        if (code === 0x2F) {
            if (html.charCodeAt(i + 1) !== 0x3E) return null;
            return { name, isClosing, end: i + 2 };
        }
        if (isClosing) return null;

        const attributeStart = i;
        while (i < length) {
            const c = html.charCodeAt(i);
            if (HTML_WHITESPACE_CODES.has(c) || c === 0x2F || c === 0x3E || c === 0x3D) break;
            if (c === 0x22 || c === 0x27 || c === 0x3C) return null;
            i++;
        }
        if (i === attributeStart) return null;
        while (i < length && HTML_WHITESPACE_CODES.has(html.charCodeAt(i))) i++;
        if (html.charCodeAt(i) !== 0x3D) continue;

        i++;
        while (i < length && HTML_WHITESPACE_CODES.has(html.charCodeAt(i))) i++;
        const quote = html.charCodeAt(i);
        if (quote === 0x22 || quote === 0x27) {
            const close = html.indexOf(String.fromCharCode(quote), i + 1);
            if (close === -1) return null;
            i = close + 1;
        } else {
            const valueStart = i;
            while (i < length) {
                const c = html.charCodeAt(i);
                if (HTML_WHITESPACE_CODES.has(c) || c === 0x3E) break;
                if (c === 0x22 || c === 0x27 || c === 0x3C || c === 0x3D || c === 0x60) return null;
                i++;
            }
            if (i === valueStart) return null;
        }
    }
    return null;
}

/**
 * Tells whether an HTML string closes everything that it opens, in order, so that the parser is in the same
 * state after it as before it. Only then does the string parse the same alone as it does inside a longer
 * document. It answers `false` for anything that it cannot show to be so: a missing, stray or misplaced end
 * tag, a start tag that relies on an implied end tag, a comment or tag that is not closed, a declaration or
 * processing instruction, and the elements in {@link HTML_STATEFUL_TAGS}.
 * @param {string} html HTML before it goes into the sanitizer
 * @returns {boolean}
 */
export function isHtmlSelfContained(html) {
    const source = String(html ?? '');
    /** @type {string[]} */
    const stack = [];
    let index = source.indexOf('<');

    while (index !== -1) {
        const next = source.charCodeAt(index + 1);
        if (source.startsWith('<!--', index)) {
            const end = source.indexOf('-->', index + 4);
            if (end === -1) return false;
            index = source.indexOf('<', end + 3);
            continue;
        }

        const isClosing = next === 0x2F;
        if (!isAsciiLetterCode(source.charCodeAt(index + (isClosing ? 2 : 1)))) {
            // `<!`, `<?` and `</` followed by a non-letter start a declaration, an instruction or a bogus comment.
            if (next === 0x21 || next === 0x3F || isClosing) return false;
            index = source.indexOf('<', index + 1);
            continue;
        }

        const tag = readHtmlTag(source, index);
        if (!tag) return false;
        const { name } = tag;

        if (tag.isClosing) {
            if (stack.pop() !== name || HTML_VOID_TAGS.has(name)) return false;
        } else if (HTML_STATEFUL_TAGS.has(name)) {
            return false;
        } else if (!HTML_VOID_TAGS.has(name)) {
            // The parser ignores a `/` on an HTML element that is not void, so `<div/>` opens a div.
            stack.push(name);
            if (HTML_RAW_TEXT_TAGS.has(name)) {
                const closer = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
                closer.lastIndex = tag.end;
                const found = closer.exec(source);
                if (!found) return false;
                const closeTag = readHtmlTag(source, found.index);
                if (!closeTag) return false;
                stack.pop();
                index = source.indexOf('<', closeTag.end);
                continue;
            }
        }
        index = source.indexOf('<', tag.end);
    }

    return stack.length === 0;
}

// `messageFormatting` rewrites `&amp;` to `&` inside each run that its pattern `<code(.*)>[\s\S]*?<\/code>` matches.
// A run reaches from a `<code` to a `</code>` of a later block, and where a run ends decides where the next one
// starts, so a block has no run of its own. The rewrite changes what the user sees only when the `&` is followed
// by a character reference: a `#`, or a name of at least two letters or digits.
const ENTITY_LIKE_AMPERSAND_RE = /&(?:#|[A-Za-z][A-Za-z0-9])/;

// The pattern of `messageFormatting` that wraps double quotes in `<q>`, with a capture group around each
// alternative that can run across blank lines. Its backtick, tilde-fence and `<style>` alternatives can pair
// with text of a later block.
const QUOTE_WRAP_SCAN_RE = /(<style>[\s\S]*?<\/style>)|(```[\s\S]*?```)|(~~~[\s\S]*?~~~)|(``[\s\S]*?``)|(`[\s\S]*?`)|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;
// `messageFormatting` hides quotes inside a `<...>` run from that pattern, and the run can reach into a later block.
const ANGLE_RUN_SCAN_RE = /<[^>]+>/g;
const AUTO_FIX_FENCE_OPENING_RE = /^[ \t]*(`{3,}|~{3,})([\s\S]*)$/;

/**
 * Tells whether the text of a block can pair with text after it in a step of `messageFormatting` that reads the
 * whole message, so that formatting the block alone could differ from formatting it inside the message:
 * - a backtick, `~~~` or `<style>` that the quote-wrapping pattern leaves unpaired inside the block;
 * - a run of backticks that the pattern pairs as a shorter run, because it finds no closer in the block, where a
 *   closer after the block would pair it as a longer run;
 * - a `<` with no `>` after it in the block;
 * - a fence that `fixMarkdown` opens in the block and does not close in it.
 * The pattern and the `<...>` run read the text after OOC extraction, so the scans do as well.
 * @param {string} block Markdown source of one settled block
 * @returns {boolean}
 */
export function hasCrossBlockTextHazard(block) {
    if (!block.includes('<') && !block.includes('`') && !block.includes('~~~')) {
        return false;
    }

    const text = extractOocBlocksForDisplay(block, []);

    if (text.includes('<')) {
        let rest = '';
        let last = 0;
        ANGLE_RUN_SCAN_RE.lastIndex = 0;
        for (let match = ANGLE_RUN_SCAN_RE.exec(text); match; match = ANGLE_RUN_SCAN_RE.exec(text)) {
            rest += text.slice(last, match.index);
            last = match.index + match[0].length;
        }
        rest += text.slice(last);
        if (rest.includes('<')) return true;
    }

    if (text.includes('`') || text.includes('~~~') || /<style>/i.test(text)) {
        let rest = '';
        let last = 0;
        QUOTE_WRAP_SCAN_RE.lastIndex = 0;
        for (let match = QUOTE_WRAP_SCAN_RE.exec(text); match; match = QUOTE_WRAP_SCAN_RE.exec(text)) {
            if (match[2] || match[4] || match[5]) {
                let run = 0;
                while (text.charCodeAt(match.index + run) === 0x60) run++;
                const openerLength = match[2] ? 3 : match[4] ? 2 : 1;
                if (openerLength < Math.min(run, 3)) return true;
            }
            rest += text.slice(last, match.index);
            last = match.index + match[0].length;
        }
        rest += text.slice(last);
        if (rest.includes('`') || rest.includes('~~~') || /<style>/i.test(rest)) return true;
    }

    if (block.includes('`') || block.includes('~~~')) {
        let fence = '';
        for (const line of block.split('\n')) {
            if (fence) {
                const marks = line.trim();
                if (marks.length >= fence.length && marks === fence[0].repeat(marks.length)) fence = '';
                continue;
            }
            const opening = AUTO_FIX_FENCE_OPENING_RE.exec(line);
            if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) fence = opening[1];
        }
        if (fence) return true;
    }

    return false;
}

/**
 * Creates a stateful incremental block formatter for a streamed message. It formats each settled block once,
 * keeps the result until `reset()`, and formats the rest of the message (the tail, and any
 * settled block that cannot stand alone) in one `formatFn` call, so the output equals `formatFn(markdown)` at every
 * tick. It formats the whole message in one call when `getSignature` returns `null`, and on `isFinal`.
 *
 * A settled block is reused only while all of these hold:
 * - `getSignature` returns a key, and the key is the one the block was formatted under;
 * - the splitter ends the block outside every construct that spans blank lines;
 * - the HTML that `formatFn` hands to `onConvertedHtml` for the block is self-contained ({@link isHtmlSelfContained});
 * - the text of the block has no {@link hasCrossBlockTextHazard};
 * - the text holds no `&` that is followed by a character reference while a block that was reused holds a `<code`
 *   (see {@link ENTITY_LIKE_AMPERSAND_RE}).
 * The first block that fails ends the reused prefix, and the message text from there on is formatted whole.
 * A `formatFn` that never calls `onConvertedHtml` therefore never has a block reused.
 *
 * @param {(markdown: string, hooks?: { onConvertedHtml: (html: string) => void }) => string} formatFn Full
 *   Markdown + DOMPurify formatter, never bypassed
 * @param {object} [options]
 * @param {(markdown: string) => string | null} [options.getSignature] Returns a key for the settings and message
 *   state that shape the output of `formatFn`, or `null` when `formatFn` reads text outside a block and the whole
 *   message must be formatted in one call. Read on every tick. Formatted blocks are dropped when the key changes.
 * @returns {{ format: (markdown: string, options?: { isFinal?: boolean }) => string, reset: () => void }}
 */
export function createIncrementalBlockFormatter(formatFn, { getSignature = () => '' } = {}) {
    /** @type {Map<string, { text: string, html: string | null, standsAlone: boolean, hasCode: boolean }>} Formatted blocks by text. */
    const entriesByText = new Map();
    const MAX_CACHED_BLOCKS = 256;
    let signature = null;

    function formatBlock(text) {
        let convertedHtml = null;
        const html = formatFn(text, { onConvertedHtml: (value) => { convertedHtml = value; } });
        const standsAlone = convertedHtml !== null && !hasCrossBlockTextHazard(text) && isHtmlSelfContained(convertedHtml);
        return { text, html: standsAlone ? html : null, standsAlone, hasCode: standsAlone && convertedHtml.includes('<code') };
    }

    return {
        format(markdown, { isFinal = false } = {}) {
            const source = String(markdown ?? '');
            if (!source) {
                return formatFn(source);
            }
            if (isFinal) {
                entriesByText.clear();
                signature = null;
                return formatFn(source);
            }

            const nextSignature = getSignature(source);
            if (nextSignature === null) {
                return formatFn(source);
            }
            if (nextSignature !== signature) {
                entriesByText.clear();
                signature = nextSignature;
            }

            const split = splitStreamingBlocks(source, { isFinal: false });
            if (!split.canReusePrefix || split.prefixBlocks.length === 0) {
                return formatFn(source);
            }

            const { prefixBlocks } = split;
            const htmlParts = [];
            let reusedHasCode = false;
            let reused = 0;
            for (; reused < prefixBlocks.length; reused++) {
                let entry = entriesByText.get(prefixBlocks[reused]);
                if (!entry) {
                    entry = formatBlock(prefixBlocks[reused]);
                    if (entriesByText.size >= MAX_CACHED_BLOCKS) {
                        entriesByText.delete(entriesByText.keys().next().value);
                    }
                    entriesByText.set(prefixBlocks[reused], entry);
                }
                if (!entry.standsAlone) {
                    break;
                }
                reusedHasCode ||= entry.hasCode;
                if (entry.html) {
                    htmlParts.push(entry.html);
                }
            }

            if (reusedHasCode && ENTITY_LIKE_AMPERSAND_RE.test(source)) {
                return formatFn(source);
            }

            const tailText = reused === prefixBlocks.length ? split.tail : source.slice(prefixBlocks.slice(0, reused).join('').length);
            const tailHtml = tailText ? formatFn(tailText) : '';
            if (tailHtml) {
                htmlParts.push(tailHtml);
            }
            return htmlParts.join('\n');
        },
        reset() {
            entriesByText.clear();
            signature = null;
        },
    };
}
