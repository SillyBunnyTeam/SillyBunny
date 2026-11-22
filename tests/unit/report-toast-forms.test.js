/**
 * @jest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let report;
let form;

beforeAll(async () => {
    report = await import('../../scripts/report-toast-forms.js');
    form = await import('../../public/scripts/sillybunny-toast-form.js');
});

/** The prediction for the first toastr call of a source text. */
const predict = (source) => {
    const found = report.analyzeSource(source);
    expect(found).not.toBeNull();
    expect(found.calls).toHaveLength(1);
    const { form: predictedForm, reason } = found.calls[0];
    return [predictedForm, reason];
};

describe('the call sites that the report finds', () => {
    test('finds the four kinds, with the line of each call and the object that holds toastr', () => {
        const found = report.analyzeSource([
            'toastr.info("A");',
            '',
            'toastr.success("B");',
            'window.toastr.warning("C");',
            'globalThis.toastr.error("D");',
            'toastr?.error?.("E");',
            'window.toastr?.success("F");',
            'toastr["warning"]("G");',
        ].join('\n'));
        expect(found.calls.map(({ kind, line }) => [kind, line])).toEqual([
            ['info', 1], ['success', 3], ['warning', 4], ['error', 5], ['error', 6], ['success', 7], ['warning', 8],
        ]);
    });

    test('ignores what is not a toast call', () => {
        const found = report.analyzeSource([
            'toastr.clear();',
            'toastr.remove(toast);',
            'toastr.subscribe(listener);',
            'toastr.options.timeOut = 1;',
            'const info = toastr.info;',
            'other.toastr.info("A");',
            'logger.info("A");',
            'toastr.getContainer();',
        ].join('\n'));
        expect(found.calls).toEqual([]);
        expect(found.computedKind).toEqual([]);
    });

    test('lists a call whose kind is computed apart, because its kind is not known', () => {
        const found = report.analyzeSource('toastr[type]("A", title);\ntoastr[kinds[index]]("B");\ntoastr["clear"]();\ntoastr[`remove`]();');
        expect(found.calls).toEqual([]);
        expect(found.computedKind).toEqual([1, 2]);
    });

    test('finds a call through a name that defaults to toastr or is assigned it, and marks it', () => {
        const found = report.analyzeSource([
            'function a({ toast = globalThis.toastr } = {}) { toast.warning("A", "Title"); }',
            'function b(notice = toastr) { notice.error("B"); }',
            'const alias = window.toastr;',
            'alias.info("C");',
            'let later;',
            'later = toastr;',
            'later.success("D");',
            'toastr.info("E");',
        ].join('\n'));
        expect(found.calls.map(({ kind, line, alias }) => [kind, line, alias])).toEqual([
            ['warning', 1, true], ['error', 2, true], ['info', 4, true], ['success', 7, true], ['info', 8, false],
        ]);
    });

    test('does not take the value of a toast call, or an unrelated object, for toastr', () => {
        const found = report.analyzeSource([
            'const toast = toastr.info("A");',
            'toast.hide();',
            'const other = makeNotifier();',
            'other.info("B");',
            'function f(toast) { toast.info("C"); }',
        ].join('\n'));
        expect(found.calls.map(({ line }) => line)).toEqual([1]);
    });

    test('finds a call that is nested inside other code', () => {
        const found = report.analyzeSource('async function run() { await go(() => { if (x) { toastr.info("A"); } }); }');
        expect(found.calls).toHaveLength(1);
    });

    test('a file that does not parse gives null', () => {
        expect(report.analyzeSource('toastr.info(')).toBeNull();
    });

    test('a file with module syntax and one with script syntax both parse', () => {
        expect(report.analyzeSource('import x from "y"; toastr.info("A");').calls).toHaveLength(1);
        expect(report.analyzeSource('with (a) { toastr.info("A"); }').calls).toHaveLength(1);
    });
});

