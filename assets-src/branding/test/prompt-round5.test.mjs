import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const kit = loadPromptKit(PROMPTS);
const read = (name) => readFileSync(join(PROMPTS, name), 'utf8');
const earsLine = read('character-reisen.md').split('\n').find((line) => line.startsWith('Rabbit ears:'));

test('Reisen\'s resting ears are rumpled, creased and folded over partway up, one lower than the other', () => {
    assert.match(earsLine, /very long, rumpled and creased/);
    assert.match(earsLine, /At rest each ear folds over partway up, so the upper half droops loosely to the side/);
    assert.match(earsLine, /one ear a little lower than the other/);
    assert.match(earsLine, /two small button-like accessories at the base of the ears/);
});

test('Reisen\'s expression range is unchanged and her ears do not stand stiff at rest', () => {
    assert.match(earsLine, /stand straight up when alert/);
    assert.match(earsLine, /droop backwards when sad/);
    assert.match(earsLine, /shoot up or splay when surprised/);
    assert.ok(!/upright|stiff|bend at the middle when relaxed/i.test(earsLine.replace('stand straight up when alert', '')));
});

test('the ear-pose table defers to each character\'s own resting pose, so nothing in it forces Reisen upright', () => {
    const { resolvedVars } = composePrompt(kit, 'expression-face-edit', { vars: { expression: 'neutral' }, refCount: 1 });
    assert.match(resolvedVars.ears, /natural resting pose/);
    assert.ok(!/upright|straight|perked|stiff/i.test(resolvedVars.ears));
});

test('the line-up asks for Reisen\'s resting ears and no longer for ears standing upright and alert', () => {
    const { prompt } = composePrompt(kit, 'lineup', { vars: {}, characters: ['reisen', 'tewi'], refCount: 2 });
    assert.ok(!/standing upright and alert/.test(prompt));
    assert.match(prompt, /character 1 on the left with her ears in their rumpled resting pose, folded over partway up/);
});
