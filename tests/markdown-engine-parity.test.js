import { describe, expect, test } from '@jest/globals';
import markdownit from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import { full as markdownItEmoji } from 'markdown-it-emoji';

import { createMarkdownItConverter } from '../public/scripts/markdown-engine.js';
import { createSillyBunnyShowdownConverter } from './util/sillybunny-showdown.js';

const showdownConverter = createSillyBunnyShowdownConverter();
const markdownItConverter = createMarkdownItConverter({ markdownit, markdownItEmoji, markdownItCjkFriendly });

const TAG_OR_COMMENT_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;

/**
 * Decodes the entities that the two engines write differently for the same character.
 * @param {string} text HTML text
 * @returns {string} Decoded text
 */
function decodeEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Lists the tags, comments and text of an HTML string, so that two serializations of the same elements compare
 * equal: tag names are lowercased, `/>` becomes `>`, entities are decoded, and whitespace is collapsed and trimmed
 * in each text node. The text of a comment is normalized the same way.
 * @param {string} html HTML string
 * @returns {string[]} Tags, comments and non-empty text nodes in document order
 */
function elementStructure(html) {
    const nodes = [];
    let textStart = 0;
    const pushText = (end) => {
        const text = decodeEntities(html.slice(textStart, end)).replace(/\s+/g, ' ').trim();
        if (text) {
            nodes.push(text);
        }
    };
    for (const match of html.matchAll(TAG_OR_COMMENT_RE)) {
        pushText(match.index);
        textStart = match.index + match[0].length;
        if (match[0].startsWith('<!--')) {
            nodes.push(`<!--${elementStructure(match[0].slice(4, -3)).join('')}-->`);
            continue;
        }
        const [, slash, name, attributes] = /^<(\/?)([A-Za-z][\w-]*)([\s\S]*?)\/?>$/.exec(match[0]);
        const normalizedAttributes = decodeEntities(attributes).replace(/\s+/g, ' ').trim();
        nodes.push(`<${slash}${name.toLowerCase()}${normalizedAttributes ? ` ${normalizedAttributes}` : ''}>`);
    }
    pushText(html.length);
    return nodes;
}

