import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
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

test('the logo template is ready and its brand colour is the lavender #8b64aa', () => {
    const { prompt, status } = compose();
    assert.equal(status, 'ready');
    assert.match(prompt, /#8b64aa/);
    assert.ok(!/\{[a-z_]+\}/.test(prompt), 'no placeholder is left in the prompt');
});

test('the emblem is two ears with SB as negative space between them, on a transparent background', () => {
    const { prompt, resolvedVars } = compose();
    assert.match(prompt, /two rabbit ears/);
    assert.match(prompt, /"SB"[^.]*negative space/);
    assert.match(resolvedVars.background, /transparent/);
    assert.ok(!/white background|plain white/i.test(prompt));
});

test('the circuit-like lines are described only as straight lines that turn at right angles and end in round dots', () => {
    const { prompt } = compose();
    assert.match(prompt, /thin straight lines that turn at right angles and end in small round dots/);
    assert.ok(!/circuit|trace|board|chip/i.test(prompt), 'the homage is not named');
});

test('the mark has to read at 16 pixels and is flat: no gradient, shading, sticker outline or other text', () => {
    const { prompt } = compose();
    assert.match(prompt, /16 pixels/);
    for (const rule of [/no gradients/, /no shading/, /no outline sticker/i, /no other text/i]) {
        assert.match(prompt, rule);
    }
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

test('the colour is a variable too', () => {
    assert.match(compose({ colour: '#112233' }).prompt, /#112233/);
    assert.ok(!compose({ colour: '#112233' }).prompt.includes('#8b64aa'));
});

test('no variant names a project, a game or a character', () => {
    for (const variation of ['asymmetric', 'symmetric']) {
        assert.ok(!/silly ?tavern|touhou|reisen|tewi|circuit/i.test(compose({ variation }).prompt));
    }
});

test('--background transparent agrees with the prompt, and asking for opaque is refused', () => {
    const { resolvedVars } = compose();
    assert.equal(resolveBackground({ requested: 'transparent', provider: 'openai', promptBackground: resolvedVars.background }), 'transparent');
    assert.throws(() => resolveBackground({ requested: 'opaque', provider: 'openai', promptBackground: resolvedVars.background }), /transparent/);
});

test('eight concepts at 1024x1024 transparent dry-run at 8 x $0.20 with nothing sent', async () => {
    const request = parseRequest('generate', [
        '--template', 'logo-concept', '--n', '8', '--size', '1024x1024', '--background', 'transparent',
        '--out', 'raw/s4/logo-concept', '--dry-run',
    ], BRANDING);
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
    const outcome = await runGeneration(request, deps);
    assert.equal(outcome.dryRun, true);
    const text = lines.join('\n');
    assert.match(text, /requests: 8/);
    assert.match(text, /8 x \$0\.20 = \$1\.60/);
    assert.match(text, /"background": "transparent"/);
    assert.ok(!/WOULD REFUSE/.test(text));
});