describe('the predicted form', () => {
    test.each([
        ['a title', 'toastr.info("Saved", "Done")', ['notification', 'title']],
        ['a title that is not a literal', 'toastr.info("Saved", title)', ['notification', 'title']],
        ['a title that is a call', 'toastr.info("Saved", t`Done`)', ['notification', 'title']],
        ['a title and a dynamic message', 'toastr.error(error.message, "Request failed")', ['notification', 'title']],
        ['an onclick key', 'toastr.info("Saved", undefined, { onclick: () => {} })', ['notification', 'onclick']],
        ['an onclick key with an empty title', 'toastr.info("Saved", "", { onclick: handler })', ['notification', 'onclick']],
        ['an onclick key in a quoted form', 'toastr.info("Saved", "", { "onclick": handler })', ['notification', 'onclick']],
        ['a title with an onclick key', 'toastr.info("Saved", "Done", { onclick: handler })', ['notification', 'title']],
    ])('%s', (name, source, expected) => {
        expect(predict(source)).toEqual(expected);
    });

    test.each([
        ['an empty title', 'toastr.info("Saved", "")'],
        ['a title of spaces', 'toastr.info("Saved", "  ")'],
        ['a null title', 'toastr.info("Saved", null)'],
        ['an undefined title', 'toastr.info("Saved", undefined)'],
        ['a void title', 'toastr.info("Saved", void 0)'],
        ['an empty template title', 'toastr.info("Saved", ``)'],
        ['a false title', 'toastr.info("Saved", false)'],
        ['an onclick that is not a function', 'toastr.info("Saved", "", { onclick: null })'],
    ])('%s is no title and no click action', (name, source) => {
        expect(predict(source)).toEqual(['toast', 'fits']);
    });

    test.each([
        ['a short string', 'toastr.info("Saved")'],
        ['no arguments', 'toastr.info()'],
        ['an empty message', 'toastr.info("")'],
        ['a template with no expressions', 'toastr.info(`Saved`)'],
        ['a translated template with no expressions', 'toastr.warning(t`Saved`)'],
        ['a concatenation of strings', 'toastr.info("Saved" + " now")'],
        ['a short string and options with no unknown keys', 'toastr.info("Saved", undefined, { timeOut: 0, extendedTimeOut: 0, closeButton: true })'],
        ['escaped text that looks like markup', 'toastr.info("<button>A</button><button>B</button>")'],
        ['escaped text with escapeHtml true', 'toastr.info("One<br>Two", undefined, { escapeHtml: true })'],
        ['44 characters', `toastr.info("${'x'.repeat(44)}")`],
    ])('%s is a toast', (name, source) => {
        expect(predict(source)).toEqual(['toast', 'fits']);
    });

    test.each([
        ['45 characters', `toastr.info("${'x'.repeat(45)}")`, 'long text'],
        ['a long translated text', `toastr.error(t\`${'x'.repeat(80)}\`)`, 'long text'],
        ['a message from a variable', 'toastr.info(message)', 'dynamic message'],
        ['a template with an expression', 'toastr.info(`Saved ${name}`)', 'dynamic message'],
        ['a translated template with an expression', 'toastr.info(t`Saved ${name}`)', 'dynamic message'],
        ['a string and a variable', 'toastr.info("Saved " + name)', 'dynamic message'],
        ['a call', 'toastr.info(format(value))', 'dynamic message'],
        ['options from a variable', 'toastr.info("Saved", undefined, options)', 'dynamic options'],
        ['options that spread another object', 'toastr.info("Saved", undefined, { ...base })', 'spread options'],
        ['options with a key that is computed', 'toastr.info("Saved", undefined, { [key]: 1 })', 'spread options'],
        ['an escapeHtml that is not a literal', 'toastr.info("Saved", undefined, { escapeHtml: flag })', 'dynamic options'],
        ['arguments that are spread', 'toastr.info(...args)', 'spread arguments'],
        ['markup with a single block', 'toastr.info("<b>Saved</b>", undefined, { escapeHtml: false })', 'markup'],
    ])('%s is decided at run time', (name, source, reason) => {
        expect(predict(source)).toEqual(['run time', reason]);
    });

    test('options with a spread still reveal an onclick key', () => {
        expect(predict('toastr.info("Saved", undefined, { ...base, onclick: handler })')).toEqual(['notification', 'onclick']);
    });

    test.each([
        ['two buttons', 'toastr.info("<button>A</button><button>B</button>", undefined, { escapeHtml: false })', 'buttons'],
        ['two menu buttons', 'toastr.info("<div class=\\"menu_button\\">A</div><div class=\\"menu_button\\">B</div>", undefined, { escapeHtml: false })', 'buttons'],
        ['two lines', 'toastr.info("One<br>Two", undefined, { escapeHtml: false })', 'blocks'],
        ['two divs', 'toastr.info("<div>One</div><div>Two</div>", undefined, { escapeHtml: false })', 'blocks'],
        ['two divs in a template with expressions', 'toastr.info(`<div>${a}</div><div>${b}</div>`, undefined, { escapeHtml: false })', 'blocks'],
        ['text and a link on two lines', 'toastr.info(`${text}<br><a href="#">More</a>`, undefined, { escapeHtml: false })', 'blocks'],
    ])('literal markup with %s is a notification', (name, source, reason) => {
        expect(predict(source)).toEqual(['notification', reason]);
    });

    test('markup with one button and one line is left to run time, because its width is not known', () => {
        expect(predict('toastr.info("<div>Removed <button>Undo</button></div>", undefined, { escapeHtml: false })')).toEqual(['run time', 'markup']);
    });
});

