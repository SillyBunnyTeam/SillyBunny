import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { createMessageFormatPipeline } from '../util/message-format-pipeline.js';
import { loadBlockFormatterModule } from '../util/block-formatter-module.js';

jest.setTimeout(120000);

const {
    createIncrementalBlockFormatter,
    hasCrossBlockTextHazard,
    isHtmlSelfContained,
    splitStreamingBlocks,
} = loadBlockFormatterModule();

/**
 * Streams `document` through the incremental formatter and through the whole-message format, the way
 * `onProgressStreaming` does at each tick, and lists the ticks where what the user sees differs.
 * @param {Awaited<ReturnType<typeof createMessageFormatPipeline>>} pipeline
 * @param {string} document Final message text
 * @param {{ step?: number }} [options] Characters added per tick
 * @returns {{ ticks: number, differing: { end: number, whole: string, incremental: string }[], reusedTicks: number }}
 */
function compareEveryTick(pipeline, document, { step = 2 } = {}) {
    let formatCalls = [];
    const formatter = createIncrementalBlockFormatter(
        (block, hooks) => { formatCalls.push(block); return pipeline.format(block, hooks); },
        { getSignature: pipeline.getSignature },
    );
    const differing = [];
    let ticks = 0;
    let reusedTicks = 0;
    for (let end = step; end < document.length + step; end += step) {
        const markdown = pipeline.balance(document.slice(0, Math.min(end, document.length)));
        formatCalls = [];
        const incremental = formatter.format(markdown, { isFinal: false });
        const whole = pipeline.format(markdown);
        ticks++;
        if (!(formatCalls.length === 1 && formatCalls[0] === markdown)) reusedTicks++;
        if (pipeline.normalize(incremental) !== pipeline.normalize(whole)) {
            differing.push({ end, whole: pipeline.normalize(whole), incremental: pipeline.normalize(incremental) });
        }
    }
    return { ticks, differing, reusedTicks };
}

const STREAMS = {
    'ordinary roleplay with lists, quotes, a fence and a table': [
        'The tavern was quiet. *She wiped the bar slowly.*', '',
        '"You came back," she said. "I didn\'t think you would."', '',
        '1. First', '', '2. Second', '', '3. Third', '',
        '> A quote that continues', '>', '> in the same quote.', '',
        '* one', '* two', '',
        'A paragraph with a `code span` and **bold**.', '',
        '```js', 'const a = 1;', '', 'const b = 2;', '```', '',
        '| a | b |', '|---|---|', '| 1 | 2 |', '',
        'Final paragraph with "dialogue" and *emphasis*.',
    ].join('\n'),
    'bold element that spans paragraphs': '<b>bold start\n\nmiddle\n\nend</b>\n\nafter\n\nlast',
    'span element that spans paragraphs': '<span style="color:red">red\n\nstill red?</span>\n\nafter\n\nlast',
    'unclosed formatting element': 'one <i>italic\n\ntwo\n\nthree\n\nfour',
    'misnested formatting elements': '<b>a <i>b</b> c</i>\n\nnext\n\nlast',
    'div card with paragraphs inside': '<div class="card">\n\ninside\n\nmore inside\n\n</div>\n\nafter\n\nlast',
    'html comment that spans paragraphs': 'before\n\n<!-- a\n\nb -->\n\nafter\n\nlast',
    'html comment before a list item': '<!-- note --> * one\n\n* two\n\nend',
    'arrow text with a dash run': 'a <--> b\n\nc --> d\n\ne <-- f\n\nlast',
    'numbered list whose next item has just started': '1. First\n\n2. Second\n\n3. Third\n\nAfter the list.',
    'loose list that starts after a line of text': 'Intro line\n- a\n\n- b\n\n  continued\n\nEnd',
    'tab-indented continuation of a list': '- item\n\n\tcontinued\n\nEnd\n\nLast',
    'indented code after a horizontal rule': '---\n    code one\n\n    code two\n\nafter\n\nlast',
    'line with only a no-break space': 'one\n\n \n\ntwo\n\nthree\n\nfour',
    'indented fence inside a list item': '1. a\n2. b\n\n   ```\n\n\nafter\n\n    code\n\n```\n\nold\n\nlast',
    'unclosed fence': 'intro\n\n```\ncode\n\nmore code\n\nand more\n\nlast',
    'tilde fence with blank lines': 'intro\n\n~~~\ncode\n\nmore\n~~~\n\nlast\n\nlast two',
    'out-of-character block over paragraphs': 'intro\n\n((ooc one\n\nooc two))\n\nafter\n\nlast',
    'reference link': 'See [a][1].\n\nmiddle\n\n[1]: https://example.com\n\nlast',
    'backtick that pairs with the fence closer added for the stream': 'Start "quoted" ``` text\n\nMiddle "quoted"\n\nEnd "quoted"\n\nLast "quoted"',
    'tilde run that pairs with the closer added for the stream': 'Start "quoted" ~~~ text\n\nMiddle "quoted"\n\nEnd "quoted"\n\nLast "quoted"',
    'angle bracket that pairs with a later one': 'a < b\n\n"quoted" middle\n\nx > y\n\n"again" last\n\nend',
    'code span whose run reaches a later code block': 'See `code` and <b>tags</b> &amp;amp; more\n\nMiddle &amp;amp; text\n\n```\nfence\n```\n\nEnd',
    'code runs that start in a settled block and end in the tail': '- one\n\n* `a` item here\n\n`b` </template> text\n\n&amp night &gt night &lt warm\n\n    code',
    'ampersands that are not followed by a character reference': 'Use `a` and R&D, AT&T and Q&A.\n\nMiddle & text\n\nLater `b` & more\n\nEnd',
    'raw html block with attributes on two lines': '<div\n  class="x">\n\ninside\n\n</div>\n\nafter\n\nlast',
    'table and entities': '| a | b |\n|---|---|\n| &amp; | &lt; |\n\n&amp;amp; &lt;b&gt;\n\nlast\n\nlast two',
    'card script in a later paragraph': 'one\n\ntwo\n\n<script>alert(1)</script>\n\nthree\n\nfour',
    'cjk and emoji': '你好。「引用」\n\n😀 family 👨‍👩‍👧 text\n\n“curly” «guillemets»\n\nlast',
};

