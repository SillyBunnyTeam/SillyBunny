import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { parse as parseCss, stringify as stringifyCss } from '@adobe/css-tools';
import markdownit from 'markdown-it';
import * as markdownItEmojiNs from 'markdown-it-emoji';
import markdownItCjkFriendlyNs from 'markdown-it-cjk-friendly';
import showdown from 'showdown';
import morphdom from 'morphdom';
import { loadDeclarations } from './load-declarations.js';
import { autoFixMarkdown } from '../../public/scripts/auto-fix-markdown.js';
import {
    CARD_SCRIPT_MARKER_TAG,
    containsEmbeddedCardScript,
    markCardScriptHtml,
} from '../../public/scripts/card-script-detection.js';
import { MARKDOWN_ENGINES, createMarkdownItConverter, normalizeMarkdownEngine } from '../../public/scripts/markdown-engine.js';
import {
    extractOocBlocksForDisplay,
    restoreOocBlocksForDisplay,
} from '../../public/scripts/ooc-blocks.js';
import { removeUnscopableCss } from '../../public/scripts/sillybunny-style-tag-scope.js';

const markdownItCjkFriendly = markdownItCjkFriendlyNs.default ?? markdownItCjkFriendlyNs;
const markdownItEmoji = markdownItEmojiNs.full ?? markdownItEmojiNs.default ?? markdownItEmojiNs;

/**
 * Builds the real `messageFormatting` of script.js (real DOMPurify on jsdom, the real converters and the real
 * `chats.js` sanitiser hooks). Only application state is stubbed: settings, the chat array, regex scripts, macros.
 *
 * `state.regexScript` is a function applied to the whole message text, as a regex script is, and
 * `state.regexActive` is what `hasApplicableRegexScripts` answers; keep them in step.
 * @param {object} [options]
 * @param {'markdown-it' | 'showdown'} [options.engine] Markdown engine
 * @param {object} [options.powerUser] Overrides for the `power_user` settings
 * @returns {Promise<object>}
 */
