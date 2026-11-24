/**
 * Add all the libraries that you want to expose to the client here.
 * They are bundled and exposed by Webpack in the /lib.js file.
 */
import lodash from 'lodash';
import Fuse from 'fuse.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCsharp from 'highlight.js/lib/languages/csharp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsDiff from 'highlight.js/lib/languages/diff';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsDos from 'highlight.js/lib/languages/dos';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsGraphql from 'highlight.js/lib/languages/graphql';
import hljsIni from 'highlight.js/lib/languages/ini';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsKotlin from 'highlight.js/lib/languages/kotlin';
import hljsLua from 'highlight.js/lib/languages/lua';
import hljsMakefile from 'highlight.js/lib/languages/makefile';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';
import hljsPhp from 'highlight.js/lib/languages/php';
import hljsPlaintext from 'highlight.js/lib/languages/plaintext';
import hljsPowershell from 'highlight.js/lib/languages/powershell';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRuby from 'highlight.js/lib/languages/ruby';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsScss from 'highlight.js/lib/languages/scss';
import hljsShell from 'highlight.js/lib/languages/shell';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import localforage from 'localforage';
import Handlebars from 'handlebars';
import css from '@adobe/css-tools';
import Bowser from 'bowser';
import DiffMatchPatch from 'diff-match-patch';
import { isProbablyReaderable, Readability } from '@mozilla/readability';
import SVGInject from '@iconfu/svg-inject';
import showdown from 'showdown';
// SillyBunny: markdown-it and its plugins back the default Markdown engine in scripts/markdown-engine.js.
import markdownit from 'markdown-it';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import moment from 'moment';
import seedrandom from 'seedrandom';
import * as Popper from '@popperjs/core';
import droll from 'droll';
import morphdom from 'morphdom';
import { toggle as slideToggle } from 'slidetoggle';
import chalk from 'chalk';
import yaml from 'yaml';
import * as chevrotain from 'chevrotain';
import { gzipSync, gzip } from 'fflate';
import { sha256 } from 'js-sha256';

const HLJS_LANGUAGES = [
    ['javascript', hljsJavascript],
    ['typescript', hljsTypescript],
    ['python', hljsPython],
    ['json', hljsJson],
    ['bash', hljsBash],
    ['shell', hljsShell],
    ['xml', hljsXml],
    ['css', hljsCss],
    ['scss', hljsScss],
    ['sql', hljsSql],
    ['yaml', hljsYaml],
    ['markdown', hljsMarkdown],
    ['c', hljsC],
    ['cpp', hljsCpp],
    ['csharp', hljsCsharp],
    ['java', hljsJava],
    ['kotlin', hljsKotlin],
    ['go', hljsGo],
    ['rust', hljsRust],
    ['ruby', hljsRuby],
    ['php', hljsPhp],
    ['swift', hljsSwift],
    ['diff', hljsDiff],
    ['ini', hljsIni],
    ['plaintext', hljsPlaintext],
    ['lua', hljsLua],
    ['dockerfile', hljsDockerfile],
    ['powershell', hljsPowershell],
    ['makefile', hljsMakefile],
    ['graphql', hljsGraphql],
    ['dos', hljsDos],
];

for (const [languageName, languageDefinition] of HLJS_LANGUAGES) {
    hljs.registerLanguage(languageName, languageDefinition);
}

hljs.registerAliases(['regex', 'regexp'], { languageName: 'plaintext' });

// Fall back to plaintext instead of throwing when a fence tag names an unloaded language.
hljs.addPlugin({
    'before:highlight'(context) {
        if (!context.language || !hljs.getLanguage(context.language)) {
            context.language = 'plaintext';
        }
    },
});

const originalHighlightElement = hljs.highlightElement.bind(hljs);
hljs.highlightElement = function highlightElementWithFallback(element) {
    if (!element) {
        return;
    }

    const className = typeof element.className === 'string' ? element.className : '';
    const langMatch = className.match(/\b(?:lang|language)-([^\s]+)/i);
    const requestedLang = langMatch?.[1];

    if (
        requestedLang
        && !/^no-?highlight$/i.test(requestedLang)
        && !hljs.getLanguage(requestedLang)
    ) {
        if (element.dataset?.highlighted) {
            return;
        }
        const result = hljs.highlight(element.textContent ?? '', { language: 'plaintext', ignoreIllegals: true });
        element.innerHTML = result.value;
        if (element.dataset) {
            element.dataset.highlighted = 'yes';
        }
        element.classList?.add?.('hljs');
        return;
    }

    return originalHighlightElement(element);
};

/**
 * Expose the libraries to the 'window' object.
 * Needed for compatibility with old extensions.
 * Note: New extensions are encouraged to import the libraries directly from lib.js.
 */
export function initLibraryShims() {
    if (!window) {
        return;
    }
    if (!('Fuse' in window)) {
        // @ts-ignore
        window.Fuse = Fuse;
    }
    if (!('DOMPurify' in window)) {
        // @ts-ignore
        window.DOMPurify = DOMPurify;
    }
    if (!('hljs' in window)) {
        // @ts-ignore
        window.hljs = hljs;
    }
    if (!('localforage' in window)) {
        // @ts-ignore
        window.localforage = localforage;
    }
    if (!('Handlebars' in window)) {
        // @ts-ignore
        window.Handlebars = Handlebars;
    }
    if (!('diff_match_patch' in window)) {
        // @ts-ignore
        window.diff_match_patch = DiffMatchPatch;
    }
    if (!('SVGInject' in window)) {
        // @ts-ignore
        window.SVGInject = SVGInject;
    }
    if (!('showdown' in window)) {
        // @ts-ignore
        window.showdown = showdown;
    }
    if (!('moment' in window)) {
        // @ts-ignore
        window.moment = moment;
    }
    if (!('Popper' in window)) {
        // @ts-ignore
        window.Popper = Popper;
    }
    if (!('droll' in window)) {
        // @ts-ignore
        window.droll = droll;
    }
}

export default {
    lodash,
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    Readability,
    isProbablyReaderable,
    SVGInject,
    showdown,
    // SillyBunny: markdown-it libraries for the default Markdown engine.
    markdownit,
    markdownItEmoji,
    markdownItCjkFriendly,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    slideToggle,
    chalk,
    yaml,
    chevrotain,
    gzipSync,
    gzip,
    sha256,
};

export {
    lodash,
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    Readability,
    isProbablyReaderable,
    SVGInject,
    showdown,
    // SillyBunny: markdown-it libraries for the default Markdown engine.
    markdownit,
    markdownItEmoji,
    markdownItCjkFriendly,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    slideToggle,
    chalk,
    yaml,
    chevrotain,
    gzipSync,
    gzip,
    sha256,
};
