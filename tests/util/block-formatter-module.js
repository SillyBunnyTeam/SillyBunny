import vm from 'node:vm';
import { extractOocBlocksForDisplay } from '../../public/scripts/ooc-blocks.js';
import { loadDeclarations } from './load-declarations.js';

const NAMES = [
    'MARKDOWN_BLANK_LINE_RE',
    'UNSPLITTABLE_HTML_TAGS',
    'REFERENCE_DEF_RE',
    'REFERENCE_LINK_USE_RE',
    'FENCE_OPEN_OR_CLOSE_RE',
    'HTML_TAG_TOKEN_RE',
    'LIST_MARKER_SOURCE',
    'LIST_ITEM_START_RE',
    'LIST_ITEM_LINE_RE',
    'INDENTED_CODE_START_RE',
    'INDENTED_CODE_LINE_RE',
    'LIST_CONTINUATION_INDENT_RE',
    'CONTINUATION_BLOCK_START_RE',
    'lastNonBlankLine',
    'splitStreamingBlocks',
    'HTML_VOID_TAGS',
    'HTML_RAW_TEXT_TAGS',
    'HTML_STATEFUL_TAGS',
    'HTML_WHITESPACE_CODES',
    'isAsciiLetterCode',
    'readHtmlTag',
    'isHtmlSelfContained',
    'ENTITY_LIKE_AMPERSAND_RE',
    'QUOTE_WRAP_SCAN_RE',
    'ANGLE_RUN_SCAN_RE',
    'AUTO_FIX_FENCE_OPENING_RE',
    'hasCrossBlockTextHazard',
    'createIncrementalBlockFormatter',
];

const DOM_NAMES = [
    'MAX_TAIL_SEGMENTS',
    'TAIL_COLLAPSE_STEP',
    'SETTLE_FADE_MS',
    'DESCENDABLE_CONTAINER_TAGS',
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
];

/**
 * Loads the DOM side of `stream-fadein.js` (`applyStreamFadeIn` and what it needs) next to the block formatter,
 * on a real jsdom window and the real morphdom.
 * @param {import('jsdom').DOMWindow} window jsdom window whose document the patched elements belong to
 * @param {Function} morphdom The morphdom function
 * @returns {Record<string, any>}
 */
export function loadStreamFadeInModule(window, morphdom) {
    const context = vm.createContext({
        extractOocBlocksForDisplay,
        document: window.document,
        window,
        Node: window.Node,
        Element: window.Element,
        HTMLElement: window.HTMLElement,
        NodeFilter: window.NodeFilter,
        Intl, String, RegExp, Set, Map, WeakMap, Date, Array, Number,
        setTimeout,
        clearTimeout,
        morphdom,
    });
    const names = [...NAMES.slice(0, NAMES.indexOf('splitStreamingBlocks')), ...DOM_NAMES, ...NAMES.slice(NAMES.indexOf('splitStreamingBlocks'))];
    const present = names.filter((name, index) => names.indexOf(name) === index);
    loadDeclarations(context, 'scripts/util/stream-fadein.js', present);
    return Object.fromEntries(present.map(name => [name, vm.runInContext(name, context)]));
}

/**
 * Loads the block splitting and incremental formatting declarations of `stream-fadein.js` in a vm context.
 * The module is not imported, because it imports the browser bundle.
 * @returns {{
 *   splitStreamingBlocks: Function,
 *   createIncrementalBlockFormatter: Function,
 *   isHtmlSelfContained: Function,
 *   hasCrossBlockTextHazard: Function,
 * }}
 */
export function loadBlockFormatterModule() {
    const context = vm.createContext({ extractOocBlocksForDisplay, String, RegExp, Set });
    loadDeclarations(context, 'scripts/util/stream-fadein.js', NAMES);
    return Object.fromEntries(NAMES.map(name => [name, vm.runInContext(name, context)]));
}