describe('the incremental block formatter shows what the whole-message format shows', () => {
    let pipeline;

    beforeAll(async () => {
        pipeline = await createMessageFormatPipeline();
    });

    afterAll(() => pipeline.cleanup());

    test.each(Object.entries(STREAMS))('%s', (_name, document) => {
        const { differing } = compareEveryTick(pipeline, document);
        expect(differing).toEqual([]);
    });

    test('keeps reusing settled blocks for an ordinary reply', () => {
        const { ticks, reusedTicks, differing } = compareEveryTick(pipeline, STREAMS['ordinary roleplay with lists, quotes, a fence and a table']);
        expect(differing).toEqual([]);
        expect(reusedTicks / ticks).toBeGreaterThan(0.5);
    });

    test('formats the whole message when an ampersand starts a character reference and a settled block holds code', () => {
        const formatCalls = [];
        const formatter = createIncrementalBlockFormatter(
            (block, hooks) => { formatCalls.push(block); return pipeline.format(block, hooks); },
            { getSignature: pipeline.getSignature },
        );
        const withCode = 'Use `a` here.\n\nMiddle &lt text\n\nLast paragraph, still going';
        formatter.format(withCode, { isFinal: false });
        expect(formatCalls.at(-1)).toBe(withCode);

        formatCalls.length = 0;
        const withoutCode = 'Use a here.\n\nMiddle &lt text\n\nLast paragraph, still going';
        formatter.format(withoutCode, { isFinal: false });
        expect(formatCalls.at(-1)).toBe('Last paragraph, still going');
    });

    test('formats the final text in one call', () => {
        const document = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
        const calls = [];
        const formatter = createIncrementalBlockFormatter(
            (block, hooks) => { calls.push(block); return pipeline.format(block, hooks); },
            { getSignature: pipeline.getSignature },
        );
        formatter.format(document.slice(0, -4), { isFinal: false });
        calls.length = 0;
        const html = formatter.format(document, { isFinal: true });
        expect(calls).toEqual([document]);
        expect(html).toBe(pipeline.format(document));
    });

    test.each([
        ['a hide script that matches across paragraphs', (text) => text.replace(/<thinking>[\s\S]*?<\/thinking>/g, ''), '<thinking>I should plan.\n\nStep two of the plan.</thinking>\n\nShe smiled.\n\nThe door opened.\n\nHe walked in.'],
        ['a script anchored to the start of the message', (text) => text.replace(/^Alice:\s*/, ''), 'Alice: Hello there.\n\nAlice: Second paragraph.\n\nAlice: Third.\n\nAlice: Fourth.'],
        ['a script anchored to the end of the message', (text) => text.replace(/\n*---\s*$/, ''), 'One.\n\nTwo.\n\nThree.\n\n---'],
        ['a script that joins paragraphs', (text) => text.replace(/\n\n(?=[a-z])/g, ' '), 'This sentence continues\n\nlowercase after a blank line.\n\nNext.\n\nMore.'],
    ])('formats the whole message while %s is active', (_name, script, document) => {
        pipeline.state.regexScript = script;
        pipeline.state.regexActive = true;
        try {
            expect(compareEveryTick(pipeline, document).differing).toEqual([]);
        } finally {
            pipeline.state.regexScript = (text) => text;
            pipeline.state.regexActive = false;
        }
    });

    test('moves a stream to the whole-message format when a script turns on during the stream, and back when it turns off', () => {
        const document = 'Alice: one.\n\nAlice: two.\n\nAlice: three.\n\nAlice: four.\n\nAlice: five.';
        const script = (text) => text.replace(/^Alice:\s*/, '');
        const formatter = createIncrementalBlockFormatter(
            (block, hooks) => pipeline.format(block, hooks),
            { getSignature: pipeline.getSignature },
        );
        const wholeAt = (markdown) => pipeline.normalize(pipeline.format(markdown));
        const incrementalAt = (markdown) => pipeline.normalize(formatter.format(markdown, { isFinal: false }));

        const early = document.slice(0, 40);
        const middle = document.slice(0, 60);
        const late = document;
        expect(incrementalAt(early)).toBe(wholeAt(early));
        try {
            pipeline.state.regexScript = script;
            pipeline.state.regexActive = true;
            expect(incrementalAt(middle)).toBe(wholeAt(middle));
            pipeline.state.regexScript = (text) => text;
            pipeline.state.regexActive = false;
            expect(incrementalAt(late)).toBe(wholeAt(late));
        } finally {
            pipeline.state.regexScript = (text) => text;
            pipeline.state.regexActive = false;
        }
    });

    test('formats the whole message while an extension hook, an agent script or a card script can read it', () => {
        const document = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph, still going';
        for (const [setup, teardown] of [
            [() => { pipeline.state.hooks = true; }, () => { pipeline.state.hooks = false; }],
            [() => { pipeline.state.agentScripts = [{ id: 'a' }]; }, () => { pipeline.state.agentScripts = []; }],
        ]) {
            setup();
            try {
                const calls = [];
                const formatter = createIncrementalBlockFormatter(
                    (block, hooks) => { calls.push(block); return pipeline.format(block, hooks); },
                    { getSignature: pipeline.getSignature },
                );
                formatter.format(document, { isFinal: false });
                expect(calls).toEqual([document]);
            } finally {
                teardown();
            }
        }
    });

    test('formats the whole message when the first message of a chat streams', () => {
        expect(pipeline.signature('a\n\nb', 0, 'Char', false, false)).toBeNull();
        expect(pipeline.signature('a\n\nb', 1, 'Char', false, false)).not.toBeNull();
    });

    test('formats the whole message when the reasoning marker occurs in the text, or a prompt bias is stripped', () => {
        pipeline.state.power_user.reasoning = { prefix: '<think>', suffix: '</think>' };
        try {
            expect(pipeline.getSignature('plain text')).not.toBeNull();
            expect(pipeline.getSignature('a <think> b')).toBeNull();
        } finally {
            pipeline.state.power_user.reasoning = { prefix: '', suffix: '' };
        }
        pipeline.state.power_user.show_user_prompt_bias = false;
        pipeline.state.promptBias = 'Bias:';
        try {
            expect(pipeline.getSignature('plain text')).toBeNull();
        } finally {
            pipeline.state.power_user.show_user_prompt_bias = true;
            pipeline.state.promptBias = '';
        }
    });

    test('drops formatted blocks when a setting that shapes the output changes during the stream', () => {
        const calls = [];
        const formatter = createIncrementalBlockFormatter(
            (block, hooks) => { calls.push(block); return pipeline.format(block, hooks); },
            { getSignature: pipeline.getSignature },
        );
        const markdown = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph, still going';
        formatter.format(markdown, { isFinal: false });
        calls.length = 0;
        formatter.format(`${markdown}!`, { isFinal: false });
        expect(calls).toEqual(['Third paragraph, still going!']);

        pipeline.state.power_user.encode_tags = true;
        try {
            calls.length = 0;
            formatter.format(`${markdown}!!`, { isFinal: false });
            expect(calls).toEqual(['First paragraph.\n\n', 'Second paragraph.\n\n', 'Third paragraph, still going!!']);
        } finally {
            pipeline.state.power_user.encode_tags = false;
        }
    });

    test('uses the whole-message format for every stream with the Showdown engine', async () => {
        const showdownPipeline = await createMessageFormatPipeline({ engine: 'showdown' });
        try {
            expect(showdownPipeline.getSignature('a\n\nb\n\nc')).toBeNull();
            expect(compareEveryTick(showdownPipeline, '- \n\n*old quietly l\n\n- item\n\nlast').differing).toEqual([]);
        } finally {
            showdownPipeline.cleanup();
        }
    });
});

