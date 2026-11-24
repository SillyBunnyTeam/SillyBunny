import { morphdom } from '../../lib.js';

/** Maximum `.text_segment` spans kept live in the active streaming tail (< 60 budget). */
const MAX_TAIL_SEGMENTS = 48;
/** Batch size used when collapsing older `.text_segment` spans inside a single long block. */
const TAIL_COLLAPSE_STEP = 24;
/** Delay after `.text_segment` CSS fade-in (300ms) before settled prefix blocks collapse spans. */
const SETTLE_FADE_MS = 320;

const DESCENDABLE_CONTAINER_TAGS = new Set([
    'UL', 'OL', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE',
]);

const UNSPLITTABLE_HTML_TAGS = new Set([
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul',
    'script', 'noscript', 'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header',
    'footer', 'nav', 'article', 'aside', 'address', 'audio', 'canvas', 'figure', 'hgroup',
    'output', 'video', 'details', 'svg',
]);

const REFERENCE_DEF_RE = /^[ \t]{0,3}\[[^\r\n\]]+\]:[ \t]*/m;
const REFERENCE_LINK_USE_RE = /\]\[[^\r\n\]]*\]/;
const FENCE_OPEN_OR_CLOSE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const HTML_TAG_TOKEN_RE = /<!--|-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*?)(\/?)>/g;
const LIST_ITEM_START_RE = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]/;
const CONTINUATION_BLOCK_START_RE = /^(?:[ \t]{4,}|[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]|[ \t]{0,3}>|[ \t]{0,3}\||[ \t]{0,3}(?:===+|---+)[ \t]*(?:\r?\n|$))/;

/** @type {Map<string, Intl.Segmenter>} */
const segmenterCache = new Map();

/**
 * Metadata for blocks that still contain live `.text_segment` spans from a recent tail render.
 * @type {WeakMap<Element, { unsegmentedClone: Element, childCount: number, textContent: string, collapsedCount: number }>}
 */
const segmentedBlockRecords = new WeakMap();

/** @type {WeakMap<HTMLElement, Set<Element>>} */
const pendingSegmentedElementsByRoot = new WeakMap();

/** @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
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
 * Schedules cleanup of `.text_segment` spans on blocks that are no longer the active tail.
 * @param {HTMLElement} messageTextElement
 * @param {Element} segmentedElement
 */