describe('counting the parts of literal markup', () => {
    // The browser classifier counts on a DOM. The report counts on a parsed fragment, so the two must agree.
    const snippets = [
        '', 'Saved', 'Saved <b>now</b> to <a href="#">the book</a>', 'A<br>B', 'A<br>', '<br>', '<div>A</div><div>B</div>',
        '<div><div>A</div></div>', '<div><div>A</div><div>B</div></div>', '<div>Title<div>Body</div></div>', '<span>A<br>B</span>',
        '<button>A</button>', '<button>A</button><button>B</button>', '<div class="menu_button">A</div><div class="menu_button">B</div>',
        '<div class="menu_button"><button>A</button></div>', '<div role="button">A</div><span role="button">B</span>',
        '<input type="button"><input type="submit"><input type="reset"><input type="text">', 'Removed <button>Undo</button> now',
        '<div><div>Removed</div><button>Undo</button></div>', '<i class="fa-solid fa-check"></i> Saved', '<i class="fa-solid fa-check"></i>',
        '<img src="a.png">', 'Saved<img src="a.png">', '<picture><img src="a.png"></picture>', '<video></video><audio></audio>', '<table><tr><td>A</td><td>B</td></tr></table>',
        '<table></table>', '<select><option>A</option></select><textarea></textarea>', '<progress></progress><meter></meter><hr>',
        '<input type="hidden"><input type="checkbox">', '<span><svg viewBox="0 0 1 1"></svg></span> Saved', '<div><svg viewBox="0 0 1 1"></svg> Saved</div>',
        '<ul><li>A</li><li>B</li></ul>', '<ul><li></li></ul>', '<ol><li>A<ul><li>B</li></ul></li></ol>', '<p>A</p><h4>B</h4><pre>C</pre>',
        '<style>.a{}</style>Saved', '<script>run()</script>Saved', '<!-- note -->Saved', '<my-tag>A</my-tag><my-tag>B</my-tag>',
        '<label>Name <input type="text"></label>', '<a href="#"><div>A</div><div>B</div></a>', '<details><summary>A</summary>B</details>',
    ];

    test.each(snippets.map(markup => [markup]))('agrees with the classifier on %j', (markup) => {
        const message = document.createElement('div');
        message.innerHTML = markup;
        expect(report.countHtmlParts(markup)).toEqual({
            buttons: form.countButtons(message),
            blocks: form.countBlocks(message),
        });
    });
});

