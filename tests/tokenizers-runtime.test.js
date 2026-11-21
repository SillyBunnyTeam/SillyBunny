/* eslint-disable playwright/no-duplicate-hooks */
/* global globalThis */
import { fileURLToPath } from 'node:url';
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('web tokenizer runtime bootstrap', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
    const dataRoot = fileURLToPath(new URL('../data', import.meta.url));
    let originalLocationDescriptor;
    let originalDataRoot;
    let originalCwd;

    beforeEach(() => {
        jest.resetModules();
        originalCwd = process.cwd();
        process.chdir(repoRoot);
        originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
        originalDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = dataRoot;

        Object.defineProperty(globalThis, 'location', {
            value: { href: '' },
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        if (originalLocationDescriptor) {
            Object.defineProperty(globalThis, 'location', originalLocationDescriptor);
        } else {
            delete globalThis.location;
        }

        globalThis.DATA_ROOT = originalDataRoot;
        process.chdir(originalCwd);
    });

    test('loads web tokenizers when the server runtime exposes an empty location href', async () => {
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(defaultConfigPath);

        const { getWebTokenizer } = await import('../src/endpoints/tokenizers.js');
        const tokenizer = await getWebTokenizer('llama3').get();

        expect(tokenizer).toBeTruthy();
        expect(tokenizer.encode('hello world').length).toBeGreaterThan(0);
    // Loading a real tokenizer takes longer than Jest's 5 s default while the full suite runs in parallel.
    }, 30_000);
});
