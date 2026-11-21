/* eslint-disable playwright/no-standalone-expect -- Jest contract for static files. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
// Vendored and third-party code keeps its own references.
const SKIPPED_DIRECTORIES = new Set(['lib', 'third-party', 'quick-image-gen', 'node_modules']);

function sourceFiles(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path.join(directory, entry.name)));
        } else if (/\.(js|mjs|html|css)$/.test(entry.name) && !entry.name.endsWith('.min.js')) {
            files.push(path.join(directory, entry.name));
        }
    }
    return files;
}

/** Every `<sheet>.css?v=<key>` reference, keyed by the sheet's path from `public/`. */
function stylesheetReferences() {
    const references = new Map();
    for (const file of sourceFiles(PUBLIC)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:\.{0,2}\/)?((?:[\w.-]+\/)*[\w.-]+\.css)\?v=([\w.-]+)/g)) {
            const sheet = path.relative(PUBLIC, path.resolve(path.dirname(file), match[1]));
            // A sheet named relative to the page (`css/x.css` in a script) resolves from `public/`.
            const resolved = fs.existsSync(path.join(PUBLIC, sheet)) ? sheet : match[1].replace(/^\.?\//, '');
            if (!references.has(resolved)) references.set(resolved, []);
            references.get(resolved).push({ key: match[2], file: path.relative(PUBLIC, file) });
        }
    }
    return references;
}

describe('stylesheet cache keys', () => {
    test('every reference to a stylesheet carries the same ?v= key', () => {
        const references = stylesheetReferences();
        expect(references.size).toBeGreaterThan(20);
        const split = [];
        for (const [sheet, uses] of references) {
            const keys = new Set(uses.map(use => use.key));
            if (keys.size > 1) {
                split.push(`${sheet}: ${uses.map(use => `${use.key} in ${use.file}`).join(', ')}`);
            }
        }
        // A sheet under two keys loads twice, or a browser keeps the copy cached under the older key (LESSONS.md, Stylesheet keys).
        expect(split).toEqual([]);
    });
});
