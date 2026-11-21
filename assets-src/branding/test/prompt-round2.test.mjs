import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const kit = loadPromptKit(PROMPTS);
const read = (name) => readFileSync(join(PROMPTS, name), 'utf8');
const count = (text, pattern) => (text.match(pattern) ?? []).length;

const EXPRESSIONS = [
    'neutral', 'approval', 'realization', 'relief', 'joy', 'amusement', 'excitement', 'optimism', 'pride', 'gratitude',
    'love', 'admiration', 'caring', 'curiosity', 'confusion', 'annoyance', 'disapproval', 'anger', 'disgust', 'sadness',
    'grief', 'remorse', 'disappointment', 'fear', 'nervousness', 'embarrassment', 'surprise', 'desire',
];

const sheet = (characters) => composePrompt(kit, 'design-sheet-illustrated', { vars: {}, characters, refCount: 0 }).prompt;

test('the sticker outline is the first trait after the opener and is described as a die-cut sticker', () => {
    const lines = read('style-illustrated.md').split('\n');
    assert.match(lines[1], /^Sticker outline/);
    assert.match(lines[1], /thick, bold, unbroken white outline of even width/);
    assert.match(lines[1], /2\.5 to 3%/);
    assert.match(lines[1], /every hair strand/);
    assert.match(lines[1], /both (rabbit )?ears/);
    assert.match(lines[1], /tail/);
    assert.match(lines[1], /lavender-grey rim/);
    assert.match(lines[1], /die-cut vinyl sticker/);
});

test('the design sheet repeats the sticker outline and makes every figure and face panel its own sticker', () => {
    const prompt = sheet(['reisen']);
    assert.ok(count(prompt, /unbroken white outline/g) >= 2, 'outline named in the style and again in the template');
    assert.match(prompt, /Each figure and each face panel is its own (die-cut )?sticker/);
});

test('the design sheet fills the panels, uses a near-white lavender background and bans grey haze', () => {
    const prompt = sheet(['reisen']);
    assert.match(prompt, /fill most of the (panel|canvas) height/);
    assert.match(prompt, /very light near-white background with a faint lavender tint/);
    assert.ok(!/light[- ]grey/i.test(prompt));
    assert.match(prompt, /no grey haze/i);
    assert.match(prompt, /saturated/);
    assert.match(prompt, /crisp line art/);
});

test('the line-up repeats the outline, fills the canvas and shares the clean background and colour rules', () => {
    const prompt = composePrompt(kit, 'lineup', { vars: {}, refCount: 2 }).prompt;
    assert.ok(count(prompt, /unbroken white outline/g) >= 2);
    assert.match(prompt, /fill most of the canvas height/);
    assert.match(prompt, /near-white background with a faint lavender tint/);
    assert.match(prompt, /no grey haze/i);
    assert.ok(!/light[- ]grey/i.test(prompt));
});

test('the design sheet names a different ear pose for each of the three face panels', () => {
    const prompt = sheet(['reisen']);
    assert.match(prompt, /neutral[^.\n]*ears[^.\n]*\n[^]*gentle smile[^.\n]*ears[^.\n]*\n[^]*surprised[^.\n]*ears/i);
    const earPoses = [...prompt.matchAll(/^(?:neutral|gentle smile|surprised)[^\n]*$/gim)].map((m) => m[0]);
    assert.equal(earPoses.length, 3);
    assert.equal(new Set(earPoses).size, 3);
});

test('Reisen\'s eyes are a vivid saturated crimson with glossy highlights', () => {
    const text = read('character-reisen.md');
    assert.match(text, /Eyes:[^\n]*vivid, saturated crimson red/);
    assert.match(text, /glossy highlights/);
});

test('ears are a primary means of expression in the style and in both character files', () => {
    assert.match(read('style-illustrated.md'), /ears[^\n]*(primary|main) (means|way) of expression/i);
    const reisen = read('character-reisen.md');
    for (const phrase of [/stand straight up when alert/, /droop backwards when sad/, /shoot up or splay when surprised/]) {
        assert.match(reisen, phrase);
    }
    const tewi = read('character-tewi.md');
    for (const phrase of [/perk up/, /tilt/, /twitch one at a time/, /flop/, /mischievous or sulking/]) {
        assert.match(tewi, phrase);
    }
});

test('the pixel style carries the same ear-expression rule', () => {
    assert.match(read('style-pixel.md'), /ears are a primary means of expression/);
});

test('the style asks for bright clean colour and a confident, creative interpretation', () => {
    const style = read('style-illustrated.md');
    assert.match(style, /clean and bright/i);
    assert.match(style, /no grey haze/i);
    assert.match(style, /creative/i);
});

test('every one of the 28 expressions has an ear pose for the face-edit template', () => {
    for (const expression of EXPRESSIONS) {
        const { prompt, resolvedVars } = composePrompt(kit, 'expression-face-edit', { vars: { expression }, refCount: 1 });
        assert.ok(resolvedVars.ears.length > 10, `${expression} has no ear hint`);
        assert.match(prompt, new RegExp(`change only the face and the ears to show ${expression}`));
        assert.ok(prompt.includes(resolvedVars.ears));
    }
    assert.equal(new Set(EXPRESSIONS.map((e) => composePrompt(kit, 'expression-face-edit', { vars: { expression: e }, refCount: 1 }).resolvedVars.ears)).size, 28);
});

test('an explicit ears variable overrides the lookup and an unlisted expression needs one', () => {
    const custom = composePrompt(kit, 'expression-face-edit', { vars: { expression: 'joy', ears: 'one ear folded over' }, refCount: 1 });
    assert.match(custom.prompt, /one ear folded over/);
    assert.throws(() => composePrompt(kit, 'expression-face-edit', { vars: { expression: 'smugness' }, refCount: 1 }), /--vars ears=/);
});

test('the pose-base stub also asks for a relaxed ear pose', () => {
    const { prompt } = composePrompt(kit, 'expression-pose-base', { vars: { pose: 'standing' }, refCount: 1 });
    assert.match(prompt, /ears/i);
    assert.match(prompt, /neutral face/);
});
