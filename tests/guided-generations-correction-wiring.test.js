import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const correctionSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'guided-generations', 'scripts', 'guidedCorrection.js'), 'utf8');

describe('Guided Correction generation wiring', () => {
    test('retains correction targets without changing ordinary regeneration', () => {
        expect(scriptSource).toContain('@property {boolean} [preserveLastMessage]');
        expect(scriptSource).toContain('preserveLastMessage = false } = {}, dryRun = false)');
        expect(scriptSource).toContain('!(type === \'regenerate\' && preserveLastMessage)');
        expect(scriptSource).toContain('setInContextMessages(arrMes.length - injectedIndices.length, type, preserveLastMessage)');
        expect(scriptSource).toContain('(type === \'regenerate\' && !preserveLastMessage)');
        expect(scriptSource).toContain('mesId: getNextMessageId(type, preserveLastMessage)');
        expect(scriptSource).toContain('(type === \'regenerate\' && preserveLastMessage) ? chat.length - 1 : chat.length');
    });

    test('uses retained regeneration and only clears input for group corrections', () => {
        expect(correctionSource).toContain('const options = { preserveLastMessage: true };');
        expect(correctionSource).toContain('if (context.groupId) {');
        expect(correctionSource).toContain('textarea.value = \'\';');
        expect(correctionSource.indexOf('textarea.value = \'\';'))
            .toBeLessThan(correctionSource.indexOf('await generateCorrection(target);'));
    });
});
