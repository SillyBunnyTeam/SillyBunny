import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

function collectJsFiles(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            collectJsFiles(fullPath, out);
        } else if (entry.name.endsWith('.js')) {
            out.push(fullPath);
        }
    }

    return out;
}

describe('frontend module identity', () => {
    // Browsers key ES module identity by full URL, query string included. Every
    // module imports '../script.js' bare, so a cache-busting query on the
    // index.html script.js tag makes the browser evaluate script.js twice and
    // register every delegated event handler twice (toggles then no-op because
    // each click fires both copies). Stale-cache protection comes from the
    // frontend-assets middleware serving JS with Cache-Control: no-cache.
    test('script.js loads under its bare URL so module identity matches bare imports', () => {
        expect(indexHtml).toContain('<link rel="modulepreload" href="script.js">');
        expect(indexHtml).toContain('<script type="module" src="script.js"></script>');
        expect(indexHtml).not.toMatch(/(?:src|href)="script\.js\?/);
    });

    test('cache-busted module tags are never bare-imported elsewhere', () => {
        const versionedModuleSrcs = [...indexHtml.matchAll(/<script type="module" src="([^"]+)\?[^"]*">/g)]
            .map(match => match[1]);
        const jsFiles = collectJsFiles(path.join(repoRoot, 'public'));

        for (const src of versionedModuleSrcs) {
            const basename = path.posix.basename(src).replace(/\./g, '\\.');
            const importPattern = new RegExp(`(?:from\\s*|import\\s*\\(\\s*)['"][^'"]*${basename}['"]`);
            const offenders = jsFiles.filter(file => importPattern.test(readFileSync(file, 'utf8')));

            expect(offenders).toEqual([]);
        }
    });
});
