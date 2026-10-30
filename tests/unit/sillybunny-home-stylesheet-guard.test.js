/* eslint-disable playwright/no-standalone-expect -- Jest contracts for source files. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const PUBLIC_ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const STYLESHEET = 'welcome.css';
const SKIPPED_DIRECTORIES = new Set(['lib', 'node_modules']);
const SCANNED_EXTENSIONS = new Set(['.css', '.html', '.js']);

function listFiles(directory) {
    return readdirSync(directory).flatMap((name) => {
        const full = path.join(directory, name);
        if (statSync(full).isDirectory()) {
            return SKIPPED_DIRECTORIES.has(name) ? [] : listFiles(full);
        }
        return SCANNED_EXTENSIONS.has(path.extname(name)) ? [full] : [];
    });
}

describe('welcome.css', () => {
    test('stays on disk, unused, because the Home stylesheet replaced it', () => {
        expect(statSync(path.join(PUBLIC_ROOT, 'css', STYLESHEET)).isFile()).toBe(true);
    });

    test('no stylesheet, page or script in public/ imports, links or loads it', () => {
        const referencing = listFiles(PUBLIC_ROOT)
            .filter(file => readFileSync(file, 'utf8').includes(STYLESHEET))
            .map(file => path.relative(PUBLIC_ROOT, file));

        expect(referencing).toEqual([]);
    });
});