// Inputs come after SillyBunny's message pipeline has wrapped quotes in <q> tags, as messageFormatting() does.
const htmlBlockCases = [
    ['div without blank lines', '<div class="status">\n**HP:** 10/10\n*Mood:* happy\n</div>'],
    ['div with blank lines', '<div class="status">\n\n**HP:** 10/10\n*Mood:* happy\n\n</div>'],
    ['span with Markdown inside', '<span style="color:red">**Angry**</span> and *calm*'],
    ['details around a list', '<details><summary>Stats</summary>\n\n- **STR** 10\n- **DEX** 12\n\n</details>'],
    ['details with a summary line', '<details>\n<summary>S</summary>\n\n*inner*\n\n</details>'],
    ['font', '<font color="#ff0000">*red italic*</font>'],
    ['div with text on the opening line', '<div style="border:1px solid">*one*\n\n*two*</div>'],
    ['br tags', 'Line<br>*next* and a<br/>b<br />c'],
    ['custom inline tag', 'Some text <custom-tag>inner **bold**</custom-tag> after'],
    ['div then text', '<div class="a">box</div>\n*after*'],
    ['text then div', '*before*\n<div class="a">box</div>'],
    ['indented HTML inside a div', '<div>\n    <span>*x*</span>\n</div>'],
    ['tab inside a div', '<div>\n\t*x*\n</div>'],
    ['nested divs', '<div class="o">\n<div class="i">\n*raw*\n</div>\n\n*still raw*\n</div>\n\n*parsed*'],
    ['section around a div', '<section>\n<div>a</div>\n\n*b*\n</section>'],
    ['table element', '<table>\n<tr><td>*a*</td></tr>\n</table>\n*after*'],
    ['style block', '<style>\n.x { color: red; }\n</style>\n*after*'],
    ['style inside a line', 'text <style>.a_b_c { color: red }</style> more'],
    ['unclosed div', '<div class="a">\n*inside*\n\n*more*'],
    ['upper-case tag', '<DIV>\n*raw*\n</DIV>\n*after*'],
    ['p block', '<p align="center">*Chapter 1*</p>\n*after*'],
    ['p inside a line', 'Hello <p>para</p>'],
    ['block tag inside a line', 'Some text <div>*x*</div> more'],
    ['center', '<center>*centered*</center>'],
    ['opening tag over two lines', '<div\nclass="x">\n*raw*\n</div>'],
    ['closing tag alone', '</div>\n*after*'],
    ['self-closing div', '<div/>\n*after*'],
    ['div indented three spaces', '   <div>\n*raw*\n</div>'],
    ['text after a closing tag', '<div class="a">box</div> *after* text\nnext line'],
    ['text after a multi-line block', '<div>\nbox\n</div> *after*'],
    ['two blocks on one line', '<div>A</div><div>B</div>'],
    ['markdown attribute', '<div markdown="1">\n**bold** and *it*\n</div>'],
    ['block then list', '<div>x</div>\n- a\n- b'],
    ['block then indented code', '<div>a</div>\n\n    code'],
    ['div after a blockquote', '> quote\n<div>x</div>'],
    ['div holding a quote', '<div>\n<q>"Hi,"</q> she said.\n</div>'],
    ['fence inside a div', '<div class="status">\n```\nHP: 10\n```\n</div>'],
    ['fence with a language inside a div', '<div class="status">\n```js\nconst a = \'<b>\' && 1;\n```\n</div>'],
    ['two fences in one block', '<div>\n```\none\n```\ntext *x*\n~~~\ntwo\n~~~\n</div>\n*after*'],
    ['tilde fence inside a div', '<div>\n~~~\nHP: 10\n~~~\n</div>'],
    ['fence inside a nested block tag', '<div class="o">\n<section>\n```\ninner\n```\n</section>\n</div>\n*after*'],
    ['fence that holds the closing tag', '<div>\n```\n</div>\n```\n</div>\n*after*'],
    ['unclosed fence inside a div', '<div>\n```\nnot closed\n</div>\n*after*'],
    ['fence with text after its closing delimiter', '<div>\n```\ncode\n```</div>\n*after*'],
    ['fence inside a block that starts with pre and code', '<pre><code>\n```\nx\n```\n</code></pre>'],
    ['fence inside a comment that holds -->', '<!--\n```\na --> b\n```\n-->\n*after*'],
    ['comment', '<!-- note -->\n*after*'],
    ['multi-line comment', '<!--\n*hidden*\n\nstill hidden\n-->\n\n*shown*'],
    ['comment then text on the same line', '<!-- c --> *after*'],
    ['comment inside a line', 'Text <!-- hidden --> more'],
    ['hr before a blank line', 'Text\n<hr>\n\nMore'],
    ['self-closing hr between paragraphs', 'Text\n\n<hr/>\n\nMore'],
    ['hr inside a paragraph', 'Text\n<hr>\nMore'],
    ['iframe', '<iframe src="x"></iframe>\n*after*'],
    ['audio', '<audio controls src="x.mp3"></audio>'],
    ['img tag', '<img src="http://x/y.png" alt="z">'],
    ['nested spans', '<span><span>*x*</span></span>'],
    ['inline formatting tags', 'H<sub>2</sub>O and x<sup>2</sup> and <kbd>Ctrl</kbd> <mark>hi</mark>'],
    ['less-than signs', 'I <3 you and 2 < 3 > 1'],
];

