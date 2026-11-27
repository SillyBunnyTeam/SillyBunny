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
