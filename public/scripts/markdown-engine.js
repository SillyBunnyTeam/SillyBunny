export const MARKDOWN_ENGINES = Object.freeze({
    SHOWDOWN: 'showdown',
    MARKDOWN_IT: 'markdown-it',
});

/**
 * @param {unknown} value Stored engine setting
 * @returns {string} The engine id, or Showdown for a missing or unknown value
 */
export function normalizeMarkdownEngine(value) {
    return value === MARKDOWN_ENGINES.MARKDOWN_IT ? MARKDOWN_ENGINES.MARKDOWN_IT : MARKDOWN_ENGINES.SHOWDOWN;
}

// The tag list of Showdown's hashHTMLBlocks, so that both engines keep the same HTML blocks raw.
const SHOWDOWN_BLOCK_TAGS = [
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul', 'script', 'noscript',
    'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header', 'footer', 'nav', 'article', 'aside', 'address',
    'audio', 'canvas', 'figure', 'hgroup', 'output', 'video', 'p',
];
const BLOCK_OPEN_TAG_RE = new RegExp(`<(${SHOWDOWN_BLOCK_TAGS.join('|')})\\b[^>]*>`, 'iy');
const HR_LINE_RE = /^<hr\b[^<>]*?\/?>[ \t]*$/;
const MARKDOWN_ATTRIBUTE_RE = /\bmarkdown\b/;
const IMAGE_DIMENSIONS_RE = /[ \t]+=([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4})/y;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ASCII_PUNCTUATION_RE = /[!-/:-@[-`{-~]/g;
const TEXT_ESCAPE_RE = /[&<>]/g;
const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Escapes text content as Showdown does. Double quotes stay literal, because code after the Markdown step reads
 * the HTML string.
 * @param {string} value Text content
 * @returns {string} Escaped text
 */
function escapeText(value) {
    return value.replace(TEXT_ESCAPE_RE, char => TEXT_ESCAPES[char]);
}

/**
 * @param {string} src Source text
 * @param {number} from Index after the opening tag
 * @param {string} tag Lowercase tag name
 * @param {number} limit Index where the search stops
 * @returns {number} Index after the matching closing tag, or -1
 */
function findClosingTag(src, from, tag, limit) {
    const tagRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
    tagRe.lastIndex = from;
    let depth = 1;
    for (let match = tagRe.exec(src); match && tagRe.lastIndex <= limit; match = tagRe.exec(src)) {
        depth += match[0][1] === '/' ? -1 : 1;
        if (depth === 0) {
            return tagRe.lastIndex;
        }
    }
    return -1;
}

/**
 * Finds the end of an HTML comment. As in Showdown, a comment nests only where `<!--` starts a line.
 * @param {string} src Source text
 * @param {number} from Index after the opening `<!--`
 * @param {number} limit Index where the search stops
 * @returns {number} Index after the matching `-->`, or -1
 */
function findCommentEnd(src, from, limit) {
    const markerRe = /\n {0,3}<!--|-->/g;
    markerRe.lastIndex = from;
    let depth = 1;
    for (let match = markerRe.exec(src); match && markerRe.lastIndex <= limit; match = markerRe.exec(src)) {
        depth += match[0] === '-->' ? -1 : 1;
        if (depth === 0) {
            return markerRe.lastIndex;
        }
    }
    return -1;
}

/**
 * @param {any} state Block state
 * @param {number} startLine Line where the block starts
 * @param {number} endLine Line after the last line of the container
 * @returns {{ end: number, tag?: string, markdown?: boolean } | null} The block, or null when the line starts none
 */
function matchShowdownHtmlBlock(state, startLine, endLine) {
    const src = state.src;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const limit = state.eMarks[endLine - 1];

    if (src.startsWith('<!--', start)) {
        const end = findCommentEnd(src, start + 4, limit);
        return end < 0 ? null : { end };
    }

    if (HR_LINE_RE.test(src.slice(start, state.eMarks[startLine]))) {
        const nextLine = startLine + 1;
        return nextLine >= endLine || state.isEmpty(nextLine) ? { end: state.eMarks[startLine] } : null;
    }

    BLOCK_OPEN_TAG_RE.lastIndex = start;
    const openTag = BLOCK_OPEN_TAG_RE.exec(src);
    if (!openTag || BLOCK_OPEN_TAG_RE.lastIndex > limit) {
        return null;
    }

    const tag = openTag[1].toLowerCase();
    const end = findClosingTag(src, BLOCK_OPEN_TAG_RE.lastIndex, tag, limit);
    return end < 0 ? null : { end, tag, markdown: MARKDOWN_ATTRIBUTE_RE.test(openTag[0]) };
}

/**
 * Makes a line start at a position inside it, as if the text before that position were on a line of its own.
 * @param {any} state Block state
 * @param {number} line Line to change
 * @param {number} pos New start of the line
 */
function startLineAt(state, line, pos) {
    let shift = 0;
    let column = state.blkIndent;
    for (let index = pos; index < state.eMarks[line]; index++, shift++) {
        const code = state.src.charCodeAt(index);
        if (code === 0x20) {
            column++;
        } else if (code === 0x09) {
            column += 4 - column % 4;
        } else {
            break;
        }
    }
    state.bMarks[line] = pos;
    state.tShift[line] = shift;
    state.sCount[line] = column;
    state.bsCount[line] = state.blkIndent;
}

/**
 * Builds a block rule that keeps HTML blocks raw the way Showdown's hashHTMLBlocks does. A tag from Showdown's
 * list that starts a line is kept through its matching closing tag, across blank lines, and text after that
 * tag on the same line starts a new block. Other tags stay inline, so Markdown inside them is parsed.
 * @param {(text: string) => string} renderMarkdown Renders the content of a block whose opening tag has a
 * `markdown` attribute
 * @returns {(state: any, startLine: number, endLine: number, silent: boolean) => boolean} Block rule
 */
function createShowdownHtmlBlockRule(renderMarkdown) {
    return function showdownHtmlBlock(state, startLine, endLine, silent) {
        if (state.sCount[startLine] - state.blkIndent >= 4) {
            return false;
        }
        if (state.src.charCodeAt(state.bMarks[startLine] + state.tShift[startLine]) !== 0x3C) {
            return false;
        }

        const block = matchShowdownHtmlBlock(state, startLine, endLine);
        if (!block) {
            return false;
        }
        if (silent) {
            return true;
        }

        let lastLine = startLine;
        while (lastLine < endLine - 1 && state.eMarks[lastLine] < block.end) {
            lastLine++;
        }
        const lineEnd = state.eMarks[lastLine];
        const hasTextAfter = state.src.slice(block.end, lineEnd).trim() !== '';

        state.eMarks[lastLine] = block.end;
        let content = state.getLines(startLine, lastLine + 1, state.blkIndent, false).trimEnd();
        state.eMarks[lastLine] = lineEnd;

        BLOCK_OPEN_TAG_RE.lastIndex = content.length - content.trimStart().length;
        if (block.markdown && BLOCK_OPEN_TAG_RE.exec(content)) {
            const innerStart = BLOCK_OPEN_TAG_RE.lastIndex;
            const innerEnd = content.length - block.tag.length - 3;
            content = content.slice(0, innerStart) + renderMarkdown(content.slice(innerStart, innerEnd)) + content.slice(innerEnd);
        }

        const token = state.push('html_block', '', 0);
        token.map = [startLine, lastLine + 1];
        token.content = `${content}\n`;

        if (hasTextAfter) {
            startLineAt(state, lastLine, block.end);
            state.md.block.tokenize(state, lastLine, endLine);
        } else {
            state.line = lastLine + 1;
        }
        return true;
    };
}

/**
 * @param {string} src Source text
 * @param {number} pos Start index
 * @param {number} max End index
 * @returns {number} Index of the first character that is not a space, tab or newline
 */
function skipLinkWhitespace(src, pos, max) {
    while (pos < max && [0x20, 0x09, 0x0A].includes(src.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

/**
 * Inline rule for Showdown's image size syntax, `![alt](url =WIDTHxHEIGHT "title")`. A `*` size is left out.
 * Images without a size go on to the standard image rule.
 * @param {any} state Inline state
 * @param {boolean} silent Whether to only check for a match
 * @returns {boolean} Whether an image was found
 */
function imageWithDimensions(state, silent) {
    const src = state.src;
    const max = state.posMax;
    if (src.charCodeAt(state.pos) !== 0x21 || src.charCodeAt(state.pos + 1) !== 0x5B) {
        return false;
    }

    const labelStart = state.pos + 2;
    const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1, false);
    if (labelEnd < 0 || src.charCodeAt(labelEnd + 1) !== 0x28) {
        return false;
    }

    const destination = state.md.helpers.parseLinkDestination(src, skipLinkWhitespace(src, labelEnd + 2, max), max);
    if (!destination.ok) {
        return false;
    }
    const href = state.md.normalizeLink(destination.str);
    if (!state.md.validateLink(href)) {
        return false;
    }

    IMAGE_DIMENSIONS_RE.lastIndex = destination.pos;
    const size = IMAGE_DIMENSIONS_RE.exec(src);
    if (!size || IMAGE_DIMENSIONS_RE.lastIndex > max) {
        return false;
    }

    const titleStart = IMAGE_DIMENSIONS_RE.lastIndex;
    let pos = skipLinkWhitespace(src, titleStart, max);
    let title = '';
    const parsedTitle = state.md.helpers.parseLinkTitle(src, pos, max);
    if (pos < max && pos !== titleStart && parsedTitle.ok) {
        title = parsedTitle.str;
        pos = skipLinkWhitespace(src, parsedTitle.pos, max);
    }
    if (pos >= max || src.charCodeAt(pos) !== 0x29) {
        return false;
    }

    if (!silent) {
        const content = src.slice(labelStart, labelEnd);
        const children = [];
        state.md.inline.parse(content, state.md, state.env, children);
        const token = state.push('image', 'img', 0);
        token.attrs = [['src', href], ['alt', '']];
        token.children = children;
        token.content = content;
        if (title) {
            token.attrs.push(['title', title]);
        }
        if (size[1] !== '*') {
            token.attrs.push(['width', size[1]]);
        }
        if (size[2] !== '*') {
            token.attrs.push(['height', size[2]]);
        }
    }

    state.pos = pos + 1;
    return true;
}

/**
 * Turns three dots into an ellipsis, as Showdown's default `ellipsis` option does. Escaped dots stay, because this
 * runs before markdown-it joins escaped characters into text.
 * @param {any} state Core state
 */
function replaceEllipsis(state) {
    for (const blockToken of state.tokens) {
        if (blockToken.type !== 'inline') {
            continue;
        }
        for (const token of blockToken.children) {
            if (token.type === 'text' && token.content.includes('...')) {
                token.content = token.content.replaceAll('...', '\u2026');
            }
        }
    }
}

/**
 * Makes each line that equals a "Non-markdown strings" entry render as literal text, and puts a blank line after
 * it, as Showdown's exclusion extension does. Lines inside fenced code blocks stay as they are.
 * @param {string} text Markdown source
 * @param {string} nonMarkdownStrings Comma-separated strings
 * @returns {string} Markdown source with those lines escaped
 */
function escapeNonMarkdownLines(text, nonMarkdownStrings) {
    const strings = String(nonMarkdownStrings ?? '').split(',').filter(value => value.length > 0);
    if (strings.length === 0) {
        return text;
    }

    let openFence = '';
    return text.replace(/\r\n?/g, '\n').split('\n').map((line) => {
        const fence = FENCE_LINE_RE.exec(line);
        if (openFence) {
            if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length && fence[2].trim() === '') {
                openFence = '';
            }
            return line;
        }
        if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
            openFence = fence[1];
            return line;
        }
        return strings.includes(line) ? `${line.replace(ASCII_PUNCTUATION_RE, '\\$&')}\n` : line;
    }).join('\n');
}

/**
 * Creates a markdown-it converter that renders chat Markdown like SillyBunny's Showdown converter, with
 * CommonMark emphasis. The libraries come in as arguments so that this module does not load the browser bundle.
 * @param {object} libraries Libraries from `lib.js` or `node_modules`
 * @param {Function} libraries.markdownit The markdown-it factory
 * @param {Function} libraries.markdownItEmoji The `full` plugin of markdown-it-emoji
 * @param {Function} libraries.markdownItCjkFriendly The markdown-it-cjk-friendly plugin
 * @param {object} [options] Converter options
 * @param {() => string} [options.getNonMarkdownStrings] Returns the comma-separated "Non-markdown strings"
 * with macros resolved. Called for each conversion.
 * @returns {{ makeHtml: (text: string) => string }} Converter
 */
export function createMarkdownItConverter({ markdownit, markdownItEmoji, markdownItCjkFriendly }, { getNonMarkdownStrings = () => '' } = {}) {
    const md = markdownit({ html: true, breaks: true, linkify: false });
    const { escapeHtml, unescapeAll } = md.utils;

    function makeHtml(text) {
        if (!text) {
            return text;
        }
        return md.render(escapeNonMarkdownLines(text, getNonMarkdownStrings()));
    }

    md.use(markdownItEmoji, { shortcuts: {} });
    md.use(markdownItCjkFriendly);
    md.block.ruler.at('html_block', createShowdownHtmlBlockRule(makeHtml), { alt: ['paragraph', 'reference', 'blockquote'] });
    md.inline.ruler.before('image', 'image_dimensions', imageWithDimensions);
    md.core.ruler.before('text_join', 'ellipsis', replaceEllipsis);

    const rules = md.renderer.rules;
    rules.text = (tokens, idx) => escapeText(tokens[idx].content);
    rules.code_inline = (tokens, idx, options, env, slf) => `<code${slf.renderAttrs(tokens[idx])}>${escapeText(tokens[idx].content)}</code>`;
    rules.code_block = (tokens, idx, options, env, slf) => `<pre${slf.renderAttrs(tokens[idx])}><code>${escapeText(tokens[idx].content)}</code></pre>\n`;
    rules.fence = (tokens, idx) => {
        const token = tokens[idx];
        const language = escapeHtml(token.info ? unescapeAll(token.info).trim().split(/\s+/)[0] : '');
        const className = language ? ` class="${language} language-${language}"` : '';
        return `<pre><code${className}>${escapeText(token.content)}</code></pre>\n`;
    };
    rules.s_open = () => '<del>';
    rules.s_close = () => '</del>';
    rules.strong_open = (tokens, idx) => tokens[idx].markup === '__' ? '<u>' : '<strong>';
    rules.strong_close = (tokens, idx) => tokens[idx].markup === '__' ? '</u>' : '</strong>';

    return { makeHtml };
}
