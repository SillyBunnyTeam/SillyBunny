import { describe, expect, test } from '@jest/globals';

import { autoFixMarkdown } from '../public/scripts/auto-fix-markdown.js';
import { importPowerUserModule } from './util/power-user-harness.js';

const { powerUser } = await importPowerUserModule();

describe('auto-fix markdown wiring', () => {
    test('fixMarkdown keeps its export and delegates text and the display flag to autoFixMarkdown', () => {
        expect(typeof powerUser.fixMarkdown).toBe('function');

        const cases = [
            ['*italic **bold and italic** italic*', true],
            ['*She smiles', true],
            ['*She smiles', false],
            ['"Hello *world', true],
            ['"Hello *world', false],
        ];
        for (const [text, forDisplay] of cases) {
            expect(powerUser.fixMarkdown(text, forDisplay)).toBe(autoFixMarkdown(text, forDisplay));
        }

        expect(powerUser.fixMarkdown('*italic **bold and italic** italic*', true)).toBe('*italic **bold and italic** italic*');
        expect(powerUser.fixMarkdown('*She smiles', true)).toBe('*She smiles*');
        expect(powerUser.fixMarkdown('*She smiles', false)).toBe('*She smiles');
    });
});