describe('settled blocks are formatted once however long the reply is', () => {
    test.each([300, 1000])('a reply of %i paragraphs', (paragraphCount) => {
        // A call that passes hooks formats a settled block; the tail is formatted without hooks.
        const callsByBlock = new Map();
        const formatter = createIncrementalBlockFormatter((block, hooks) => {
            if (hooks) callsByBlock.set(block, (callsByBlock.get(block) ?? 0) + 1);
            const html = `<p>${block.trim()}</p>`;
            hooks?.onConvertedHtml?.(html);
            return html;
        });
        const paragraphs = Array.from({ length: paragraphCount }, (_, index) => `Paragraph ${index}: she turned toward the window.`);
        const document = paragraphs.join('\n\n');
        const streamedFrom = document.indexOf(`Paragraph ${paragraphCount - 20}:`);
        for (let end = streamedFrom; end <= document.length; end += 7) {
            formatter.format(document.slice(0, end), { isFinal: false });
        }

        expect(callsByBlock.size).toBeGreaterThanOrEqual(paragraphCount - 21);
        expect([...callsByBlock].filter(([, calls]) => calls > 1)).toEqual([]);
    });

    test('drops the formatted blocks on reset', () => {
        const formatCalls = [];
        const formatter = createIncrementalBlockFormatter((block, hooks) => {
            formatCalls.push(block);
            hooks?.onConvertedHtml?.(`<p>${block}</p>`);
            return `<p>${block}</p>`;
        });
        const markdown = 'One.\n\nTwo.\n\nThree, still going';
        formatter.format(markdown, { isFinal: false });
        formatter.reset();
        formatCalls.length = 0;
        formatter.format(markdown, { isFinal: false });
        expect(formatCalls).toEqual(['One.\n\n', 'Two.\n\n', 'Three, still going']);
    });
});

