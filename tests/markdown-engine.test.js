import { describe, expect, test } from '@jest/globals';
import markdownit from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import { full as markdownItEmoji } from 'markdown-it-emoji';

import { MARKDOWN_ENGINES, createMarkdownItConverter, normalizeMarkdownEngine } from '../public/scripts/markdown-engine.js';

const libraries = { markdownit, markdownItEmoji, markdownItCjkFriendly };
const converter = createMarkdownItConverter(libraries);
const render = text => converter.makeHtml(text);

describe('normalizeMarkdownEngine', () => {
    test('keeps Showdown only for the exact showdown id', () => {
        expect(normalizeMarkdownEngine('showdown')).toBe(MARKDOWN_ENGINES.SHOWDOWN);
    });

    test.each([['markdown-it'], [undefined], [null], [''], ['Showdown'], ['marked'], [1]])('maps %p to markdown-it', (value) => {
        expect(normalizeMarkdownEngine(value)).toBe(MARKDOWN_ENGINES.MARKDOWN_IT);
    });
});

describe('markdown-it converter', () => {
    test.each([
        ['*italic **bold and italic** italic*', '<p><em>italic <strong>bold and italic</strong> italic</em></p>\n'],
        ['***bold italic** italic*', '<p><em><strong>bold italic</strong> italic</em></p>\n'],
        ['*one **two *three* two** one*', '<p><em>one <strong>two <em>three</em> two</strong> one</em></p>\n'],
    ])('nests emphasis in %p', (input, html) => {
        expect(render(input)).toBe(html);
    });

    test('renders double underscores as underline, like Showdown with underline on', () => {
        expect(render('__underlined__ and _italic_')).toBe('<p><u>underlined</u> and <em>italic</em></p>\n');
    });

    test('renders strikethrough as del and leaves a single tilde literal', () => {
        expect(render('~~strike~~ and ~single~')).toBe('<p><del>strike</del> and ~single~</p>\n');
    });

    test('replaces emoji shortcodes but not emoticons', () => {
        expect(render(':smile: :heart: :not_an_emoji:')).toBe('<p>\u{1F604} ❤️ :not_an_emoji:</p>\n');
        expect(render('I <3 you :) 8) :-D ;)')).toBe('<p>I &lt;3 you :) 8) :-D ;)</p>\n');
    });

    test.each([
        ['**注意：**内容', '<p><strong>注意：</strong>内容</p>\n'],
        ['これは**「重要」**です', '<p>これは<strong>「重要」</strong>です</p>\n'],
    ])('closes emphasis next to CJK punctuation in %p', (input, html) => {
        expect(render(input)).toBe(html);
    });

    test('turns single newlines into line breaks', () => {
        expect(render('Line one\nLine two\n\nNew paragraph')).toBe('<p>Line one<br>\nLine two</p>\n<p>New paragraph</p>\n');
    });

    test('renders tables', () => {
        expect(render('| a | b |\n|---|---|\n| *1* | 2 |')).toBe(
            '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td><em>1</em></td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n',
        );
    });

    test('does not read a hashtag as a heading', () => {
        expect(render('#hashtag and #1 fan')).toBe('<p>#hashtag and #1 fan</p>\n');
    });

    test('keeps escaped underscores literal', () => {
        expect(render('\\_escaped\\_')).toBe('<p>_escaped_</p>\n');
    });

    test('turns three dots into an ellipsis outside code', () => {
        expect(render('Wait... `a...b` \\.\\.\\.')).toBe('<p>Wait… <code>a...b</code> ...</p>\n');
    });

    test('leaves double quotes in text literal and escapes them in attributes', () => {
        expect(render('He said "hi" & left')).toBe('<p>He said "hi" &amp; left</p>\n');
        expect(render('[a "b"](http://x "c \\"d\\"") `e "f"`')).toBe('<p><a href="http://x" title="c &quot;d&quot;">a "b"</a> <code>e "f"</code></p>\n');
    });

    test('gives fenced code the class shape that Showdown uses', () => {
        expect(render('```js\nconst a = "<b>" && 1;\n```')).toBe('<pre><code class="js language-js">const a = "&lt;b&gt;" &amp;&amp; 1;\n</code></pre>\n');
        expect(render('```\nplain\n```')).toBe('<pre><code>plain\n</code></pre>\n');
    });

    test('returns empty input unchanged', () => {
        expect(render('')).toBe('');
        expect(render(undefined)).toBeUndefined();
    });
});

