import { afterEach, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildReport,
    compareSbNames,
    extractMarkupNames,
    extractSelectorNames,
    extractStylesheetNames,
    formatMarkdown,
    parseRenameMap,
    parseStyleRules,
    readFilesAtRef,
    splitHtmlBlocks,
    stripCssComments,
} from '../scripts/list-sb-class-changes.js';

const scriptPath = fileURLToPath(new URL('../scripts/list-sb-class-changes.js', import.meta.url));
const temporaryRoots = [];
afterEach(() => temporaryRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function classesOf(css) {
    return [...extractStylesheetNames(css).classes.keys()].sort();
}

function idsOf(css) {
    return [...extractStylesheetNames(css).ids.keys()].sort();
}

function markup(source, options) {
    const names = extractMarkupNames(source, options);
    return {
        classes: [...names.classes].sort(),
        ids: [...names.ids].sort(),
        mentions: [...names.mentions].sort(),
        dynamicClasses: [...names.dynamicClassPrefixes].sort(),
        dynamicIds: [...names.dynamicIdPrefixes].sort(),
        dynamicMentions: [...names.dynamicMentions].sort(),
    };
}

describe('selector extraction', () => {
    test('finds classes next to pseudo-classes, pseudo-elements and combinators', () => {
        const names = extractSelectorNames('.sb-a:hover > .sb-b::before, div.sb-c:not(.sb-d, .sb-e):nth-child(2n+1) ~ .sb-f:is(.sb-g)');
        expect(names.classes).toEqual(['sb-a', 'sb-b', 'sb-c', 'sb-d', 'sb-e', 'sb-f', 'sb-g']);
    });

    test('ignores classes without the sb- prefix and a bare prefix', () => {
        expect(extractSelectorNames('.sbx-a .sb- .not-sb-a .sb_a .Sb-a').classes).toEqual([]);
    });

    test('does not read names out of attribute selectors', () => {
        const names = extractSelectorNames('[data-x=".sb-hidden"].sb-real, [class*="sb-"], [data-y=\'#sb-hidden\'] [title~=sb-x]');
        expect(names.classes).toEqual(['sb-real']);
        expect(names.ids).toEqual([]);
    });

    test('decodes escaped characters in class names', () => {
        expect(extractSelectorNames('.sb-a\\:b, .sb\\-c, .sb-d\\/2, .sb-\\31 0, .sb-e\\.f').classes).toEqual(['sb-a:b', 'sb-c', 'sb-d/2', 'sb-10', 'sb-e.f']);
    });

    test('an escaped dot does not start a class', () => {
        expect(extractSelectorNames('a\\.sb-nope .sb-yes').classes).toEqual(['sb-yes']);
    });

    test('collects ids that start with sb- or sb_', () => {
        const names = extractSelectorNames('#sb-one, #sb_two.sb-c, #other, #sb, #sbx-three');
        expect(names.ids).toEqual(['sb-one', 'sb_two']);
        expect(names.classes).toEqual(['sb-c']);
    });
});

describe('stylesheet extraction', () => {
    test('skips comments that contain .sb- text', () => {
        const css = '/* .sb-comment { color: red } */ .sb-real { color: blue } /* #sb-gone */';
        expect(classesOf(css)).toEqual(['sb-real']);
        expect(idsOf(css)).toEqual([]);
        expect(stripCssComments('a /* x */ b')).toBe('a   b');
    });

    test('skips strings that contain .sb- text and braces', () => {
        const css = '.sb-a::after { content: ".sb-string { }"; } .sb-b::before { content: \'\\\'.sb-c\'; } .sb-d { color: red }';
        expect(classesOf(css)).toEqual(['sb-a', 'sb-b', 'sb-d']);
    });

    test('keeps comment markers inside strings and unquoted url() values', () => {
        const css = '.sb-a { background: url(images/a/*b.png); } .sb-b { content: "/* .sb-c */"; } .sb-d { color: red }';
        expect(classesOf(css)).toEqual(['sb-a', 'sb-b', 'sb-d']);
    });

    test('does not read url() values as selectors', () => {
        const css = [
            '.sb-a { background: url(data:image/svg+xml;utf8,<svg class=".sb-x"></svg>); }',
            '.sb-b { background: url("img/.sb-y.png"); }',
            '.sb-c { background: url(img/.sb-z.png) }',
            '.sb-d { color: red }',
        ].join('\n');
        expect(classesOf(css)).toEqual(['sb-a', 'sb-b', 'sb-c', 'sb-d']);
    });

    test('reads rules inside @media, @supports and @layer but not keyframes or font-face', () => {
        const css = `
            @import url("a.css");
            @layer base, theme;
            @media (max-width: 600px) { .sb-media { color: red } @supports (display: grid) { .sb-nested { display: grid } } }
            @layer theme { .sb-layer { color: red } }
            @keyframes sb-spin { from { opacity: 0 } to { opacity: 1 } }
            @font-face { font-family: "x"; src: url(x.woff2); }
            .sb-after { color: red }
        `;
        expect(classesOf(css)).toEqual(['sb-after', 'sb-layer', 'sb-media', 'sb-nested']);
    });

    test('reads nested style rules', () => {
        expect(classesOf('.sb-outer { color: red; &:hover { color: blue } .sb-inner { color: green } }')).toEqual(['sb-inner', 'sb-outer']);
    });

    test('keeps the media conditions with each rule', () => {
        const rules = parseStyleRules('@media (hover: hover) { .sb-a:hover { color: red } } .sb-b { color: blue }');
        expect(rules.map(rule => [rule.conditions, rule.selector])).toEqual([[['@media (hover: hover)'], '.sb-a:hover'], [[], '.sb-b']]);
    });

    test('does not change names when whitespace and declaration order of the same rule differ', () => {
        const left = extractStylesheetNames('.sb-a {\n  color: red;\n  margin: 0;\n}').classes.get('sb-a');
        const right = extractStylesheetNames('.sb-a{color:red; margin:0}').classes.get('sb-a');
        expect(left).toEqual(right);
    });
});

describe('markup and script extraction', () => {
    test('reads class attributes in HTML', () => {
        const result = markup('<div class="sb-a  other sb-b" id="sb-one"></div><span class=\'sb-c\'></span><i data-sb-x="1" class="not-sb-d x-sb-e"></i>');
        expect(result.classes).toEqual(['sb-a', 'sb-b', 'sb-c']);
        expect(result.ids).toEqual(['sb-one']);
    });

    test('reads class attributes inside script strings, escaped quotes included', () => {
        const result = markup('const a = `<div class="sb-tpl ${state ? \'sb-on\' : \'\'}"></div>`; const b = "<p class=\\"sb-esc\\"></p>";');
        expect(result.classes).toEqual(['sb-esc', 'sb-on', 'sb-tpl']);
    });

    test('reads classList calls', () => {
        const result = markup(`
            el.classList.add('sb-add', 'plain', "sb-add-two");
            el.classList.remove("sb-remove");
            el.classList.toggle('sb-toggle', isOpen(a, b));
            if (el?.classList.contains('sb-contains')) {}
            el.classList.replace('sb-old', 'sb-new');
            classListOther.add('sb-not-a-call');
        `);
        expect(result.classes).toEqual(['sb-add', 'sb-add-two', 'sb-contains', 'sb-new', 'sb-old', 'sb-remove', 'sb-toggle']);
    });

    test('reads className, class properties and jQuery class calls', () => {
        const result = markup(`
            node.className = 'sb-one other';
            node.className += \` sb-two \${x}\`;
            if (node.className.includes('sb-three')) {}
            $('<div>', { class: 'sb-four' });
            $(el).addClass('sb-five sb-six').removeClass('sb-seven').toggleClass('sb-eight', on).hasClass('sb-nine');
            el.setAttribute('class', 'sb-ten');
        `);
        expect(result.classes).toEqual(['sb-eight', 'sb-five', 'sb-four', 'sb-nine', 'sb-one', 'sb-seven', 'sb-six', 'sb-ten', 'sb-three', 'sb-two']);
    });

    test('reads dotted selectors in script strings', () => {
        const result = markup('document.querySelector(\'#chat .sb-sel > div.sb-tag\'); $(".sb-jq:hover"); el.closest(`.sb-closest`);');
        expect(result.classes).toEqual(['sb-closest', 'sb-jq', 'sb-sel', 'sb-tag']);
    });

    test('does not report custom properties, data attributes or event names', () => {
        const result = markup('el.style.setProperty("--sb-width", "1px"); el.dataset.sbMode = "x"; <div data-sb-mode="a" style="width: var(--sb-width)"></div>');
        expect(result.classes).toEqual([]);
    });

    test('puts names built at run time into the dynamic prefixes', () => {
        const result = markup('node.className = `sb-shell-${mode}`; node.classList.add("sb-tab-" + id); $(`.sb-root-${x}`);');
        expect(result.classes).toEqual([]);
        expect(result.dynamicClasses).toEqual(['sb-root-${}', 'sb-shell-${}', 'sb-tab-']);
    });

    test('reads ids from attributes, getElementById and hash selectors', () => {
        const result = markup('<input id="sb-field"><a href="#sb_anchor"></a>\ndocument.getElementById("sb-by-id"); $(\'#sb-jq\'); const el = { id: \'sb-prop\' }; $(`#sb-row-${n}`);');
        expect(result.ids).toEqual(['sb-by-id', 'sb-field', 'sb-jq', 'sb-prop', 'sb_anchor']);
        expect(result.dynamicIds).toEqual(['sb-row-${}']);
    });

    test('splits <style> and <script> blocks out of HTML and drops comments', () => {
        const { markup: rest, styles, scripts } = splitHtmlBlocks('<style>.sb-a { color: red }</style><div class="sb-b"></div><SCRIPT type="module">run("sb-s")</SCRIPT><!-- <style>.sb-c {}</style> -->');
        expect(styles).toEqual(['.sb-a { color: red }']);
        expect(scripts).toEqual(['run("sb-s")']);
        expect(rest).not.toMatch(/sb-a|sb-s|sb-c/);
        expect(rest).toContain('sb-b');
    });
});

describe('comments and look-alikes', () => {
    test('does not count names in JS comments', () => {
        const result = markup([
            '// the old .sb-old rule',
            '/* see .sb-two',
            '   and class="sb-three" */',
            'el.classList.add("sb-real"); // trailing .sb-four',
        ].join('\n'));
        expect(result.classes).toEqual(['sb-real']);
        expect(result.mentions).toEqual(['sb-real']);
    });

    test('does not count names in HTML comments, in HTML files or in script strings', () => {
        expect(markup('<!-- <div class="sb-c"> -->\n<div class="sb-real"></div>', { html: true }).classes).toEqual(['sb-real']);
        expect(markup('const tpl = `<!-- <i class="sb-gone"></i> --><i class="sb-live"></i>`;').classes).toEqual(['sb-live']);
        expect(markup('<script>/* .sb-no */ el.classList.add("sb-yes"); // .sb-nope\n</script><!-- <script>el.classList.add("sb-commented")</script> -->', { html: true }).classes).toEqual(['sb-yes']);
    });

    test('blanks an HTML comment inside one string without eating code between two strings', () => {
        const result = markup([
            'const open = \'<!--\';',
            'el.classList.add(\'sb-between\');',
            'const close = \'-->\';',
            'const tpl = \'<!-- <i class="sb-commented"></i> --><i class="sb-live"></i>\';',
        ].join('\n'));
        expect(result.classes).toEqual(['sb-between', 'sb-live']);
        expect(result.mentions).toEqual(['sb-between', 'sb-live']);
    });

    test('keeps code after a // inside a string, a URL or a regular expression', () => {
        const result = markup([
            'const url = "http://example.test/a"; el.classList.add("sb-after-url");',
            'const re = /["\']/g; el.classList.add("sb-after-regex");',
            'const split = a / b; el.classList.add(\'sb-after-division\'); // .sb-comment',
            'const text = `${x /* .sb-inline */} //not a comment`; el.classList.add("sb-after-template");',
        ].join('\n'));
        expect(result.classes).toEqual(['sb-after-division', 'sb-after-regex', 'sb-after-template', 'sb-after-url']);
    });

    test('requires a dotted selector to sit inside a string literal', () => {
        const result = markup('const x = a.sb-bare; $(".sb-quoted"); el.closest(`div.sb-tpl > .sb-tpl-child`);');
        expect(result.classes).toEqual(['sb-quoted', 'sb-tpl', 'sb-tpl-child']);
    });

    test('does not read file names or URLs as dotted classes', () => {
        const result = markup('import "./a.sb-file.js"; const u = "https://example.test/a.sb-url"; const p = "img/x.sb-img.png"; $(".sb-real");');
        expect(result.classes).toEqual(['sb-real']);
    });
});

describe('names passed as arguments and constants', () => {
    test('records names in call arguments and constants as mentions', () => {
        const result = markup(`
            const button = createMobileShellRailButton(action, fn, 'sb-shell-rail-customize-action');
            const group = createAdvFormattingDrawer('sb-af-reasoning', 'Title');
            const CLS = 'sb-const';
            el.classList.add(CLS);
        `);
        expect(result.classes).toEqual([]);
        expect(result.mentions).toEqual(['sb-af-reasoning', 'sb-const', 'sb-shell-rail-customize-action']);
    });

    test('does not record custom properties or data attribute names as mentions', () => {
        const result = markup('el.style.setProperty("--sb-width", "1px"); const a = "data-sb-mode"; const b = "var(--sb-gap)"; const c = "sb-ok";');
        expect(result.mentions).toEqual(['sb-ok']);
    });

    test('reads ids from Id properties and assignments', () => {
        const result = markup('const a = { railId: \'sb-rail\', panelId: "sb_panel" }; el.id = \'sb-assigned\'; if (el.id === \'sb-compared\') {}');
        expect(result.ids).toEqual(['sb-assigned', 'sb-rail', 'sb_panel']);
    });

    test('follows a className assignment onto the next lines', () => {
        const result = markup('node.className =\n    \'sb-next-line\';\nother.className = isOpen\n    ? \'sb-open\'\n    : \'sb-closed\';\nlast.className = \'sb-one\';\nconst unrelated = \'sb-not-a-class-context\';');
        expect(result.classes).toEqual(['sb-closed', 'sb-next-line', 'sb-one', 'sb-open']);
        expect(result.mentions).toContain('sb-not-a-class-context');
    });

    test('reads class attributes without quotes', () => {
        const result = markup('<div class=sb-bare data-x=1></div><p class = sb-spaced id=sb_bare_id>', { html: true });
        expect(result.classes).toEqual(['sb-bare', 'sb-spaced']);
        expect(result.ids).toEqual(['sb_bare_id']);
    });

    test('reads class attributes with nested quotes inside a template expression', () => {
        const result = markup('const html = `<div class="sb-outer ${active ? "sb-nested-on" : "sb-nested-off"} ${other}"></div>`;');
        expect(result.classes).toEqual(['sb-nested-off', 'sb-nested-on', 'sb-outer']);
    });

    test('records template tokens as run-time patterns', () => {
        const result = markup('const a = `sb-${kind}-end`; const b = `sb-${kind}`; const c = "sb-prefix-" + x; const d = "sb-";');
        expect(result.mentions).toEqual([]);
        expect(result.dynamicMentions).toEqual(['sb-${}', 'sb-${}-end', 'sb-prefix-']);
    });

    test('reads attribute values in HTML as mentions', () => {
        const result = markup('<label for="sb-target" data-sb-skip="x" aria-controls=sb_panel>sb-text-node</label>', { html: true });
        expect(result.mentions).toEqual(['sb-target', 'sb_panel']);
    });
});

describe('input handling', () => {
    test('handles CRLF line endings', () => {
        const css = '/* .sb-comment */\r\n.sb-a {\r\n    color: red;\r\n}\r\n@media (max-width: 1px) {\r\n    .sb-b { color: blue }\r\n}\r\n';
        expect(classesOf(css)).toEqual(['sb-a', 'sb-b']);
        expect(extractStylesheetNames(css.replace(/\r\n/g, '\n')).classes.get('sb-a')).toEqual(extractStylesheetNames(css).classes.get('sb-a'));

        const result = markup('// .sb-no\r\nnode.className =\r\n    \'sb-crlf\';\r\n<!-- x\r\n-->\r\nel.classList.add("sb-two");');
        expect(result.classes).toEqual(['sb-crlf', 'sb-two']);
    });

    test('reads rules after a url() with many spaces and an upper-case URL(', () => {
        const css = '.sb-a { background: url(            "x.png"); } .sb-b { background: URL(a;b{c.png); } .sb-c { color: red }';
        expect(classesOf(css)).toEqual(['sb-a', 'sb-b', 'sb-c']);
    });

    test('reads classes in an @scope prelude', () => {
        expect(classesOf('@scope (.sb-root) to (.sb-limit) { .sb-inner { color: red } }')).toEqual(['sb-inner', 'sb-limit', 'sb-root']);
    });
});

describe('comparison', () => {
    const file = (name, source) => ({ file: name, source });

    test('splits removed names by CSS rules and reports added names', () => {
        const result = compareSbNames({
            baseFiles: [
                file('public/css/a.css', '.sb-gone { color: red } .sb-kept { color: red } .sb-css-only-lost { color: red }'),
                file('public/scripts/a.js', 'el.classList.add("sb-script-gone"); el.classList.add("sb-kept"); el.classList.add("sb-css-only-lost");'),
                file('public/index.html', '<div class="sb-gone sb-html-gone"></div>'),
            ],
            headFiles: [
                file('public/css/a.css', '.sb-kept { color: red } .sb-new { color: red }'),
                file('public/scripts/a.js', 'el.classList.add("sb-kept"); el.classList.add("sb-css-only-lost");'),
            ],
        });
        expect(result.classes.removed.withCssRules).toEqual([{ name: 'sb-gone', cssFiles: ['public/css/a.css'], markupFiles: ['public/index.html'] }]);
        expect(result.classes.removed.markupOnly).toEqual([
            { name: 'sb-html-gone', files: ['public/index.html'] },
            { name: 'sb-script-gone', files: ['public/scripts/a.js'] },
        ]);
        expect(result.classes.added).toEqual(['sb-new']);
    });

    test('moves mapped names to renamed and flags a missing target', () => {
        const renames = parseRenameMap({ '.sb-old': 'sb-new', 'sb-other': 'sb-missing', '#sb-old-id': '#sb-new-id' });
        const result = compareSbNames({
            baseFiles: [file('public/css/a.css', '.sb-old { color: red } .sb-other { color: blue } #sb-old-id { color: red }')],
            headFiles: [file('public/css/a.css', '.sb-new { color: red } #sb-new-id { color: red }')],
            renames,
        });
        expect(result.classes.renamed.map(entry => [entry.name, entry.to, entry.presentAtHead])).toEqual([['sb-old', 'sb-new', true], ['sb-other', 'sb-missing', false]]);
        expect(result.classes.removed.withCssRules).toEqual([]);
        expect(result.ids.renamed.map(entry => [entry.name, entry.to])).toEqual([['sb-old-id', 'sb-new-id']]);
    });

    test('reports unused map entries', () => {
        const result = compareSbNames({
            baseFiles: [file('public/css/a.css', '.sb-kept { color: red }')],
            headFiles: [file('public/css/a.css', '.sb-kept { color: red }')],
            renames: parseRenameMap({ 'sb-kept': 'sb-else' }),
        });
        expect(result.classes.unusedRenames).toEqual(['sb-kept']);
    });

    test('guesses renames from identical rules and marks ambiguous matches', () => {
        const result = compareSbNames({
            baseFiles: [file('public/css/a.css', '.sb-a { color: red; margin: 0 } .sb-b:hover { color: blue } .sb-c { top: 0 }')],
            headFiles: [file('public/css/a.css', '.sb-a2 { margin: 0; color: red } .sb-b2:hover { color: blue } .sb-c2 { top: 1px }')],
        });
        expect(result.classes.renameCandidates).toEqual([{ from: 'sb-b', to: ['sb-b2'], ambiguous: false }]);

        const ambiguous = compareSbNames({
            baseFiles: [file('public/css/a.css', '.sb-a { color: red }')],
            headFiles: [file('public/css/a.css', '.sb-x { color: red } .sb-y { color: red }')],
        });
        expect(ambiguous.classes.renameCandidates).toEqual([{ from: 'sb-a', to: ['sb-x', 'sb-y'], ambiguous: true }]);
    });

    test('compares ids in their own section', () => {
        const result = compareSbNames({
            baseFiles: [file('public/css/a.css', '#sb-gone { color: red } #sb_kept { color: red }'), file('public/index.html', '<i id="sb-html-gone"></i>')],
            headFiles: [file('public/css/a.css', '#sb_kept { color: red }')],
        });
        expect(result.ids.removed.withCssRules.map(entry => entry.name)).toEqual(['sb-gone']);
        expect(result.ids.removed.markupOnly.map(entry => entry.name)).toEqual(['sb-html-gone']);
        expect(result.classes.counts.removed).toBe(0);
    });

    test('rejects a rename map that is not an object', () => {
        expect(() => parseRenameMap(['a'])).toThrow('rename map');
        expect(() => parseRenameMap({ a: '' })).toThrow('no new name');
    });

    test('accepts the renames wrapper only as the sole key', () => {
        expect([...parseRenameMap({ renames: { 'sb-a': 'sb-b' } }).classes]).toEqual([['sb-a', 'sb-b']]);
        expect(() => parseRenameMap({ renames: { 'sb-a': 'sb-b' }, 'sb-c': 'sb-d' })).toThrow('no new name: renames');
        expect([...parseRenameMap({ renames: 'sb-b', 'sb-c': 'sb-d' }).classes]).toEqual([['renames', 'sb-b'], ['sb-c', 'sb-d']]);
    });

    test('a name the head still spells out in a string is not removed', () => {
        const result = compareSbNames({
            baseFiles: [
                file('public/css/a.css', '.sb-kept-by-string { color: red } .sb-gone { color: red }'),
                file('public/scripts/a.js', 'el.classList.add("sb-script-kept", "sb-script-gone");'),
            ],
            headFiles: [file('public/scripts/b.js', 'const KEEP = "sb-kept-by-string"; register("sb-script-kept");')],
        });
        expect(result.classes.removed.withCssRules.map(entry => entry.name)).toEqual(['sb-gone']);
        expect(result.classes.removed.markupOnly.map(entry => entry.name)).toEqual(['sb-script-gone']);
        expect(result.classes.added).toEqual([]);
    });

    test('lists removed names that the base only mentioned in a string', () => {
        const result = compareSbNames({
            baseFiles: [
                file('public/scripts/a.js', 'makeButton(action, fn, "sb-arg-gone"); makeButton(action, fn, "sb-arg-kept"); const k = "sb-class-too"; el.classList.add(k, "sb-class-too");'),
            ],
            headFiles: [file('public/scripts/a.js', 'makeButton(action, fn, "sb-arg-kept");')],
        });
        expect(result.mentionedInStrings.removed).toEqual([{ name: 'sb-arg-gone', files: ['public/scripts/a.js'] }]);
        expect(result.classes.removed.markupOnly.map(entry => entry.name)).toEqual(['sb-class-too']);
    });

    test('lists names that the base used in markup and the head has in CSS only', () => {
        const result = compareSbNames({
            baseFiles: [
                file('public/css/a.css', '.sb-old { color: red } .sb-still { color: red }'),
                file('public/scripts/a.js', 'el.classList.add("sb-old"); el.classList.add("sb-still");'),
                file('public/index.html', '<i id="sb-old-id"></i>'),
            ],
            headFiles: [
                file('public/css/a.css', '.sb-old { color: red } .sb-still { color: red } #sb-old-id { top: 0 }'),
                file('public/scripts/a.js', 'el.classList.add("sb-new"); const LEGACY = "sb-old"; el.classList.add("sb-still");'),
            ],
        });
        expect(result.classes.cssOnlyAtHead).toEqual([{
            name: 'sb-old',
            baseTier: 'markup',
            baseMarkupFiles: ['public/scripts/a.js'],
            headCssFiles: ['public/css/a.css'],
            headMentionFiles: ['public/scripts/a.js'],
        }]);
        expect(result.ids.cssOnlyAtHead.map(entry => entry.name)).toEqual(['sb-old-id']);
        expect(result.classes.removed.withCssRules).toEqual([]);
    });

    test('lists a name the base only passed as an argument when its CSS rule stays at the head', () => {
        const result = compareSbNames({
            baseFiles: [
                file('public/css/a.css', '.sb-arg { color: red }'),
                file('public/scripts/a.js', 'makeButton(action, fn, "sb-arg");'),
            ],
            headFiles: [
                file('public/css/a.css', '.sb-arg { color: red }'),
                file('public/scripts/a.js', 'makeButton(action, fn);'),
            ],
        });
        expect(result.classes.cssOnlyAtHead).toEqual([{
            name: 'sb-arg',
            baseTier: 'string mention',
            baseMarkupFiles: ['public/scripts/a.js'],
            headCssFiles: ['public/css/a.css'],
            headMentionFiles: [],
        }]);
        const markdown = formatMarkdown({ base: { ref: 'v1', commit: 'a'.repeat(40) }, head: { ref: 'working tree', commit: null }, ...result });
        expect(markdown).toContain('| `.sb-arg` | string mention | `public/scripts/a.js` | `public/css/a.css` | - |');
    });

    test('formats the new sections and the run-time patterns in Markdown', () => {
        const comparison = compareSbNames({
            baseFiles: [
                file('public/css/a.css', '.sb-old { color: red }'),
                file('public/scripts/a.js', 'el.classList.add("sb-old"); make("sb-arg-gone"); el.className = `sb-shell-${mode}`;'),
            ],
            headFiles: [file('public/css/a.css', '.sb-old { color: red }')],
        });
        const markdown = formatMarkdown({ base: { ref: 'v1', commit: 'a'.repeat(40) }, head: { ref: 'working tree', commit: null }, ...comparison });
        expect(markdown).toContain('### CSS rules only at the head (heuristic)');
        expect(markdown).toContain('| `.sb-old` | markup | `public/scripts/a.js` | `public/css/a.css` | - |');
        expect(markdown).toContain('## Mentioned in a string only (heuristic)');
        expect(markdown).toContain('Storage keys, event names and message text land here; they are not filtered.');
        expect(markdown).toContain('| `sb-arg-gone` | `public/scripts/a.js` |');
        expect(markdown).toContain('## Names built at run time');
        expect(markdown).toContain('- class `sb-shell-${}`');
        expect(markdown).toContain('CSS rules only at the head: 1.');
    });

    test('shows empty new sections as None', () => {
        const comparison = compareSbNames({ baseFiles: [], headFiles: [] });
        const markdown = formatMarkdown({ base: { ref: 'v1', commit: 'a'.repeat(40) }, head: { ref: 'working tree', commit: null }, ...comparison });
        expect(markdown).toMatch(/### CSS rules only at the head \(heuristic\)\n\n.*\n\nNone\./);
        expect(markdown).toMatch(/## Mentioned in a string only \(heuristic\)\n\n.*\n\nNone\./);
        expect(markdown).not.toContain('## Names built at run time');
    });
});

describe('reading git objects', () => {
    function commitFiles(files, { dropBlobOf } = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-class-objects-'));
        temporaryRoots.push(root);
        const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' }).toString('utf8').trim();
        run('init', '-q');
        for (const [name, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
            fs.writeFileSync(path.join(root, name), content);
        }
        run('add', '-A');
        run('commit', '-q', '-m', 'base');
        if (dropBlobOf) {
            const oid = run('rev-parse', `HEAD:${dropBlobOf}`);
            fs.rmSync(path.join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)), { force: true });
        }
        return { root, run, commit: run('rev-parse', 'HEAD') };
    }

    test('reads several files in one batch, with non-ASCII content and a missing blob', () => {
        const files = {
            'public/css/a.css': '/* 日本語 é */ .sb-ünï { content: "→"; }\n',
            'public/scripts/b.js': 'const label = "naïve café 😀"; el.classList.add("sb-b");\n',
            'public/scripts/missing.js': 'el.classList.add("sb-missing");\n',
            'public/index.html': '<div class="sb-html">€</div>\r\n',
            'public/scripts/c.js': 'el.classList.add("sb-c");\n',
        };
        const { root, commit } = commitFiles(files, { dropBlobOf: 'public/scripts/missing.js' });
        const read = readFilesAtRef(root, commit);
        expect(Object.fromEntries(read.map(entry => [entry.file, entry.source]))).toEqual({
            'public/css/a.css': files['public/css/a.css'],
            'public/index.html': files['public/index.html'],
            'public/scripts/b.js': files['public/scripts/b.js'],
            'public/scripts/c.js': files['public/scripts/c.js'],
        });
    });

    test('skips lib, third-party, quick-image-gen and other file types', () => {
        const { root, commit } = commitFiles({
            'public/css/a.css': '.sb-a { color: red }',
            'public/lib/x.css': '.sb-lib { color: red }',
            'public/scripts/extensions/third-party/Ext/style.css': '.sb-third { color: red }',
            'public/scripts/extensions/third-party/Ext/index.js': 'el.classList.add("sb-third-js");',
            'public/scripts/extensions/quick-image-gen/style.css': '.sb-qig { color: red }',
            'public/scripts/extensions/quick-image-gen/index.js': 'el.classList.add("sb-qig-js");',
            'public/img/icon.svg': '<svg class="sb-svg"></svg>',
            'public/data.json': '{"class":"sb-json"}',
            'src/server.js': 'el.classList.add("sb-server");',
        });
        expect(readFilesAtRef(root, commit).map(entry => entry.file)).toEqual(['public/css/a.css']);
    });

    test('the exported buildReport does not treat a ref as an option', () => {
        const { root } = commitFiles({ 'public/css/a.css': '.sb-a { color: red }' });
        const marker = path.join(root, 'created-by-option');
        expect(() => buildReport({ repoRoot: root, base: `--output=${marker}` })).toThrow('Cannot resolve git ref');
        expect(() => buildReport({ repoRoot: root, base: '-x' })).toThrow('Cannot resolve git ref');
        expect(fs.existsSync(marker)).toBe(false);
    });
});

describe('command line', () => {
    function repo() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-class-changes-'));
        temporaryRoots.push(root);
        const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
        run('init', '-q');
        fs.mkdirSync(path.join(root, 'public/css'), { recursive: true });
        fs.mkdirSync(path.join(root, 'public/lib'), { recursive: true });
        fs.writeFileSync(path.join(root, 'public/css/a.css'), '.sb-gone { color: red } .sb-kept { color: red } .sb-old { top: 0 }');
        fs.writeFileSync(path.join(root, 'public/lib/vendor.css'), '.sb-vendor { color: red }');
        fs.writeFileSync(path.join(root, 'public/index.html'), '<div class="sb-gone sb-kept"></div>');
        run('add', '.');
        run('commit', '-q', '-m', 'base');
        run('tag', 'v0.0.1');
        fs.writeFileSync(path.join(root, 'public/css/a.css'), '.sb-kept { color: red } .sb-new { top: 0 }');
        fs.writeFileSync(path.join(root, 'public/index.html'), '<div class="sb-kept"></div>');
        fs.writeFileSync(path.join(root, 'public/css/untracked.css'), '.sb-untracked { color: green }');
        return { root, run };
    }

    function cli(root, ...args) {
        return spawnSync(process.execPath, [scriptPath, '--root', root, ...args], { encoding: 'utf8' });
    }

    test('prints JSON for a tag against the working tree and leaves git alone', () => {
        const { root, run } = repo();
        const before = run('status', '--porcelain=v1').toString();
        const result = cli(root, '--base', 'v0.0.1', '--json');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.head.ref).toBe('working tree');
        expect(report.classes.removed.withCssRules.map(entry => entry.name)).toEqual(['sb-gone', 'sb-old']);
        expect(report.classes.added).toEqual(['sb-new', 'sb-untracked']);
        expect(report.classes.renameCandidates).toEqual([{ from: 'sb-old', to: ['sb-new'], ambiguous: false }]);
        expect(JSON.stringify(report)).not.toContain('sb-vendor');
        expect(run('status', '--porcelain=v1').toString()).toBe(before);
    });

    test('writes Markdown with a rename map to --out', () => {
        const { root } = repo();
        const mapFile = path.join(root, 'renames.json');
        const outFile = path.join(root, 'out.md');
        fs.writeFileSync(mapFile, JSON.stringify({ 'sb-old': 'sb-new' }));
        const result = cli(root, '--base', 'v0.0.1', '--renames', mapFile, '--out', outFile);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        const markdown = fs.readFileSync(outFile, 'utf8');
        expect(markdown).toContain('### Renamed (from the rename map)');
        expect(markdown).toContain('| `.sb-old` | `.sb-new` | yes |');
        expect(markdown).toContain('Added at the head: 2.');
        expect(markdown).not.toContain('sb-untracked');
    });

    test('compares two refs', () => {
        const { root, run } = repo();
        run('add', '-A');
        run('commit', '-q', '-m', 'head');
        const result = cli(root, '--base', 'v0.0.1', '--head', 'HEAD', '--json');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).head.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    test('fails clearly on a bad ref, an unknown argument and a missing value', () => {
        const { root } = repo();
        expect(cli(root, '--base', 'no-such-ref')).toMatchObject({ status: 1, stderr: expect.stringContaining('Cannot resolve git ref') });
        expect(cli(root, '--nope')).toMatchObject({ status: 1, stderr: expect.stringContaining('Unknown argument') });
        expect(cli(root, '--out')).toMatchObject({ status: 1, stderr: expect.stringContaining('Missing value') });
        expect(cli(root, '--base', '-x')).toMatchObject({ status: 1, stderr: expect.stringContaining('Invalid git ref for --base') });
        expect(cli(root, '--head', '-x')).toMatchObject({ status: 1, stderr: expect.stringContaining('Invalid git ref for --head') });
        expect(cli(root, '--base', '--json')).toMatchObject({ status: 1, stderr: expect.stringContaining('Missing value for --base') });
    });
});
