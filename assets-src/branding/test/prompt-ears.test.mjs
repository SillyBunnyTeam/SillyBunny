import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const kit = loadPromptKit(PROMPTS);
const read = (name) => readFileSync(join(PROMPTS, name), 'utf8');

const RULE = 'No human ears: the only ears are the rabbit ears on top of the head; the sides of the head where human ears would be are covered by hair.';
// A template that draws no character must be listed here, so a new character template cannot forget the rule.
const DRAWS_NO_CHARACTER = ['logo-concept'];

const composeWith = (id, refCount) => {
    const template = kit.templates.get(id);
    const vars = Object.fromEntries(template.required.map((name) => [name, name === 'expression' ? 'neutral' : 'x']));
    return composePrompt(kit, id, { vars, refCount }).prompt;
};

test('both styles and both character files state that there are no human ears', () => {
    for (const file of ['style-illustrated.md', 'style-pixel.md', 'character-reisen.md', 'character-tewi.md']) {
        assert.ok(read(file).includes(RULE), `${file} lacks the no-human-ears rule`);
    }
});

test('the no-human-ears constraint section holds the rule', () => {
    assert.ok(kit.constraints.get('no-human-ears').includes(RULE));
});

test('every character-drawing template carries the rule, with and without references', () => {
    const ids = [...kit.templates.keys()].filter((id) => !DRAWS_NO_CHARACTER.includes(id));
    assert.ok(ids.length >= 14, 'the check should cover every real template');
    for (const id of ids) {
        for (const refCount of [0, 2]) {
            assert.ok(composeWith(id, refCount).includes(RULE), `${id} (${refCount} refs) lacks the no-human-ears rule`);
        }
    }
});

test('the logo template is the only one that does not need it', () => {
    assert.deepEqual([...kit.templates.keys()].filter((id) => !composeWith(id, 0).includes(RULE)), DRAWS_NO_CHARACTER);
});

test('the bare edit template carries the rule unless the instruction says otherwise, and tells the model to remove human ears', () => {
    const prompt = composePrompt(kit, 'edit', { vars: { instruction: 'Change only the smile.' }, refCount: 1 }).prompt;
    assert.match(prompt, /Unless the instruction explicitly says otherwise/);
    assert.ok(prompt.includes(RULE));
    assert.match(prompt, /If human ears show there, remove them and extend the hair over that area/);
});

test('the other edit templates keep every other pixel or detail and so only state the rule', () => {
    for (const id of ['expression-face-edit', 'pixel-edit-blink', 'pixel-edit-ear', 'pixel-edit-mouth']) {
        const prompt = composeWith(id, 1);
        assert.ok(prompt.includes(RULE), id);
        assert.ok(!/remove them/.test(prompt), `${id} must not ask to remove anything`);
    }
});