describe('markdown-it image dimensions', () => {
    test('reads Showdown\'s =WIDTHxHEIGHT size', () => {
        expect(render('![a](http://x/y.png =100x50)')).toBe('<p><img src="http://x/y.png" alt="a" width="100" height="50"></p>\n');
    });

    test('leaves out a * size and keeps the title', () => {
        expect(render('![a](http://x/y.png =100x* "A \\"title\\"")')).toBe('<p><img src="http://x/y.png" alt="a" title="A &quot;title&quot;" width="100"></p>\n');
        expect(render('![a](<http://x/y z.png> =*x50)')).toBe('<p><img src="http://x/y%20z.png" alt="a" height="50"></p>\n');
    });

    test('passes the URL through the link validator', () => {
        expect(render('![a](javascript:alert(1) =10x10)')).toBe('<p>![a](javascript:alert(1) =10x10)</p>\n');
    });

    test('leaves images without a size to the standard rule', () => {
        expect(render('![a](http://x/y.png)')).toBe('<p><img src="http://x/y.png" alt="a"></p>\n');
    });
});

describe('markdown-it HTML blocks', () => {
    test('keeps a Showdown block tag raw through its closing tag, across blank lines', () => {
        expect(render('<div class="status">\n\n**HP:** 10\n\n</div>\n*after*')).toBe('<div class="status">\n\n**HP:** 10\n\n</div>\n<p><em>after</em></p>\n');
    });

    test('parses Markdown inside tags that Showdown does not treat as blocks', () => {
        expect(render('<think>\n*reasoning*\n</think>')).toBe('<p><think><br>\n<em>reasoning</em><br>\n</think></p>\n');
        expect(render('<details><summary>S</summary>\n\n*inner*\n\n</details>')).toBe('<p><details><summary>S</summary></p>\n<p><em>inner</em></p>\n<p></details></p>\n');
    });

    test('renders a closed fence inside a raw block as code and ignores the tags and comment ends in it', () => {
        expect(render('<div class="status">\n```js\n</div>\n```\n</div>\n*after*')).toBe(
            '<div class="status">\n<pre><code class="js language-js">&lt;/div&gt;\n</code></pre>\n</div>\n<p><em>after</em></p>\n',
        );
        expect(render('<!--\n```\na --> b\n```\n-->\n*after*')).toBe('<!--\n<pre><code>a --&gt; b\n</code></pre>\n-->\n<p><em>after</em></p>\n');
    });

    test('keeps an unclosed fence inside a raw block as raw text', () => {
        expect(render('<div>\n```\nnot closed\n</div>')).toBe('<div>\n```\nnot closed\n</div>\n');
    });

    test('starts a new block after the closing tag', () => {
        expect(render('<div>A</div> *B*')).toBe('<div>A</div>\n<p><em>B</em></p>\n');
    });

    test('renders Markdown inside a block whose opening tag has a markdown attribute', () => {
        expect(render('<div markdown="1">\n**bold**\n</div>')).toBe('<div markdown="1"><p><strong>bold</strong></p>\n</div>\n');
    });

    test('keeps comments and an <hr> before a blank line as blocks', () => {
        expect(render('<!-- note -->\n*after*')).toBe('<!-- note -->\n<p><em>after</em></p>\n');
        expect(render('Text\n<hr>\n\nMore')).toBe('<p>Text</p>\n<hr>\n<p>More</p>\n');
    });
});

describe('markdown-it non-markdown strings', () => {
    test('renders a line that equals a configured string as literal text in its own paragraph', () => {
        const withStrings = createMarkdownItConverter(libraries, { getNonMarkdownStrings: () => '***,---' });

        expect(withStrings.makeHtml('Para one.\n\n***\n\nPara two.')).toBe('<p>Para one.</p>\n<p>***</p>\n<p>Para two.</p>\n');
        expect(withStrings.makeHtml('Para\n---\nnext')).toBe('<p>Para<br>\n---</p>\n<p>next</p>\n');
        expect(withStrings.makeHtml('a\r\n***\r\nb')).toBe('<p>a<br>\n***</p>\n<p>b</p>\n');
    });

    test('matches whole lines only and skips fenced code', () => {
        const withStrings = createMarkdownItConverter(libraries, { getNonMarkdownStrings: () => '***' });

        expect(withStrings.makeHtml('*** ')).toBe('<hr>\n');
        expect(withStrings.makeHtml('```\n***\n```\n***')).toBe('<pre><code>***\n</code></pre>\n<p>***</p>\n');
    });

    test('reads the strings again for each conversion', () => {
        let strings = '***';
        const withStrings = createMarkdownItConverter(libraries, { getNonMarkdownStrings: () => strings });

        expect(withStrings.makeHtml('***')).toBe('<p>***</p>\n');
        strings = '';
        expect(withStrings.makeHtml('***')).toBe('<hr>\n');
    });
});
