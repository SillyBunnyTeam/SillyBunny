import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveBackground } from '../scripts/lib/background.mjs';
import { parseRequest } from '../scripts/lib/cli.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { loadEnvironment } from '../scripts/lib/env.mjs';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';
import { runGeneration } from '../scripts/lib/run.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = loadPromptKit(join(BRANDING, 'prompts'));
const config = loadConfig(join(BRANDING, 'config.json'));

const compose = (vars = {}) => composePrompt(kit, 'logo-concept', { vars, refCount: 0 });
const GROUPS = [
    { variation: 'asymmetric', letters: 'inside' },
    { variation: 'asymmetric', letters: 'none' },
    { variation: 'symmetric', letters: 'inside' },
    { variation: 'symmetric', letters: 'none' },
];

// A logo made of one lavender must not name another hue, even to forbid it, or the model may draw it.
const OTHER_COLOURS = /\b(gold|golden|yellow|orange|green|red|blue|pink|brown|white|black|grey|gray|silver|cream|beige|cyan|teal|magenta|colourful|rainbow)\b/i;
const NAMES = /silly ?tavern|touhou|reisen|tewi|circuit|trace|homage|fork/i;
const STYLE_WORDS = /realistic|anatomical|photo|3d|volumetric/i;

test('the logo template is ready and its mid tone is the brand lavender #8b64aa', () => {
    const { prompt, status } = compose();
    assert.equal(status, 'ready');
    assert.match(prompt, /#8b64aa/);
    assert.ok(!/\{[a-z_]+\}/.test(prompt), 'no placeholder is left in the prompt');
});

test('the ears are the dominant shapes and the brain beneath them is small, about a third of their height', () => {
    const { prompt } = compose();
    assert.match(prompt, /two rabbit ears are the largest and dominant shapes/);
    assert.match(prompt, /rise from the top of a small, compact brain/);
    assert.match(prompt, /about a third of the height of the ears/);
});

test('the brain is a simple line-art icon of two lobes with a central gap and a few fold strokes, with no realism asked for or named', () => {
    const { prompt } = compose();
    assert.match(prompt, /simple, stylised, icon-like brain/);
    assert.match(prompt, /two rounded lobes split by a central gap/);
    assert.match(prompt, /few simple curved fold strokes/);
    assert.match(prompt, /one family of stroke weights/);
    for (const variant of GROUPS) {
        assert.ok(!STYLE_WORDS.test(compose(variant).prompt), JSON.stringify(variant));
    }
});

test('the ears are drawn in the same flat style, with a dark outline, a light fill and a darker inner ear', () => {
    const { prompt } = compose();
    assert.match(prompt, /dark outline, a flat light-lavender fill and a darker mid-lavender inner-ear shape/);
});

test('symmetric and asymmetric are variables, and each changes the ear description', () => {
    const asymmetric = compose({ variation: 'asymmetric' }).prompt;
    const symmetric = compose({ variation: 'symmetric' }).prompt;
    assert.notEqual(asymmetric, symmetric);
    assert.match(asymmetric, /left ear is long and slightly rumpled[^]*right ear is shorter and floppier/);
    assert.match(symmetric, /mirrored pair/);
    assert.ok(!/right ear is shorter/.test(symmetric));
    assert.throws(() => compose({ variation: 'lopsided' }), /logo-variations\.md has no entry/);
});

test('letters is a variable: inside puts a small bold SB in the brain in place of some fold strokes, none draws no letters at all', () => {
    const inside = compose({ letters: 'inside' }).prompt;
    assert.match(inside, /"SB"[^.]*inside the brain outline/);
    assert.match(inside, /in place of some of the fold strokes/);
    assert.match(inside, /lightest lavender/);
    assert.match(inside, /No other text, letters or numbers/);
    const none = compose({ letters: 'none' }).prompt;
    assert.ok(!/SB/.test(none), 'the letters are not mentioned at all');
    assert.match(none, /No text, letters or numbers anywhere/);
    assert.equal(compose().prompt, inside, 'inside is the default');
    assert.throws(() => compose({ letters: 'outside' }), /logo-letters\.md has no entry/);
});

test('about six thin lines leave the sides of the brain, each with one bend at a right angle or 45 degrees and a round dot at the end', () => {
    const { prompt } = compose();
    assert.match(prompt, /about six thin, even lines, three out of each side of the brain/);
    assert.match(prompt, /turning once at a right angle or at 45 degrees and ending in a small round dot/);
    assert.match(prompt, /stay clear of the charms/);
});

test('a crescent moon sits by the left ear and a carrot hangs from the right ear on a short cord, each in lavender and in its own gap', () => {
    const { prompt } = compose();
    assert.match(prompt, /small crescent moon[^.]*light lavender[^.]*left ear/);
    assert.match(prompt, /small carrot[^.]*mid lavender[^.]*light lavender leaves[^.]*hangs from the tip of the right ear on a short thin dark cord/);
    assert.equal((prompt.match(/clear silhouette separated from the ear and the brain by a small gap/g) ?? []).length, 2);
});

test('only four flat lavender tones are used, with no gradient, shading, glow, soft shadow or texture', () => {
    const { prompt } = compose();
    for (const hex of ['#513867', '#8b64aa', '#af92c4', '#f4eefa']) {
        assert.ok(prompt.includes(hex), hex);
    }
    assert.match(prompt, /only these four flat lavender tones/);
    for (const rule of [/no gradients/, /no shading/, /no glow/, /no soft shadows/, /no texture/, /no airbrush/, /no outline sticker/i]) {
        assert.match(prompt, rule);
    }
});

test('the mark reads at 64 pixels from its ears and brain, with the details left for large sizes', () => {
    const { prompt } = compose();
    assert.match(prompt, /still read at 64 pixels/);
    assert.match(prompt, /detail for large sizes and may disappear when small/);
});

test('the tones are variables', () => {
    const custom = compose({ colour: '#112233', dark: '#445566', light: '#778899', lightest: '#aabbcc' }).prompt;
    for (const hex of ['#112233', '#445566', '#778899', '#aabbcc']) {
        assert.ok(custom.includes(hex), hex);
    }
    assert.ok(!custom.includes('#8b64aa'));
});

test('no variant names a project, a game, a character or the project it echoes', () => {
    for (const variant of GROUPS) {
        assert.ok(!NAMES.test(compose(variant).prompt), JSON.stringify(variant));
    }
});

test('no variant names any colour but lavender, because the carrot and the moon are lavender too', () => {
    for (const variant of GROUPS) {
        const hit = OTHER_COLOURS.exec(compose(variant).prompt);
        assert.equal(hit, null, `${JSON.stringify(variant)} names ${hit?.[0]}`);
    }
});

test('--background transparent agrees with the prompt, and asking for opaque is refused', () => {
    const { resolvedVars } = compose();
    assert.match(resolvedVars.background, /transparent/);
    assert.equal(resolveBackground({ requested: 'transparent', provider: 'openai', promptBackground: resolvedVars.background }), 'transparent');
    assert.throws(() => resolveBackground({ requested: 'opaque', provider: 'openai', promptBackground: resolvedVars.background }), /transparent/);
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
    const request = parseRequest('generate', ['--template', 'logo-concept', '--size', '1024x1024', '--background', 'transparent', '--out', 'raw/s4/logo-concept', '--dry-run', ...args], BRANDING);
    const outcome = await runGeneration(request, deps);
    return { outcome, text: lines.join('\n') };
}

test('eight concepts are four groups of two: each variation with and without letters, $0.40 a group and $1.60 in all, with nothing sent', async () => {
    let total = 0;
    const prompts = new Set();
    for (const { variation, letters } of GROUPS) {
        const { outcome, text } = await dryRun(['--n', '2', '--vars', `variation=${variation}`, '--vars', `letters=${letters}`]);
        assert.equal(outcome.dryRun, true);
        assert.match(text, /requests: 2/);
        assert.match(text, /2 x \$0\.20 = \$0\.40/);
        assert.match(text, /"background": "transparent"/);
        total += outcome.batch.totalUsd;
        prompts.add(outcome.prompt);
    }
    assert.equal(Math.round(total * 100) / 100, 1.6);
    assert.equal(prompts.size, 4, 'the four groups are four different prompts');
});