export async function createMessageFormatPipeline({ engine = 'markdown-it', powerUser = {} } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:4444/' });
    const w = dom.window;
    const DOMPurify = createDOMPurify(w);

    const state = {
        regexScript: (text) => text,
        regexActive: false,
        hooks: false,
        agentScripts: [],
        promptBias: '',
        nonMarkdownStrings: '',
        power_user: {
            markdown_engine: engine,
            auto_fix_generated_markdown: true,
            encode_tags: false,
            show_user_prompt_bias: true,
            allow_name2_display: true,
            markdown_escape_strings: '',
            reasoning: { prefix: '', suffix: '' },
            ...powerUser,
        },
    };

    const converter = engine === 'showdown'
        ? new showdown.Converter({
            emoji: true, literalMidWordUnderscores: true, parseImgDimensions: true, tables: true, underline: true,
            simpleLineBreaks: true, strikethrough: true, disableForced4SpacesIndentedSublists: true,
        })
        : createMarkdownItConverter(
            { markdownit, markdownItEmoji, markdownItCjkFriendly },
            { getNonMarkdownStrings: () => state.nonMarkdownStrings },
        );

    const chat = [
        { name: 'Char', mes: '', is_user: false, is_system: false, extra: {} },
        { name: 'Char', mes: '', is_user: false, is_system: false, extra: {} },
    ];
    const context = vm.createContext({
        console,
        css: { parse: parseCss, stringify: stringifyCss },
        removeUnscopableCss,
        isExternalMediaAllowed: () => false,
        DOMPurify,
        HTMLUnknownElement: w.HTMLUnknownElement,
        HTMLMediaElement: w.HTMLMediaElement,
        Element: w.Element,
        NodeFilter: w.NodeFilter,
        document: w.document,
        window: w,
        getCurrentEntityId: () => 'char-1',
        accountStorage: { getItem: () => 'shown', setItem: () => {} },
        toastr: { warning() {}, clear() {} },
        t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        chat,
        power_user: state.power_user,
        substituteParams: (text) => text,
        getEffectivePromptBias: () => state.promptBias,
        getRegexedString: (text) => state.regexScript(text),
        hasApplicableRegexScripts: () => state.regexActive,
        regex_placement: { REASONING: 6, USER_INPUT: 1, SLASH_COMMAND: 3, AI_OUTPUT: 2 },
        getNonSystemMessageDepth: () => 0,
        resolveRegexScriptsForSnapshot: () => state.agentScripts,
        applyRegexScriptList: (text) => text,
        AGENT_REGEX_PLACEMENT: { AI_OUTPUT: 2 },
        substituteParamsExtended: (text) => text,
        COMMENT_NAME_DEFAULT: 'comment',
        systemUserName: 'System',
        MessageFormatter: {
            runStage: (_stage, text) => text,
            hasHooks: () => state.hooks,
            stage: { BEFORE_REGEX: 'beforeRegex', AFTER_REGEX: 'afterRegex', AFTER_MARKDOWN: 'afterMarkdown' },
        },
        fixMarkdown: (text, forDisplay) => autoFixMarkdown(text, forDisplay),
        extractOocBlocksForDisplay,
        restoreOocBlocksForDisplay,
        canUseNegativeLookbehind: () => true,
        escapeHtml: (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        escapeRegex: (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        markCardScriptHtml,
        containsEmbeddedCardScript,
        CARD_SCRIPT_MARKER_TAG,
        MARKDOWN_ENGINES,
        normalizeMarkdownEngine,
        isOdd: (n) => n % 2 === 1,
        countOccurrences: (text, part) => text.split(part).length - 1,
        converter,
    });
    context.globalThis = context;

    loadDeclarations(context, 'scripts/chats.js', [
        'STYLE_ENCODE_REGEX', 'STYLE_DECODE_REGEX', 'PSEUDO_SELECTOR_REGEX', 'CLASS_SELECTOR_REGEX',
        'SANITIZED_STYLE_CACHE_LIMIT', 'sanitizedStyleCache', 'EXTERNAL_MEDIA_TAG_NAMES',
        'sanitizeSimpleSelector', 'sanitizeSelector', 'encodeStyleTags', 'decodeStyleTags', 'addDOMPurifyHooks',
    ]);
    vm.runInContext('addDOMPurifyHooks()', context);
    loadDeclarations(context, 'script.js', [
        'getDisplayRegexPlacement', 'prepareMessageDisplayText', 'balanceStreamingMarkdown', 'sanitizeMessageHtml',
        'messageFormatting', 'getStreamingBlockFormatSignature',
    ]);

    const messageFormatting = vm.runInContext('messageFormatting', context);
    const signature = vm.runInContext('getStreamingBlockFormatSignature', context);

    const normalize = (html) => {
        const root = w.document.createElement('div');
        root.innerHTML = html;
        for (const child of [...root.childNodes]) {
            if (child.nodeType === 3 && /^\s*$/.test(child.data)) child.remove();
        }
        root.normalize();
        return root.innerHTML;
    };

    return {
        state,
        window: w,
        DOMPurify,
        /** The whole-message format of the streaming renderer, as `onProgressStreaming` calls it. */
        format: (text, hooks) => messageFormatting(text, 'Char', false, false, 1, {}, false, hooks?.onConvertedHtml),
        /** What `onProgressStreaming` hands to the incremental formatter as `getSignature`. */
        getSignature: (source) => signature(source, 1, 'Char', false, false),
        signature,
        /** The text of a streamed message at one tick, as `formatText` prepares it. */
        balance: vm.runInContext('balanceStreamingMarkdown', context),
        /** The visible content of a rendering: markup without the whitespace between top-level blocks. */
        normalize,
        morphdom,
        cleanup: () => w.close(),
    };
}