const roleplayCases = [
    ['italic around bold', '*italic **bold and italic** italic*'],
    ['bold around italic', '**bold *italic* bold**'],
    ['bold at the end of italic', '*italic **bold***'],
    ['bold inside italic without spaces', '*italic**bold**italic*'],
    ['italic inside bold without spaces', '**bold*italic*bold**'],
    ['bold quote in italics', '*She said **<q>"no"</q>** and left.*'],
    ['bold lead-in and italic tail', '**Bold lead-in.** *Then she **snaps** her fingers.*'],
    ['emphasis inside dialogue', '<q>"Dialogue with *emphasis* inside,"</q> she said.'],
    ['italic dialogue', '*<q>"Whispered dialogue,"</q>* she said. *She leans in.*'],
    ['dialogue inside italics', '*She says, <q>"Hello there,"</q> and waves.*'],
    ['bold inside dialogue', '<q>"**Stop!**"</q>she yelled.'],
    ['mixed narration and dialogue', '*She whispers,* <q>"I *really* mean it."</q>'],
    ['curly quotes', '<q>“I *will* go,”</q> she said, *smiling*.'],
    ['CJK bold', '**注意：**内容'],
    ['CJK bold around corner brackets', 'これは**<q>「重要」</q>**です'],
    ['CJK italic', '彼女は*<q>「こんにちは」</q>*と言った。'],
    ['bold inside words', 'text**bold**text and **bold**text'],
    ['spaced asterisks', '* spaced * and *trailing space * and ** bold **'],
    ['asterisks as marks', 'Price is 5* and rated 4* overall'],
    ['multiplication', '2 * 3 * 4 = 24 and 2*3*4'],
    ['scene break', '*Scene break*\n\n* * *\n\n*Next scene*'],
    ['hr between paragraphs', 'She left.\n\n---\n\nLater.'],
    ['underscore and spaced dash hr', '___\n\n- - -'],
    ['indented code', '    She paused, four spaces in.'],
    ['year at line start', '1984. A year to remember.'],
    ['numbered list from three', '3. third\n4. fourth'],
    ['nested list', '- a\n  - nested\n- b'],
    ['four-space nested list', '- one\n    - sub\n- two'],
    ['star list', '* one\n* two'],
    ['plus list', '+ one\n+ two'],
    ['list after text', 'Text\n- item one\n- item two'],
    ['numbered list after text', 'Text\n1. first\n2. second'],
    ['lazy blockquote', '> quote line\nlazy continuation'],
    ['nested blockquote', '> one\n>> two'],
    ['line breaks', 'Line one\nLine two\n\nNew para\n\n\n\nLast'],
    ['trailing spaces', 'line one  \nline two'],
    ['separate italics on lines', '*She smiles.* *She waves.*\n*She leaves.*'],
    ['underline, italic and snake case', '__underlined__ and _italic_ and snake_case_word and __init__.py'],
    ['underscore italics', 'file_name_here.txt and _leading underscore_ end'],
    ['table', '| a | b |\n|---|---|\n| *1* | 2 |'],
    ['strikethrough', '~~strike~~ and ~single~ and *a ~~b~~ c*'],
    ['emoji', ':smile: :heart: :not_an_emoji: :+1: :100:'],
    ['emoji-like text', 'Time 12:30:45 and :x: and :smile::smile:'],
    ['emoticons', 'I <3 you :) 8) :-D'],
    ['emoji in code', '`:smile:` :smile:'],
    ['image size', '![a](http://x/y.png =100x50)'],
    ['link with title', '[link](http://a.b "t")'],
    ['reference link', '[ref]\n\n[ref]: http://a.b'],
    ['autolinks', '<http://auto.link> and <a@b.co> but not www.example.com'],
    ['fenced code', '```js\nconst a = \'<b>\' && 1;\n```'],
    ['tilde fence', '~~~\ncode *x*\n~~~'],
    ['inline code', 'inline `code with *stars*` here'],
    ['math', '$x^2 * y^2 * z$ and $$a_1 + a_2$$'],
    ['display math', '$$\nx_1 * y_2\n$$'],
    ['task list text', '- [ ] todo\n- [x] done'],
    ['ellipsis', 'Wait... what? `a...b`'],
    ['numbered dialogue', '<q>"1. Not a list,"</q> she said.'],
    ['action line with spaced stars', '* She smiles *'],
    ['OOC placeholder', 'Text SBOOCBLOCK0 more'],
];

