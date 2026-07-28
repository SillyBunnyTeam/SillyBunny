import { describe, expect, test } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';

import { isPathInside } from '../src/path-containment.js';

describe('path containment', () => {
    const parentPath = path.resolve(os.tmpdir(), 'sillybunny-path-containment', 'parent');

    test('accepts normalized descendants, including dot-prefixed names', () => {
        expect(isPathInside(parentPath, path.join(parentPath, 'nested', 'file.txt'))).toBe(true);
        expect(isPathInside(parentPath, path.join(parentPath, '..cache', 'file.txt'))).toBe(true);
        expect(isPathInside(parentPath, path.resolve(parentPath, 'nested', '..', 'file.txt'))).toBe(true);
    });

    test('rejects traversal, sibling paths, and parent-prefix collisions', () => {
        expect(isPathInside(parentPath, path.resolve(parentPath, '..', 'sibling', 'file.txt'))).toBe(false);
        expect(isPathInside(parentPath, `${parentPath}-backup`)).toBe(false);
        expect(isPathInside(parentPath, path.dirname(parentPath))).toBe(false);
    });

    test('requires callers to explicitly allow the parent path itself', () => {
        expect(isPathInside(parentPath, parentPath)).toBe(false);
        expect(isPathInside(parentPath, parentPath, { allowEqual: true })).toBe(true);
    });
});