describe('the report of a source tree', () => {
    let root;

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function makeTree(files) {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'toast-forms-report-'));
        for (const [name, content] of Object.entries(files)) {
            const target = path.join(root, 'public', name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
        }
        return report.analyzeProject(root);
    }

    test('walks public, in path order, and leaves out vendored and generated code', () => {
        const result = makeTree({
            'scripts/b.js': 'toastr.info("B");',
            'scripts/a.js': 'toastr.error("A", "Title");\ntoastr.info("A2");',
            'lib/vendored.js': 'toastr.info("lib");',
            'scripts/extensions/third-party/ext/index.js': 'toastr.info("third party");',
            'scripts/extensions/quick-image-gen/index.js': 'toastr.info("quick image gen");',
            'scripts/readme.txt': 'toastr.info("not javascript");',
        });
        expect(result.calls.map(({ file, line }) => `${file}:${line}`)).toEqual(['public/scripts/a.js:1', 'public/scripts/a.js:2', 'public/scripts/b.js:1']);
    });

    test('counts every call in the totals, by form and by reason', () => {
        const result = makeTree({
            'a.js': [
                'toastr.info("A");',
                'toastr.info("B");',
                'toastr.info("C", "Title");',
                'toastr.info(message);',
                'toastr.info("D", "", { onclick: go });',
            ].join('\n'),
        });
        expect(result.totals.calls).toBe(5);
        expect(result.totals.byForm).toEqual({ toast: 2, notification: 2, 'run time': 1 });
        expect(result.totals.byReason).toEqual({
            'toast: fits': 2,
            'notification: title': 1,
            'notification: onclick': 1,
            'run time: dynamic message': 1,
        });
    });

    test('counts the calls through an alias of toastr, which are also in the totals', () => {
        const result = makeTree({ 'a.js': 'function a(toast = toastr) { toast.info("A"); toastr.info("B"); }' });
        expect(result.totals.calls).toBe(2);
        expect(result.totals.viaAlias).toBe(1);
        expect(renderedLine(result, 'Calls through an alias of toastr')).toBe('Calls through an alias of toastr (included in the calls): 1');
    });

    const renderedLine = (result, prefix) => report.renderMarkdown(result).split('\n').find(line => line.startsWith(prefix));

    test('lists a file that does not parse, and counts nothing from it', () => {
        const result = makeTree({ 'broken.js': 'toastr.info(', 'fine.js': 'toastr.info("A");' });
        expect(result.skipped).toEqual(['public/broken.js']);
        expect(result.totals.calls).toBe(1);
    });

    test('the same tree gives the same report', () => {
        const files = { 'a.js': 'toastr.info("A");', 'b/c.js': 'toastr.error("B", "T");' };
        const first = makeTree(files);
        fs.rmSync(root, { recursive: true, force: true });
        expect(makeTree(files)).toEqual(first);
    });

    test('the Markdown has the totals and one row for each call', () => {
        const result = makeTree({ 'a.js': 'toastr.info("A");\ntoastr.error("B", "Title");' });
        const markdown = report.renderMarkdown(result);
        expect(markdown).toContain('| public/a.js | 1 | info | toast | fits |');
        expect(markdown).toContain('| public/a.js | 2 | error | notification | title |');
        expect(markdown).toMatch(/Calls: 2/);
    });

    test('the JSON has the calls, the totals and the skipped files', () => {
        const result = makeTree({ 'a.js': 'toastr.info("A");' });
        const json = JSON.parse(report.renderJson(result));
        expect(Object.keys(json).sort()).toEqual(['calls', 'computedKind', 'skipped', 'totals']);
        expect(json.calls).toEqual([{ file: 'public/a.js', line: 1, kind: 'info', alias: false, form: 'toast', reason: 'fits' }]);
    });
});