describe('markdown-it and Showdown render the same element structure', () => {
    test.each([...htmlBlockCases, ...roleplayCases])('%s', (label, input) => {
        expect(elementStructure(markdownItConverter.makeHtml(input))).toEqual(elementStructure(showdownConverter.makeHtml(input)));
    });
});

// Each row: what differs, the input, the Showdown result and the markdown-it result.
const intendedDifferences = [
    [
        'markdown-it closes bold and italic in order where Showdown mis-nests them',
        '***bold italic** italic*',
        '<p><strong><em>bold italic</strong> italic</em></p>',
        '<p><em><strong>bold italic</strong> italic</em></p>',
    ],
    [
        'markdown-it puts strong inside em for triple asterisks',
        '***both***',
        '<p><strong><em>both</em></strong></p>',
        '<p><em><strong>both</strong></em></p>',
    ],
    [
        'markdown-it nests italic inside bold inside italic',
        '*one **two *three* two** one*',
        '<p>*one <strong>two *three* two</strong> one*</p>',
        '<p><em>one <strong>two <em>three</em> two</strong> one</em></p>',
    ],
    [
        'markdown-it does not close bold between punctuation and a letter',
        '**<q>"Stop!"</q>**she yelled.',
        '<p><strong><q>"Stop!"</q></strong>she yelled.</p>',
        '<p>**<q>"Stop!"</q>**she yelled.</p>',
    ],
    [
        'markdown-it does not close bold between a colon and a letter',
        '**Note:**text follows',
        '<p><strong>Note:</strong>text follows</p>',
        '<p>**Note:**text follows</p>',
    ],
    [
        'markdown-it gives headings no id',
        '# Title\n\nShe left.\n---\nLater.',
        '<h1 id="title">Title</h1><h2 id="sheleft">She left.</h2><p>Later.</p>',
        '<h1>Title</h1><h2>She left.</h2><p>Later.</p>',
    ],
    [
        'markdown-it needs a space after # for a heading',
        '#hashtag and #1 fan',
        '<h1 id="hashtagand1fan">hashtag and #1 fan</h1>',
        '<p>#hashtag and #1 fan</p>',
    ],
    [
        'markdown-it lets only a list that starts at 1 interrupt a paragraph',
        'Text\n2. starts at two',
        '<p>Text</p><ol start="2"><li>starts at two</li></ol>',
        '<p>Text<br>2. starts at two</p>',
    ],
    [
        'markdown-it nests a list only when it is indented to the text of the item',
        '1. one\n  - sub\n2. two',
        '<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>',
        '<ol><li>one</li></ol><ul><li>sub</li></ul><ol start="2"><li>two</li></ol>',
    ],
    [
        'markdown-it starts a new list when the bullet character changes',
        '* one\n* two\n\n+ three\n+ four',
        '<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li><li><p>four</p></li></ul>',
        '<ul><li>one</li><li>two</li></ul><ul><li>three</li><li>four</li></ul>',
    ],
    [
        'markdown-it keeps a block that is indented under a list item inside the item',
        '- item\n\n  <div>*raw*</div>\n- next',
        '<ul><li><p>item</p></li></ul><div>*raw*</div><ul><li>next</li></ul>',
        '<ul><li><p>item</p><div>*raw*</div></li><li><p>next</p></li></ul>',
    ],
    [
        'markdown-it renders triple underscores as italic underline',
        '___both___',
        '<p><u>both</u></p>',
        '<p><em><u>both</u></em></p>',
    ],
    [
        'markdown-it breaks lines inside emphasis',
        '*italic across\nsingle newline* and **bold\nacross**',
        '<p><em>italic across single newline</em> and <strong>bold across</strong></p>',
        '<p><em>italic across<br>single newline</em> and <strong>bold<br>across</strong></p>',
    ],
    [
        'markdown-it breaks lines inside inline tags',
        '<think>\n*reasoning*\n</think>\n\n<StatusBlock>\nHP: *10*\n</StatusBlock>',
        '<p><think><em>reasoning</em></think></p><p><StatusBlock>HP: <em>10</em></StatusBlock></p>',
        '<p><think><br><em>reasoning</em><br></think></p><p><StatusBlock><br>HP: <em>10</em><br></StatusBlock></p>',
    ],
    [
        'markdown-it keeps escaped underscores literal',
        '\\_not italic\\_',
        '<p><em>not italic</em></p>',
        '<p>_not italic_</p>',
    ],
    [
        'markdown-it leaves out a * image size instead of writing auto',
        '![a](http://x/y.png =100x*)',
        '<p><img src="http://x/y.png" alt="a" width="100" height="auto"></p>',
        '<p><img src="http://x/y.png" alt="a" width="100"></p>',
    ],
    [
        'markdown-it refuses a javascript: image URL',
        '![a](javascript:alert(1) =10x10)',
        '<p><img src="javascript:alert(1)" alt="a" width="10" height="10"></p>',
        '<p>![a](javascript:alert(1) =10x10)</p>',
    ],
    [
        'markdown-it reads an unclosed fence as code to the end',
        '```\ncode *x*\n\nmore',
        '<p>```<br>code <em>x</em></p><p>more</p>',
        '<pre><code>code *x* more</code></pre>',
    ],
    [
        'markdown-it does not put a fence inside a markdown block in a paragraph',
        '<div markdown="1">\n```\nx\n```\n</div>',
        '<div markdown="1"><p><pre><code>x</code></pre></p></div>',
        '<div markdown="1"><pre><code>x</code></pre></div>',
    ],
    [
        'markdown-it keeps HTML inside a <pre><code> block as HTML',
        '<pre><code>\n<b>x</b> & y\n</code></pre>',
        '<pre><code>&lt;b&gt;x&lt;/b&gt; &amp; y</code></pre>',
        '<pre><code><b>x</b> & y</code></pre>',
    ],
    [
        'markdown-it keeps HTML inside a <code> tag as HTML',
        'Use <code><b>x</b></code> here',
        '<p>Use <code>&lt;b&gt;x&lt;/b&gt;</code> here</p>',
        '<p>Use <code><b>x</b></code> here</p>',
    ],
    [
        'markdown-it shows an unclosed comment as text',
        '<!-- unclosed\nmore > text',
        '<p>&lt;!-- unclosed more > text</p>',
        '<p>&lt;!-- unclosed<br>more &gt; text</p>',
    ],
    [
        'markdown-it reads a backslash at the end of a line as a line break',
        'line one\\\nline two',
        '<p>line one\\<br>line two</p>',
        '<p>line one<br>line two</p>',
    ],
    [
        'markdown-it reads numbers with a parenthesis as a list',
        '1) one\n2) two',
        '<p>1) one<br>2) two</p>',
        '<ol><li>one</li><li>two</li></ol>',
    ],
    [
        'markdown-it does not strike through text with spaces inside the tildes',
        '~~ a ~~',
        '<p><del> a </del></p>',
        '<p>~~ a ~~</p>',
    ],
    [
        'markdown-it knows more emoji names',
        ':thumbsup:',
        '<p>:thumbsup:</p>',
        '<p>\u{1F44D}</p>',
    ],
    [
        'markdown-it reads a table delimiter cell with one dash',
        '| l | c |\n|:--|:-:|\n| 1 | 2 |',
        '<p>| l | c |<br>|:--|:-:|<br>| 1 | 2 |</p>',
        '<table><thead><tr><th style="text-align:left">l</th><th style="text-align:center">c</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td></tr></tbody></table>',
    ],
];

describe('intended differences from Showdown', () => {
    test.each(intendedDifferences)('%s', (label, input, showdownHtml, markdownItHtml) => {
        expect(elementStructure(showdownConverter.makeHtml(input))).toEqual(elementStructure(showdownHtml));
        expect(elementStructure(markdownItConverter.makeHtml(input))).toEqual(elementStructure(markdownItHtml));
    });
});