function trackSegmentedElementForSettle(messageTextElement, segmentedElement) {
    if (segmentedElement === messageTextElement) {
        return;
    }

    let pending = pendingSegmentedElementsByRoot.get(messageTextElement);
    if (!pending) {
        pending = new Set();
        pendingSegmentedElementsByRoot.set(messageTextElement, pending);
    }
    pending.add(segmentedElement);

    const existingTimer = settleTimerByRoot.get(messageTextElement);
    if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        settleTimerByRoot.delete(messageTextElement);
        const tracked = pendingSegmentedElementsByRoot.get(messageTextElement);
        if (!tracked || tracked.size === 0) {
            return;
        }
        const currentTail = messageTextElement.isConnected ? findActiveTailElement(messageTextElement) : null;
        for (const el of Array.from(tracked)) {
            if (!el.isConnected) {
                tracked.delete(el);
                segmentedBlockRecords.delete(el);
                continue;
            }
            if (el !== currentTail) {
                collapseTextSegments(el);
                tracked.delete(el);
            }
        }
    }, SETTLE_FADE_MS);
    timer?.unref?.();
    settleTimerByRoot.set(messageTextElement, timer);
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
    if (bypassFadeIn || isFinal) {
        const existingTimer = settleTimerByRoot.get(messageTextElement);
        if (existingTimer !== undefined) {
            clearTimeout(existingTimer);
            settleTimerByRoot.delete(messageTextElement);
        }
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
        const isBlankLine = line.trim().length === 0;

        if (!inHtmlComment && oocDepth === 0 && htmlTagStack.length === 0) {
            const fenceMatch = FENCE_OPEN_OR_CLOSE_RE.exec(line);
            if (fenceMatch) {
                const marker = fenceMatch[1];
                const rest = fenceMatch[2];
                if (fenceLength === 0) {
                    if (!(marker[0] === '`' && rest.includes('`'))) {
                        fenceChar = marker[0];
                        fenceLength = marker.length;
                        sawContentInBlock = true;
                        lineStart = lineEnd;
                        continue;
                    }
                } else if (marker[0] === fenceChar && marker.length >= fenceLength && rest.trim() === '') {
                    fenceChar = '';
                    fenceLength = 0;
                    sawContentInBlock = true;
                    lineStart = lineEnd;
                    continue;
                }
            }
        }

        if (fenceLength === 0) {
            // Track OOC (( ... )) outside HTML comments
            if (!inHtmlComment && (oocDepth > 0 || line.includes('(('))) {
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

        const isTopLevel = fenceLength === 0 && oocDepth === 0 && !inHtmlComment && htmlTagStack.length === 0;
        if (isTopLevel && isBlankLine && sawContentInBlock) {
            // Absorb consecutive blank lines into the completed block's trailing separator.
            while (lineEnd < source.length) {
                const nextNl = source.indexOf('\n', lineEnd);
                const nextEnd = nextNl === -1 ? source.length : nextNl + 1;
                const nextBodyEnd = nextNl === -1
                    ? source.length
                    : (nextNl > lineEnd && source.charCodeAt(nextNl - 1) === 0x0D ? nextNl - 1 : nextNl);
                if (source.slice(lineEnd, nextBodyEnd).trim().length !== 0) {
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

    // Merge adjacent blocks that can coalesce in Markdown (loose lists, indented continuations, tables, blockquotes).
    /** @type {string[]} */
    const blocks = [];
    for (const block of rawBlocks) {
        if (blocks.length > 0) {
            const prev = blocks[blocks.length - 1];
            const prevTrimmed = prev.replace(/^\s+/, '');
            const currTrimmed = block.replace(/^\s+/, '');
            const bothLists = LIST_ITEM_START_RE.test(prevTrimmed) && (LIST_ITEM_START_RE.test(currTrimmed) || /^[ \t]{2,}/.test(block));
            const bothQuotes = prevTrimmed.startsWith('>') && currTrimmed.startsWith('>');
            const bothTables = prevTrimmed.startsWith('|') && currTrimmed.startsWith('|');
            if (bothLists || bothQuotes || bothTables) {
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

/**
 * Creates a stateful incremental block formatter that caches formatted HTML of settled
 * prefix blocks while ALWAYS running the full formatter + sanitizer (`formatFn`) on the
 * active tail, and running a single full-document pass on `isFinal = true` for 100% parity.
 *
 * @param {(markdown: string) => string} formatFn Full Markdown + DOMPurify formatter (never bypassed)
 * @returns {{ format: (markdown: string, options?: { isFinal?: boolean }) => string, reset: () => void }}
 */
export function createIncrementalBlockFormatter(formatFn) {
    /** @type {Map<string, string>} */
    const blockHtmlCache = new Map();
    const MAX_CACHED_BLOCKS = 256;

    return {
        format(markdown, { isFinal = false } = {}) {
            const source = String(markdown ?? '');
            if (!source) {
                return formatFn(source);
            }
            if (isFinal) {
                blockHtmlCache.clear();
                return formatFn(source);
            }

            const split = splitStreamingBlocks(source, { isFinal: false });
            if (!split.canReusePrefix || split.prefixBlocks.length === 0) {
                return formatFn(source);
            }

            let prefixHtml = '';
            for (const block of split.prefixBlocks) {
                let cached = blockHtmlCache.get(block);
                if (cached === undefined) {
                    cached = formatFn(block);
                    if (blockHtmlCache.size >= MAX_CACHED_BLOCKS) {
                        const oldest = blockHtmlCache.keys().next().value;
                        blockHtmlCache.delete(oldest);
                    }
                    blockHtmlCache.set(block, cached);
                }
                prefixHtml += cached;
            }

            const tailHtml = split.tail ? formatFn(split.tail) : '';
            return prefixHtml && tailHtml ? `${prefixHtml}\n${tailHtml}` : (prefixHtml || tailHtml);
        },
        reset() {
            blockHtmlCache.clear();
        },
    };
}
