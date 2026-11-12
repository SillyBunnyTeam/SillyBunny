import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const kit = loadPromptKit(join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts'));
const still = (vars = {}, refCount = 0) => composePrompt(kit, 'pixel-still', { vars: { pose: 'standing', ...vars }, refCount });
const scene = (vars = {}, refCount = 0) => composePrompt(kit, 'pixel-scene', { vars: { pose: 'side by side', ...vars }, refCount });

test('the still takes expression, facing, props and a canvas line, and drops the ones that are empty', () => {
    const bare = still().prompt;
    for (const label of ['Expression:', 'Props:', 'Canvas:', 'Composition:']) {
        assert.ok(!bare.includes(label), `${label} should be dropped when empty`);
    }
    const full = still({ expression: 'sly grin', props: 'a plain gift box', canvas: 'a square canvas', composition: 'centred' }).prompt;
    for (const line of ['Expression: sly grin', 'Props: a plain gift box', 'Canvas: a square canvas', 'Composition: centred']) {
        assert.ok(full.includes(line), line);
    }
});

test('facing is a lookup: the viewer by default, and the right or left side of the picture on request', () => {
    assert.match(still().prompt, /Facing: Facing the viewer straight on/);
    assert.match(still({ direction: 'inline-end' }).prompt, /Facing: [^\n]*right side of the picture/);
    assert.match(still({ direction: 'inline-start' }).prompt, /Facing: [^\n]*left side of the picture/);
    assert.throws(() => still({ direction: 'up' }), /pixel-facings\.md has no entry for direction "up"/);
});

test('a facing never mentions text, so the model has no cue to draw any', () => {
    for (const direction of ['viewer', 'inline-end', 'inline-start']) {
        const facing = still({ direction }).prompt.split('\n').find((line) => line.startsWith('Facing:'));
        assert.ok(!/\btext|word|label|caption/i.test(facing), facing);
    }
});

test('the master reference paragraph needs the third picture, so older two picture runs do not mention a missing one', () => {
    assert.ok(!still({}, 2).prompt.includes('third attached image'));
    const three = still({}, 3).prompt;
    assert.match(three, /The third attached image is the character's approved pixel-art master in front view/);
    assert.match(three, /do not copy its pose/);
});

test('the scene is ready, draws two characters in order, and needs a pose', () => {
    const { prompt, status, characters } = scene();
    assert.equal(status, 'ready');
    assert.deepEqual(characters, ['reisen', 'tewi']);
    assert.match(prompt, /Character 1:[^]*Character 2:/);
    assert.throws(() => composePrompt(kit, 'pixel-scene', { vars: {}, refCount: 0 }), /--vars pose=/);
});

test('the scene carries the pixel rules, the no-human-ears rule, a transparent background and a two character framing', () => {
    const { prompt, resolvedVars } = scene();
    assert.equal(resolvedVars.background, 'fully transparent');
    assert.match(prompt, /on a fully transparent background/);
    assert.match(prompt, /No human ears/);
    assert.match(prompt, /unbroken white outline exactly one grid pixel wide/);
    assert.match(prompt, /Both characters are drawn together as one group/);
    assert.match(prompt, /Pixel art style: detailed pixel art/);
    assert.ok(!/centred and fills most of the canvas/.test(prompt), 'the single figure framing does not apply to a pair');
});

test('the scene names the five pictures in order only when all five are attached', () => {
    assert.ok(!scene({}, 3).prompt.includes('fifth attached image'));
    const five = scene({}, 5).prompt;
    assert.match(five, /first attached image is character 1's approved illustrated design sheet/);
    assert.match(five, /second attached image is character 2's/);
    assert.match(five, /third attached image is the line-up/);
    assert.match(five, /fourth and fifth attached images/);
    assert.match(five, /Do not mix details between the two characters/);
    assert.ok(!five.includes('Redraw the character as pixel art'), 'the single character paragraph is not used');
});

test('the scene says how the characters relate in height, from the line-up', () => {
    assert.match(scene().prompt, /Character 1 is clearly taller than character 2/);
});