describe('splitStreamingBlocks', () => {
    test('does not throw on a dash run that closes no comment', () => {
        for (const text of ['a <--> b\n\nc', 'x < y --> z\n\nw', '<-- left\n\nright -->\n\nend']) {
            expect(() => splitStreamingBlocks(text)).not.toThrow();
            const { prefix, tail } = splitStreamingBlocks(text);
            expect(prefix + tail).toBe(text);
        }
    });

    test('keeps a list together while the marker of its next item has no text yet', () => {
        const { prefixBlocks } = splitStreamingBlocks('1. First\n\n2.');
        expect(prefixBlocks).toEqual([]);
        expect(splitStreamingBlocks('Intro\n- a\n\n- b\n\nEnd').prefixBlocks).toEqual(['Intro\n- a\n\n- b\n\n']);
    });

    test('treats a line of no-break spaces as text, not as a blank line', () => {
        expect(splitStreamingBlocks('one\n \ntwo\n\nthree\n\nfour').prefixBlocks[0]).toBe('one\n \ntwo\n\n');
    });
});

describe('what makes a block unsafe to format on its own', () => {
    test.each([
        ['a paragraph', '<p>text</p>', true],
        ['void elements and a comment', '<p>a<br>b<img src="x"><!-- c --></p>', true],
        ['an element that stays open', '<div class="card">', false],
        ['a stray end tag', 'text</b>', false],
        ['end tags in the wrong order', '<b><i>x</b></i>', false],
        ['a start tag that relies on an implied end tag', '<p>one<p>two</p>', false],
        ['a comment that is not closed', '<p>a</p><!-- b', false],
        ['a tag that is not closed', '<p>a</p><a href="x', false],
        ['a declaration', '<!DOCTYPE html><p>a</p>', false],
        ['an svg element', '<svg><path d="M0"/></svg>', false],
        ['a div with a self-closing slash, which the parser ignores', '<div/>', false],
        ['a raw text element that closes', '<style>.a > b { color: red }</style><p>a</p>', true],
        ['a raw text element that stays open', '<style>.a { color: red }', false],
        ['an attribute value with a greater-than sign', '<a title="a>b">x</a>', true],
    ])('isHtmlSelfContained: %s', (_name, html, expected) => {
        expect(isHtmlSelfContained(html)).toBe(expected);
    });

    test.each([
        ['plain prose', 'She said "hello" and left.', false],
        ['a backtick without a partner', 'it`s odd', true],
        ['paired backticks', 'use `a` and `b`', false],
        ['a run of two backticks that the pattern pairs as one', 'a `` b', true],
        ['a tilde fence without a closer', '~~~\ncode', true],
        ['a closed tilde fence', '~~~\ncode\n~~~', false],
        ['a less-than sign without a greater-than sign', 'a < b', true],
        ['a tag', 'a <b>b</b>', false],
        ['a style element that is not closed', '<style>.a{}', true],
        ['a fence inside an out-of-character block, which is hidden from the scan', '((see ```))', false],
    ])('hasCrossBlockTextHazard: %s', (_name, block, expected) => {
        expect(hasCrossBlockTextHazard(block)).toBe(expected);
    });
});

