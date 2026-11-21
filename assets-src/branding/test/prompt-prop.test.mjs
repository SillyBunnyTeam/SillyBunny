import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../scripts/lib/cli.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { loadEnvironment } from '../scripts/lib/env.mjs';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';
import { runGeneration } from '../scripts/lib/run.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = loadPromptKit(join(BRANDING, 'prompts'));
const config = loadConfig(join(BRANDING, 'config.json'));
const prop = (vars = {}, refCount = 0) => composePrompt(kit, 'pixel-prop', { vars, refCount });
const NAMES = /silly ?tavern|touhou|reisen|tewi|homage|fork/i;
// An object has no character, so nothing about one may leak in from the character templates.
const CHARACTER_WORDS = /\b(ears?|hair|rabbits?|characters?|girls?|outfit|face)\b/i;

test('the prop template is ready, has no character and draws the moon by default', () => {
    const { prompt, status, characters } = prop();
    assert.equal(status, 'ready');
    assert.deepEqual(characters, []);
    assert.match(prompt, /Subject: A full moon: one large round disc in a flat pale cream/);
    assert.match(prompt, /soft, low-contrast crater patches/);
    assert.match(prompt, /nothing on it but the craters/);
});

test('the star is a lookup entry too, and an unknown prop is refused', () => {
    assert.match(prop({ prop: 'star' }).prompt, /Subject: A small four-point sparkle star/);
    assert.notEqual(prop({ prop: 'star' }).prompt, prop().prompt);
    assert.throws(() => prop({ prop: 'comet' }), /pixel-props\.md has no entry for prop "comet"/);
    assert.match(prop({ prop: 'moon', subject: 'A custom thing.' }).prompt, /Subject: A custom thing\./);
});

test('every pixel is a crisp block on a transparent background, with the same one pixel sticker edge as the characters', () => {
    const { prompt, resolvedVars } = prop();
    assert.equal(resolvedVars.background, 'fully transparent');
    assert.match(prompt, /every pixel of the grid is a crisp flat square block of one colour/);
    assert.match(prompt, /no anti-aliasing, no blur and no gradient inside a block/);
    assert.match(prompt, /on a fully transparent background/);
    assert.match(prompt, /unbroken white outline exactly one grid pixel wide runs around the whole silhouette/);
    assert.match(prompt, /soft lavender-grey rim exactly one grid pixel wide outside it/);
    assert.match(prompt, /No text, letters, numbers/);
    assert.match(prompt, /centred and fills most of the canvas/);
    assert.match(prompt, /no cast shadow/);
});

test('the prop style is the character pixel style with the character parts taken out, so the two cannot drift apart', () => {
    const characterStyle = readFileSync(join(BRANDING, 'prompts', 'style-pixel.md'), 'utf8').split('\n');
    const propStyle = readFileSync(join(BRANDING, 'prompts', 'style-pixel-prop.md'), 'utf8').trim().split('\n');
    const labelOf = (line) => line.split(':')[0];
    const shared = ['Pixel art style', 'Outlines', 'Clusters'];
    for (const label of shared) {
        assert.equal(propStyle.find((line) => labelOf(line) === label), characterStyle.find((line) => labelOf(line) === label), label);
    }
    const sticker = (lines) => lines.find((line) => line.startsWith('Sticker edge'));
    for (const phrase of ['an unbroken white outer outline one grid pixel wide', 'with a soft lavender-grey rim one grid pixel wide outside it']) {
        assert.ok(sticker(propStyle).includes(phrase) && sticker(characterStyle).includes(phrase), phrase);
    }
    const palette = propStyle.find((line) => line.startsWith('Palette'));
    assert.match(palette, /hue-shifted ramps, with shadows shifting toward violet or blue and highlights shifting toward warm yellow/);
    assert.ok(!/24 to 32/.test(palette), 'an object needs a smaller palette than a character');
});

test('no character words reach the prompt, and no project or character is named', () => {
    for (const vars of [{}, { prop: 'star' }]) {
        const { prompt } = prop(vars);
        const hit = CHARACTER_WORDS.exec(prompt);
        assert.equal(hit, null, `names ${hit?.[0]}`);
        assert.ok(!NAMES.test(prompt));
    }
});

test('an empty composition line is dropped, and a given one is kept', () => {
    assert.ok(!prop().prompt.includes('Composition:'));
    assert.match(prop({ composition: 'the disc fills the canvas' }).prompt, /Composition: the disc fills the canvas/);
});

async function dryRun(args) {
    const lines = [];
    const deps = {
        rootDir: BRANDING,
        config,
        kit,
        env: loadEnvironment({ env: {} }),
        fetchImpl: async () => {
            throw new Error('a dry run must not touch the network');
        },
        print: (line) => lines.push(line),
        confirm: async () => false,
        now: () => new Date('2026-11-01T12:00:00.000Z'),
    };
    const request = parseRequest('generate', ['--template', 'pixel-prop', '--size', '1024x1024', '--background', 'transparent', '--dry-run', ...args], BRANDING);
    const outcome = await runGeneration(request, deps);
    return { outcome, text: lines.join('\n') };
}

test('the moon and the star each cost $0.40 for two, with nothing sent', async () => {
    for (const which of ['moon', 'star']) {
        const { outcome, text } = await dryRun(['--n', '2', '--vars', `prop=${which}`, '--out', `raw/s5/${which}`]);
        assert.equal(outcome.dryRun, true);
        assert.match(text, /requests: 2/);
        assert.match(text, /2 x \$0\.20 = \$0\.40/);
        assert.match(text, /"background": "transparent"/);
    }
});
