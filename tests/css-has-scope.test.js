import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

/**
 * A `:has()` on the root, html or body is checked against the whole document on every DOM change, and it
 * matches outside the area it was written for. `body:has(dialog[open])` once made every message update in
 * a long chat take about fifty times longer in style recalculation, and so did the one that looked for the
 * prompt editor's column. The entries below measured as free. Each watches an element that sits in another
 * subtree than its target, so only a script-set marker could replace it, or the rule is upstream's.
 */
const DOCUMENT_WIDE_HAS_ALLOWED = Object.freeze([
    { file: 'style.css', selector: 'body:has(.drawer-content.maximized) #top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))' },
    { file: 'style.css', selector: 'body:has(.drawer-content.open) #top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))' },
    { file: 'css/sillybunny-mobile-shell.css', selector: 'body:has([data-slide-toggle="shown"]) #send_form' },
]);

const DOCUMENT_ROOT_HAS = /(^|[\s>+~(])(?:html|body|:root)(?:\.[\w-]+|\[[^\]]*\]|:not\([^)]*\))*:has\(/;

function listStylesheets() {
    const files = ['style.css'];
    for (const name of readdirSync(path.join(publicRoot, 'css'))) {
        if (name.endsWith('.css') && !name.endsWith('.min.css')) {
            files.push(`css/${name}`);
        }
    }
    // Bundled extensions are ours; third-party ones are not ours to rewrite.
    const extensionsRoot = path.join(publicRoot, 'scripts/extensions');
    for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
        const sheet = `scripts/extensions/${entry.name}/style.css`;
        if (entry.isDirectory() && entry.name !== 'third-party' && existsSync(path.join(publicRoot, sheet))) {
            files.push(sheet);
        }
    }
    return files;
}

function splitSelectorList(prelude) {
    const selectors = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < prelude.length; index++) {
        const char = prelude[index];
        if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth--;
        else if (char === ',' && depth === 0) {
            selectors.push(prelude.slice(start, index));
            start = index + 1;
        }
    }
    selectors.push(prelude.slice(start));
    return selectors.map(selector => selector.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function findDocumentWideHas(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [];
    for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
        const prelude = match[1].trim();
        if (prelude.startsWith('@') || !prelude.includes(':has(')) continue;
        for (const selector of splitSelectorList(prelude)) {
            if (DOCUMENT_ROOT_HAS.test(selector)) found.push(selector);
        }
    }
    return found;
}

describe('document-wide :has() selectors', () => {
    test('the detector finds the selectors it is meant to find', () => {
        expect(findDocumentWideHas('body:has(.a) .b, .c { x: y }')).toEqual(['body:has(.a) .b']);
        expect(findDocumentWideHas('html:not([data-x]):has(.a) .b { x: y }')).toHaveLength(1);
        expect(findDocumentWideHas(':root:has(.a) { x: y }')).toHaveLength(1);
        expect(findDocumentWideHas('.panel:has(.a) .b { x: y }')).toEqual([]);
        expect(findDocumentWideHas('body > #page:not([hidden]) ~ .b { x: y }')).toEqual([]);
        expect(findDocumentWideHas('/* body:has(.a) */ .b { x: y }')).toEqual([]);
    });

    test('the stylesheets of the app and its bundled extensions are all scanned', () => {
        const files = listStylesheets();
        expect(files).toContain('style.css');
        expect(files).toContain('css/sillybunny-tabs.css');
        expect(files).toContain('scripts/extensions/in-chat-agents/style.css');
        expect(files).not.toContain('scripts/extensions/third-party/ChatCompletionTabs/style.css');
    });

    test('no stylesheet asks :has() for an open dialog', () => {
        const offenders = listStylesheets().filter(file => /:has\(\s*(?:>\s*)?dialog\[open\]/.test(readFileSync(path.join(publicRoot, file), 'utf8')));
        expect(offenders).toEqual([]);
    });

    test('only the listed ones remain in the stylesheets', () => {
        const allowed = new Set(DOCUMENT_WIDE_HAS_ALLOWED.map(entry => `${entry.file}|${entry.selector}`));
        const found = new Set();
        for (const file of listStylesheets()) {
            for (const selector of findDocumentWideHas(readFileSync(path.join(publicRoot, file), 'utf8'))) {
                found.add(`${file}|${selector}`);
            }
        }

        expect([...found].filter(entry => !allowed.has(entry))).toEqual([]);
        expect([...allowed].filter(entry => !found.has(entry))).toEqual([]);
    });
});
