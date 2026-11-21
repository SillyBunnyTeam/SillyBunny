import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const design = fs.readFileSync(path.join(repoRoot, 'DESIGN.md'), 'utf8');
const frontMatter = design.split('\n---')[0];

/** The keys of each top-level group of the front matter, such as `rounded` and `colors`. */
function frontMatterKeys(text) {
    const groups = new Map();
    let current = null;
    for (const line of text.split('\n')) {
        const top = /^([a-zA-Z][\w-]*):\s*$/.exec(line);
        if (top) {
            current = top[1];
            groups.set(current, new Set());
            continue;
        }
        if (/^\S/.test(line)) {
            current = null;
            continue;
        }
        const key = /^ {2}"?([\w-]+)"?:/.exec(line);
        if (current && key) groups.get(current).add(key[1]);
    }
    return groups;
}

describe('the front matter of DESIGN.md', () => {
    test('every {group.key} reference names a key that the front matter defines', () => {
        const groups = frontMatterKeys(frontMatter);
        const dangling = [...design.matchAll(/\{(colors|rounded|spacing|typography|motion)\.([\w-]+)\}/g)]
            .map(([reference, group, key]) => (groups.get(group)?.has(key) ? null : reference))
            .filter(Boolean);

        expect(groups.get('rounded')?.size).toBeGreaterThan(0);
        expect(dangling).toEqual([]);
    });
});