describe('hasApplicableRegexScripts', () => {
    test('answers as getRegexedString filters: placement, mode, disabled scripts, depth and edit', async () => {
        const extension_settings = { disabledExtensions: [], regex: [], character_allowed_regex: [], preset_allowed_regex: {} };
        await jest.unstable_mockModule('../../public/script.js', () => ({
            characters: [], saveSettingsDebounced: jest.fn(), substituteParams: v => v, substituteParamsExtended: v => v, this_chid: undefined,
        }));
        await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extension_settings, writeExtensionField: jest.fn(async () => {}) }));
        await jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({ getPresetManager: () => null }));
        await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ regexFromString: jest.fn(value => new RegExp(value.replace(/^\/|\/[a-z]*$/g, ''), 'g')) }));
        await jest.unstable_mockModule('../../public/lib.js', () => ({ lodash: { set: jest.fn() } }));
        const engine = await import('../../public/scripts/extensions/regex/engine.js');
        const { AI_OUTPUT, USER_INPUT } = engine.regex_placement;
        const script = {
            id: 's', scriptName: 'S', findRegex: '/cat/g', replaceString: 'dog', trimStrings: [], placement: [AI_OUTPUT],
            disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: 1, maxDepth: 3,
        };
        extension_settings.regex.push(script);
        engine.invalidateRegexScriptsCache();

        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 2 })).toBe(true);
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true })).toBe(true);
        expect(engine.hasApplicableRegexScripts(USER_INPUT, { isMarkdown: true, depth: 2 })).toBe(false);
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: false, depth: 2 })).toBe(false);
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 0 })).toBe(false);
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 4 })).toBe(false);
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 2, isEdit: true })).toBe(false);

        script.disabled = true;
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 2 })).toBe(false);
        script.disabled = false;
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 2 })).toBe(true);

        extension_settings.disabledExtensions.push('regex');
        expect(engine.hasApplicableRegexScripts(AI_OUTPUT, { isMarkdown: true, depth: 2 })).toBe(false);
    });
});
