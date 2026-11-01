import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/lib/config.mjs';
import { loadEnvironment } from '../scripts/lib/env.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { runPatches } from '../scripts/lib/patch-run.mjs';
import { loadPromptKit } from '../scripts/lib/prompt-kit.mjs';
import { readRaster } from '../scripts/lib/raster.mjs';
import { createRaster, getPixel, setPixel } from '../test-support/synthetic.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-test-0123456789abcdefABCDEF';
const config = loadConfig(join(BRANDING, 'config.json'));
const kit = loadPromptKit(join(BRANDING, 'prompts'));
const RULE = 'No human ears: the only ears are the rabbit ears on top of the head; the sides of the head where human ears would be are covered by hair.';

function page() {
    const raster = createRaster(300, 200, [240, 236, 250, 255]);
    for (let y = 40; y < 160; y++) {
        for (let x = 90; x < 210; x++) {
            setPixel(raster, x, y, (x + y) % 11 < 5 ? [250, 220, 200] : [60, 40, 90]);
        }
    }
    for (let y = 90; y < 100; y++) {
        for (let x = 100; x < 110; x++) {
            setPixel(raster, x, y, [220, 30, 30]);
        }
    }
    return raster;
}

async function makeRoot({ logLines = [] } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'sb-patch-'));
    mkdirSync(join(root, 'refs'));
    const source = page();
    const imagePath = join(root, 'refs', 'page.png');
    await sharp(source.data, { raw: { width: 300, height: 200, channels: 4 } }).png().toFile(imagePath);
    if (logLines.length > 0) {
        mkdirSync(join(root, 'log'));
        writeFileSync(join(root, 'log', 'generations.jsonl'), logLines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    }
    return { root, source, imagePath };
}

