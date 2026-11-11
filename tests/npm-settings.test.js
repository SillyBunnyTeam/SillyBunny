import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

describe('npm settings', () => {
    test('tests/.npmrc matches the root .npmrc', () => {
        const rootSettings = fs.readFileSync(new URL('../.npmrc', import.meta.url), 'utf8');
        const testSettings = fs.readFileSync(new URL('./.npmrc', import.meta.url), 'utf8');

        expect(testSettings).toBe(rootSettings);
    });
});
