import { describe, expect, test } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));

function collectStaticModules(entrypoints) {
    const visited = new Set();
    const missing = new Set();
    const visit = file => {
        if (visited.has(file)) return;
        if (!existsSync(file)) {
            missing.add(file);
            return;
        }
        visited.add(file);
        const source = readFileSync(file, 'utf8');
        const imports = source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;'"()]*?\s+from\s*)?['"]([^'"]+)['"]/g);
        for (const [, specifier] of imports) {
            if (specifier.startsWith('.')) visit(path.resolve(path.dirname(file), specifier));
        }
    };
    for (const entrypoint of entrypoints) visit(path.join(publicRoot, entrypoint));
    return { missing, visited };
}

describe('startup module graph', () => {
    function getStartupModules() {
        const html = readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
        const entrypoints = [
            ...Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"?]+)(?:\?[^" ]*)?"[^>]*>/g), match => match[1]),
            ...Array.from(html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"?]+)(?:\?[^" ]*)?"[^>]*>/g), match => match[1]),
        ];
        expect(entrypoints).toContain('script.js');
        return collectStaticModules(entrypoints);
    }

    test('ships every local module required to build the top menu on a clean install', () => {
        const { missing } = getStartupModules();
        expect([...missing].map(file => path.relative(publicRoot, file))).toEqual([]);
    });

    test('keeps optional administration and cleanup out of eager imports', () => {
        const { visited: eager } = getStartupModules();
        for (const deferred of ['sillybunny-server-tools.js', 'data-maid-dialog.js']) {
            expect(eager.has(path.join(publicRoot, 'scripts', deferred))).toBe(false);
        }
        // Live provider exports remain available to third-party extensions at startup.
        for (const shared of ['openai.js', 'textgen-settings.js', 'kai-settings.js', 'nai-settings.js', 'server-restart-monitor.js']) {
            expect(eager.has(path.join(publicRoot, 'scripts', shared))).toBe(true);
        }
    });
});