/** Plays the model: turns the red marker green, or inverts everything, and counts what it was sent. */
function makeDeps(root, { mode = 'recolour', failOnCall, usage = [] } = {}) {
    const lines = [];
    const calls = [];
    const balances = [...usage];
    return {
        lines,
        calls,
        deps: {
            rootDir: root,
            config,
            kit,
            env: loadEnvironment({ env: { OPENAI_API_KEY: KEY } }),
            fetchImpl: async (url, init) => {
                if (String(url).includes('/api/usage/token')) {
                    return new Response(JSON.stringify({ data: { total_used: balances.shift() } }));
                }
                const form = init.body;
                const sent = Buffer.from(await form.get('image[]').arrayBuffer());
                calls.push({ url: String(url), fields: Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string')), files: form.getAll('image[]').length, sent });
                if (failOnCall === calls.length) {
                    return new Response('{"error":{"message":"boom"}}', { status: 500 });
                }
                const { data, info } = await sharp(sent).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                for (let at = 0; at < data.length; at += 4) {
                    if (mode === 'invert') {
                        data[at] = 255 - data[at];
                        data[at + 1] = 255 - data[at + 1];
                        data[at + 2] = 255 - data[at + 2];
                    } else if (data[at] > 180 && data[at + 1] < 90 && data[at + 2] < 90) {
                        data.set([30, 220, 30], at);
                    }
                }
                const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
                return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
            },
            print: (line) => lines.push(line),
            confirm: async () => true,
            now: () => new Date('2026-11-01T12:00:00.000Z'),
        },
    };
}

const ONE = [{ crop: [80, 30, 140, 120], composite: [[95, 85, 30, 25]] }];
const TWO = [...ONE, { crop: [0, 0, 130, 110], instruction: 'Make it clearer.' }];
const request = (imagePath, overrides = {}) => ({
    imagePath,
    patches: ONE,
    instruction: 'Remove the human ears.',
    n: 1,
    outDir: 'raw/s2',
    stage: 's2',
    feather: 6,
    allowUnlocked: false,
    dryRun: false,
    yes: true,
    balance: false,
    ...overrides,
});
const logOf = (root) => readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const isGreenish = ([r, g, b]) => g > r + 100 && g > b + 100;

test('a dry run lists every patch with its size, scale and padding, prints the prompts and the request, and writes nothing', async () => {
    const { root, imagePath } = await makeRoot();
    const { deps, lines, calls } = makeDeps(root);
    await runPatches(request(imagePath, { patches: TWO, dryRun: true }), deps);
    const text = lines.join('\n');
    assert.match(text, /openai \/ gpt-image-2\.5-sunburst-h {3}template: patch-edit {3}stage: s2/);
    assert.match(text, /patches: 2 {3}calls: 2/);
    assert.match(text, /patch 1: crop \[80,30,140,120\] -> 1536x1024 \(8\.53x\) {2}padding #f0ecfa {2}composite \[\[95,85,30,25\]\] {2}feather 6/);
    assert.match(text, /patch 2: crop \[0,0,130,110\].*composite \[\[0,0,130,110\]\]/);
    assert.match(text, /estimate: 2 x \$0\.20 = \$0\.40/);
    assert.match(text, /--- prompt \(patch 1\) ---[^]*close-up crop of a larger image[^]*Remove the human ears\.[^]*--- prompt \(patch 2\) ---[^]*Make it clearer\./);
    assert.ok(text.includes(RULE));
    assert.match(text, /"url": "https:\/\/api\.linkapi\.ai\/v1\/images\/edits"/);
    assert.match(text, /"field": "image\[\]"/);
    assert.match(text, /nothing was sent, saved or logged/);
    assert.equal(calls.length, 0);
    assert.ok(!existsSync(join(root, 'raw')) && !existsSync(join(root, 'log')));
});

test('one patch: one call, a full-size result that changed only inside the composite rect, and one log line per call plus one for the result', async () => {
    const { root, source, imagePath } = await makeRoot();
    const { deps, calls } = makeDeps(root);
    const outcome = await runPatches(request(imagePath), deps);
    assert.equal(outcome.partial, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/images\/edits$/);
    assert.deepEqual([calls[0].fields.model, calls[0].fields.n, calls[0].fields.size, calls[0].files], ['gpt-image-2.5-sunburst-h', '1', '1536x1024', 1]);
    assert.match(calls[0].fields.prompt, /Remove the human ears\./);

    const files = readdirSync(join(root, 'raw', 's2')).sort();
    assert.deepEqual(files, [
        '20261101T120000Z-gpt-image-2.5-sunburst-h-patch-1-compare.png',
        '20261101T120000Z-gpt-image-2.5-sunburst-h-patch-1.png',
        '20261101T120000Z-gpt-image-2.5-sunburst-h-patch-p1-1.png',
        '20261101T120000Z-gpt-image-2.5-sunburst-h-patch-p1.prompt.txt',
        '20261101T120000Z-gpt-image-2.5-sunburst-h-patch-p1.request.png',
    ]);
    const result = await readRaster(join(root, 'raw', 's2', files[1]));
    assert.deepEqual([result.width, result.height], [300, 200]);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 300; x++) {
            const inside = x >= 95 && x < 125 && y >= 85 && y < 110;
            if (!inside) {
                assert.deepEqual(getPixel(result, x, y), getPixel(source, x, y), `pixel ${x},${y} outside the composite rect changed`);
            } else if (isGreenish(getPixel(result, x, y))) {
                sx += x;
                sy += y;
                n++;
            }
        }
    }
    assert.ok(n > 60, `the marker turned green (${n} pixels)`);
    assert.ok(Math.abs(sx / n - 104.5) < 0.7 && Math.abs(sy / n - 94.5) < 0.7, `marker centre ${sx / n}, ${sy / n}`);

    const [call, composite] = logOf(root);
    const sourceHash = sha256(readFileSync(imagePath));
    assert.equal(call.template, 'patch-edit');
    assert.equal(call.stage, 's2');
    assert.deepEqual(call.refs, [sourceHash]);
    assert.equal(call.size, '1536x1024');
    assert.equal(call.estimatedUsd, 0.2);
    assert.equal(call.outputs.length, 1);
    assert.deepEqual([call.vars.crop, call.vars.composite, call.vars.patch, call.vars.variant, call.vars.instruction, call.vars.feather], [[80, 30, 140, 120], [[95, 85, 30, 25]], 1, 1, 'Remove the human ears.', 6]);
    assert.equal(call.vars.source, 'refs/page.png');
    assert.equal(call.approved, false);
    assert.equal(composite.template, 'patch-composite');
    assert.equal(composite.estimatedUsd, 0);
    assert.deepEqual(composite.refs, [sourceHash]);
    assert.match(composite.outputs[0].file, /patch-1\.png$/);
    assert.equal(composite.outputs[0].sha256, sha256(readFileSync(join(root, composite.outputs[0].file))));
    assert.equal(composite.vars.patches.length, 1);
});

test('two patches and two variants make four calls and two full-size results, each variant built from its own results', async () => {
    const { root, imagePath } = await makeRoot();
    const { deps, calls, lines } = makeDeps(root);
    await runPatches(request(imagePath, { patches: TWO, n: 2 }), deps);
    assert.equal(calls.length, 4);
    assert.match(calls[2].fields.prompt, /Make it clearer\./, 'the per-patch instruction replaces the default');
    assert.match(calls[0].fields.prompt, /Remove the human ears\./);
    const entries = logOf(root);
    assert.deepEqual(entries.map((entry) => entry.template), ['patch-edit', 'patch-edit', 'patch-edit', 'patch-edit', 'patch-composite', 'patch-composite']);
    assert.deepEqual(entries.slice(0, 4).map((entry) => [entry.vars.patch, entry.vars.variant]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
    assert.equal(readdirSync(join(root, 'raw', 's2')).filter((name) => /patch-[12]\.png$/.test(name)).length, 2);
    assert.match(lines.join('\n'), /patch 1 variant 2: mean colour difference inside the composite area/);
});

test('--balance puts the relay charge of each call into its own log line', async () => {
    const { root, imagePath } = await makeRoot();
    const { deps } = makeDeps(root, { usage: [1_000_000, 1_100_000, 1_300_000] });
    await runPatches(request(imagePath, { patches: TWO, balance: true }), deps);
    const entries = logOf(root);
    assert.deepEqual(entries.slice(0, 2).map((entry) => entry.chargedUsd), [0.2, 0.4]);
    assert.equal(entries[2].chargedUsd, undefined);
});

test('a model that redraws the area outside the composite rects is called out, since that is the face being redrawn', async () => {
    const { root, imagePath } = await makeRoot();
    const { deps, lines } = makeDeps(root, { mode: 'invert' });
    await runPatches(request(imagePath), deps);
    assert.match(lines.join('\n'), /WARNING: .*changed the area outside the composite rects/);
    const calm = await makeRoot();
    const quiet = makeDeps(calm.root);
    await runPatches(request(calm.imagePath), quiet.deps);
    assert.ok(!quiet.lines.join('\n').includes('WARNING'));
});

test('a failed call stops the run, keeps and logs what was already made, builds no result and says so', async () => {
    const { root, imagePath } = await makeRoot();
    const { deps, calls, lines } = makeDeps(root, { failOnCall: 2 });
    const outcome = await runPatches(request(imagePath, { patches: TWO }), deps);
    assert.equal(outcome.partial, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(logOf(root).map((entry) => entry.template), ['patch-edit']);
    assert.match(lines.join('\n'), /STOPPED after 1 of 2 calls/);
    assert.ok(!readdirSync(join(root, 'raw', 's2')).some((name) => /patch-1\.png$/.test(name)), 'no full-size result for an incomplete variant');
});

test('every refusal happens before any call: no instruction, the wrong provider, a bad spec, the cost cap, a folder outside raw/, an unconfirmed run', async () => {
    const { root, imagePath } = await makeRoot({ logLines: [{ time: 't', estimatedUsd: 9.9, outputs: [], refs: [], approved: false }] });
    const attempts = [
        [{ instruction: undefined }, /Patch 1 has no instruction/],
        [{ model: 'gemini-nano-banana-2.1', allowUnlocked: true }, /only the OpenAI provider/],
        [{ model: 'gpt-image-2.5-flare-h' }, /--allow-unlocked/],
        [{ patches: [{ crop: [0, 0, 400, 10] }] }, /outside the 300x200 image/],
        [{}, /costCapUsd/],
        [{ outDir: 'approved' }, /raw\/ or out\//],
    ];
    for (const [overrides, message] of attempts) {
        const { deps, calls } = makeDeps(root);
        await assert.rejects(runPatches(request(imagePath, overrides), deps), message);
        assert.equal(calls.length, 0);
    }
    const cheap = await makeRoot();
    const declined = makeDeps(cheap.root);
    declined.deps.confirm = async () => false;
    await assert.rejects(runPatches(request(cheap.imagePath, { yes: false }), declined.deps), /Cancelled/);
    assert.equal(declined.calls.length, 0);
});

test('the key never appears in the printed lines', async () => {
    const { root, imagePath } = await makeRoot();
    const { deps, lines } = makeDeps(root);
    await runPatches(request(imagePath), deps);
    assert.ok(!lines.join('\n').includes(KEY));
});
