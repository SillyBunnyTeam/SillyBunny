import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const kit = loadPromptKit(PROMPTS);

const lineup = (overrides = {}) => composePrompt(kit, 'lineup', { vars: {}, characters: ['reisen', 'tewi'], refCount: 2, ...overrides });

test('the line-up composes both character files, Reisen first, labelled character 1 and character 2', () => {
    const { prompt, characters } = lineup();
    assert.deepEqual(characters, ['reisen', 'tewi']);
    const reisen = prompt.indexOf('Hair: light purple');
    const tewi = prompt.indexOf('Hair: black');
    assert.ok(reisen > 0 && tewi > reisen, 'Reisen\'s file comes before Tewi\'s');
    assert.ok(prompt.indexOf('Character 1:') < reisen && reisen < prompt.indexOf('Character 2:') && prompt.indexOf('Character 2:') < tewi);
});

test('the line-up uses the same-character references paragraph and never the style-reference one', () => {
    const { prompt } = lineup();
    assert.match(prompt, /approved references for the same characters/);
    assert.ok(!/style reference only/.test(prompt));
});

test('the line-up says which attached image belongs to which character and that each must match exactly', () => {
    const { prompt } = lineup();
    assert.match(prompt, /The first attached image is character 1's approved design sheet and the second attached image is character 2's approved design sheet/);
    assert.match(prompt, /match her own sheet exactly: face, hair, ears, outfit and colours/);
    assert.match(prompt, /Do not mix details between the two characters/);
});

test('the sheet-order paragraph only appears with references, and only in the line-up', () => {
    assert.ok(!/first attached image is character 1/.test(lineup({ refCount: 0 }).prompt));
    const card = composePrompt(kit, 'card-portrait', { vars: { pose: 'waving' }, refCount: 1 }).prompt;
    assert.ok(!/first attached image is character 1/.test(card));
});

test('the line-up keeps the relative height and the relaxed sticker pose on the near-white background', () => {
    const { prompt } = lineup();
    assert.match(prompt, /Character 2's head reaches roughly to character 1's shoulder/);
    assert.match(prompt, /both standing relaxed and facing the viewer/);
    assert.match(prompt, /Each character is its own die-cut sticker/);
    assert.match(prompt, /near-white background with a faint lavender tint/);
});
