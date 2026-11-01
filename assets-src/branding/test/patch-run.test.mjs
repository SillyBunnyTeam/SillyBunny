import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('--balance drops the relay charge of a call when another run is using the same token', async () => {
    const { root, imagePath } = await makeRoot();
    const started = Date.parse('2026-11-01T11:59:00.000Z');
    mkdirSync(join(root, 'log', '.runs'), { recursive: true });
    writeFileSync(join(root, 'log', '.runs', `openai-${started}-${process.pid}.json`), JSON.stringify({ provider: 'openai', pid: process.pid, startedAt: started }));
    const { deps, lines } = makeDeps(root, { usage: [1_000_000, 1_100_000, 1_300_000] });
    await runPatches(request(imagePath, { patches: TWO, balance: true }), deps);
    assert.ok(logOf(root).slice(0, 2).every((entry) => entry.chargedUsd === undefined));
    assert.match(lines.join('\n'), /WARNING: chargedUsd not recorded: another run used this token at the same time/);
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
    const { root, imagePath } = await makeRoot({ logLines: [{ time: 't', estimatedUsd: config.costCapUsd - 0.1, outputs: [], refs: [], approved: false }] });
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

const FIRST_STAMP = '20261101T120000Z';
const PREFIX = `raw/s2/${FIRST_STAMP}-gpt-image-2.5-sunburst-h-patch`;
const REUSE_SPEC = [
    { crop: [80, 30, 140, 120], composite: [[98, 88, 14, 14]] },
    { crop: [0, 0, 130, 110], composite: [[100, 85, 20, 20]] },
];
const readLogText = (root) => readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8');
const listRaw = (root) => readdirSync(join(root, 'raw'), { recursive: true }).sort();

/** Deps for a reuse run: a later clock so the new files do not collide, and a relay that must never be called. */
function reuseDeps(root) {
    const { deps, lines } = makeDeps(root);
    deps.now = () => new Date('2026-11-01T13:00:00.000Z');
    deps.fetchImpl = async () => {
        throw new Error('a reuse run must not call the relay');
    };
    return { deps, lines };
}

const reuseRequest = (imagePath, overrides = {}) => request(imagePath, { patches: REUSE_SPEC, reuse: PREFIX, outDir: 'raw/s2/fix', feather: 0, instruction: undefined, ...overrides });

/** A finished normal run of two patches and two variants, whose results a reuse run can start from. */
async function finishedRun() {
    const made = await makeRoot();
    const { deps } = makeDeps(made.root);
    await runPatches(request(made.imagePath, { patches: TWO, n: 2 }), deps);
    return made;
}

test('--reuse composites the saved results again with new rects: no call, the same variants, pictures that change only inside the new rects, and a free log line per picture', async () => {
    const { root, source, imagePath } = await finishedRun();
    const before = logOf(root);
    const { deps, lines } = reuseDeps(root);
    const outcome = await runPatches(reuseRequest(imagePath), deps);
    assert.deepEqual([outcome.dryRun, outcome.partial, outcome.calls], [false, false, 0]);

    const stem = '20261101T130000Z-gpt-image-2.5-sunburst-h-patch';
    assert.deepEqual(readdirSync(join(root, 'raw', 's2', 'fix')).sort(), [`${stem}-1-compare.png`, `${stem}-1.png`, `${stem}-2-compare.png`, `${stem}-2.png`]);
    for (const variant of [1, 2]) {
        const result = await readRaster(join(root, 'raw', 's2', 'fix', `${stem}-${variant}.png`));
        assert.deepEqual([result.width, result.height], [300, 200]);
        for (let y = 0; y < 200; y++) {
            for (let x = 0; x < 300; x++) {
                const inside = (x >= 98 && x < 112 && y >= 88 && y < 102) || (x >= 100 && x < 120 && y >= 85 && y < 105);
                if (!inside) {
                    assert.deepEqual(getPixel(result, x, y), getPixel(source, x, y), `pixel ${x},${y} outside the new rects changed`);
                }
            }
        }
        assert.ok(isGreenish(getPixel(result, 104, 94)), 'the saved result, not the source, shows inside the new rects');
    }

    const logged = logOf(root);
    assert.equal(logged.length, before.length + 2);
    assert.deepEqual(logged.slice(0, before.length), before, 'earlier lines are untouched');
    const [first, second] = logged.slice(before.length);
    const editOutputs = (patch, variant) => before.find((entry) => entry.template === 'patch-edit' && entry.vars.patch === patch && entry.vars.variant === variant).outputs[0].sha256;
    const sourceHash = sha256(readFileSync(imagePath));
    assert.deepEqual([first.template, first.estimatedUsd, first.approved, first.stage, first.model, first.provider], ['patch-composite', 0, false, 's2', 'gpt-image-2.5-sunburst-h', 'openai']);
    assert.deepEqual(first.refs, [sourceHash, editOutputs(1, 1), editOutputs(2, 1)]);
    assert.deepEqual(second.refs, [sourceHash, editOutputs(1, 2), editOutputs(2, 2)]);
    assert.deepEqual([first.vars.reused, first.vars.feather, first.vars.variant, first.vars.source], [PREFIX, 0, 1, 'refs/page.png']);
    assert.deepEqual(first.vars.patches.map((patch) => patch.composite), [[[98, 88, 14, 14]], [[100, 85, 20, 20]]]);
    assert.deepEqual(first.vars.patches.map((patch) => patch.instruction), ['Remove the human ears.', 'Make it clearer.'], 'instructions come from the reused run');
    assert.equal(first.outputs[0].file, `raw/s2/fix/${stem}-1.png`);
    assert.equal(first.outputs[0].sha256, sha256(readFileSync(join(root, first.outputs[0].file))));
    assert.match(lines.join('\n'), /reusing raw\/s2\/.*-patch {3}openai \/ gpt-image-2\.5-sunburst-h {3}template: patch-composite/);
    assert.match(lines.join('\n'), /patches: 2 {3}variants: 2 {3}model calls: 0/);
});

test('--reuse accepts a prefix given as a full path', async () => {
    const { root, imagePath } = await finishedRun();
    const { deps } = reuseDeps(root);
    const outcome = await runPatches(reuseRequest(imagePath, { reuse: join(root, PREFIX) }), deps);
    assert.equal(outcome.partial, false);
    assert.equal(logOf(root).at(-1).vars.reused, PREFIX);
});

test('a --reuse dry run prints the plan and the checks it passed, and writes nothing', async () => {
    const { root, imagePath } = await finishedRun();
    const files = listRaw(root);
    const log = readLogText(root);
    const { deps, lines } = reuseDeps(root);
    const outcome = await runPatches(reuseRequest(imagePath, { dryRun: true }), deps);
    assert.equal(outcome.dryRun, true);
    const text = lines.join('\n');
    assert.match(text, /patch 2: crop \[0,0,130,110\] {2}composite \[\[100,85,20,20\]\] {2}feather 0/);
    assert.match(text, /variant 2: raw\/s2\/.*-patch-p2-2\.png {2}sha256 [0-9a-f]{16}/);
    assert.match(text, /patch 1 variant 1: mean colour difference inside the composite area/);
    assert.match(text, /dry run: nothing was saved or logged/);
    assert.deepEqual(listRaw(root), files);
    assert.equal(readLogText(root), log);
});

async function otherPicture(root) {
    const changed = page();
    setPixel(changed, 5, 5, [1, 2, 3]);
    const path = join(root, 'refs', 'other.png');
    await sharp(changed.data, { raw: { width: 300, height: 200, channels: 4 } }).png().toFile(path);
    return path;
}

const REFUSALS = [
    ['a crop that differs from the reused run', {}, { patches: [{ ...REUSE_SPEC[0], crop: [80, 30, 140, 121] }, REUSE_SPEC[1]] }, /Patch 1: the crop \[80,30,140,121\] is not the reused run's \[80,30,140,120\]. Only the composite rects and --feather may differ/],
    ['fewer patches than the reused run', {}, { patches: [REUSE_SPEC[0]] }, /edited 2 patches, but the spec has 1/],
    ['more patches than the reused run', {}, { patches: [...REUSE_SPEC, REUSE_SPEC[0]] }, /edited 2 patches, but the spec has 3/],
    ['a prefix nothing was logged under', {}, { reuse: 'raw/s2/20990101T000000Z-gpt-image-2.5-sunburst-h-patch' }, /no patch-edit result under raw\/s2\/20990101/],
    ['a prefix outside the package', {}, { reuse: '../elsewhere/run-patch' }, /outside/],
    ['a result missing from the log', { async mutate(root) {
        const kept = logOf(root).filter((entry) => !(entry.template === 'patch-edit' && entry.vars.patch === 2 && entry.vars.variant === 2));
        writeFileSync(join(root, 'log', 'generations.jsonl'), kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    } }, {}, /no result for patch 2 variant 2/],
    ['a result file that is gone', { async mutate(root) {
        rmSync(join(root, `${PREFIX}-p1-2.png`));
    } }, {}, /result file for patch 1 variant 2 is missing/],
    ['a result file that is not the logged one', { async mutate(root) {
        writeFileSync(join(root, `${PREFIX}-p2-1.png`), 'changed since it was logged');
    } }, {}, /p2-1\.png is not the file the log recorded/],
    ['a different source image', { async prepare(root) {
        return { imagePath: await otherPicture(root) };
    } }, {}, /source image .* is not the one the reused run edited/],
];

for (const [name, { mutate, prepare }, overrides, message] of REFUSALS) {
    test(`--reuse refuses ${name}, before anything is written`, async () => {
        const made = await finishedRun();
        await mutate?.(made.root);
        const { imagePath = made.imagePath } = (await prepare?.(made.root)) ?? {};
        const files = listRaw(made.root);
        const log = readLogText(made.root);
        const { deps } = reuseDeps(made.root);
        await assert.rejects(runPatches(reuseRequest(imagePath, overrides), deps), message);
        assert.deepEqual(listRaw(made.root), files);
        assert.equal(readLogText(made.root), log);
    });
}
