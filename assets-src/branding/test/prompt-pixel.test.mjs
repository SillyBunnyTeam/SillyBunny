import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';

const kit = loadPromptKit(join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts'));
const sheet = (vars = {}, { refCount = 0, characters } = {}) => composePrompt(kit, 'design-sheet-pixel', { vars, refCount, characters });
const still = (vars = {}, refCount = 0) => composePrompt(kit, 'pixel-still', { vars: { pose: 'standing', ...vars }, refCount });

test('both pixel templates are ready, not stubs, so a real run needs no --allow-stub', () => {
    assert.equal(sheet().status, 'ready');
    assert.equal(still().status, 'ready');
});

test('the default background is a transparent one, with the green screen only as an explicit fallback', () => {
    for (const { prompt, resolvedVars } of [sheet(), still()]) {
        assert.equal(resolvedVars.background, 'fully transparent');
        assert.match(prompt, /on a fully transparent background/);
        assert.ok(!/00FF00|green/i.test(prompt));
    }
    assert.match(sheet({ background: 'flat pure green #00FF00' }).prompt, /on a flat pure green #00FF00 background/);
});

test('the sheet draws one sprite or one portrait by its format, each with its own grid', () => {
    const sprite = sheet().prompt;
    assert.match(sprite, /full-body standing sprite in front view/);
    assert.match(sprite, /128 by 128 pixel grid/);
    const portrait = sheet({ format: 'portrait-64' }).prompt;
    assert.match(portrait, /head-and-shoulders portrait in front view/);
    assert.match(portrait, /64 by 64 pixel grid/);
    assert.ok(!/full-body/.test(portrait));
    assert.throws(() => sheet({ format: 'banner' }), /pixel-subjects\.md has no entry for format "banner"/);
    assert.match(sheet({ subject: 'One custom thing.' }).prompt, /One custom thing\./);
});

test('every pixel is a crisp block, the sticker edge is one grid pixel wide and unbroken, and the ears are expressive', () => {
    for (const { prompt } of [sheet(), still()]) {
        assert.match(prompt, /every pixel of the (native )?grid is a crisp flat square block of one colour/);
        assert.match(prompt, /no anti-aliasing, no blur and no gradient inside a block/);
        assert.match(prompt, /unbroken white outline exactly one grid pixel wide/);
        assert.match(prompt, /including every hair strand, both rabbit ears and the tail/);
        assert.match(prompt, /rim exactly one grid pixel wide/);
        assert.match(prompt, /the ears are a primary means of expression/);
        assert.match(prompt, /Ears: ears in /);
    }
    assert.match(still({ ears: 'one ear tilted' }).prompt, /Ears: one ear tilted/);
});

test('Reisen\'s resting ears come from her character file, and a Tewi sprite uses hers', () => {
    assert.match(sheet().prompt, /folds over partway up/);
    const tewi = sheet({}, { characters: ['tewi'] }).prompt;
    assert.match(tewi, /lucky carrot necklace/);
    assert.ok(!/folds over partway up/.test(tewi));
});

test('with references the sprite redraws the character from the sheet and ignores the other character in the line-up', () => {
    const prompt = sheet({}, { refCount: 2 }).prompt;
    assert.match(prompt, /The first attached image is the character's approved illustrated design sheet/);
    assert.match(prompt, /Any second attached image is a line-up/);
    assert.match(prompt, /the other character in the line-up must not appear/);
    assert.match(prompt, /replaced by the pixel-art rules above/);
    assert.ok(!/first attached image is/.test(sheet().prompt), 'no references, no paragraph');
});

test('the pixel templates carry the no-human-ears rule, framing and the pixel style', () => {
    for (const { prompt } of [sheet(), still()]) {
        assert.match(prompt, /No human ears/);
        assert.match(prompt, /centred and fills most of the canvas/);
        assert.match(prompt, /Pixel art style: detailed pixel art/);
        assert.match(prompt, /Palette: a small locked palette of 24 to 32 colours/);
    }
});

test('the still needs a pose', () => {
    assert.throws(() => composePrompt(kit, 'pixel-still', { vars: {}, refCount: 0 }), /--vars pose=/);
});
