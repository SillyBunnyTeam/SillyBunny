import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// graphify-out/ is generated knowledge-graph output -- a 3.1M-line graph.json that
// .gitignore already excludes at /graphify-out/. It was force-added past that rule,
// removed in #305, then reinstated on staging by the v1.7.0 main reconcile merge:
// main still carried the files, so its side of the merge won. A merge is exactly
// where this class of file comes back unnoticed, so the guard reads the tracked file
// list rather than the working tree -- the directory may legitimately exist on disk.
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

describe('graphify artifacts', () => {
    test('reads the tracked file list', () => {
        // Without this, an empty or failed git call would make the guard below pass vacuously.
        expect(trackedFiles.length).toBeGreaterThan(0);
    });

    test('no generated graphify output is tracked', () => {
        expect(trackedFiles.filter(file => /graphify/i.test(file))).toEqual([]);
    });
});
